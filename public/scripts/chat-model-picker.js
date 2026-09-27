/** Recent choices first, then available models in dropdown order, without duplicates. */
export function getQuickModelChoices(models, recent = []) {
    const available = new Map(models.map(model => [model.id, model]));
    const ids = [...(Array.isArray(recent) ? recent : []), ...models.map(model => model.id)];
    return [...new Set(ids)].filter(id => available.has(id)).slice(0, 5).map(id => available.get(id));
}

let closePicker = () => {};

export function closeChatModelPicker() {
    closePicker();
}

/** Add a touch/mouse hold menu while retaining the button's normal click action. */
export function initChatModelPicker({ button, getProvider, getModels, getRecent, getSelected, onSelect, onClick }) {
    const menu = document.createElement('div');
    menu.id = 'chat_model_picker';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', menu.id);
    button.setAttribute('aria-expanded', 'false');
    let timer;
    let press;
    let suppressClick = false;
    const cancelHold = () => { clearTimeout(timer); press = null; };
    const close = (restoreFocus = false) => {
        const wasOpen = !menu.hidden;
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        if (wasOpen && restoreFocus) button.focus({ preventScroll: true });
    };
    closePicker = close;
    const position = () => {
        if (menu.hidden) return;
        const viewport = window.visualViewport;
        const minX = (viewport?.offsetLeft || 0) + 8;
        const minY = (viewport?.offsetTop || 0) + 8;
        const maxX = minX + (viewport?.width || window.innerWidth) - 16;
        const maxY = minY + (viewport?.height || window.innerHeight) - 16;
        menu.style.maxWidth = `${Math.max(0, maxX - minX)}px`;
        menu.style.maxHeight = `${Math.max(0, maxY - minY)}px`;
        const anchor = button.getBoundingClientRect();
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(minX, Math.min(anchor.left, maxX - rect.width))}px`;
        const above = anchor.top - rect.height - 8;
        menu.style.top = `${Math.max(minY, Math.min(above >= minY ? above : anchor.bottom + 8, maxY - rect.height))}px`;
    };
    const open = (last = false) => {
        cancelHold();
        close();
        const provider = getProvider();
        const models = getQuickModelChoices(getModels(provider.id), getRecent(provider.id));
        menu.replaceChildren();
        menu.setAttribute('aria-label', provider.name);
        const heading = document.createElement('div');
        heading.className = 'chat_model_picker_heading';
        heading.textContent = provider.name;
        menu.append(heading);
        for (const model of models) {
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', String(model.id === getSelected(provider.id)));
            item.dataset.model = model.id;
            item.textContent = model.label;
            item.title = model.id;
            item.addEventListener('click', () => {
                close(true);
                onSelect(provider.id, model.id);
            });
            menu.append(item);
        }
        if (!models.length) return;
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        position();
        const items = menu.querySelectorAll('button');
        items[last ? items.length - 1 : 0]?.focus({ preventScroll: true });
    };
    button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        cancelHold();
        suppressClick = false;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY };
        timer = setTimeout(() => {
            suppressClick = true;
            open();
        }, 500);
    });
    document.addEventListener('pointermove', event => {
        if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) {
            suppressClick = true;
            cancelHold();
        }
    });
    document.addEventListener('pointerup', event => {
        if (press?.id === event.pointerId) cancelHold();
    });
    document.addEventListener('pointercancel', () => { cancelHold(); suppressClick = true; });
    window.addEventListener('blur', () => { cancelHold(); close(); });
    button.addEventListener('click', event => {
        if (suppressClick) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick = false;
            return;
        }
        suppressClick = false;
        close();
        onClick();
    });
    button.addEventListener('contextmenu', event => {
        event.preventDefault();
        suppressClick = true;
        open();
    });
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') suppressClick = false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open(event.key === 'ArrowUp');
        }
    });
    menu.addEventListener('keydown', event => {
        const items = [...menu.querySelectorAll('button')];
        const index = items.indexOf(document.activeElement);
        let next;
        if (event.key === 'ArrowDown') next = (index + 1) % items.length;
        if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = items.length - 1;
        if (next !== undefined) { event.preventDefault(); items[next].focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        if (event.key === 'Tab') close(true);
    });
    document.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target) && !button.contains(event.target)) close();
    });
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
}
