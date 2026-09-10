import crypto from 'node:crypto';
import { once } from 'node:events';
import { parseCodexEvents } from './codex.js';
import { IMAGE_TOOL, IMAGE_TOOL_NAME, buildImageGenerationRequest, generateInlineImage } from './inline-image-generation.js';

/** Add the server-owned tool without changing the user's other tools. */
export function addClaudeImageTool(tools) {
    if (tools.some(tool => tool.name === IMAGE_TOOL_NAME)) throw new Error('Image tool name conflicts with an extension tool.');
    tools.push({ name: IMAGE_TOOL_NAME, description: IMAGE_TOOL.description, input_schema: structuredClone(IMAGE_TOOL.parameters) });
}

/** Intercept only our image calls; preserve Claude's native text, thinking and extension tools. */
export async function sendClaudeImageResponse(upstream, response, manager, controller, streaming) {
    const requestId = crypto.randomUUID();
    const abort = () => controller.abort();
    response.on('close', abort);
    let heartbeat;
    const write = async event => {
        controller.signal.throwIfAborted();
        if (!response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
            await once(response, 'drain', { signal: controller.signal });
        }
    };
    const generate = async (calls, onImage) => {
        if (calls.length > 4) throw new Error('At most four images can be generated per response.');
        // Validate every job before making the first billable request.
        const jobs = calls.map(call => buildImageGenerationRequest(call));
        if (streaming && jobs.length) heartbeat = setInterval(() => {
            if (!response.destroyed) response.write(': Generating image\n\n');
        }, 15000);
        for (const [index, job] of jobs.entries()) {
            console.info(`[Claude images ${requestId}] Generating image ${index + 1}/${jobs.length} using Codex`);
            const image = await generateInlineImage(manager, job, controller.signal, requestId);
            await onImage(image);
        }
    };
    try {
        if (response.destroyed) controller.abort();
        controller.signal.throwIfAborted();
        if (!upstream.ok) {
            const error = await upstream.json().catch(() => null);
            throw new Error(`Claude request failed (HTTP ${upstream.status}): ${error?.error?.message || 'No error details returned.'}`);
        }
        if (!streaming) {
            const message = await upstream.json();
            if (message.error || !Array.isArray(message.content)) throw new Error('Claude returned an invalid response.');
            const calls = message.content.filter(block => block.type === 'tool_use' && block.name === IMAGE_TOOL_NAME);
            if (calls.length && message.stop_reason !== 'tool_use') throw new Error('Claude image tool call did not complete. Increase the response token limit and retry.');
            const content = message.content.filter(block => !calls.includes(block));
            let text = content.filter(block => block.type === 'text').map(block => block.text).join('');
            const images = [];
            await generate(calls.map(call => JSON.stringify(call.input)), image => { images.push(image); });
            if (images.length && !text) {
                text = 'Generated image.';
                content.push({ type: 'text', text });
            }
            return response.json({ choices: [{ message: { content: text, images } }], content, usage: message.usage });
        }

        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('X-Accel-Buffering', 'no');
        response.flushHeaders();
        const calls = new Map();
        const indexes = new Map();
        const finalEvents = [];
        let nextIndex = 0;
        let externalTools = false;
        let hasText = false;
        let completed = false;
        let stopReason;
        for await (const event of parseCodexEvents(upstream.body)) {
            if (event.type === 'error') throw new Error(event.error?.message || 'Claude stream failed.');
            if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'tool_use' && block.name === IMAGE_TOOL_NAME) {
                    if (calls.size >= 4) throw new Error('At most four images can be generated per response.');
                    calls.set(event.index, { input: block.input, arguments: '', closed: false });
                    continue;
                }
                indexes.set(event.index, nextIndex++);
                externalTools ||= block?.type === 'tool_use';
                hasText ||= block?.type === 'text' && Boolean(block.text);
            }
            const call = calls.get(event.index);
            if (call && event.type.startsWith('content_block_')) {
                if (event.delta?.type === 'input_json_delta') {
                    call.arguments += event.delta.partial_json || '';
                    if (call.arguments.length > 256 * 1024) throw new Error('Image tool arguments exceeded the size limit.');
                }
                if (event.type === 'content_block_stop') call.closed = true;
                continue;
            }
            if (event.type === 'content_block_delta') hasText ||= Boolean(event.delta?.text);
            if (event.type === 'message_delta') {
                stopReason = event.delta?.stop_reason ?? stopReason;
                if (calls.size) {
                    if (!externalTools && event.delta?.stop_reason === 'tool_use') event.delta.stop_reason = 'end_turn';
                    finalEvents.push(event);
                    continue;
                }
            }
            if (event.type === 'message_stop') {
                completed = true;
                finalEvents.push(event);
                break;
            }
            if (indexes.has(event.index)) event.index = indexes.get(event.index);
            await write(event);
        }
        if (!completed) throw new Error('Claude stream ended before the response completed.');
        if (calls.size && (stopReason !== 'tool_use' || [...calls.values()].some(call => !call.closed))) {
            throw new Error('Claude image tool call did not complete. Increase the response token limit and retry.');
        }
        await generate([...calls.values()].map(call => call.arguments || JSON.stringify(call.input)), async image => {
            await write({ type: 'sillytavern_images', delta: { images: [image], text: hasText ? '' : 'Generated image.' } });
            hasText = true;
        });
        for (const event of finalEvents) await write(event);
        response.end();
    } catch (error) {
        if (!controller.signal.aborted && !response.destroyed) {
            const message = String(error.message)
                .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+|rt_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, '[redacted]')
                .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
            console.error(`[Claude images ${requestId}] ${message}`);
            if (response.headersSent) {
                await write({ type: 'error', error: { message } });
                response.end();
            } else response.status(502).json({ error: { message } });
        }
    } finally {
        clearInterval(heartbeat);
        response.removeListener('close', abort);
        upstream.body?.destroy();
    }
}
