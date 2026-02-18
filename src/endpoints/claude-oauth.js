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

export const OAUTH_FILE = 'claude-oauth.json';

// OAuth configuration - must match Claude Code
const OAUTH_CONFIG = {
    TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
    PROFILE_URL: 'https://api.anthropic.com/api/oauth/profile',
    CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    SCOPES: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
    REFRESH_BUFFER_MS: 5 * 60 * 1000, // Refresh 5 minutes before expiry
    BETA_HEADER: 'oauth-2025-04-20',
};

/**
 * @typedef {object} OAuthTokens
 * @property {string} accessToken The OAuth access token
 * @property {string} refreshToken The OAuth refresh token
 * @property {number} expiresAt Token expiry timestamp in milliseconds
 * @property {string} [scopes] OAuth scopes
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
     */
    constructor(directories) {
        this.directories = directories;
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
            scopes: tokens.scopes,
            userId: tokens.userId || existing.userId,
            accountUuid: tokens.accountUuid || existing.accountUuid,
        };

        writeFileAtomicSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    /**
     * Deletes OAuth tokens
     */
    deleteTokens() {
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
        try {
            const response = await fetch(OAUTH_CONFIG.TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: OAUTH_CONFIG.CLIENT_ID,
                    scope: OAUTH_CONFIG.SCOPES,
                }),
            });

            if (!response.ok) {
                const text = await response.text();
                console.error(color.red(`OAuth refresh failed: ${response.status}`), text);
                return null;
            }

            /** @type {any} */
            const data = await response.json();

            const tokens = {
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshToken,
                expiresAt: data.expires_in ? Date.now() + (data.expires_in * 1000) : 0,
                scopes: data.scope || OAUTH_CONFIG.SCOPES,
            };

            this.writeTokens(tokens);
            console.info(color.green('Claude OAuth token refreshed successfully'));

            return tokens;
        } catch (error) {
            console.error(color.red('OAuth refresh error:'), error.message);
            return null;
        }
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
                console.error(color.red('Token refresh failed. Re-import tokens or use API key.'));
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

        let changed = false;

        // Generate persistent userId if missing
        if (!tokens.userId) {
            tokens.userId = crypto.randomBytes(32).toString('hex');
            changed = true;
        }

        // Fetch accountUuid if missing
        if (!tokens.accountUuid) {
            try {
                const response = await fetch(OAUTH_CONFIG.PROFILE_URL, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'anthropic-beta': OAUTH_CONFIG.BETA_HEADER,
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

        if (changed) {
            this.writeTokens(tokens);
        }
    }

    /**
     * Builds metadata user_id string for API requests.
     * Format: user_{userId}_account_{accountUuid}_session_{sessionUuid}
     * @returns {string}
     */
    buildMetadataUserId() {
        const tokens = this.readTokens();
        const userId = tokens?.userId || '';
        const accountUuid = tokens?.accountUuid || '';
        const sessionId = uuidv4();
        return `user_${userId}_account_${accountUuid}_session_${sessionId}`;
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
                userId: data.userId,
                accountUuid: data.accountUuid,
            };

            this.writeTokens(tokens);
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
        const tokens = {
            accessToken,
            refreshToken,
            expiresAt: expiresIn ? Date.now() + (expiresIn * 1000) : 0,
            scopes: OAUTH_CONFIG.SCOPES,
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
