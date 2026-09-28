/**
 * Track the visible area separately from CSS viewport units: in fullscreen the
 * Android keyboard may resize/pan the visual viewport without resizing 100dvh.
 */
export function initFullscreenViewport() {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = null;

    function update() {
        frame = null;
        if (document.fullscreenElement !== root) {
            root.style.removeProperty('--fullscreen-viewport-height');
            root.style.removeProperty('--fullscreen-viewport-top');
            return;
        }

        // Leave pinch zoom to the browser instead of resizing the chat around it.
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const windowHeight = window.innerHeight;
        const height = Math.min(windowHeight, viewport?.height || windowHeight);
        if (!(height > 0)) return;
        const top = Math.max(0, Math.min(viewport?.offsetTop || 0, windowHeight - height));
        root.style.setProperty('--fullscreen-viewport-height', `${height}px`);
        root.style.setProperty('--fullscreen-viewport-top', `${top}px`);
    }

    function schedule() {
        if (frame === null) frame = window.requestAnimationFrame(update);
    }

    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('fullscreenchange', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    update();
}
