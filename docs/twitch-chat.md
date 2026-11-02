# Twitch chat in Couchkin

Couchkin can listen to Twitch chat, answer addressed viewers aloud, and optionally post short text replies. **Reply in Twitch chat is off by default.** Posting requires a signed-in Twitch account, an OpenAI API key, an active Couchkin session, and the reply switch enabled.

## Connect and choose an account

For listening only, enter a channel's login name in **Connections → Twitch chat** and choose **Listen to chat**. Guest listening needs no token or stream key. It does not use the Twitch sign-in from your browser.

The session page shows whether chat is connected beside the microphone controls, plus the received-message count, last receipt time, and a preview of the latest message. A successful join alone is not evidence that messages are arriving. Restarting the app does not reconnect Twitch: use **Connect chat** to listen again, or sign in again for replies. Starting voice alone does not join Twitch.

When asked what chat is saying, Live is instructed to call **get_recent_chat** before answering. That tool returns connection status and up to 20 messages received on the current connection within the past five minutes, with names and timestamps. This separate in-memory buffer survives a long spoken conversation, but is cleared on chat disconnect or channel change. It is not written to disk and does not backfill missed messages. Disconnected and no-recent-message states are explicit; neither allows invented quotes or viewer consensus.

To post replies:

1. Enter the channel name and choose **Sign in to reply**. Couchkin includes its registered Public Twitch application's Client ID, so the standard build needs no developer setup.
2. Open Twitch and approve the requested chat permissions. Enter the displayed device code if asked. Sign into the account whose username viewers should see: your broadcaster account or a dedicated companion account. Naming the character Riff does not create a Twitch account named Riff.
3. Confirm the displayed sending account, enable **Reply in Twitch chat**, and choose a cooldown. Start or resume the Couchkin session when ready.

The bundled Client ID is a public application identifier and is safe to include in this GitHub repository; it does not grant access to anyone's account. Each user still authorizes their own Twitch session. For a fork or your own application, optionally register a **Public** app in the [Twitch developer console](https://dev.twitch.tv/console/apps) and override the Client ID in the advanced sign-in setup. No client secret belongs in this desktop app or repository.

The device authorization uses Twitch's public-client flow. Tokens stay in memory for the current connection; restart or token expiry requires signing in again. Couchkin validates the account and permissions before connecting, then validates at least hourly while connected. Revocation ends the authenticated connection. There is no saved refresh-token or automatic sign-in restoration. See [Twitch OAuth flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/) and [token validation requirements](https://dev.twitch.tv/docs/authentication/validate-tokens/).

**Already have a chat token?** accepts a matching Twitch username and user access token. This build reads through IRC with `chat:read` and posts through the Helix API with `user:write:chat`. A token with only `chat:read` can still listen. `chat:edit` is IRC's sending scope and does not enable this API-based sender; `user:read:chat` belongs to EventSub reading and does not replace the current IRC scope. Never paste a stream key into the token field. [IRC authentication](https://dev.twitch.tv/docs/chat/irc/), [Send Chat Message API](https://dev.twitch.tv/docs/api/reference/#send-chat-message).

## How replies behave

- A viewer must address the companion's current name or “Couchkin.” Ordinary conversation is still available as context for the spoken companion, but it does not independently trigger public text replies.
- Spoken and text replies triggered by chat share one cooldown: **45 seconds by default**, configurable from **30 to 300 seconds**. One accepted viewer message may produce both a spoken answer and a text reply. There is no backlog: messages skipped while busy, paused, or cooling down are not replayed later.
- Text uses the selected personality. The reply body is at most **280 characters**, with the companion's name added as a prefix, and is threaded under the viewer's message. The Twitch username remains the signed-in account shown in Connections.
- Text generation uses a separate OpenAI Responses request with the game title, addressed viewer's words, character personality, and recent public replies. It does **not** receive private voice transcripts, saved memories, or the current game frame. It therefore should not claim to see a specific current play. This request has separate OpenAI API usage even when the spoken companion uses Codex.
- Repeated reply text, duplicate incoming message IDs, and echoes of Couchkin's own automated replies are suppressed. Manually typed broadcaster messages are included in chat history, even when the same account sends the companion's replies.
- Pending work is cancelled when the session stops or the relevant connection/settings change. Replies are not retried after an uncertain network result, since Twitch might already have received them. “Sent” appears only after Twitch confirms delivery; moderation and channel restrictions can prevent a send. Turning the switch off cannot retract a message already submitted.

When the channel participates in **Shared Chat**, Twitch sends user-token messages to all participating channels; this token type cannot restrict a send to the source channel. [Twitch's Shared Chat sending behavior](https://dev.twitch.tv/docs/api/reference/#send-chat-message).

A stream does not have to be broadcasting to test its chat. Test the authenticated path in your own channel before the first broadcast, with a clearly labeled addressed message from another viewer account. The new posting flow has deterministic test coverage, but has not yet been verified by a real public Twitch send.

## Listening and recovery

The IRC reader uses a guest transport identity, including when an account is signed in for replies. The account token remains in memory for identity validation and authenticated Helix posting; it is not used as the reader’s IRC login. The IRC bridge requests message tags, parses bounded buffers, and deduplicates message IDs.

After joining, Couchkin sends an IRC health probe and requires the matching acknowledgment within 15 seconds. It checks again 30 seconds after each acknowledgment. A missed check triggers reconnection; an acknowledgment proves the transport is responding, not that chat messages were delivered. The session's receipt count remains the message-delivery check. Private, bounded diagnostics record probe results and message counts without message text, usernames, channel names, or tokens.

Established connections retry after interruptions or Twitch-requested reconnects at 1, 2, 4, 8, and 16 seconds. Five failed attempts stop recovery and request manual reconnection; a successful probe resets this retry budget. Disconnect cancels pending retries and checks. Messages missed while disconnected are not replayed.

On October 26, 2026, guest IRC joined the user's channel and actual Twitch messages reached both the earlier Codex and packaged Live voice paths. These were incoming-chat tests, not evidence of Couchkin sending text. See the [verification record](verification.md).

Guest access is not documented in Twitch's current authentication guide; it remains a prototype compatibility path. Twitch recommends EventSub for reading and its API for sending. The sender now uses that API; migrating the reader to `channel.chat.message` over EventSub remains future work. [Twitch migration guide](https://dev.twitch.tv/docs/chat/irc-migration/), [installed chatbot authentication](https://dev.twitch.tv/docs/chat/authenticating/).

## Regression checks

`npm test -- tests/twitch.test.ts` covers parsing, guest listening, authenticated identity/scope checks, threaded API sends, confirmed versus dropped delivery, automated-reply echo suppression while preserving real broadcaster messages, invalid text, sanitized failures, cancellation, token revocation, periodic validation, and health checks across idle or stalled connections. These tests use local fixtures; they do not connect to Twitch or post messages.

Device sign-in and controller reply-policy checks are separate from transport tests. Run the full `npm run check` before packaging. Real authorization, posted-message appearance, moderation behavior, and cooldown behavior in an actual channel still require an end-to-end rehearsal.
