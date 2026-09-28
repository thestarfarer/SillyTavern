import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';

/** @type {Popup} */
let loaderPopup;

let preloaderYoinked = false;

export function showLoader() {
    // Two loaders don't make sense. Don't await, we can overlay the old loader while it closes
    if (loaderPopup) loaderPopup.complete(POPUP_RESULT.CANCELLED);

    loaderPopup = new Popup(`
        <div id="loader">
            <div id="load-spinner" role="status" aria-label="Loading">
                <svg class="pressure-hatch" viewBox="0 0 180 216" aria-hidden="true" focusable="false">
                    <!-- Stationary frame, gasket and recessed door. -->
                    <rect class="hatch-frame" x="23" y="8" width="134" height="200" rx="44" />
                    <rect class="hatch-seal" x="31" y="16" width="118" height="184" rx="37" />
                    <rect class="hatch-door" x="37" y="22" width="106" height="172" rx="32" />
                    <path class="hatch-detail" d="M49 58V53a22 22 0 0 1 22-22h38" />
                    <g class="hatch-hinges">
                        <rect x="16" y="56" width="24" height="22" rx="5" />
                        <rect x="16" y="140" width="24" height="22" rx="5" />
                        <path d="M24 59v16m0 68v16" />
                    </g>
                    <g class="hatch-bolts">
                        <circle cx="58" cy="18" r="2" /><circle cx="122" cy="18" r="2" />
                        <circle cx="29" cy="96" r="2" /><circle cx="151" cy="96" r="2" />
                        <circle cx="29" cy="120" r="2" /><circle cx="151" cy="120" r="2" />
                        <circle cx="58" cy="198" r="2" /><circle cx="122" cy="198" r="2" />
                    </g>
                    <!-- Locking rods stay still while the handwheel turns. -->
                    <path class="hatch-rods" d="M90 73V59m0 89v26M58 91l-12-7m76 7 12-7M58 129l-12 7m76-7 12 7" />
                    <path class="hatch-dogs" d="M83 59h14m-14 115h14M43 79l6 10m82-10 6 10M43 131l6 10m82-10 6 10" />
                    <circle class="hatch-wheel-base" cx="90" cy="110" r="39" />
                    <g class="hatch-handwheel">
                        <circle cx="90" cy="110" r="31" />
                        <path d="M90 79v62m-27-46 54 30m-54 0 54-30" />
                        <circle class="hatch-grip" cx="90" cy="79" r="5" />
                    </g>
                    <circle class="hatch-hub" cx="90" cy="110" r="9" />
                    <circle class="hatch-hub-pin" cx="90" cy="110" r="3" />
                </svg>
            </div>
        </div>`, POPUP_TYPE.DISPLAY, null, { transparent: true, animation: 'none', wide: true, large: true });

    // No close button, loaders are not closable
    loaderPopup.closeButton.style.display = 'none';

    loaderPopup.show();
}

export async function hideLoader() {
    if (!loaderPopup) {
        console.warn('There is no loader showing to hide');
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const spinner = $('#load-spinner');
        if (!spinner.length) {
            console.warn('Spinner element not found, skipping animation');
            cleanup();
            return;
        }

        // Check if transitions are enabled
        const transitionDuration = spinner[0] ? getComputedStyle(spinner[0]).transitionDuration : '0s';
        const hasTransitions = parseFloat(transitionDuration) > 0;

        if (hasTransitions) {
            Promise.race([
                new Promise((r) => setTimeout(r, 500)), // Fallback timeout
                new Promise((r) => spinner.one('transitionend webkitTransitionEnd oTransitionEnd MSTransitionEnd', r)),
            ]).finally(cleanup);
        } else {
            cleanup();
        }

        function cleanup() {
            $('#loader').remove();
            // Yoink preloader entirely; it only exists to cover up unstyled content while loading JS
            // If it's present, we remove it once and then it's gone.
            yoinkPreloader();

            loaderPopup.complete(POPUP_RESULT.AFFIRMATIVE)
                .catch((err) => console.error('Error completing loaderPopup:', err))
                .finally(() => {
                    loaderPopup = null;
                    resolve();
                });
        }

        // Apply the styles
        spinner.css({
            'filter': 'blur(15px)',
            'opacity': '0',
        });
    });
}

function yoinkPreloader() {
    if (preloaderYoinked) return;
    document.getElementById('preloader').remove();
    preloaderYoinked = true;
}
