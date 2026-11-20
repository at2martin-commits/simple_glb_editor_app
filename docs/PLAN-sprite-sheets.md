# Plan: sprite sheets (for later)

Turn a rigged, animated model into 2D sprite sheets: every frame of chosen animations, from chosen directions, packed into a
PNG + a JSON file a 2D game engine can read. Status: **built** 2026-11-20 (see CLAUDE.md "Sprite sheets").

## What it does
- **Export > Sprite sheet…** window with a live preview: pick animations, directions, frame size, frames per second, style.
- Output into the Library: `Library/Sprites/<model>/<model>.png` + `<model>.json` (or one sheet per animation).
- Same thing from scripts / MCP through `glb_run`: `await editor.renderSprites({...})` (no new MCP command — keep it lean).

## Options
- **Animations**: any clips (default all); expression frames and slide joints play as they do in the editor.
- **Directions**: 1, 4 or 8 around the character (front, back, left, right, diagonals), or a list of angles.
- **Camera**: orthographic (no perspective — standard for sprites); preset angles: side-on, 3/4 top-down (RPG), isometric (2:1); custom elevation.
- **Frame size**: e.g. 32, 48, 64, 128 px (square or W×H); **fps**: 8 / 12 / 24 (frames sampled from each clip's length).
- **Framing**: one fixed box for ALL frames of a direction (fitted over the whole animation), feet on a fixed baseline, so nothing jitters
  between frames; pivot point (feet centre) written into the JSON.
- **Style**: smooth (anti-aliased) or pixel art (render at the target size, nearest filtering, optional 1-px dark outline, optional
  palette limit to the model's own colours — our Build-mode models are already palette-based); flat lighting option.
- **Background**: transparent (default) or a colour.
- **Packing**: grid (rows = directions, columns = frames) — simplest for engines; optional trim of empty space with offsets kept in the JSON.

## Output formats
- PNG sheet(s) + JSON in a common shape: TexturePacker "hash" (works with Phaser, PixiJS, many others) and Aseprite-style
  `frameTags` per animation/direction (Godot / Unity importers exist). Optionally also loose PNGs per frame and an animated GIF preview.

## How (tech)
- Offscreen `WebGLRenderTarget` + `OrthographicCamera`; for each clip × direction × frame: `editor.setTime(t)` (frame keys and slide
  joints apply), render, `readPixels` → canvas. Fit box: union of the model's world bounds over all sampled frames of that direction.
- Pixel-art outline: alpha edge pass on the frame canvas. Palette limit: snap to the atlas colours.
- Packing on a 2D canvas → PNG via `toBlob`; JSON built alongside; saved with the existing library PUT.
- Clothing layers: render with the layers that are switched on (preview what the sheet will show); optional "one sheet per outfit".

## Steps
1. `editor.renderSprites(opts)` core: sampling, fixed framing, grid packing, PNG + JSON into the Library.
2. Export window with live preview (frame scrubber, direction picker) and the options above.
3. Pixel-art mode (nearest, outline, palette), trim + offsets, GIF preview.
4. Docs in CLAUDE.md (glb_help), test with toon_base_f (37 clips) and a Phaser/Godot import.

## Questions to settle when we start
- Which engine / format first (Phaser, Godot, Unity, Aseprite)?
- How many directions (4 or 8) and which camera angle (side-on, 3/4, isometric)?
- Pixel art or smooth, and what frame size?
