import { recordFullscreenEvent } from './fullscreen-diagnostics.js';

const clearanceKey = 'fullscreen-keyboard-clearance';
const sessionClearance = new Map();

function orientation() {
    return screen.width > screen.height ? 'landscape' : 'portrait';
}

export function getFullscreenKeyboardClearance() {
    if (sessionClearance.has(orientation())) return sessionClearance.get(orientation());
    try {
        const saved = localStorage.getItem(`${clearanceKey}-${orientation()}`);
        if (saved !== null && Number.isFinite(Number(saved))) return Math.max(0, Math.min(160, Number(saved)));
    } catch { /* Storage may be disabled. */ }
    // Compatibility allowance, not a measurement of the keyboard. Android
    // Gecko can report a resized viewport that still extends under the IME.
    return /Android/.test(navigator.userAgent) && /Firefox\//.test(navigator.userAgent) ? 32 : 0;
}

export function setFullscreenKeyboardClearance(value) {
    const clearance = Math.max(0, Math.min(160, Math.round(Number(value) || 0)));
    sessionClearance.set(orientation(), clearance);
    try {
        localStorage.setItem(`${clearanceKey}-${orientation()}`, String(clearance));
    } catch { /* The live adjustment still works without persistent storage. */ }
    window.dispatchEvent(new CustomEvent('fullscreen-keyboard-clearance', { detail: clearance }));
}

/** Follow the visible viewport, including delayed Android keyboard resizing. */
export function initFullscreenViewport() {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = null;
    let settleTimers = [];
    let expandedHeight = 0;
    let viewportWidth = 0;
    let clearance = getFullscreenKeyboardClearance();

    function update() {
        frame = null;
        if (document.fullscreenElement !== root) {
            root.style.removeProperty('--fullscreen-viewport-height');
            root.style.removeProperty('--fullscreen-viewport-top');
            root.style.removeProperty('--fullscreen-keyboard-clearance');
            expandedHeight = 0;
            return;
        }

        // Leave pinch zoom to the browser instead of resizing the chat around it.
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const windowHeight = window.innerHeight;
        const height = Math.min(windowHeight, viewport?.height || windowHeight);
        if (!(height > 0)) return;
        const width = window.innerWidth;
        if (Math.abs(width - viewportWidth) > 1) {
            expandedHeight = 0;
            viewportWidth = width;
            clearance = getFullscreenKeyboardClearance();
        }
        expandedHeight = Math.max(expandedHeight, height);
        // Use actual viewport contraction, not focus: Android can hide its
        // keyboard while leaving the textarea focused (as seen in the trace).
        const keyboardVisible = expandedHeight - height > Math.max(100, expandedHeight * 0.15);
        const inset = keyboardVisible ? Math.min(clearance, height * 0.3) : 0;
        // Panning is independent of resizing. In particular, a nonzero offset
        // can be valid even when innerHeight equals visualViewport.height.
        const top = Math.max(0, viewport?.offsetTop || 0);
        root.style.setProperty('--fullscreen-viewport-height', `${height}px`);
        root.style.setProperty('--fullscreen-viewport-top', `${top}px`);
        root.style.setProperty('--fullscreen-keyboard-clearance', `${inset}px`);
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
    window.addEventListener('fullscreen-keyboard-clearance', event => {
        clearance = event.detail;
        schedule();
    });
    document.addEventListener('visibilitychange', settle);
    document.addEventListener('fullscreenchange', settle);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    update();
}
