# Project Couch visual concepts

Date: 2026-10-26. Project Couch is a temporary label. All images are illustrative concepts, not screenshots of a working application.

Generation path: built-in image_gen.imagegen tool. The requested imagegen CLI was not invoked because OPENAI_API_KEY was absent; no credential was requested or exposed. Built-in model, quality and pixel size are tool-managed. transparent_background=false for all images.

Follow-up from the parent chat: `04-theme-attribute-creator.png` visualizes the user's theme-and-attribute request. It uses the creator-controls and character-exploration images as references, preserves the visual family, and shows theme, shape, palette, eyes, and accessory choices. Generated with the same built-in tool and `transparent_background=false`; inspected for readable controls and consistent character identity. The exact prompt is in `04-theme-attribute-creator-prompt.txt`. These concepts are illustrations, not working UI. Image 04 is a 1536 × 1024 PNG, copied unchanged.

Creative direction: warm ivory, graphite, moss green, terracotta; small expressive original companions; game-first stream composition. POCKET BOT connects the three concepts. Research and technical-plan files are unchanged.

## Final outputs

1. 01-stream-mockup.png — lower-left compact character, original gameplay, brief spoken caption.
2. 02-creator-controls.png — character preview and creator/session controls.
3. 03-character-exploration.png — orb, sprite, pocket bot; four emotional poses each.

The character sheet is generated first. It then serves as the visual identity reference for the other two concepts.

All three final images are 1536 × 1024 RGB PNGs. Exact prompts are saved in `prompts.json` under `stream`, `creator`, and `character`. New character generation used no reference. Stream and creator calls each used `referenced_image_paths=["output/imagegen/03-character-exploration.png"]`. Each concept was generated once, visually inspected, and accepted without editing. Files are unmodified copies of the built-in tool's output.

| File | Prompt focus | Visual inspection |
| --- | --- | --- |
| 01-stream-mockup.png | Original broken-bridge gameplay; lower-left pocket bot; “We can make that. Probably.” | Caption readable, visible bridge gap, compact corner reaction, clear illustrative label. |
| 02-creator-controls.png | Warm desktop UI with character preview, name, voice, personality, separate talkativeness/backseating sliders, game/source selection, OBS and Twitch status | Requested controls present and legible; character identity consistent; illustrative label present. |
| 03-character-exploration.png | Original orb, sprite and pocket bot in watching, hyped, skeptical and oops poses | Three designs × four poses; labels correct; complete silhouettes; restrained consistent palette. |



`05-native-codex-character.png` is an original transparent PNG generated through the installed Codex app-server using ChatGPT subscription authentication during the runtime proof. It demonstrates the image-generation path; it is not the default attribute-controlled character.
