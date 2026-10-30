<!-- Hallmark · pre-emit critique: P4 H4 E4 S5 R4 V4 -->
# Couchkin readability and setup review

October 26, 2026. Scope: improve the existing desktop workbench and its OBS overlay. The established cream/moss palette, DM Sans/Fraunces pairing, routes, and component ownership are preserved. This is a focused audit followed by the user's requested fixes, not a new marketing-page design.

## Baseline findings

Locations below refer to the initial implementation in commit `73713b6`.

| Severity | Tell | Where | Correction |
| --- | --- | --- | --- |
| Critical | Tiny interface type | `src/renderer/src/styles.css:105`, `:190`, `:210`, and repeated 7–12 px metadata | Use 16 px normal controls and body text; 14 px supporting text. |
| Critical | Low-contrast supporting copy | `src/renderer/src/styles.css:16` and connection/capture helper text | Darken muted text and provide a stronger control-boundary token. |
| Major | Decorative hierarchy ahead of the task | `src/renderer/src/App.tsx`, companion page heading | Remove the oversized two-line welcome and ornamental player stamp; retain a compact, specific heading. |
| Major | Connection inventory without a sequence | `src/renderer/src/App.tsx`, Connections | Add Codex → Game → Overlay → Chat progress, ordered panels, and direct local-OBS/overlay actions. |
| Major | Broadcast status implied without evidence | `src/renderer/src/App.tsx`, topbar | Use “Companion active” and “Ready to hang out”; Couchkin's session is distinct from Twitch broadcasting. |
| Major | Narrow viewport assumptions | `src/renderer/src/styles.css:40` and responsive blocks | Remove the 360 px floor, reflow navigation/columns, and keep labels readable at 320 px. |
| Minor | Color/font values scattered through styles | `src/renderer/src/styles.css` | Put interface and companion-art palettes, fonts, type, spacing, and motion values in root `tokens.css`. |

Baseline: **2 critical · 4 major · 1 minor**. All seven received targeted corrections.

## Resulting flow

1. Create a companion. Attribute previews remain immediate, and original image generation stays optional.
2. Connect the existing Codex login, then use **Connect local OBS**. Manual connection details are tucked into an optional disclosure.
3. Choose the original game input. The session view distinguishes missing connection, missing source, and readiness for its first screenshot.
4. Use **Add to OBS**, or copy the Browser Source URL. The overlay step reflects the actual playback connection; opening the silent preview does not falsely complete it.
5. Enter a Twitch channel and **Listen to chat**. Public read-only chat is the default; account/token fields are optional. The app explains that it does not post to Twitch.

The overlay uses a compact 224 px portrait cameo, a 28 px safe inset at 1080p, and 22 px captions. Its root, body, and React container are transparent so it does not cover the game with an opaque page background. Character expression and motion remain distinct from interface transition effects.

## Verification

- **20 rendered views checked:** all four routes at 1440, 768, 414, 375, and 320 CSS pixels. No page-width overflow, no overflowing visible elements, and no visible text below 14 px in those views.
- **Contrast sweep:** enabled visible text on all four default route states had a minimum measured WCAG ratio of **4.59:1**, using rendered foreground and nearest solid background colors. This is a targeted contrast check, not a complete WCAG conformance claim; disabled controls and character artwork were excluded.
- **Visual inspection:** desktop creator/connections and the 320 px connections view were reviewed. Slider and switch geometry were corrected after increasing control hit areas.
- **Transparency:** a 1920 × 1080 overlay screenshot with background omitted had alpha 0 at the canvas corner, game center, and a point outside the cameo. The nontransparent bounds were limited to the cameo and disconnected label.
- **State corrections:** real integration feedback drove the connected-but-not-yet-captured empty state, actual overlay readiness, and companion/broadcast status wording.
- **TypeScript:** typecheck passes with the new local OBS and overlay commands.

Relevant Hallmark gates reviewed: type hierarchy and measure; text/control contrast; immediate focus outlines; transform/opacity transitions; reduced motion; semantic tokens; honest state copy; no fabricated chrome/metrics; reflowing grids; long-heading wrap; and the 320/375/414/768 viewport floor. Marketing-page rotation, hero enrichment, nav/footer archetypes, and studied-DNA gates are not applicable to this in-place desktop-app review. No blanket “69/69” claim is made.

The pre-emit scores are editorial judgments: Philosophy 4, Hierarchy 4, Execution 4, Specificity 5, Restraint 4, Variety 4. Existing character identity and app structure were preserved deliberately.

## October 30: quick picks and personality controls

Component-scope extension using the existing cream/moss palette, readable typography and character renderer. The companion page now opens with four complete presets and a current-companion strip; the full editor is behind **Customize**. Selection stages a draft, **Use [name]** saves and navigates, and live voice starts separately. Existing custom companions remain selected until explicitly replaced.

Six personality choices expose a short behavioral description and a clearly labeled scripted response to the same 1-HP overkill scenario. The stage introduction updates with the selected personality. The nonproduction `PersonalityPicker.preview.tsx` demonstrates default, hover, focus, active, disabled, loading, error and success states. Controls retain keyboard focus, pressed-state semantics, 44px minimum targets and reduced-motion behavior.

Browser checks passed at 1360, 768, 414, 375 and 320px with no horizontal overflow or clipped option labels. Minimum contrast across 31 new text surfaces was 5.35:1. The primary save-and-navigate flow and all six examples worked without external requests or session-start commands. The packaged Mac layout was also inspected, including a draft preset, personality change, and restoration of the saved companion. See [quick picks](../output/screenshots/quick-picks-desktop.png) and [customization](../output/screenshots/personality-customize-desktop.png); these saved images are browser previews, not recordings of model output.

## October 30: memory controls

Shared memories now provides an automatic-memory switch, a quiet saving/error status, and a manual note form beside the existing forget controls. Failed manual saves retain the draft; failed deletion retains the note. Off and empty states explain the available next action. Browser fixture checks passed at 1360, 768, 414, 375 and 320px without overflow or browser errors; no external requests or session-start commands were made by those checks. The packaged app was separately checked for manual-note persistence across restart and a real automatic save. [Desktop](../output/screenshots/shared-memories-desktop.png) and [narrow](../output/screenshots/shared-memories-mobile.png) screenshots show the fixture interface.
