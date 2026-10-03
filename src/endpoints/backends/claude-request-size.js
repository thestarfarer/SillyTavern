// Leave room below the Messages API's 32 MB wire-size limit. Base64 counts too.
const REQUEST_BUDGET = 31_000_000;
const IMAGE_BUDGET = 10_000_000;
const PROTECTED_IMAGES = 3;

function sizeError(message) {
    const error = new Error(message);
    error.code = 'CLAUDE_REQUEST_TOO_LARGE';
    return error;
}

function collectImages(body) {
    const images = [];
    function collect(content) {
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (block.type === 'image') images.push(block);
            else if (block.type === 'tool_result') collect(block.content);
        }
    }
    for (const message of body.messages || []) collect(message.content);
    return images;
}

function isInlineImage(block) {
    return block.source?.type === 'base64' && typeof block.source.data === 'string';
}

/** Bound the complete Claude request, preserving the newest three images verbatim. */
export async function serializeClaudeRequest(body, signal) {
    signal?.throwIfAborted();
    let serialized = JSON.stringify(body);
    let bytes = Buffer.byteLength(serialized);
    const originalBytes = bytes;
    const originals = collectImages(body);
    const oversized = block => isInlineImage(block) && Buffer.byteLength(block.source.data) > IMAGE_BUDGET;
    if (originals.slice(-PROTECTED_IMAGES).some(oversized)) {
        throw sizeError('One of the newest three images exceeds Claude\'s 10 MB encoded-image limit. Resize that attachment or remove it from the prompt. Saved originals have not been changed.');
    }
    if (bytes <= REQUEST_BUDGET && !originals.some(oversized)) return serialized;

    // Copy only for shrinking. Never modify saved originals, signed thinking,
    // tool arguments, message order, or the newest three image blocks.
    const copy = structuredClone(body);
    const images = collectImages(copy).slice(0, -PROTECTED_IMAGES).filter(block => isInlineImage(block)
        && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.source.media_type));
    const fail = () => sizeError(`Claude request cannot fit within ${REQUEST_BUDGET} bytes while keeping the newest three images at full quality (${bytes} bytes currently). Reduce the chat context or inline attachments. Saved originals have not been changed.`);
    // If the text and protected content alone exceed the limit, decoding images
    // cannot help. Fail before allocating pixel buffers or contacting upstream.
    if (!images.length || bytes - images.reduce((sum, block) => sum + Buffer.byteLength(block.source.data), 0) >= REQUEST_BUDGET) throw fail();
    images.sort((a, b) => b.source.data.length - a.source.data.length);
    const { Jimp, JimpMime } = await import('../../jimp.js');
    const changed = new Set();
    for (const [edge, quality] of [[1568, 80], [1024, 65], [768, 50], [512, 40]]) {
        for (const block of images) {
            signal?.throwIfAborted();
            const before = Buffer.byteLength(JSON.stringify(block.source));
            try {
                const picture = await Jimp.read(Buffer.from(block.source.data, 'base64'));
                const scale = Math.min(1, edge / Math.max(picture.bitmap.width, picture.bitmap.height));
                picture.resize({ w: Math.max(1, Math.round(picture.bitmap.width * scale)), h: Math.max(1, Math.round(picture.bitmap.height * scale)) });
                const data = (await picture.getBuffer(JimpMime.jpeg, { quality, jpegColorSpace: 'ycbcr' })).toString('base64');
                const source = { type: 'base64', media_type: 'image/jpeg', data };
                const after = Buffer.byteLength(JSON.stringify(source));
                if (after < before) {
                    block.source = source;
                    bytes -= before - after;
                    changed.add(block);
                }
            } catch {
                // Preserve undecodable images. Try other images, or fail safely.
            }
            signal?.throwIfAborted();
            if (bytes <= REQUEST_BUDGET && !images.some(oversized)) {
                serialized = JSON.stringify(copy);
                bytes = Buffer.byteLength(serialized);
                if (bytes <= REQUEST_BUDGET) {
                    console.info(`[Claude images] Payload ${originalBytes} -> ${bytes} bytes; compressed ${changed.size} older image(s); newest three unchanged`);
                    return serialized;
                }
            }
        }
    }
    throw fail();
}
