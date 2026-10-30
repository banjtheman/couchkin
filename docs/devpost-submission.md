# Couchkin — Devpost submission copy

Prepared October 30, 2026. The sections below match the submission fields. The demo-video link and personal eligibility confirmations still need to be completed. Readiness notes at the end are not submission copy.

## Project name

Couchkin

## Elevator pitch

A tiny AI cohost with big opinions. Couchkin follows your game, banters in a natural voice, and brings Twitch chat into the bit—with a personality you choose.

## About the project

[Copy the standalone About section](devpost-about.md) to use Devpost's exact seven headings.

### Inspiration

I wanted a stream companion that felt like my best friend sitting next to me on the couch: celebrating a ridiculous win, questioning my terrible decisions, and becoming part of the joke.

The visual inspiration was the little companion character in an RPG—the expressive face in the corner that makes an adventure feel shared. For Twitch, that character could become part of the show. It should have opinions, remember shared moments, and give viewers someone else to play off.

That became Couchkin.

### What it does

Couchkin is an Electron desktop app that puts an animated AI companion on your stream through OBS. The current release is tested on macOS; Windows support still needs compatibility fixes and verification.

Choose a ready-made companion, such as playful Pip or trash-talking Riff, or customize your own. Personality, talkativeness, backseat energy, appearance, and voice help shape the relationship.

Your companion can follow a selected game source, talk with you in a natural voice, react with expressions, and draw on saved game preferences and shared moments. Twitch viewers can address the companion to join the conversation. Optional text replies use the signed-in Twitch account, a character-name prefix, and a configurable cooldown.

The streamer stays in control: choose the microphone and game input, turn memories or chat replies off, and pause the companion whenever needed.

### How we built it

I built Couchkin with OpenAI Codex, using it to develop the application, connect the integrations, review the interface, write regression tests, and investigate problems discovered during gameplay.

The desktop app uses Electron, React, and TypeScript. OBS WebSocket supplies screenshots from the chosen game input, while a local browser overlay displays the character, captions, and audio.

OpenAI GPT-Live handles natural voice conversation. The Responses API supports game understanding, research, memory extraction, and short public chat replies. Screen context uses sampled images and speech-triggered refreshes; it is not continuous video.

Twitch IRC brings incoming chat into the experience, and the Twitch API sends authenticated text replies. Codex CLI integration also supports original character artwork and the earlier conversation mode.

Settings and saved memories live on the streamer's computer. Voice and selected context still go to OpenAI for processing.

### Challenges we ran into

The hardest part was timing. An answer can sound intelligent and still feel wrong if it describes a screen that has already changed. I added speech-triggered frame refreshes, discarded stale observations, and separated quiet screen understanding from spoken reactions.

Audio introduced another set of problems: OBS and Couchkin could listen to different microphones, and overlay playback needed clear ownership to avoid doubled sound. An explicit microphone picker, input-level feedback, and separate connection states made those problems easier to diagnose.

Personality also required more than a label. Riff needed permission to tease, but also enough restraint to leave room for the streamer and stop when asked.

### Accomplishments that we're proud of

The strongest milestone was playing Slay the Spire 2 with a companion that could follow along and feel like company. In a later 18-minute Riff rehearsal, the lag felt manageable and the session ended with an intentional pause. That was encouraging evidence for the experience I wanted, while longer-session reliability still needs work.

Couchkin now brings voice, game context, an animated OBS overlay, distinct personalities, and local memories into one desktop app. The source passes 358 automated tests, plus type checking and a production build, including from a clean installation.

### What we learned

A convincing companion depends as much on when it speaks as on what it says. Fresh context, selective reactions, and room for the streamer matter more than filling every silence. Personality also has to shape the actual conversation: a trash-talking couch buddy should behave differently from a helpful guide.

Real gameplay exposed problems that a scripted demo missed, from the wrong microphone to stale observations and interrupted connections. Useful diagnostics and small, repeatable tests helped turn those experiences into concrete improvements.

### What's next for Couchkin

The immediate priority is a complete Twitch rehearsal: viewer interaction, the audience's audio mix, memory behavior, and a longer session together. After that, I want to improve onboarding, expand expressive character artwork, and complete the compatibility fixes, packaging, and testing needed for Windows.

## Built with

Suggested tags (18; use the closest available Devpost tag names):

OpenAI Codex, OpenAI API, GPT-Live, Responses API, Twitch API, Twitch IRC, OBS Studio, obs-websocket, Electron, React, TypeScript, Node.js, WebSockets, Web Audio API, CSS, Zod, Vitest, Playwright

## Try it out links

- **Source code:** https://github.com/banjtheman/couchkin
- **Run it from source:** https://github.com/banjtheman/couchkin#run-from-source
- **Let Codex help with setup:** https://github.com/banjtheman/couchkin/blob/main/docs/codex-setup-prompt.md

Couchkin is a desktop prototype, not a hosted browser demo. Live features require the streamer's own OpenAI API key and OBS; API usage is billed separately from a ChatGPT subscription. Source setup instructions are in the README.

## Demo video URL

**Pending: record and upload the real demonstration to YouTube, then replace this line with its URL.**

Use public or unlisted visibility, without a password. Keep all judged material within three minutes. Include real footage of Couchkin working on Twitch and footage showing how Codex was used to build it. The image gallery does not replace this requirement.

## Code repository URL

https://github.com/banjtheman/couchkin

## Main Codex session ID

`01a17657-f64e-79a0-b51f-71d004ee09e6`

Verified against the main build chat, **Research Twitch co-host hackathon**, rather than an image-generation subthread or Couchkin's own runtime session.

## Explain how your project meets the main technology requirement

I used OpenAI Codex throughout Couchkin's development to build the Electron, React, and TypeScript application; implement its OBS, Twitch, and OpenAI integrations; review the interface; write regression tests; and debug issues found during gameplay. Codex helped iterate on microphone selection, speech-triggered screen refreshes, companion personalities, memory saving, and chat-reply controls.

Couchkin connects directly to Twitch through incoming chat over Twitch IRC, authenticated outgoing replies through the Twitch API, and an OBS Browser Source that places the companion, captions, and voice on stream. OBS WebSocket provides selected game screenshots. OpenAI GPT-Live supplies the default voice conversation, while the Responses API supports screen understanding, research, memory extraction, and public chat replies.

The optional Codex CLI integration generates original character artwork through its native image-generation tool and powers the earlier conversation mode. The default live voice uses the OpenAI API; it does not run on the streamer's ChatGPT subscription.

## Explain how streamers and their community on Twitch use your project

A streamer chooses or customizes a companion, connects a game source in OBS, selects their microphone, and adds Couchkin's transparent overlay to the stream. They can talk naturally while playing, tune how talkative or opinionated the companion is, and choose whether it remembers shared game moments.

Viewers join in by addressing the companion's name or “Couchkin” in Twitch chat. Addressed messages can trigger spoken responses and, when enabled, short threaded text replies. Replies carry the companion's name, use the authorized Twitch account, and share a configurable cooldown to limit spam.

Couchkin is useful even when chat is quiet: the streamer has another personality to react to. When viewers arrive, they can help shape the conversation and become part of the bit. Pause, microphone, memory, and chat controls remain with the streamer.

## How much did this hackathon help you develop new skills or knowledge?

**Somewhat.**

Confirmed by the entrant. If the form uses different wording, select the equivalent response.

## How likely are you to use OpenAI Codex again, at work or in personal projects?

**Very likely.**

Confirmed by the entrant. If the form uses different wording, select the equivalent response.

## Eligibility confirmations — entrant must answer personally

These are deliberately unanswered. Confirm each statement for yourself and every teammate, if applicable, before submitting:

- [ ] I and all teammates are at least 18 or the age of majority where we reside, whichever is older.
- [ ] I and all teammates are from an eligible jurisdiction.
- [ ] I and all teammates are not employees, representatives, or agents of the hackathon's Promotion Entities.

Use the [official rules](https://twitchcon-codex.devpost.com/rules) to check the full eligibility requirements. This document does not make these attestations on the entrant's behalf.

## Project media — recommended gallery

Existing files below are under the 5 MB limit. The captions distinguish actual app screenshots from fixture previews. None is proof of real Twitch message delivery. A real gameplay image should be added after the Twitch rehearsal. Devpost recommends a 3:2 ratio and allows up to 15 JPG, PNG, or GIF images; fewer strong images are sufficient.

| Order | Image | Suggested caption |
| --- | --- | --- |
| 1 | Pending real Twitch gameplay screenshot | Riff on the couch: gameplay, conversation, and the animated OBS overlay. |
| 2 | [Quick picks](../output/screenshots/couchkin-app-quick-picks.png) | Pick your company: Pip, Riff, Miso, or Jinx. Actual packaged desktop app. |
| 3 | [Customization](../output/screenshots/couchkin-app-creator.png) | Shape the look, personality, and backseat energy of your companion. Actual packaged desktop app. |
| 4 | [Shared memories](../output/screenshots/shared-memories-desktop.png) | Review, add, or forget shared memories. Demonstration data shown. |
| 5 | [Chat controls](../output/screenshots/twitch-chat-replies.png) | Optional Twitch replies with account identity and a cooldown. Simulated connection status shown. |

The new [Couchkin cover](../output/imagegen/06-couchkin-cover.png) is an original 3:2 brand illustration suitable for a project cover; label it as artwork. The original [stream concept](../output/imagegen/01-stream-mockup.png) is 3:2, but it is a design illustration, not a working-stream screenshot. Use it only with that label; prefer real footage for the submission.

## Final preparation notes — do not paste into the form

- Verify an actual viewer-triggered Twitch text reply and cooldown. Authorization is verified; a real outgoing reply is still unverified as of this draft. The sending account's own messages are ignored, so use another viewer account.
- Record the complete stream loop and check viewer/VOD audio. Public text replies use a separate request with the game title and viewer message; they do not receive private voice transcripts, memories, or the current game frame.
- Replace the video placeholder and add a real gameplay gallery image. Update the story's accomplishments and next steps only with newly observed results.
- Credit the game in the YouTube description. Mega Crit's [content policy](https://www.megacrit.com/content-policy/) permits gameplay videos and requests a link to the game's store page. Use appropriate permission for any other footage or music.
- Complete eligibility confirmations and any teammate invitations personally.
- Submit before **Monday, November 2, 2026, 5 PM Eastern / 2 PM Pacific**. Confirm the entry says **Submitted**, not Draft.
- Keep the submitted repository, video, and links unchanged after the deadline until winners are announced. Continue development in a separate copy if needed.

Sources: [hackathon requirements](https://twitchcon-codex.devpost.com/), [October 30 organizer update](https://twitchcon-codex.devpost.com/updates/47341-final-weekend-make-your-project-come-alive), and the entrant's provided form fields. See [verification](verification.md) for the current evidence and limits.
