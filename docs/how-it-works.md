# How Couchkin works

Couchkin runs the desktop app, stream overlay, device connections, settings, and saved memories on your computer. OpenAI handles the selected model tasks in the cloud. You do not need to deploy a Couchkin server.

~~~mermaid
flowchart LR
  subgraph Computer["Your computer"]
    Mic["Selected microphone"]
    Game["OBS game input"]
    App["Couchkin desktop app"]
    Memory["Local settings and memories"]
    Overlay["Animated character, captions, and audio"]
    Broadcast["Your OBS stream"]
    Mic -->|"audio when enabled"| App
    Game -->|"selected screenshots"| App
    Memory <-->|"reviewable local state"| App
    App --> Overlay
    Overlay --> Broadcast
  end
  subgraph OpenAI["OpenAI API"]
    Live["GPT-Live conversation"]
    Responses["Vision, research, memory suggestions, public chat text"]
  end
  Chat["Twitch chat"]
  App -->|"voice and selected context"| Live
  Live -->|"voice and transcript"| App
  App -->|"bounded task inputs"| Responses
  Responses -->|"observations and results"| App
  Chat -->|"incoming viewer messages"| App
  App -->|"optional authenticated replies with cooldown"| Chat
~~~

**Following the game:** OBS supplies screenshots of the chosen game input. Optional periodic observations and speech-triggered refreshes update the voice companion's context. Stale observations are discarded. This is sampled visual context, not a continuous video feed or a guarantee of instant game understanding.

**Talking and reacting:** GPT-Live supports natural voice conversation. The desktop app coordinates playback, captions, and character expressions. Quiet, Pause, and microphone controls remain with the streamer. The OBS Browser Source carries the companion to the stream; Couchkin does not start broadcasts.

**Letting chat join in:** incoming Twitch chat can inform the spoken companion. Public text replies are composed separately from the game title, addressed viewer message, personality, and recent public replies. That request excludes private voice transcripts, saved memories, and current game frames. Replies use Twitch's authenticated send API and share a cooldown with chat-triggered spoken responses.

**Remembering useful moments:** the app can extract a small number of game preferences or streamer-confirmed shared moments from settled direct dialogue. Accepted notes stay locally and can be reviewed, added manually, disabled, or deleted. Viewer chat is not accepted as memory evidence.

**Where Codex fits:** Codex was used to build and iterate on the application. An optional Codex CLI/app-server connection also provides original character artwork and the earlier conversation mode. The default live voice and Responses requests use the OpenAI API, not a ChatGPT subscription.

## Platform status

The app is built with Electron and React. The current release is tested on macOS; Windows support is not yet established. Most network and UI components are portable, but Windows needs fixes and verification for path containment in the packaged overlay/artwork, OBS configuration discovery, optional Codex executable discovery, microphone behavior, and installer packaging. Mac system voices are not a Windows speech implementation. This source release does not promise a working Windows package.

## What the repository images show

- Native app screenshots show the current packaged desktop interface without starting a paid session.
- Browser-fixture previews show implemented controls with demonstration data.
- Generated artwork is labeled as illustration or concept art, not a screenshot of the product operating on Twitch.

See [visual provenance](../output/README.md) and [verification](verification.md) for the boundaries of each kind of evidence.
