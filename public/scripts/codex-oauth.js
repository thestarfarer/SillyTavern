import { getRequestHeaders } from '../script.js';
import { Popup } from './popup.js';

export let hasCodexOAuth = false;
let login = null;
let timer;
let apiModelGroups;
let onCredentialsChanged = async () => {};

async function api(endpoint, body, method = 'POST') {
    const response = await fetch(`/api/codex-oauth${endpoint}`, {
        method, headers: getRequestHeaders(), cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Codex authentication failed.');
    return data;
}

function showLogin(next) {
    clearTimeout(timer);
    login = next;
    $('#codex_oauth_login_pending').toggle(Boolean(next));
    $('#codex_oauth_login').prop('disabled', Boolean(next));
    $('#codex_oauth_code').text(next?.userCode || '');
    // Use the known official URL, never an arbitrary link from response data.
    $('#codex_oauth_verification').attr('href', 'https://auth.openai.com/codex/device');
    if (next) timer = setTimeout(pollLogin, Math.max(1, next.interval) * 1000);
}

async function pollLogin() {
    const current = login;
    if (!current) return;
    try {
        if (Date.now() >= current.expiresAt) throw new Error('ChatGPT login expired. Please start again.');
        const result = await api('/login/poll', { loginId: current.loginId });
        if (login !== current) return;
        if (result.success) {
            showLogin(null);
            await updateCodexOAuthStatus();
            toastr.success('Signed in with ChatGPT');
            await onCredentialsChanged();
        } else {
            timer = setTimeout(pollLogin, Math.max(1, current.interval) * 1000);
        }
    } catch (error) {
        if (login !== current) return;
        showLogin(null);
        toastr.error(error.message);
    }
}

export async function updateCodexOAuthStatus() {
    let state;
    try {
        state = await api('/state', undefined, 'GET');
    } catch (error) {
        $('#codex_oauth_status').text(error.message);
        // Keep recovery available even when a damaged credentials file cannot be read.
        $('#codex_oauth_delete').show();
        throw error;
    }
    hasCodexOAuth = state.hasTokens;
    if (!hasCodexOAuth) $('#codex_cache_last').hide();
    const expiry = state.expiresAt ? `Expires ${new Date(state.expiresAt).toLocaleString()}` : 'Automatic refresh enabled';
    $('#codex_oauth_status').text(state.hasTokens ? `${state.email || 'Signed in'} — ${state.isExpired ? 'Token expired; will refresh on connect' : expiry}` : 'Not configured');
    $('#codex_oauth_refresh, #codex_oauth_delete').toggle(state.hasTokens);
    $('#codex_oauth_import').toggle(state.canImportServer);
    // Detach API groups to avoid duplicate model values selecting hidden options.
    if (hasCodexOAuth && !apiModelGroups) {
        apiModelGroups = $('#model_openai_select optgroup').not('#openai_external_category').detach();
    } else if (!hasCodexOAuth && apiModelGroups) {
        $('#model_openai_select').prepend(apiModelGroups);
        apiModelGroups = null;
    }
    $('#openai_show_external_models').prop('disabled', hasCodexOAuth);
    if (hasCodexOAuth) $('#openai_external_category').show();
    showLogin(state.login);
    return state;
}

export function updateCodexCacheReadout(usage) {
    if (!usage) return;
    const input = usage.prompt_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens;
    const output = usage.completion_tokens ?? 0;
    const percent = input > 0 && Number.isFinite(cached) ? Math.round(cached / input * 100) : 0;
    const cacheText = Number.isFinite(cached) ? `Cached ${cached} / ${input} input tokens (${percent}%)` : `Input ${input} tokens; cache usage not reported`;
    $('#codex_cache_last').text(`${cacheText} · output ${output}`).show();
}

export function initCodexOAuth(onChange) {
    onCredentialsChanged = onChange;
    updateCodexOAuthStatus().catch(() => $('#codex_oauth_status').text('Could not load Codex login status'));

    const action = async (button, callback) => {
        $(button).prop('disabled', true);
        try {
            await callback();
        } catch (error) {
            toastr.error(error.message);
        } finally {
            $(button).prop('disabled', false);
        }
    };
    $('#codex_oauth_login').on('click', function () {
        action(this, async () => showLogin(await api('/login/start'))).then(() => $(this).prop('disabled', Boolean(login)));
    });
    $('#codex_oauth_cancel').on('click', function () {
        action(this, async () => {
            const loginId = login?.loginId;
            showLogin(null);
            await api('/login/cancel', { loginId });
        });
    });
    for (const [selector, endpoint] of [['#codex_oauth_import', '/import'], ['#codex_oauth_refresh', '/refresh']]) {
        $(selector).on('click', function () {
            action(this, async () => {
                await api(endpoint);
                await updateCodexOAuthStatus();
                await onCredentialsChanged();
            });
        });
    }
    $('#codex_oauth_upload').on('click', () => $('#codex_oauth_file').trigger('click'));
    $('#codex_oauth_file').on('change', async function () {
        const file = this.files[0];
        this.value = '';
        if (!file) return;
        await action('#codex_oauth_upload', async () => {
            if (file.size > 128 * 1024) throw new Error('Choose a Codex auth.json file smaller than 128 KB.');
            let auth;
            try {
                auth = JSON.parse(await file.text());
            } catch {
                throw new Error('The selected file is not valid JSON.');
            }
            await api('/import', { auth });
            await updateCodexOAuthStatus();
            await onCredentialsChanged();
        });
    });
    $('#codex_oauth_delete').on('click', function () {
        action(this, async () => {
            if (!await Popup.show.confirm('Delete Codex credentials?', 'This removes the ChatGPT login stored in SillyTavern.')) return;
            await api('/tokens', undefined, 'DELETE');
            showLogin(null);
            await updateCodexOAuthStatus();
            await onCredentialsChanged();
        });
    });
}
