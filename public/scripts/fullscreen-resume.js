/**
 * Restore fullscreen after the browser drops it while the app is backgrounded.
 * Browsers may require a new user gesture, so retry on the next real page click.
 * Returns an intent setter for the explicit fullscreen menu action.
 */
export function initFullscreenResume() {
    const root = document.documentElement;
    let wanted = document.fullscreenElement === root;
    let backgrounded = false;
    let blurred = false;
    let requesting = false;
    let revision = 0;

    function setIntent(value = false) {
        wanted = value;
        backgrounded = false;
        revision++;
    }

    async function restore() {
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
        const attempt = revision;
        requesting = true;
        try {
            await root.requestFullscreen();
            // An explicit exit may have arrived while the browser was entering.
            if (attempt !== revision && !wanted && document.fullscreenElement === root) {
                await document.exitFullscreen();
            }
        } catch {
            // A denied automatic request is expected without user activation.
            // Keep the intent and retry from a click; don't repeatedly toast.
        } finally {
            requesting = false;
        }
    }

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === root) {
            // Do not turn a cancelled, still-resolving restore into new intent.
            if (!requesting || wanted) {
                wanted = true;
                backgrounded = false;
            }
        } else if (document.fullscreenElement || (!document.hidden && !blurred && !backgrounded)) {
            setIntent(false);
        }
    });

    window.addEventListener('blur', () => { blurred = true; });
    window.addEventListener('focus', () => {
        blurred = false;
        if (!backgrounded && !document.fullscreenElement) setIntent(false);
        void restore();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            backgrounded = wanted;
        } else {
            void restore();
        }
    });
    document.addEventListener('click', event => {
        // Let the explicit menu action decide, without racing its own request.
        if (event.target instanceof Element && event.target.closest('#option_fullscreen')) return;
        void restore();
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setIntent(false);
    }, true);

    return setIntent;
}
