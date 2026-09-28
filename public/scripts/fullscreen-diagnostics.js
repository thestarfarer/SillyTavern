// A bounded, local-only trace. Never collect input values, chat text or credentials.
const events = [];
const limit = 160;

function bounds(id) {
    const rect = document.getElementById(id)?.getBoundingClientRect();
    return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null;
}

function snapshot() {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    return {
        fullscreen: document.fullscreenElement === root,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        composerFocused: document.activeElement?.id === 'send_textarea',
        activation: navigator.userActivation?.isActive ?? null,
        innerHeight: window.innerHeight,
        clientHeight: root.clientHeight,
        viewport: viewport ? { height: viewport.height, top: viewport.offsetTop, scale: viewport.scale } : null,
        appliedHeight: root.style.getPropertyValue('--fullscreen-viewport-height'),
        appliedTop: root.style.getPropertyValue('--fullscreen-viewport-top'),
        keyboardClearance: root.style.getPropertyValue('--fullscreen-keyboard-clearance'),
        chat: bounds('sheld'),
        form: bounds('form_sheld'),
        input: bounds('send_textarea'),
    };
}

export function recordFullscreenEvent(event, details = {}) {
    events.push({ time: Math.round(performance.now()), event, ...details, ...snapshot() });
    if (events.length > limit) events.shift();
}

export function getFullscreenDiagnostics() {
    return JSON.stringify({
        browser: navigator.userAgent,
        screen: { width: screen.width, height: screen.height, pixelRatio: window.devicePixelRatio },
        current: snapshot(),
        events,
    }, null, 2);
}
