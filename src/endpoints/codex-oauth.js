/** ChatGPT device login and per-user Codex credentials. See docs/codex-oauth.md. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const AUTH_URL = 'https://auth.openai.com';
const API_URL = 'https://chatgpt.com/backend-api/codex';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const LOGIN_TTL = 15 * 60 * 1000;
const managers = new Map();

async function authJson(response) {
    try {
        return await response.json();
    } catch {
        throw new Error('ChatGPT returned an invalid authentication response. Please try again.');
    }
}

// Claims are metadata only; the upstream service validates the actual credentials.
function claims(token) {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    } catch {
        return {};
    }
}

function credentials(data, previous = {}) {
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token || previous.refreshToken;
    const idToken = data.id_token || previous.idToken;
    const accessClaims = claims(accessToken);
    const identity = claims(idToken);
    const auth = identity['https://api.openai.com/auth'] || accessClaims['https://api.openai.com/auth'] || {};
    const accountId = data.account_id || auth.chatgpt_account_id || previous.accountId;
    if (![accessToken, refreshToken, accountId].every(x => typeof x === 'string' && x.length > 0 && !/[\r\n]/.test(x))) {
        throw new Error('Valid ChatGPT access, refresh, and account credentials are required. Sign in with ChatGPT, not an API key.');
    }
    if (auth.chatgpt_account_is_fedramp) {
        throw new Error('This integration does not support FedRAMP account routing.');
    }
    return {
        accessToken, refreshToken, idToken, accountId,
        expiresAt: Number(accessClaims.exp) * 1000 || (Number(data.expires_in) > 0 ? Date.now() + Number(data.expires_in) * 1000 : 0),
        lastRefresh: Date.now(),
        email: identity.email || identity['https://api.openai.com/profile']?.email || previous.email,
    };
}

export class CodexOAuthManager {
    constructor(directories, fetchImpl = fetch) {
        this.filePath = path.join(directories.root, 'codex-oauth.json');
        this.fetch = fetchImpl;
        this.pending = null;
        this.refreshing = null;
        this.revision = 0;
    }

    readTokens() {
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (!data.accessToken || !data.refreshToken || !data.accountId) throw new Error();
            return data;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new Error('Cannot read Codex credentials. Delete them and sign in again.');
        }
    }

    writeTokens(tokens) {
        writeFileAtomicSync(this.filePath, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
        this.revision++;
    }

    deleteTokens() {
        this.pending = null;
        this.revision++;
        fs.rmSync(this.filePath, { force: true });
    }

    getState() {
        const tokens = this.readTokens();
        if (this.pending?.expiresAt <= Date.now()) this.pending = null;
        return {
            hasTokens: Boolean(tokens),
            isExpired: Boolean(tokens && tokens.expiresAt && tokens.expiresAt <= Date.now()),
            expiresAt: tokens?.expiresAt,
            email: tokens?.email,
            login: this.pending?.userCode ? {
                loginId: this.pending.loginId,
                userCode: this.pending.userCode,
                verificationUrl: `${AUTH_URL}/codex/device`,
                interval: this.pending.interval,
                expiresAt: this.pending.expiresAt,
            } : null,
        };
    }

    async authRequest(endpoint, body, form = false) {
        return this.fetch(`${AUTH_URL}${endpoint}`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
            body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        });
    }

    async startLogin() {
        const pending = { loginId: crypto.randomUUID(), expiresAt: Date.now() + LOGIN_TTL };
        this.pending = pending;
        try {
            const result = await this.authRequest('/api/accounts/deviceauth/usercode', { client_id: CLIENT_ID });
            if (!result.ok) throw new Error(`ChatGPT login could not start (HTTP ${result.status}). Enable device code login in ChatGPT security settings, then try again.`);
            const data = await authJson(result);
            if (!data.device_auth_id || !(data.user_code || data.usercode)) throw new Error('ChatGPT returned an invalid device code.');
            if (this.pending !== pending) throw new Error('Login cancelled.');
            Object.assign(pending, {
                deviceAuthId: data.device_auth_id, userCode: data.user_code || data.usercode,
                interval: Math.max(1, Number(data.interval) || 5), nextPoll: 0,
            });
            return this.getState().login;
        } catch (error) {
            if (this.pending === pending) this.pending = null;
            throw error;
        }
    }

    async pollLogin(loginId) {
        const pending = this.pending;
        if (!pending || pending.loginId !== loginId || pending.expiresAt <= Date.now()) {
            if (pending?.expiresAt <= Date.now()) this.pending = null;
            throw new Error('Login expired or cancelled. Start a new login.');
        }
        if (pending.polling || Date.now() < pending.nextPoll) return { pending: true };
        pending.polling = true;
        pending.nextPoll = Date.now() + pending.interval * 1000;
        try {
            const result = await this.authRequest('/api/accounts/deviceauth/token', {
                device_auth_id: pending.deviceAuthId, user_code: pending.userCode,
            });
            if ([403, 404].includes(result.status)) return { pending: true };
            if (!result.ok) throw new Error(`ChatGPT login failed (HTTP ${result.status}). Start a new login.`);
            const data = await authJson(result);
            if (!data.authorization_code || !data.code_verifier) throw new Error('ChatGPT returned an invalid authorization response.');
            if (this.pending !== pending) throw new Error('Login cancelled.');
            const exchange = await this.authRequest('/oauth/token', {
                grant_type: 'authorization_code', client_id: CLIENT_ID,
                code: data.authorization_code, code_verifier: data.code_verifier,
                redirect_uri: `${AUTH_URL}/deviceauth/callback`,
            }, true);
            if (!exchange.ok) throw new Error(`ChatGPT token exchange failed (HTTP ${exchange.status}). Start a new login.`);
            const tokens = credentials(await authJson(exchange));
            if (this.pending !== pending || pending.expiresAt <= Date.now()) throw new Error('Login cancelled or expired.');
            this.writeTokens(tokens);
            this.pending = null;
            return { success: true };
        } catch (error) {
            if (this.pending === pending) this.pending = null;
            throw error;
        } finally {
            pending.polling = false;
        }
    }

    importTokens(data) {
        if (data?.auth_mode && data.auth_mode !== 'chatgpt') throw new Error('Import a ChatGPT login, not API key or external authentication.');
        const tokens = credentials(data?.tokens || {});
        this.pending = null;
        this.writeTokens(tokens);
    }

    async refreshTokens(staleAccessToken) {
        if (this.refreshing) return this.refreshing;
        const current = this.readTokens();
        if (!current) throw new Error('Sign in with ChatGPT first.');
        // Another request may already have refreshed the token that received a 401.
        if (staleAccessToken && staleAccessToken !== current.accessToken) return current;
        const revision = this.revision;
        this.refreshing = (async () => {
            const response = await this.authRequest('/oauth/token', {
                grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: current.refreshToken,
            });
            if (!response.ok) throw new Error(`Codex token refresh failed (HTTP ${response.status}). Sign in with ChatGPT again.`);
            const next = credentials(await authJson(response), current);
            if (this.revision !== revision) throw new Error('Codex credentials changed during refresh. Please retry.');
            if (next.accountId !== current.accountId) throw new Error('Codex account changed during refresh. Sign in again.');
            this.writeTokens(next);
            return next;
        })();
        try {
            return await this.refreshing;
        } finally {
            this.refreshing = null;
        }
    }

    async apiRequest(endpoint, options = {}) {
        let tokens = this.readTokens();
        if (!tokens) throw new Error('Sign in with ChatGPT first.');
        if ((tokens.expiresAt && tokens.expiresAt <= Date.now() + 300000) || (!tokens.expiresAt && Date.now() - (tokens.lastRefresh || 0) >= 8 * 86400000)) {
            tokens = await this.refreshTokens(tokens.accessToken);
        }
        const send = auth => this.fetch(`${API_URL}${endpoint}`, {
            ...options, redirect: 'error',
            headers: {
                ...options.headers, Authorization: `Bearer ${auth.accessToken}`,
                'ChatGPT-Account-Id': auth.accountId, originator: 'sillytavern',
            },
        });
        let result = await send(tokens);
        if (result.status === 401) {
            result.body?.destroy();
            tokens = await this.refreshTokens(tokens.accessToken);
            result = await send(tokens);
        }
        return result;
    }
}

export function getCodexOAuthManager(directories) {
    if (!managers.has(directories.root)) managers.set(directories.root, new CodexOAuthManager(directories));
    return managers.get(directories.root);
}

export const router = express.Router();
router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
});
const route = handler => async (request, response) => {
    try {
        const result = await handler(getCodexOAuthManager(request.user.directories), request);
        response.json(result);
    } catch (error) {
        response.status(400).json({ error: error.message });
    }
};
router.get('/state', route((manager, request) => ({ ...manager.getState(), canImportServer: Boolean(request.user.profile.admin) })));
router.post('/login/start', route(manager => manager.startLogin()));
router.post('/login/poll', route((manager, request) => manager.pollLogin(request.body?.loginId)));
router.post('/login/cancel', route((manager, request) => {
    if (manager.pending?.loginId === request.body?.loginId) manager.pending = null;
    return { success: true };
}));
router.post('/import', route((manager, request) => {
    let data = request.body?.auth;
    if (!data) {
        if (!request.user.profile.admin) throw new Error('Only administrators can import the server’s Codex credentials. Upload your own auth.json instead.');
        const authPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
        try {
            data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        } catch {
            throw new Error('No readable Codex auth.json found on the server. Sign in here or upload your own file.');
        }
    }
    manager.importTokens(data);
    return { success: true };
}));
router.post('/refresh', route(async manager => {
    await manager.refreshTokens();
    return { success: true };
}));
router.delete('/tokens', route(manager => {
    manager.deleteTokens();
    return { success: true };
}));
