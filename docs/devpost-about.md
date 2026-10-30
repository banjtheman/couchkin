## Inspiration

I wanted a stream companion that felt like my best friend sitting next to me on the couch: celebrating a ridiculous win, questioning my terrible decisions, and becoming part of the joke.

The visual inspiration was the little companion character in an RPG—the expressive face in the corner that makes an adventure feel shared. For Twitch, that character could become part of the show. It should have opinions, remember shared moments, and give viewers someone else to play off.

That became Couchkin.

## What it does

Couchkin is an Electron desktop app that puts an animated AI companion on your stream through OBS. The current release is tested on macOS; Windows support still needs compatibility fixes and verification.

Choose a ready-made companion, such as playful Pip or trash-talking Riff, or customize your own. Personality, talkativeness, backseat energy, appearance, and voice help shape the relationship.

Your companion can follow a selected game source, talk with you in a natural voice, react with expressions, and draw on saved game preferences and shared moments. Twitch viewers can address the companion to join the conversation. Optional text replies use the signed-in Twitch account, a character-name prefix, and a configurable cooldown.

The streamer stays in control: choose the microphone and game input, turn memories or chat replies off, and pause the companion whenever needed.

## How we built it

I built Couchkin with OpenAI Codex, using it to develop the application, connect the integrations, review the interface, write regression tests, and investigate problems discovered during gameplay.

The desktop app uses Electron, React, and TypeScript. OBS WebSocket supplies screenshots from the chosen game input, while a local browser overlay displays the character, captions, and audio.

OpenAI GPT-Live handles natural voice conversation. The Responses API supports game understanding, research, memory extraction, and short public chat replies. Screen context uses sampled images and speech-triggered refreshes; it is not continuous video.

Twitch IRC brings incoming chat into the experience, and the Twitch API sends authenticated text replies. Codex CLI integration also supports original character artwork and the earlier conversation mode.

Settings and saved memories live on the streamer's computer. Voice and selected context still go to OpenAI for processing.

## Challenges we ran into

The hardest part was timing. An answer can sound intelligent and still feel wrong if it describes a screen that has already changed. I added speech-triggered frame refreshes, discarded stale observations, and separated quiet screen understanding from spoken reactions.

Audio introduced another set of problems: OBS and Couchkin could listen to different microphones, and overlay playback needed clear ownership to avoid doubled sound. An explicit microphone picker, input-level feedback, and separate connection states made those problems easier to diagnose.

Personality also required more than a label. Riff needed permission to tease, but also enough restraint to leave room for the streamer and stop when asked.

## Accomplishments that we're proud of

The strongest milestone was playing Slay the Spire 2 with a companion that could follow along and feel like company. In a later 18-minute Riff rehearsal, the lag felt manageable and the session ended with an intentional pause. That was encouraging evidence for the experience I wanted, while longer-session reliability still needs work.

Couchkin now brings voice, game context, an animated OBS overlay, distinct personalities, and local memories into one desktop app. The source passes 358 automated tests, plus type checking and a production build, including from a clean installation.

## What we learned

A convincing companion depends as much on when it speaks as on what it says. Fresh context, selective reactions, and room for the streamer matter more than filling every silence. Personality also has to shape the actual conversation: a trash-talking couch buddy should behave differently from a helpful guide.

Real gameplay exposed problems that a scripted demo missed, from the wrong microphone to stale observations and interrupted connections. Useful diagnostics and small, repeatable tests helped turn those experiences into concrete improvements.

## What's next for Couchkin

The immediate priority is a complete Twitch rehearsal: viewer interaction, the audience's audio mix, memory behavior, and a longer session together. After that, I want to improve onboarding, expand expressive character artwork, and complete the compatibility fixes, packaging, and testing needed for Windows.
