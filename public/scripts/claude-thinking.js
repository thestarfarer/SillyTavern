// Preserve Anthropic content blocks verbatim: a signature authenticates the
// thinking block, not the rendered/edited reasoning text shown by Tavern.
const PREFIX = 'claude-content-v1:';

export function serializeClaudeContent(content) {
    if (!Array.isArray(content) || !content.some(block =>
        (block?.type === 'thinking' && typeof block.signature === 'string' && block.signature)
        || (block?.type === 'redacted_thinking' && typeof block.data === 'string'))) return null;
    return PREFIX + JSON.stringify(content);
}

export function captureClaudeContent(event, state) {
    if (event.type === 'message_start') {
        state.claudeContent = [];
        state.claudeInputs = {};
        state.claudeContentInvalid = false;
    }
    if (!state.claudeContent) return;
    // The image bridge replaces a native tool call with an attached image. Its
    // rewritten reply is no longer the original signed content sequence.
    if (event.type === 'sillytavern_images') state.claudeContentInvalid = true;
    if (event.type === 'content_block_start') {
        state.claudeContent[event.index] = structuredClone(event.content_block);
    }
    const block = state.claudeContent[event.index];
    if (event.type === 'content_block_delta' && block) {
        const delta = event.delta;
        if (delta?.type === 'text_delta') block.text = (block.text || '') + delta.text;
        else if (delta?.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
        else if (delta?.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
        else if (delta?.type === 'input_json_delta') state.claudeInputs[event.index] = (state.claudeInputs[event.index] || '') + delta.partial_json;
        else if (delta?.type === 'citations_delta') (block.citations ??= []).push(delta.citation);
        else state.claudeContentInvalid = true;
    }
    if (event.type === 'content_block_stop' && state.claudeInputs[event.index]) {
        try {
            block.input = JSON.parse(state.claudeInputs[event.index]);
        } catch {
            state.claudeContentInvalid = true;
        }
    }
    if (event.type === 'message_stop' && !state.claudeContentInvalid) {
        state.signature = serializeClaudeContent(state.claudeContent.filter(Boolean)) || '';
    }
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.every(block => block.type === 'text')) return content.map(block => block.text).join('');
    return content == null ? '' : null;
}

/** Restore only an unchanged reply or tool call from the same model's saved signature. */
export function restoreClaudeContent(message, previousMessage) {
    if (message.role !== 'assistant' || typeof message.signature !== 'string' || !message.signature.startsWith(PREFIX)) return null;
    try {
        const content = JSON.parse(message.signature.slice(PREFIX.length));
        if (!serializeClaudeContent(content)) return null;
        const calls = content.filter(block => block.type === 'tool_use');
        const text = content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (calls.length) {
            if (calls.length !== message.tool_calls?.length || !calls.every((block, index) => {
                const call = message.tool_calls[index];
                const input = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
                return block.id === call.id && block.name === call.function.name && JSON.stringify(block.input) === JSON.stringify(input);
            })) return null;
            // Tavern stores the visible reply and its tool invocations separately.
            // Fold the duplicate reply back into the original ordered content array.
            if (previousMessage?.role === 'assistant') {
                if (textOf(previousMessage.content) !== text) return null;
                return { content, replacePrevious: true };
            }
            return { content, replacePrevious: false };
        }
        if (message.tool_calls?.length || textOf(message.content) !== text) return null;
        return { content, replacePrevious: false };
    } catch {
        return null;
    }
}
