/** Server-executed image tool shared by Claude, Codex and OpenAI requests. */
export const IMAGE_TOOL_NAME = 'sillytavern_generate_image';

export const IMAGE_TOOL = {
    type: 'function', name: IMAGE_TOOL_NAME,
    description: 'Generate a picture to display directly in your chat reply. Use when the user requests a picture, illustration, selfie, or visual depiction. Write a complete, detailed image prompt using the conversation context. The resulting picture is attached automatically; do not invent image URLs. This tool creates new images from text, not pixel-faithful edits of attachments.',
    strict: true,
    parameters: {
        type: 'object', additionalProperties: false,
        properties: {
            prompt: { type: 'string', description: 'A detailed description of the image to create.' },
            size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
        },
        required: ['prompt', 'size'],
    },
};

/** Validate tool arguments locally before making a billable image request. */
export function buildImageGenerationRequest(argumentsJson) {
    let args;
    try { args = JSON.parse(argumentsJson); } catch { throw new Error('Image generation returned invalid tool arguments.'); }
    if (!args || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000) {
        throw new Error('Image generation requires a prompt between 1 and 32000 characters.');
    }
    if (!IMAGE_TOOL.parameters.properties.size.enum.includes(args.size)) throw new Error('Invalid generated image size.');
    return { model: 'gpt-image-2', prompt: args.prompt, size: args.size, quality: 'auto', n: 1 };
}

/** Only accept raster image bytes, never an upstream URL or executable document. */
export function generatedImageDataUrl(base64) {
    if (typeof base64 !== 'string' || base64.length > 64 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new Error('Image generation returned invalid image data.');
    }
    const bytes = Buffer.from(base64, 'base64');
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new Error('Image generation returned an unsupported image format.');
    return `data:${mime};base64,${base64}`;
}

/** Execute a validated image job using the caller's authenticated transport. */
export async function generateInlineImage(manager, job, signal, requestId, onResponse = () => {}) {
    signal.throwIfAborted();
    const result = await manager.apiRequest('/images/generations', {
        method: 'POST', signal, size: 64 * 1024 * 1024,
        headers: { 'Content-Type': 'application/json', 'x-codex-image-turn-id': requestId },
        body: JSON.stringify(job),
    });
    onResponse(result);
    let data;
    try { data = await result.json(); } catch { throw new Error(`Image generation returned invalid JSON (HTTP ${result.status}).`); }
    if (!result.ok || data?.error) {
        const error = data?.error;
        const detail = String((typeof error === 'string' ? error : error?.message) || data?.detail || 'Check your image access and usage limits.')
            .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+|rt_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, '[redacted]')
            .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
        throw new Error(`Image generation failed (HTTP ${result.status}): ${detail}`);
    }
    if (!Array.isArray(data?.data) || data.data.length !== 1) throw new Error('Image generation returned no image or an unexpected image count.');
    return { type: 'image_url', image_url: { url: generatedImageDataUrl(data.data[0].b64_json) } };
}
