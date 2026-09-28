import { recordFullscreenEvent } from './fullscreen-diagnostics.js';

/** Follow the visible viewport, including delayed Android keyboard resizing. */
export function initFullscreenViewport() {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = null;
    let settleTimers = [];

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
        // Panning is independent of resizing. In particular, a nonzero offset
        // can be valid even when innerHeight equals visualViewport.height.
        const top = Math.max(0, viewport?.offsetTop || 0);
        root.style.setProperty('--fullscreen-viewport-height', `${height}px`);
        root.style.setProperty('--fullscreen-viewport-top', `${top}px`);
        recordFullscreenEvent('viewport-applied');
    }

    function schedule() {
        if (frame === null) frame = window.requestAnimationFrame(update);
    }

    function settle(event) {
        recordFullscreenEvent(event.type);
        settleTimers.forEach(clearTimeout);
        settleTimers = [];
        schedule();
        // Focus/fullscreen events may precede native keyboard animations, and
        // some Gecko versions miss the final resize. Recheck briefly, not forever.
        if (!document.hidden) {
            settleTimers = [100, 300, 600, 1000].map(delay => setTimeout(schedule, delay));
        }
    }

    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', settle);
    window.addEventListener('pageshow', settle);
    document.addEventListener('visibilitychange', settle);
    document.addEventListener('fullscreenchange', settle);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    update();
}
