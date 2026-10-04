import crypto from 'node:crypto';
import { once } from 'node:events';
import { parseCodexEvents } from './codex.js';
import { IMAGE_TOOL, IMAGE_TOOL_NAME, buildImageGenerationRequest, generateInlineImage } from './inline-image-generation.js';
import { captureClaudeContent } from '../../../public/scripts/claude-thinking.js';

function combinedUsage(first = {}, second = {}) {
    const usage = { ...first, ...second };
    for (const key of Object.keys(usage)) {
        if (typeof first[key] === 'number' && typeof second[key] === 'number') usage[key] = first[key] + second[key];
    }
    return usage;
}

function safeErrorMessage(error) {
    return String(error?.message || error)
        .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+|rt_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, '[redacted]')
        .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
}

/** Return actual image bytes in the tool result, independently of the inline-media setting. */
async function imageToolResult(call, image) {
    const [, mime, base64] = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.image_url.url) || [];
    if (!base64) throw new Error('Generated image could not be returned to Claude.');
    const source = { type: 'base64', media_type: mime, data: base64 };
    return {
        type: 'tool_result', tool_use_id: call.id,
        content: [
            { type: 'image', source },
            { type: 'text', text: 'The generated image is attached to your reply. Continue your response using this image and the conversation context, without repeating text you already wrote. Do not generate another image.' },
        ],
    };
}

/** Add the server-owned tool without changing the user's other tools. */
export function addClaudeImageTool(tools, description = '') {
    if (tools.some(tool => tool.name === IMAGE_TOOL_NAME)) throw new Error('Image tool name conflicts with an extension tool.');
    if (typeof description !== 'string' || description.length > 8000) throw new Error('Image tool description must be at most 8000 characters.');
    tools.push({ name: IMAGE_TOOL_NAME, description: description.trim() || IMAGE_TOOL.description, input_schema: structuredClone(IMAGE_TOOL.parameters) });
}

/** Intercept only our image calls; preserve Claude's native text, thinking and extension tools. */
export async function sendClaudeImageResponse(upstream, response, manager, controller, streaming, continueReply = null) {
    const requestId = crypto.randomUUID();
    const abort = () => controller.abort();
    response.once('close', abort);
    // An async socket write error is an EventEmitter error, not a rejected
    // fetch. Keep this handler through final flushing/close, including errors
    // that arrive after this function returns.
    response.on('error', error => controller.abort(error));
    let heartbeat;
    let continuation;
    let warning;
    const writeRaw = async chunk => {
        controller.signal.throwIfAborted();
        if (response.destroyed || response.writableEnded) throw new Error('Client response is closed.');
        // compression() wraps write() without forwarding callbacks. Waiting for
        // one deadlocks on the first event when HTTP compression is negotiated.
        // Use stream backpressure; the response error handler above catches EPIPE.
        if (!response.write(chunk)) {
            await once(response, 'drain', { signal: controller.signal });
        }
    };
    const write = event => writeRaw(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const generate = async (calls, onImage) => {
        if (calls.length > 4) throw new Error('At most four images can be generated per response.');
        // Validate every job before making the first billable request.
        const jobs = calls.map(call => buildImageGenerationRequest(call));
        for (const [index, job] of jobs.entries()) {
            console.info(`[Claude images ${requestId}] Claude called ${IMAGE_TOOL_NAME} (${index + 1}/${jobs.length})`, { prompt: job.prompt, size: job.size });
        }
        if (streaming && jobs.length) heartbeat = setInterval(() => {
            if (!response.destroyed && !response.writableEnded && !response.writableNeedDrain) {
                void writeRaw(': Generating image\n\n').catch(abort);
            }
        }, 15000);
        for (const [index, job] of jobs.entries()) {
            console.info(`[Claude images ${requestId}] Generating image ${index + 1}/${jobs.length} using Codex`);
            const image = await generateInlineImage(manager, job, controller.signal, requestId);
            console.info(`[Claude images ${requestId}] Image ${index + 1}/${jobs.length} received from GPT Image 2`);
            await onImage(image);
        }
    };
    const continueWithImages = async (message, images) => {
        const calls = message.content.filter(block => block.type === 'tool_use');
        if (calls.some(call => call.name !== IMAGE_TOOL_NAME)) throw new Error('Claude returned parallel tools despite single-tool mode. Retry image generation.');
        try {
            const results = await Promise.all(calls.map((call, index) => imageToolResult(call, images[index])));
            controller.signal.throwIfAborted();
            console.info(`[Claude images ${requestId}] Returning ${images.length} generated image(s) to Claude for reply continuation`);
            continuation = await continueReply(message, results);
            if (!continuation.ok) {
                const error = await continuation.json().catch(() => null);
                throw new Error(`Claude image continuation failed (HTTP ${continuation.status}): ${error?.error?.message || 'No error details returned.'}`);
            }
            return continuation;
        } catch (error) {
            controller.signal.throwIfAborted();
            // Generation has already succeeded. A rejected follow-up must not
            // discard the original text/images or turn them into a failed turn.
            warning = `Image generated, but Claude could not continue the reply. ${safeErrorMessage(error)}`;
            console.warn(`[Claude images ${requestId}] ${warning}`);
            return null;
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
            if (continueReply && calls.length && message.content.some(block => block.type === 'tool_use' && block.name !== IMAGE_TOOL_NAME)) {
                throw new Error('Claude returned parallel tools despite single-tool mode. Retry image generation.');
            }
            const content = message.content.filter(block => !calls.includes(block));
            let text = content.filter(block => block.type === 'text').map(block => block.text).join('');
            const images = [];
            await generate(calls.map(call => JSON.stringify(call.input)), image => { images.push(image); });
            let usage = message.usage;
            if (continueReply && calls.length) {
                const result = await continueWithImages(message, images);
                const followup = result ? await result.json() : null;
                if (followup) {
                    if (followup.error || !Array.isArray(followup.content) || followup.content.some(block => block.type === 'tool_use')) {
                        throw new Error('Claude returned an invalid image continuation.');
                    }
                    if (text && followup.content.some(block => block.type === 'text' && block.text)) content.push({ type: 'text', text: '\n\n' });
                    content.push(...followup.content);
                    text = content.filter(block => block.type === 'text').map(block => block.text).join('');
                    usage = combinedUsage(usage, followup.usage);
                    console.info(`[Claude images ${requestId}] Claude reply continuation completed`);
                }
            }
            if (images.length && !text) {
                text = 'Generated image.';
                content.push({ type: 'text', text });
            }
            return response.json({ choices: [{ message: { content: text, images } }], content, usage, ...(warning ? { warning } : {}) });
        }

        response.setHeader('Content-Type', 'text/event-stream');
        // Deliver each SSE event immediately instead of buffering it in a codec.
        response.setHeader('Cache-Control', 'no-cache, no-transform');
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
        const original = {};
        let usage = {};
        for await (const event of parseCodexEvents(upstream.body)) {
            if (event.type === 'error') throw new Error(event.error?.message || 'Claude stream failed.');
            // Capture before hiding image calls or renumbering blocks. Signed thinking
            // and tool arguments must be replayed in their original order, unmodified.
            if (continueReply) captureClaudeContent(event, original);
            usage = { ...usage, ...(event.message?.usage || event.usage) };
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
        if (continueReply && calls.size && (externalTools || original.claudeContentInvalid)) {
            throw new Error('Claude image request could not be safely continued. Retry image generation.');
        }
        const images = [];
        await generate([...calls.values()].map(call => call.arguments || JSON.stringify(call.input)), async image => {
            images.push(image);
            await write({ type: 'sillytavern_images', delta: { images: [image], text: hasText || continueReply ? '' : 'Generated image.' } });
            if (!continueReply) hasText = true;
        });
        if (continueReply && calls.size) {
            const followup = await continueWithImages({ content: original.claudeContent.filter(Boolean) }, images);
            if (!followup) {
                await write({ type: 'sillytavern_warning', message: warning });
                if (!hasText) await write({ type: 'sillytavern_images', delta: { images: [], text: 'Generated image.' } });
                for (const event of finalEvents) await write(event);
                response.end();
                return;
            }
            let followupUsage = {};
            let finished = false;
            let needsSeparator = hasText;
            const followupIndexes = new Map();
            for await (const event of parseCodexEvents(followup.body)) {
                if (event.type === 'error') throw new Error(event.error?.message || 'Claude image continuation failed.');
                followupUsage = { ...followupUsage, ...(event.message?.usage || event.usage) };
                if (event.type === 'message_start') continue;
                if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                    throw new Error('Claude requested a tool while finishing the image reply.');
                }
                if (event.type === 'content_block_start' && event.content_block?.type === 'text' && needsSeparator) {
                    await write({ type: 'content_block_start', index: nextIndex, content_block: { type: 'text', text: '' } });
                    await write({ type: 'content_block_delta', index: nextIndex, delta: { type: 'text_delta', text: '\n\n' } });
                    await write({ type: 'content_block_stop', index: nextIndex });
                    nextIndex++;
                    needsSeparator = false;
                }
                if (event.type === 'content_block_start') followupIndexes.set(event.index, nextIndex++);
                if (followupIndexes.has(event.index)) event.index = followupIndexes.get(event.index);
                if (event.type === 'message_delta') event.usage = combinedUsage(usage, followupUsage);
                await write(event);
                if (event.type === 'message_stop') { finished = true; break; }
            }
            if (!finished) throw new Error('Claude image continuation ended before the response completed.');
            console.info(`[Claude images ${requestId}] Claude reply continuation completed`);
        } else {
            for (const event of finalEvents) await write(event);
        }
        response.end();
    } catch (error) {
        if (!controller.signal.aborted && !response.destroyed) {
            const message = safeErrorMessage(error);
            console.error(`[Claude images ${requestId}] ${message}`);
            try {
                if (response.headersSent) {
                    await write({ type: 'error', error: { message } });
                    response.end();
                } else response.status(502).json({ error: { message } });
            } catch {
                // The peer can disconnect while we are reporting the error.
                controller.abort();
                response.destroy();
            }
        }
    } finally {
        clearInterval(heartbeat);
        upstream.body?.destroy();
        continuation?.body?.destroy();
    }
}
