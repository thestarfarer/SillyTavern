/** Codex Responses transport adapted to SillyTavern's Chat Completions format. */
import crypto from 'node:crypto';
import { once } from 'node:events';
import { getCodexOAuthManager } from '../codex-oauth.js';
import { IMAGE_TOOL, IMAGE_TOOL_NAME, buildImageGenerationRequest, generateInlineImage } from './inline-image-generation.js';

// Protocol compatibility version, not the identity of this client.
const CLIENT_VERSION = '0.153.4';

export function getCodexPromptCacheKey(userScope, chatId) {
    if (chatId === undefined || chatId === null || chatId === '') return undefined;
    if (typeof chatId !== 'string' || chatId.length > 4096) throw new Error('Invalid Codex chat cache identity.');
    // Stable across turns/restarts; no raw chat names or user paths go upstream.
    return crypto.createHash('sha256').update(JSON.stringify(['sillytavern-codex', userScope, chatId])).digest('hex');
}

export function buildCodexRequest(body, userScope = '') {
    if (!Array.isArray(body.messages)) throw new Error('Codex requires chat messages.');
    if (!body.model) throw new Error('Select a Codex model first.');
    if (Number(body.n) > 1) throw new Error('Codex and image-enabled requests support one response at a time. Set number of responses to 1.');
    const input = [];
    for (const message of body.messages) {
        if (message.role === 'tool') {
            input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
            continue;
        }
        const role = message.role === 'system' ? 'developer' : message.role;
        if (!['developer', 'user', 'assistant'].includes(role)) throw new Error(`Unsupported Codex message role: ${role}`);
        const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content || []);
        const content = parts.map(part => {
            if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
            if (part.type === 'image_url' && ['user', 'assistant'].includes(role)) return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
            throw new Error(`Unsupported Codex content type: ${part.type}`);
        });
        if (message.name && content.length) {
            const text = content.find(part => 'text' in part);
            if (text) text.text = `${message.name}: ${text.text}`;
        }
        if (role === 'assistant' && content.some(part => part.type === 'input_image')) {
            const text = content.filter(part => part.type !== 'input_image');
            if (text.length) input.push({ role, content: text });
            // Generated attachments are visual context, not assistant output_text parts.
            input.push({ role: 'user', content: [
                { type: 'input_text', text: 'Image from an earlier assistant reply:' },
                ...content.filter(part => part.type === 'input_image'),
            ] });
        } else if (content.length) input.push({ role, content });
        for (const call of message.tool_calls || []) {
            input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
    }
    const request = { model: body.model, instructions: '', input, store: false, stream: true };
    const cacheKey = getCodexPromptCacheKey(userScope, body.codex_cache_id);
    if (cacheKey) request.prompt_cache_key = cacheKey;
    if (body.tools?.length) {
        request.tools = body.tools.map(tool => {
            if (tool.type !== 'function') throw new Error('Codex supports function tools in this integration.');
            return { type: 'function', ...tool.function, strict: tool.function.strict ?? false };
        });
        request.tool_choice = typeof body.tool_choice === 'object'
            ? { type: 'function', name: body.tool_choice.function.name } : (body.tool_choice || 'auto');
        request.parallel_tool_calls = body.parallel_tool_calls ?? true;
    }
    if (body.reasoning_effort && body.reasoning_effort !== 'auto') request.reasoning = { effort: body.reasoning_effort === 'min' ? 'minimal' : body.reasoning_effort };
    if (body.include_reasoning) request.reasoning = { ...request.reasoning, summary: 'auto' };
    if (body.verbosity && body.verbosity !== 'auto') request.text = { verbosity: body.verbosity };
    if (body.json_schema?.value) {
        request.text = { ...request.text, format: { type: 'json_schema', name: body.json_schema.name || 'response', schema: body.json_schema.value, strict: body.json_schema.strict ?? true } };
    }
    if (body.openai_image_generation === true) {
        if (request.tools?.some(tool => tool.name === IMAGE_TOOL_NAME)) throw new Error('Image tool name conflicts with an extension tool.');
        request.tools = [...(request.tools || []), structuredClone(IMAGE_TOOL)];
        request.tool_choice ??= 'auto';
    }
    // Codex does not accept Chat Completions sampling, stop, or max_tokens fields.
    return request;
}

/** Parse SSE across arbitrary byte boundaries, including CRLF and multibyte text. */
export async function* parseCodexEvents(stream) {
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        return data && data !== '[DONE]' ? JSON.parse(data) : null;
    };
    for await (const chunk of stream) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const event = parse(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
            if (event) yield event;
        }
        if (buffer.length > 16 * 1024 * 1024) throw new Error('Codex stream event exceeded the size limit.');
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
        const event = parse(buffer);
        if (event) yield event;
    }
}

// Only structured error text is surfaced; never log raw response bodies or credentials.
function safeDiagnostic(value) {
    return String(value || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|rt_[A-Za-z0-9_-]+)/g, '[redacted]')
        .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
}

function upstreamMessage(data) {
    const error = data?.error || data?.response?.error;
    return safeDiagnostic(typeof error === 'string' ? error : error?.message || data?.detail || data?.message);
}

function responseMetadata(response) {
    return `HTTP ${response.status}; content-type=${safeDiagnostic(response.headers.get('content-type')) || 'missing'}; request-id=${safeDiagnostic(response.headers.get('x-request-id') || response.headers.get('cf-ray')) || 'missing'}`;
}

/** Read the wire format instead of assuming the Content-Type header is reliable. */
export async function* readCodexResponseEvents(response) {
    if (!response.body) throw new Error(`Codex returned an empty body (${responseMetadata(response)}).`);
    const iterator = response.body[Symbol.asyncIterator]();
    const decoder = new TextDecoder();
    let prefix = '';
    const buffered = [];
    let ended = false;
    try {
        while (true) {
            const next = await iterator.next();
            if (next.done) { ended = true; break; }
            buffered.push(next.value);
            prefix += typeof next.value === 'string' ? next.value : decoder.decode(next.value, { stream: true });
            const start = prefix.trimStart();
            if (/^(?:(?:data|event|id|retry):|:|[<{[])/.test(start) || start.includes('\n') || prefix.length >= 1024) break;
        }
        if (/^\s*(?:(?:data|event|id|retry):|:)/.test(prefix) && response.ok) {
            async function* replay() {
                yield* buffered;
                while (!ended) {
                    const next = await iterator.next();
                    if (next.done) break;
                    yield next.value;
                }
            }
            yield* parseCodexEvents(replay());
            return;
        }
        // Accept completed JSON responses and surface structured upstream errors.
        if (/^\s*(?:\[|\{)/.test(prefix)) {
            if (prefix.length > 16 * 1024 * 1024) throw new Error('Codex JSON response exceeded the size limit.');
            while (!ended) {
                const next = await iterator.next();
                if (next.done) break;
                prefix += typeof next.value === 'string' ? next.value : decoder.decode(next.value, { stream: true });
                if (prefix.length > 16 * 1024 * 1024) throw new Error('Codex JSON response exceeded the size limit.');
            }
            prefix += decoder.decode();
            let data;
            try { data = JSON.parse(prefix); } catch { throw new Error(`Codex returned invalid JSON (${responseMetadata(response)}).`); }
            const message = upstreamMessage(data);
            if (!response.ok || data.error || data.detail || data.type === 'error' || data.response?.error) {
                throw new Error(`Codex: ${message || 'Upstream request failed'} (${responseMetadata(response)}).`);
            }
            const result = data.type === 'response.completed' ? data.response : data;
            if (!result || typeof result !== 'object') throw new Error(`Codex returned JSON without a response (${responseMetadata(response)}).`);
            if (result.status === 'failed' || result.status === 'incomplete') {
                throw new Error(`Codex: ${message || result.incomplete_details?.reason || result.status} (${responseMetadata(response)}).`);
            }
            if (!Array.isArray(result.output) || (result.status !== 'completed' && data.type !== 'response.completed')) {
                throw new Error(`Codex returned JSON without a completed response (${responseMetadata(response)}).`);
            }
            yield { type: 'response.created', response: result };
            for (const [output_index, item] of result.output.entries()) {
                if (item.type === 'function_call') yield { type: 'response.output_item.added', output_index, item };
                if (item.type === 'message') {
                    for (const part of item.content || []) {
                        if (part.type === 'output_text') yield { type: 'response.output_text.delta', delta: part.text };
                        if (part.type === 'refusal') yield { type: 'response.refusal.delta', delta: part.refusal };
                    }
                }
                if (item.type === 'reasoning') {
                    for (const part of item.summary || []) {
                        if (part.type === 'summary_text') yield { type: 'response.reasoning_summary_text.delta', delta: part.text };
                    }
                }
            }
            yield { type: 'response.completed', response: result };
            return;
        }
        const format = !prefix.trim() ? 'an empty body' : /^\s*</.test(prefix) ? 'HTML instead of a model response' : 'an unrecognized body';
        throw new Error(`Codex returned ${format} (${responseMetadata(response)}).`);
    } finally {
        await iterator.return?.();
    }
}

export class CodexResponseAdapter {
    constructor(model, imageGenerationEnabled = false) {
        this.id = `chatcmpl-${crypto.randomUUID()}`;
        this.model = model;
        this.created = Math.floor(Date.now() / 1000);
        this.text = '';
        this.reasoning = '';
        this.tools = new Map();
        this.imageCalls = new Map();
        this.images = [];
        this.imageGenerationEnabled = imageGenerationEnabled;
        this.finished = false;
        this.finishReason = 'stop';
    }

    chunk(delta, finishReason = null) {
        return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
    }

    consume(event) {
        const chunks = [];
        switch (event.type) {
            case 'response.created':
                this.id = event.response?.id || this.id;
                chunks.push(this.chunk({ role: 'assistant', content: '' }));
                break;
            case 'response.output_text.delta':
            case 'response.refusal.delta':
                this.text += event.delta || '';
                chunks.push(this.chunk({ content: event.delta || '' }));
                break;
            case 'response.reasoning_summary_text.delta':
                this.reasoning += event.delta || '';
                chunks.push(this.chunk({ reasoning_content: event.delta || '' }));
                break;
            case 'response.output_item.added':
                if (event.item?.type === 'function_call') {
                    if (this.imageGenerationEnabled && event.item.name === IMAGE_TOOL_NAME) {
                        if (this.imageCalls.size >= 4) throw new Error('At most four images can be generated per response.');
                        this.imageCalls.set(event.output_index, { ...event.item, arguments: event.item.arguments || '' });
                        break;
                    }
                    const tool = { index: this.tools.size, id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: event.item.arguments || '' } };
                    this.tools.set(event.output_index, tool);
                    chunks.push(this.chunk({ tool_calls: [structuredClone(tool)] }));
                }
                break;
            case 'response.output_item.done': {
                if (event.item?.type !== 'function_call') break;
                if (this.imageGenerationEnabled && event.item.name === IMAGE_TOOL_NAME) {
                    if (!this.imageCalls.has(event.output_index)) this.consume({ ...event, type: 'response.output_item.added' });
                    else this.imageCalls.get(event.output_index).arguments = event.item.arguments || '';
                    break;
                }
                let tool = this.tools.get(event.output_index);
                if (!tool) {
                    chunks.push(...this.consume({ ...event, type: 'response.output_item.added' }));
                    break;
                }
                const complete = event.item.arguments || '';
                if (!complete.startsWith(tool.function.arguments)) throw new Error('Codex returned inconsistent tool arguments.');
                const delta = complete.slice(tool.function.arguments.length);
                if (delta) chunks.push(...this.consume({ type: 'response.function_call_arguments.delta', output_index: event.output_index, delta }));
                break;
            }
            case 'response.function_call_arguments.delta': {
                const imageCall = this.imageCalls.get(event.output_index);
                if (imageCall) {
                    imageCall.arguments += event.delta || '';
                    break;
                }
                const tool = this.tools.get(event.output_index);
                if (!tool) throw new Error('Codex sent arguments for an unknown tool call.');
                tool.function.arguments += event.delta || '';
                chunks.push(this.chunk({ tool_calls: [{ index: tool.index, function: { arguments: event.delta || '' } }] }));
                break;
            }
            case 'error':
            case 'response.failed':
                throw new Error(event.response?.error?.message || event.error?.message || event.message || 'Codex generation failed.');
            case 'response.incomplete':
                throw new Error(`Codex response incomplete: ${event.response?.incomplete_details?.reason || 'unknown reason'}`);
            case 'response.completed': {
                this.finished = true;
                this.finishReason = this.tools.size ? 'tool_calls' : 'stop';
                const usage = event.response?.usage;
                if (usage) {
                    this.usage = {
                        prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0,
                        total_tokens: usage.total_tokens ?? ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
                        prompt_tokens_details: usage.input_tokens_details,
                        completion_tokens_details: usage.output_tokens_details,
                    };
                }
                chunks.push({ ...this.chunk({}, this.finishReason), usage: this.usage });
                break;
            }
        }
        return chunks;
    }

    completion() {
        if (!this.finished) throw new Error('Codex stream ended before the response completed.');
        const message = { role: 'assistant', content: this.text };
        if (this.images.length) message.images = this.images;
        if (this.reasoning) message.reasoning_content = this.reasoning;
        if (this.tools.size) message.tool_calls = [...this.tools.values()].map(({ index, ...tool }) => tool);
        return { id: this.id, object: 'chat.completion', created: this.created, model: this.model, choices: [{ index: 0, message, finish_reason: this.finishReason }], usage: this.usage };
    }
}

export async function sendCodexStatus(request, response) {
    try {
        const result = await getCodexOAuthManager(request.user.directories).apiRequest(`/models?client_version=${CLIENT_VERSION}`, { signal: AbortSignal.timeout(30000) });
        if (!result.ok) {
            result.body?.destroy();
            return response.status(result.status).json({ error: { message: `Codex model discovery failed (HTTP ${result.status}).` } });
        }
        const data = await result.json();
        if (!Array.isArray(data.models)) throw new Error('Codex returned an invalid model list.');
        const models = data.models.filter(model => model.visibility !== 'hide' && model.slug).map(model => ({ id: model.slug, name: model.display_name, context_length: model.context_window, supported_reasoning_levels: model.supported_reasoning_levels, support_verbosity: model.support_verbosity }));
        if (!models.length) throw new Error('No Codex models are available for this account.');
        return response.json({ data: models, codex_oauth: true });
    } catch (error) {
        return response.status(400).json({ error: { message: error.message } });
    }
}

export async function sendCodexRequest(request, response, transport = null) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.on('close', abort);
    let upstream;
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const service = transport ? 'OpenAI' : 'Codex';
    const manager = transport || getCodexOAuthManager(request.user.directories);
    let imageHeartbeat;
    try {
        const body = buildCodexRequest(request.body, request.user.directories.root);
        if (transport) {
            if (request.body.max_tokens) body.max_output_tokens = request.body.max_tokens;
            if (/^gpt-4/.test(body.model)) {
                body.temperature = request.body.temperature;
                body.top_p = request.body.top_p;
            }
        }
        const adapter = new CodexResponseAdapter(body.model, request.body.openai_image_generation === true);
        const imageCount = body.input.reduce((count, item) => count + (item.content?.filter(part => part.type === 'input_image').length || 0), 0);
        console.info(`[${service} ${requestId}] Generate model=${safeDiagnostic(body.model)} messages=${body.input.length} images=${imageCount} stream=${Boolean(request.body.stream)} cache=${Boolean(body.prompt_cache_key)}`);
        upstream = await manager.apiRequest('/responses', {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-client-request-id': requestId },
            body: JSON.stringify(body),
        });
        console.info(`[${service} ${requestId}] Upstream ${responseMetadata(upstream)}`);
        if (request.body.stream) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('X-Accel-Buffering', 'no');
            response.flushHeaders();
        }
        for await (const event of readCodexResponseEvents(upstream)) {
            for (const chunk of adapter.consume(event)) {
                // Keep the response open until server-executed image tools have finished.
                if (adapter.imageCalls.size && chunk.choices[0].finish_reason) continue;
                if (request.body.stream && !response.write(`data: ${JSON.stringify(chunk)}\n\n`)) {
                    await once(response, 'drain', { signal: controller.signal });
                }
            }
            if (adapter.finished) break;
        }
        adapter.completion(); // Reject truncated streams before running any image tools.
        if (adapter.imageCalls.size) {
            // Validate every call before generating the first image.
            const jobs = [...adapter.imageCalls.values()].map(call => buildImageGenerationRequest(call.arguments));
            imageHeartbeat = setInterval(() => {
                if (request.body.stream && !response.destroyed) response.write(': Generating image\n\n');
            }, 15000);
            for (const [index, job] of jobs.entries()) {
                if (controller.signal.aborted) throw new Error('Image generation cancelled.');
                console.info(`[${service} ${requestId}] Generating image ${index + 1}/${jobs.length}`);
                const image = await generateInlineImage(manager, job, controller.signal, requestId,
                    result => console.info(`[${service} ${requestId}] Image upstream ${responseMetadata(result)}`));
                adapter.images.push(image);
                const delta = { images: [image] };
                if (!adapter.text && index === 0) {
                    adapter.text = 'Generated image.';
                    delta.content = adapter.text;
                }
                if (request.body.stream && !response.write(`data: ${JSON.stringify(adapter.chunk(delta))}\n\n`)) {
                    await once(response, 'drain', { signal: controller.signal });
                }
            }
            if (request.body.stream) response.write(`data: ${JSON.stringify({ ...adapter.chunk({}, adapter.finishReason), usage: adapter.usage })}\n\n`);
        }
        const completion = adapter.completion();
        console.info(`[${service} ${requestId}] Completed in ${Date.now() - started}ms; input=${completion.usage?.prompt_tokens ?? 'unknown'} cached=${completion.usage?.prompt_tokens_details?.cached_tokens ?? 'unknown'} output=${completion.usage?.completion_tokens ?? 'unknown'}`);
        if (request.body.stream) response.end('data: [DONE]\n\n');
        else response.json(completion);
    } catch (error) {
        if (controller.signal.aborted || response.destroyed) {
            console.info(`[${service} ${requestId}] Request cancelled after ${Date.now() - started}ms`);
            return;
        }
        const message = safeDiagnostic(error.message);
        console.error(`[${service} ${requestId}] ${message}`);
        const payload = { error: { message } };
        if (response.headersSent) response.end(`data: ${JSON.stringify(payload)}\n\n`);
        else response.status(upstream && !upstream.ok ? upstream.status : 502).json(payload);
    } finally {
        clearInterval(imageHeartbeat);
        response.off('close', abort);
        controller.abort();
        upstream?.body?.destroy();
    }
}
