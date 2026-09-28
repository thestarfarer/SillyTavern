import { recordFullscreenEvent } from './fullscreen-diagnostics.js';

/** Restore browser-dropped fullscreen on a fresh interaction after app return. */
export function initFullscreenResume() {
    const root = document.documentElement;
    let wanted = document.fullscreenElement === root;
    let backgrounded = false;
    let requesting = false;
    let revision = 0;
    let exitTimer;

    function cancelExitTimer() {
        clearTimeout(exitTimer);
        exitTimer = undefined;
    }

    function setIntent(value = false) {
        cancelExitTimer();
        wanted = value;
        backgrounded = false;
        revision++;
        recordFullscreenEvent('intent', { wanted });
    }

    function markBackground() {
        cancelExitTimer();
        backgrounded = wanted;
        recordFullscreenEvent('background', { wanted, backgrounded });
    }

    async function restore(source) {
        if (document.hidden) return;
        if (document.fullscreenElement === root) {
            backgrounded = false;
            return;
        }
        if (!wanted || !backgrounded || requesting || document.fullscreenElement) return;
        if (document.fullscreenEnabled === false || typeof root.requestFullscreen !== 'function') {
            setIntent(false);
            return;
        }
        // Do not start an inevitably denied request that could occupy the next
        // touch gesture. Older browsers without this API may still try on return.
        if (navigator.userActivation?.isActive === false) return;
        const attempt = revision;
        requesting = true;
        recordFullscreenEvent('restore-request', { source });
        try {
            await root.requestFullscreen();
            // The menu or Escape may have cancelled an in-flight request.
            if (attempt !== revision && !wanted && document.fullscreenElement === root) {
                await document.exitFullscreen();
            }
            recordFullscreenEvent('restore-result', { source });
        } catch (error) {
            recordFullscreenEvent('restore-rejected', { source, name: error.name, message: error.message });
            console.debug('[Fullscreen] Restore rejected:', source, error.name, error.message);
            // Keep intent for the next trusted gesture, without repeated toasts.
        } finally {
            requesting = false;
        }
    }

    document.addEventListener('fullscreenchange', () => {
        recordFullscreenEvent('fullscreenchange');
        cancelExitTimer();
        if (document.fullscreenElement === root) {
            if (!requesting || wanted) {
                wanted = true;
                backgrounded = false;
            }
        } else if (document.fullscreenElement) {
            setIntent(false);
        } else if (document.hidden) {
            markBackground();
        } else if (wanted && !backgrounded) {
            // Gecko can deliver fullscreen loss BEFORE visibilitychange. Allow
            // that notification to arrive, but never restore from this grace
            // period alone: Back/browser UI exits must remain exits.
            exitTimer = setTimeout(() => {
                if (document.hidden) markBackground();
                else setIntent(false);
            }, 1500);
        }
    });

    window.addEventListener('blur', () => recordFullscreenEvent('blur'));
    window.addEventListener('focus', () => {
        recordFullscreenEvent('focus');
        void restore('focus');
    });
    window.addEventListener('pagehide', markBackground);
    window.addEventListener('pageshow', () => {
        recordFullscreenEvent('pageshow');
        void restore('pageshow');
    });
    document.addEventListener('visibilitychange', () => {
        recordFullscreenEvent('visibilitychange');
        if (document.hidden) markBackground();
        else void restore('visibilitychange');
    });

    function onInteraction(event) {
        if (!event.isTrusted) return;
        if (event.type === 'keydown' && event.key === 'Escape') {
            setIntent(false);
            return;
        }
        if (event.type === 'pointerup' && event.pointerType === 'mouse') return;
        if (wanted && (backgrounded || exitTimer !== undefined)) recordFullscreenEvent(event.type);
        // A real foreground interaction after an unclassified exit confirms
        // that it was not an app switch. Respect that exit immediately.
        if (exitTimer !== undefined && !backgrounded) setIntent(false);
        // The menu action owns its request; don't race it on touchend/click.
        if (event.target instanceof Element && event.target.closest('#option_fullscreen, #option_fullscreen_diagnostics')) return;
        void restore(event.type);
    }

    for (const type of ['pointerup', 'touchend', 'click', 'keydown']) {
        document.addEventListener(type, onInteraction, { capture: true, passive: true });
    }
    return setIntent;
}
