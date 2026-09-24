/**
 * claude-oauth.js - OAuth token management for Claude API
 *
 * Manages OAuth tokens independently, supporting:
 * - One-time import from claude-c's ~/.claude/claude-c.json
 * - Automatic token refresh
 * - Per-user token storage
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { color, uuidv4 } from '../util.js';

// Shared across manager instances so concurrent requests cannot rotate the same token twice.
const refreshes = new Map();
const revisions = new Map();

function scopeList(scopes) {
    return [...new Set((Array.isArray(scopes) ? scopes : String(scopes || '').split(' ')).filter(scope => typeof scope === 'string' && scope))];
}

export const OAUTH_FILE = 'claude-oauth.json';

// OAuth configuration - must match Claude Code
const OAUTH_CONFIG = {
    TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
    PROFILE_URL: 'https://api.anthropic.com/api/oauth/profile',
    CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    SCOPES: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins',
    REFRESH_BUFFER_MS: 5 * 60 * 1000, // Refresh 5 minutes before expiry
    BETA_HEADER: 'oauth-2025-04-20',
};

/**
 * @typedef {object} OAuthTokens
 * @property {string} accessToken The OAuth access token
 * @property {string} refreshToken The OAuth refresh token
 * @property {number} expiresAt Token expiry timestamp in milliseconds
 * @property {string|string[]} [scopes] OAuth scopes
 * @property {number} [refreshTokenExpiresAt] Refresh-token expiry timestamp
 * @property {string} [sessionId] Persistent fallback session ID
 * @property {string} [clientId] OAuth client that issued the imported credentials
 * @property {string} [userId] Persistent 64-char hex user ID
 * @property {string} [accountUuid] Account UUID from OAuth profile
 */

/**
 * @typedef {object} OAuthState
 * @property {boolean} hasTokens Whether OAuth tokens are configured
 * @property {boolean} isExpired Whether the access token is expired
 * @property {number} [expiresAt] Token expiry timestamp
 */

/**
 * Claude OAuth Manager class
 */
export class ClaudeOAuthManager {
    /**
     * @param {import('../users.js').UserDirectoryList} directories
     * @param {typeof fetch} [fetchImpl] HTTP transport
     */
    constructor(directories, fetchImpl = fetch) {
        this.directories = directories;
        this.fetch = fetchImpl;
        this.filePath = path.join(directories.root, OAUTH_FILE);
    }

    /**
     * Reads OAuth tokens from file
     * @returns {OAuthTokens|null}
     */
    readTokens() {
        if (!fs.existsSync(this.filePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(this.filePath, 'utf-8');
            const data = JSON.parse(content);

            if (!data.accessToken || !data.refreshToken) {
                return null;
            }

            return {
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
                expiresAt: data.expiresAt || 0,
                scopes: data.scopes,
                refreshTokenExpiresAt: data.refreshTokenExpiresAt,
                sessionId: data.sessionId,
                clientId: data.clientId,
                userId: data.userId,
                accountUuid: data.accountUuid,
            };
        } catch (error) {
            console.warn(color.yellow('Failed to read Claude OAuth tokens:'), error.message);
            return null;
        }
    }

    /**
     * Writes OAuth tokens to file
     * @param {OAuthTokens} tokens
     */
    writeTokens(tokens) {
        // Merge with existing data to preserve userId/accountUuid across refreshes
        let existing = {};
        try {
            if (fs.existsSync(this.filePath)) {
                existing = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            }
        } catch { /* ignore */ }

        const data = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes ?? existing.scopes,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            sessionId: tokens.sessionId || existing.sessionId,
            clientId: tokens.clientId,
            userId: tokens.userId || existing.userId,
            accountUuid: tokens.accountUuid ?? existing.accountUuid,
        };

        writeFileAtomicSync(this.filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }

    /**
     * Deletes OAuth tokens
     */
    deleteTokens() {
        revisions.set(this.filePath, (revisions.get(this.filePath) || 0) + 1);
        if (fs.existsSync(this.filePath)) {
            fs.unlinkSync(this.filePath);
        }
    }

    /**
     * Checks if token needs refresh
     * @param {number} expiresAt
     * @returns {boolean}
     */
    needsRefresh(expiresAt) {
        if (!expiresAt) return true;
        const now = Date.now();
        return now + OAUTH_CONFIG.REFRESH_BUFFER_MS >= expiresAt;
    }

    /**
     * Refreshes the OAuth token
     * @param {string} refreshToken
     * @returns {Promise<OAuthTokens|null>}
     */
    async refreshToken(refreshToken) {
        const revision = revisions.get(this.filePath) || 0;
        const pending = refreshes.get(this.filePath);
        if (pending?.revision === revision) return pending.promise;
        const entry = { revision, promise: this.performRefresh(refreshToken, revision) };
        refreshes.set(this.filePath, entry);
        try {
            return await entry.promise;
        } finally {
            if (refreshes.get(this.filePath) === entry) refreshes.delete(this.filePath);
        }
    }

    /** Refresh once, retaining granted scopes and never overwriting a newer login or logout. */
    async performRefresh(refreshToken, revision) {
        const previous = this.readTokens();
        if (!previous) return null;
        if (previous.refreshToken !== refreshToken) return previous;
        if (previous.refreshTokenExpiresAt && Date.now() >= previous.refreshTokenExpiresAt) return null;
        const originalScopes = scopeList(previous.scopes);
        // 2.1.281 adds plugins and preserves granted project scopes. Older grants can
        // reject the expanded scope list; retry that specific error with the original grant.
        const defaultClient = !previous.clientId || previous.clientId === OAUTH_CONFIG.CLIENT_ID;
        const scopes = defaultClient && (!originalScopes.length || originalScopes.includes('user:inference'))
            ? [...scopeList(OAUTH_CONFIG.SCOPES), ...originalScopes.filter(scope => ['user:projects:read', 'user:projects:write'].includes(scope))]
            : originalScopes;
        const isCurrent = () => (revisions.get(this.filePath) || 0) === revision
            && this.readTokens()?.refreshToken === refreshToken
            && this.readTokens()?.accessToken === previous.accessToken;
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const requestedScopes = attempt ? originalScopes : scopes;
                const response = await this.fetch(OAUTH_CONFIG.TOKEN_URL, {
                    method: 'POST',
                    redirect: 'error',
                    signal: AbortSignal.timeout(30000),
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        grant_type: 'refresh_token',
                        refresh_token: refreshToken,
                        client_id: previous.clientId || OAUTH_CONFIG.CLIENT_ID,
                        scope: requestedScopes.join(' '),
                    }),
                });
                const data = await response.json().catch(() => null);
                if ((revisions.get(this.filePath) || 0) !== revision) return null;
                if (!isCurrent()) return this.readTokens();
                if (!response.ok) {
                    const errorCode = typeof data?.error === 'string' ? data.error : data?.error?.type;
                    if (attempt === 0 && errorCode === 'invalid_scope' && originalScopes.length
                        && requestedScopes.join(' ') !== originalScopes.join(' ')) continue;
                    // Never log a token response body: OAuth error payloads may contain credentials.
                    console.error(color.red(`Claude OAuth refresh failed (HTTP ${response.status}).`));
                    return null;
                }
                if (typeof data?.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)
                    || !Number.isFinite(data.expires_in) || data.expires_in <= 0
                    || (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token))) {
                    console.error(color.red('Claude OAuth returned invalid refresh credentials.'));
                    return null;
                }
                const tokens = {
                    ...this.readTokens(),
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token || refreshToken,
                    expiresAt: Date.now() + data.expires_in * 1000,
                    refreshTokenExpiresAt: Number.isFinite(data.refresh_token_expires_in)
                        ? Date.now() + data.refresh_token_expires_in * 1000 : previous.refreshTokenExpiresAt,
                    scopes: data.scope || requestedScopes.join(' '),
                    accountUuid: data.account?.uuid || previous.accountUuid,
                };
                this.writeTokens(tokens);
                console.info(color.green('Claude OAuth token refreshed successfully'));
                return tokens;
            }
        } catch (error) {
            console.error(color.red('Claude OAuth refresh request failed:'), error.name);
        }
        return null;
    }

    /** Recover a rejected token once, first adopting credentials another request refreshed. */
    async recoverUnauthorized(accessToken) {
        const current = this.readTokens();
        if (!current) return null;
        if (current.accessToken !== accessToken) return this.getValidAccessToken();
        const refreshed = await this.refreshToken(current.refreshToken);
        return refreshed?.accessToken || null;
    }

    /**
     * Gets a valid access token, refreshing if necessary
     * @returns {Promise<string|null>}
     */
    async getValidAccessToken() {
        const tokens = this.readTokens();
        if (!tokens) {
            return null;
        }

        if (this.needsRefresh(tokens.expiresAt)) {
            console.info(color.blue('Claude OAuth token expired or expiring soon, refreshing...'));
            const refreshed = await this.refreshToken(tokens.refreshToken);
            if (!refreshed) {
                console.error(color.red('Token refresh failed. Refresh or re-import your Claude credentials.'));
                return null;
            }
            return refreshed.accessToken;
        }

        return tokens.accessToken;
    }

    /**
     * Gets the OAuth state for the UI
     * @returns {OAuthState}
     */
    getState() {
        const tokens = this.readTokens();

        if (!tokens) {
            return { hasTokens: false, isExpired: false };
        }

        return {
            hasTokens: true,
            isExpired: this.needsRefresh(tokens.expiresAt),
            expiresAt: tokens.expiresAt,
        };
    }

    /**
     * Fetches OAuth profile to get accountUuid, generates userId if missing.
     * Caches both in the token file.
     * @param {string} accessToken
     * @returns {Promise<void>}
     */
    async fetchProfile(accessToken) {
        const tokens = this.readTokens();
        if (!tokens) return;
        const revision = revisions.get(this.filePath) || 0;

        let changed = false;

        // Generate persistent userId if missing
        if (!tokens.userId) {
            tokens.userId = crypto.randomBytes(32).toString('hex');
            changed = true;
        }

        // Fetch accountUuid if missing
        if (!tokens.accountUuid) {
            try {
                const response = await this.fetch(OAUTH_CONFIG.PROFILE_URL, {
                    signal: AbortSignal.timeout(10000),
                    redirect: 'error',
                    // Match the official client's profile fetch: Bearer +
                    // Content-Type + Cache-Control, and NO anthropic-beta.
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache',
                    },
                });
                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    if (data?.account?.uuid) {
                        tokens.accountUuid = data.account.uuid;
                        changed = true;
                    }
                }
            } catch (error) {
                console.warn(color.yellow('Failed to fetch OAuth profile:'), error.message);
            }
        }

        if (changed && (revisions.get(this.filePath) || 0) === revision) {
            const current = this.readTokens();
            if (current && current.accessToken === tokens.accessToken) {
                this.writeTokens({ ...current, userId: tokens.userId, accountUuid: tokens.accountUuid });
            }
        }
    }

    /**
     * Gets or creates a persistent session ID stored in the token file.
     * @returns {string}
     */
    getSessionId() {
        const tokens = this.readTokens();
        if (tokens?.sessionId) return tokens.sessionId;

        if (!tokens) throw new Error('Claude OAuth credentials are not configured.');
        const sessionId = uuidv4();
        this.writeTokens({ ...tokens, sessionId });
        return sessionId;
    }

    /**
     * Builds metadata user_id JSON string for API requests.
     * @returns {string}
     */
    buildMetadataUserId() {
        const tokens = this.readTokens();
        const userId = tokens?.userId || '';
        const accountUuid = tokens?.accountUuid || '';
        const sessionId = this.getSessionId();
        return JSON.stringify({ device_id: userId, account_uuid: accountUuid, session_id: sessionId });
    }

    /**
     * Imports tokens from claude-c's storage (~/.claude/claude-c.json)
     * @returns {boolean} Whether import was successful
     */
    importFromClaudeC() {
        const claudeCPath = path.join(os.homedir(), '.claude', 'claude-c.json');

        if (!fs.existsSync(claudeCPath)) {
            console.warn(color.yellow('claude-c config not found at:'), claudeCPath);
            return false;
        }

        try {
            const content = fs.readFileSync(claudeCPath, 'utf-8');
            const data = JSON.parse(content);

            if (!data.oauth?.accessToken || !data.oauth?.refreshToken) {
                console.warn(color.yellow('No OAuth tokens found in claude-c config'));
                return false;
            }

            const tokens = {
                accessToken: data.oauth.accessToken,
                refreshToken: data.oauth.refreshToken,
                expiresAt: data.oauth.expiresAt || 0,
                scopes: data.oauth.scopes || OAUTH_CONFIG.SCOPES,
                refreshTokenExpiresAt: data.oauth.refreshTokenExpiresAt,
                clientId: data.oauth.clientId,
                userId: data.userId,
                accountUuid: data.accountUuid,
            };

            revisions.set(this.filePath, (revisions.get(this.filePath) || 0) + 1);
            this.writeTokens({ ...tokens, accountUuid: tokens.accountUuid || '' });
            console.info(color.green('Claude OAuth tokens imported from claude-c'));

            return true;
        } catch (error) {
            console.error(color.red('Failed to import from claude-c:'), error.message);
            return false;
        }
    }

    /**
     * Manually sets OAuth tokens
     * @param {string} accessToken
     * @param {string} refreshToken
     * @param {number} [expiresIn] Expiry time in seconds
     */
    setTokens(accessToken, refreshToken, expiresIn) {
        revisions.set(this.filePath, (revisions.get(this.filePath) || 0) + 1);
        const tokens = {
            accessToken,
            refreshToken,
            expiresAt: expiresIn ? Date.now() + (expiresIn * 1000) : 0,
            scopes: OAUTH_CONFIG.SCOPES,
            accountUuid: '',
        };

        this.writeTokens(tokens);
    }
}

/**
 * Gets the OAuth beta header value
 * @returns {string}
 */
export function getOAuthBetaHeader() {
    return OAUTH_CONFIG.BETA_HEADER;
}

/**
 * Factory function for getting OAuth manager
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {ClaudeOAuthManager}
 */
export function getOAuthManager(directories) {
    return new ClaudeOAuthManager(directories);
}

export const router = express.Router();

// Get OAuth state
router.get('/state', (request, response) => {
    try {
        const manager = new ClaudeOAuthManager(request.user.directories);
        const state = manager.getState();
        return response.send(state);
    } catch (error) {
        console.error('Error getting OAuth state:', error);
        return response.status(500).send({ error: error.message });
    }
});

// Import tokens from claude-c
router.post('/import', (request, response) => {
    try {
        const manager = new ClaudeOAuthManager(request.user.directories);
        const success = manager.importFromClaudeC();

        if (success) {
            return response.send({ success: true, message: 'OAuth tokens imported successfully' });
        } else {
            return response.status(400).send({ success: false, message: 'Failed to import tokens. Make sure claude-c has valid OAuth tokens.' });
        }
    } catch (error) {
        console.error('Error importing OAuth tokens:', error);
        return response.status(500).send({ error: error.message });
    }
});

// Manually set tokens
router.post('/set', (request, response) => {
    try {
        const { accessToken, refreshToken, expiresIn } = request.body;

        if (!accessToken || !refreshToken) {
            return response.status(400).send({ error: 'accessToken and refreshToken are required' });
        }

        const manager = new ClaudeOAuthManager(request.user.directories);
        manager.setTokens(accessToken, refreshToken, expiresIn);

        return response.send({ success: true });
    } catch (error) {
        console.error('Error setting OAuth tokens:', error);
        return response.status(500).send({ error: error.message });
    }
});

// Delete tokens
router.delete('/tokens', (request, response) => {
    try {
        const manager = new ClaudeOAuthManager(request.user.directories);
        manager.deleteTokens();
        return response.send({ success: true });
    } catch (error) {
        console.error('Error deleting OAuth tokens:', error);
        return response.status(500).send({ error: error.message });
    }
});

// Force refresh tokens
router.post('/refresh', async (request, response) => {
    try {
        const manager = new ClaudeOAuthManager(request.user.directories);
        const tokens = manager.readTokens();

        if (!tokens) {
            return response.status(400).send({ error: 'No OAuth tokens configured' });
        }

        const refreshed = await manager.refreshToken(tokens.refreshToken);

        if (refreshed) {
            return response.send({ success: true, expiresAt: refreshed.expiresAt });
        } else {
            return response.status(400).send({ success: false, message: 'Token refresh failed' });
        }
    } catch (error) {
        console.error('Error refreshing OAuth tokens:', error);
        return response.status(500).send({ error: error.message });
    }
});
