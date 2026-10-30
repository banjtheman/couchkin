# Couchkin's Codex runtime

Couchkin runs a local `codex app-server` subprocess and uses the user's existing ChatGPT sign-in. It does not require an OpenAI Platform API key. The application never reads or copies Codex's credential file, sends credentials to its renderer, or changes the user's Codex configuration. Codex itself manages authentication through its normal supported mechanisms. See [Codex authentication](https://learn.chatgpt.com/docs/auth).

## Verified implementation

Tested on macOS with Codex CLI **0.159.3**, using newline-delimited JSON-RPC over standard input/output. The bridge initializes the client, verifies `account/read` reports a ChatGPT account, and creates an ephemeral thread for each response. `turn/start` accepts text plus `localImage` attachments and an output schema. Completed items supply the response; `turn/interrupt` cancels it. The thread is unsubscribed afterward so observed frames do not accumulate indefinitely in the running server. See the [app-server protocol](https://learn.chatgpt.com/docs/app-server).

Actual signed-in smoke tests succeeded for:

- A structured, short companion response.
- Visual commentary grounded in a supplied game screenshot: crystals, a merchant, and a vegetable stall.
- Live web research returning the official Twitch EventSub WebSocket documentation as a source.
- Native image generation producing a real transparent PNG companion, copied into the application's requested character folder.

The native image tool depends on Codex's code-mode host. Turning that host off caused the model to report that image generation was unavailable, even though the image-generation feature flag was enabled. Couchkin therefore keeps that host enabled while restricting the other capabilities below. Image support is detected from the installed CLI's feature inventory; a flag alone does not guarantee remaining account quota or future availability.

The CLI's generated experimental protocol also exposes realtime start, append-audio, append-text, append-speech, stop, and voice-list methods. A read-only voice-list request succeeded. **Couchkin does not implement native Codex realtime audio yet.** Live audio authentication, interruption, capture, playback, and usage behavior have not been validated end to end. The current voice path is implemented separately by the desktop application.

## Usage and billing

ChatGPT-authenticated Codex usage counts against the user's applicable plan allowances and any enabled additional usage. It is not unlimited or guaranteed free. Native image generation can have its own availability and usage limits. These smoke tests establish working access for the tested account, not an entitlement for every account or a measurement of image/voice billing. Consult current [Codex pricing and limits](https://learn.chatgpt.com/docs/pricing).

Couchkin forces ChatGPT authentication for its subprocess, removes API-key and alternate API-auth environment variables, and rejects API-key-authenticated accounts. It never silently falls back to Platform API billing. Model inference and hosted web/image tools still run on OpenAI services: local capture, storage, and orchestration do not mean offline model inference. Selected screen frames and supplied conversation context are sent through Codex.

## Process and tool boundaries

The bridge launches the executable directly without a shell. It searches absolute PATH entries, then common Mac install locations such as `/opt/homebrew/bin/codex` and `/usr/local/bin/codex`, so Finder launches work with a minimal PATH. An explicit absolute `COUCHKIN_CODEX_BIN` can select a custom installation; shell command strings are not supported.

Each bridge instance uses a unique, in-memory permission profile with read access to its isolated frame directory and Codex's minimal runtime paths, no filesystem writes, and no command network access. The application validates frame paths after resolving symlinks. Native hosted web search and image generation use their own service transport. See [permission scope and enforcement](https://learn.chatgpt.com/docs/permissions#scope-and-enforcement).

Shell execution, unified execution, browser/computer control, apps, plugins, hooks, agent delegation, memory, host skill discovery, and filesystem image viewing are disabled. Server-initiated tool/permission requests are rejected. The bridge supplies explicit companion instructions, treats chat/screenshots/retrieved material as untrusted input, validates reply JSON, limits input/output sizes, filters source URL schemes, and enforces timeouts.

Codex config tables merge: `mcp_servers={}` does **not** remove inherited server entries. The bridge inspects only the effective server names in memory and explicitly disables each one in its thread overrides. Runtime verification showed inherited entries could remain listed but exposed zero tools.

This is capability restriction within an installed Codex runtime, not a separate operating-system sandbox around the entire Codex client. The client retains its normal home and authentication state. On the tested version, the global `AGENTS.md` still appeared in thread instruction-source metadata despite `project_doc_max_bytes=0`; complete isolation from global user instructions is not established. Managed account/device policies still apply. Recheck effective behavior when upgrading the CLI, especially permission-profile and experimental realtime fields.

## Automated checks

`npm test -- tests/codex.test.ts` runs local subprocess fixtures without model usage. Tests cover fragmented protocol messages, structured replies and intentional silence, source filtering, executable discovery, authentication refusal, tool configuration, late cancellation, overlap prevention, denied approvals, frame symlink escapes, and generated-image saving. `npm run typecheck` verifies the TypeScript interface.
