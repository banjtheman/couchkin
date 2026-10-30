# Set up Couchkin with Codex

Paste the prompt below into Codex on the computer you use for streaming. Codex needs access to a local folder and terminal. If browser or desktop control is available, it can also help with the app and OBS; otherwise it should give you precise manual steps.

The verified setup is currently macOS. Electron makes the foundation portable, but Windows has known compatibility gaps; this prompt must not turn an untested Windows installation into a claim of support. You need your own OpenAI API key for natural live voice. Never paste a key or Twitch token into the chat.

## Copy this prompt

~~~text
Help me install and set up Couchkin, an animated AI couch buddy for Twitch and OBS:
https://github.com/banjtheman/couchkin

Work through the setup with me and verify each step. Use the repository's current README, AGENTS.md if present, package files, and docs as the source of truth. Keep existing files and preferences intact. Do not just give me a list of commands when you can perform the setup yourself.

1. Inspect this computer's operating system, Node.js/npm, Git, OBS, and optional Codex CLI. Use an existing Couchkin checkout if I am already in one; otherwise clone the official repository into a suitable development folder. Do not overwrite another project or uncommitted changes. Use Node 24 LTS if available; the project requires at least 22.12.

2. Explain the platform status before starting: macOS is the tested path. On Windows, inspect the documented compatibility gaps first, including packaged overlay/artwork paths, automatic OBS discovery, system speech, Codex executable discovery, and packaging. Do not claim Windows works or silently begin a port. Explain the specific blockers and ask whether I want an experimental setup or a separate compatibility task.

3. Gather only the choices you cannot discover, preferably together: which game or OBS source I want the companion to watch, which microphone/headphones I use, my Twitch channel if I want chat, and whether I want Pip, Riff, Miso, Jinx, or a custom companion. Preserve existing choices unless I ask to change them.

4. Install the locked dependencies with npm ci and run npm run check. Report failures clearly and fix setup problems within this task. Avoid broad dependency upgrades or unrelated application changes. Use current official documentation if an installation step has changed.

5. Check whether OPENAI_API_KEY is already configured without printing its value. If not, create .env from .env.example only when .env does not already exist, then tell me how to enter my key locally. Never ask me to paste a key, OBS password, Twitch access token, or private overlay URL into chat. Never commit credentials. Confirm only that the configuration is present. Explain that live voice, vision, memory extraction, and text chat replies use OpenAI API billing separately from a ChatGPT subscription. Codex CLI login is optional for character artwork and the earlier conversation mode; help with its normal login flow if I want those features.

6. Launch Couchkin using npm run dev and confirm that its window opens. Do not start a paid voice session yet. Choose the requested companion. Use the ready-made art initially; original character generation is optional and should not block setup.

7. Open OBS if needed. On the verified Mac path, enable its WebSocket server and use Couchkin's Connect local OBS. Use manual WebSocket settings if automatic discovery is unavailable. Keep authentication enabled, use loopback for a same-computer connection, and keep the password private. Select the original game/capture input rather than a finished scene containing Couchkin. If a source is blank or ambiguous, tell me what is missing instead of substituting a private desktop or unrelated window.

8. Add Couchkin's transparent Browser Source to the intended OBS scene. Preserve an existing overlay's position and audio choices. Verify that the character appears. Keep the source active across scenes. Set up companion audio so viewers hear it once; use Monitor and Output if I want headphone playback, while avoiding duplicate desktop-audio capture. Treat the pairing URL as private. A silent overlay preview is not proof that viewers can hear the voice.

9. In On the couch, select the intended microphone and check macOS microphone permission. Explain that OBS's microphone selection does not select Couchkin's microphone. Help me grant the normal OS permission myself if necessary. Set the game title and explain Look at the game, automatic watching, Pause, and Quiet. Screen understanding uses sampled screenshots, not continuous video.

10. If I want Twitch chat, enter my channel. Guest Listen to chat is read-only. For text replies, use Sign in to reply with Couchkin's bundled public app ID. Let me complete Twitch authorization in my browser. Make the posting account explicit: the character name does not create a separate Twitch account. Enable text replies only if requested, using a 45-second cooldown initially. The sending account's own messages are ignored, so an addressed-message test requires another viewer account.

11. When setup is ready, explain the short paid voice test and ask me to say when I am ready. Then start the session, enable the intended microphone, and verify that I can speak to the companion and hear it. Check a current game frame and that the overlay/audio routing remains correct. For chat, verify an actual viewer-triggered reply and the cooldown when another viewer is available. Distinguish app state, observed delivery, and my report of what I heard; do not infer a successful broadcast from a moving meter alone.

12. Never start a public broadcast or recording without my explicit instruction. Stop or pause the paid session after the test unless I ask to keep playing. Finish with a short status: what is verified, what still needs my action, the exact way to launch next time, and any unresolved issue. Do not claim a test passed if it was skipped or simulated.

If you cannot operate a required UI, give me the exact current screen/control and continue the independent setup work. Keep secrets, private conversations, screenshots, and logs out of Git.
~~~

## Useful follow-up

Once setup is complete, a short request such as “Open Couchkin for my next session, check OBS and the selected microphone, and leave it ready for me to start” is enough. Twitch credentials are held only in memory, so restarting the app requires Twitch sign-in again for posting.

See [first-session instructions](../README.md#your-first-session), [how it works](how-it-works.md), [voice troubleshooting](live-voice.md), and [Twitch setup](twitch-chat.md).
