# ChatGPT / Codex authentication

Select **Chat Completion → OpenAI → Sign in with ChatGPT**. Open the displayed
ChatGPT device login link, enter the one-time code, and finish sign-in. SillyTavern
polls for completion and then loads the models available to your account. Enable
device code login in ChatGPT's security settings first; workspace administrators
may control its availability. Codes expire after 15 minutes. Cancel stops the
pending login; refreshing the page resumes a pending login while the server is
still running.

This integration uses your account's Codex access. It is not an OpenAI Platform
API key, and model access and limits are determined by ChatGPT. Credentials take
priority over API keys for the OpenAI provider. Requests go directly to the Codex
service; reverse proxy addresses and passwords are ignored while signed in.
Delete the stored credentials to return to API key or proxy authentication.
A failed token refresh does not fall back to a billable API key.

**Refresh** renews the token manually; requests also refresh expiring tokens and
retry authentication once after a 401. **Delete** removes this SillyTavern user's
local credentials and cancels pending login. It does not revoke other sessions.

## Latest model options

Verified on 2026-09-05 against the official OpenAI model documentation and Codex
model catalog. The OpenAI picker includes `gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, the documented `gpt-5.6` alias for Sol, and
`gpt-5.6-cyber` (requires separate Daybreak provisioning).

When signed in with Codex, the picker uses the account's live model catalog.
The official Codex catalog contains Astra, Sol, Terra, and Luna; actual account
availability determines which appear. API context defaults for these four are
1,050,000 tokens; Codex uses the context advertised by its backend instead.
Reasoning/verbosity handling and the existing approximate tokenizer mapping
include Astra as well as the GPT-5.6 family.

Sources:
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-cyber
- `openai/codex`, `codex-rs/models-manager/models.json`

## Optional import

**Upload auth.json** imports a file from your own Codex CLI ChatGPT login.
**Import from server** is available only to SillyTavern administrators and reads
`$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset.
API-key-only and external-auth files are not accepted. OS keychain storage is not
read. Imported tokens are managed independently; concurrent CLI use of the same
rotating refresh token can require signing in again. Prefer signing in directly
here to establish a separate session.

Tokens are stored in `codex-oauth.json` in the current SillyTavern user's data
root, using atomic writes and owner-only file permissions on Unix. Auth routes
use the existing SillyTavern user session and CSRF protection. Raw tokens and
PKCE verifiers are never sent to the browser by login, refresh, or state routes.
Pending login and refresh locks are held in memory for a single server process.

## Prompt caching

Per-chat prompt cache keys are enabled by default, matching Codex's use of a
stable session key. SillyTavern hashes the user scope, character/group identity,
and chat identity into a 64-character `prompt_cache_key`. It stays stable across
turns, swipes, reconnects, and server restarts for the same chat, and changes for
different chats or users. Renaming a chat changes its key. Raw chat names and
user paths are not included in the upstream key. Standalone requests with no
chat identity omit the key.

The **Use per-chat prompt cache key** setting is saved with chat completion
settings and presets. Turning it off omits the routing key; it does not disable
upstream automatic caching. The latest reply displays cached input tokens, total
input tokens, cache-hit percentage, and output tokens, for streaming and buffered
responses. A missing cache metric is shown as unreported rather than as a miss.

Codex caches matching prefixes automatically. Keep early instructions, history,
and tool definitions stable; changing early context can reduce cache hits. A
stable key helps routing but does not guarantee a hit. The Codex source inspected
here exposes `prompt_cache_key` and cached-token usage, but does not send cache
breakpoints, depth controls, or a TTL override, so this integration does not add
those Claude-specific controls. General OpenAI API caching documentation is not
proof that every field is accepted by the ChatGPT Codex backend.

## Supported requests and limits

The adapter supports chat history, system/developer instructions, user images,
function tools, reasoning summaries, structured output, and both streaming and
buffered replies. It preserves message order and maps function calls and usage
back to Chat Completions format. Codex always streams upstream.

Codex sampling and generation controls differ from Chat Completions. Temperature,
top-p, penalties, stop strings, log probabilities, and `max_tokens` are not sent.
Only one response per request is supported. Audio/video inputs and non-function
tools are rejected with an error. Incomplete, failed, or truncated streams are
reported as errors. This integration does not provide Codex's local shell/agent
runtime or FedRAMP routing.

## Implementation reference

Based on the official `openai/codex` source at commit
`52e73e3a548ae5310c7765995b9803dd538b82b0`:

- `codex-rs/login/src/device_code_auth.rs`: device code, polling, and PKCE exchange.
- `codex-rs/login/src/auth/manager.rs`: client ID, token refresh and 401 recovery.
- `codex-rs/login/src/auth/storage.rs` and `token_data.rs`: auth cache and account claims.
- `codex-rs/codex-api/src/endpoint/models.rs`, `common.rs`, and `sse/responses.rs`:
  model discovery, Responses requests and SSE events.

The model-discovery compatibility version is pinned to the observed stable
Codex release `0.153.4`. The client identifies its originator as `sillytavern`.

Official authentication documentation: https://developers.openai.com/codex/auth

## Validation status

Before removing the test suite at the repository owner's request, 19 backend
checks passed using synthetic credentials and mocked upstream responses. DOM
checks covered login, cancellation, model selection and cache readouts;
production startup and CSRF checks also passed. Test sources were backed up
locally and are not part of this branch's current files.

A real account sign-in and model request are still required to verify live
upstream compatibility.

## Generation diagnostics

Generation logs use a `[Codex request-id]` prefix and report the model, upstream
HTTP status, content type, upstream request ID, completion time and token usage.
Raw response bodies and authentication credentials are not logged. The adapter
recognizes SSE from its body even if its content type is missing or incorrect,
and also accepts completed Responses JSON. Structured upstream errors are shown
in the chat error message.

## Images in replies

Enable **Allow image generation** beneath **Send inline media** in the OpenAI
provider settings. It defaults off and is saved in settings and presets.
The model can call an image tool when a picture is appropriate; the checkbox
does not force an image on every reply or require the extension function-calling
switch. Quiet/background and impersonation requests do not offer the tool.

The tool uses GPT Image 2 with automatic quality, one image per call, and a
maximum of four calls per response. It creates new pictures from a text prompt;
pixel-faithful editing of attached images is not implemented. The model can
request square, portrait, landscape, or automatic dimensions.

Codex sign-in uses the subscription image endpoint and existing token refresh.
A failed subscription request does not fall back to a paid API key. API-key
connections use Responses for image-enabled chat requests and the Images API
through their configured OpenAI base URL. A reverse proxy must support both
endpoints. Image-enabled requests support one chat response at a time. API mode
forwards the output token limit and GPT-4 temperature/top-p; Chat Completions-only
sampling controls are not forwarded through the Responses adapter.

Text streams normally while the picture is generated. Completed pictures use
SillyTavern's existing image attachments, including saving and swipe history.
Stop cancels the local upstream request. Image generation has its own usage cost;
the chat cache readout reports text-model token usage, not image-model usage.
With inline media enabled, retained generated attachments are sent as visual
context on subsequent turns. Request logs show image progress without image
bytes or prompts.

The image request shape follows `openai/codex`'s
`codex-rs/ext/image-generation/src/backend.rs` and `tool.rs`, and
`codex-rs/codex-api/src/images.rs`. Upstream account availability requires a live
image-generation request; local mocked transport checks do not establish it.
