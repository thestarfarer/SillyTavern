/** Codex Responses transport adapted to SillyTavern's Chat Completions format. */
import crypto from 'node:crypto';
import { once } from 'node:events';
import { getCodexOAuthManager } from '../codex-oauth.js';

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
    if (Number(body.n) > 1) throw new Error('Codex supports one response per request. Set number of responses to 1.');
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
            if (part.type === 'image_url' && role === 'user') return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
            throw new Error(`Unsupported Codex content type: ${part.type}`);
        });
        if (message.name && content.length) {
            const text = content.find(part => 'text' in part);
            if (text) text.text = `${message.name}: ${text.text}`;
        }
        if (content.length) input.push({ role, content });
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

export class CodexResponseAdapter {
    constructor(model) {
        this.id = `chatcmpl-${crypto.randomUUID()}`;
        this.model = model;
        this.created = Math.floor(Date.now() / 1000);
        this.text = '';
        this.reasoning = '';
        this.tools = new Map();
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
                    const tool = { index: this.tools.size, id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: event.item.arguments || '' } };
                    this.tools.set(event.output_index, tool);
                    chunks.push(this.chunk({ tool_calls: [structuredClone(tool)] }));
                }
                break;
            case 'response.output_item.done': {
                if (event.item?.type !== 'function_call') break;
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

export async function sendCodexRequest(request, response) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.on('close', abort);
    let upstream;
    try {
        const body = buildCodexRequest(request.body, request.user.directories.root);
        const adapter = new CodexResponseAdapter(body.model);
        upstream = await getCodexOAuthManager(request.user.directories).apiRequest('/responses', {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(body),
        });
        if (!upstream.ok) {
            return response.status(upstream.status).json({ error: { message: `Codex request failed (HTTP ${upstream.status}). ${upstream.status === 401 ? 'Sign in again.' : upstream.status === 429 ? 'Your account is rate limited. Try again later.' : 'Check model access and request settings.'}` } });
        }
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Codex returned an unexpected response format.');
        if (request.body.stream) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('X-Accel-Buffering', 'no');
            response.flushHeaders();
        }
        for await (const event of parseCodexEvents(upstream.body)) {
            for (const chunk of adapter.consume(event)) {
                if (request.body.stream && !response.write(`data: ${JSON.stringify(chunk)}\n\n`)) {
                    await once(response, 'drain', { signal: controller.signal });
                }
            }
            if (adapter.finished) break;
        }
        const completion = adapter.completion();
        if (request.body.stream) response.end('data: [DONE]\n\n');
        else response.json(completion);
    } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        const payload = { error: { message: error.message } };
        if (response.headersSent) response.end(`data: ${JSON.stringify(payload)}\n\n`);
        else response.status(400).json(payload);
    } finally {
        response.off('close', abort);
        controller.abort();
        upstream?.body?.destroy();
    }
}
