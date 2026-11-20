# Simple GLB Editor

A free desktop editor for `.glb` 3D models (Windows): fix broken models, give them a skeleton, animate them, paint them, or build new ones from blocks, Blockbench-style. Every button explains itself in plain English when you hover over it.

- **Repair**: move points and edges, weld cracks, delete or make faces, one-click **Clean up** for AI-made models.
- **Rig**: drop in a stick-figure skeleton (or draw your own), fit it to the model, bind the skin, make a walk cycle.
- **Animate**: keyframes on a timeline, looped playback, copy animations between models, expression frames, slide joints.
- **Paint**: brush, smudge and blur straight onto the model, or pixel-paint block sides.
- **Build**: make models from cubes, cylinders, spheres and more; group parts into joints, mirror, combine, cut holes, hollow; open and save Blockbench `.bbmodel` files; switchable clothing layers; game colliders.
- **Export**: `.glb` with skeleton and every animation, and **sprite sheets** (PNG + JSON for Phaser, PixiJS, Godot / Unity importers).
- **Tabs** for several projects at once, light and dark themes, a read-only **watch page** for a phone or a second screen.
- **Works with AI**: an optional Claude Code panel inside the editor, and an MCP server so AI assistants can drive the editor (see below).

## Download

Get `SimpleGLBEditor.exe` from the **Releases** page and double-click it: no installer. You can also drag a `.glb` onto the exe, or use *Open with → SimpleGLBEditor.exe*.

## Quick start

- **Library**: your models live in the `Library` folder next to the exe (📚 Library ▾ → *Change library location…* to move it). Double-click a model, or drag it into the 3D view, to open it; drag `.glb` files in from Explorer to import them. **File → Save into the library** writes into the folder picked in the library window.
- **Mouse**: middle-drag turns the view, right-drag slides it, wheel zooms, left-drag on empty space draws a selection box. Change the buttons in **⌨ Keys**.
- **Shortcuts**: every one can be changed in **⌨ Keys** (Ctrl+K): click a key, press the new one.
- **Windows**: Tools, Scene, Animations and Library can be popped out, moved, resized from any edge, and docked back by dragging them to the left or right edge of the screen. **View → Arrange the buttons…** lets you move the toolbar buttons and group them into your own menus.
- Hover over anything for a plain-English explanation and its shortcut. Press **?** for help.

1. **Open** a `.glb`, pick one from the **Library**, or use **File → Load the test dummy**.
2. **Bone** mode → **Stick figure**, or **Draw bones** and click joints into the model. Drag joints to fit.
3. **Bind** (Ctrl+B) attaches the model's surface to the skeleton.
4. **Tab** into Animate, move along the timeline, turn joints (keys are saved automatically). **Close loop**, **Loop** on, **Space** to play.
5. **File → Save into the library**.

Fixing a bad download: **Vertex** / **Edge** mode: pick, drag the arrows to move, **J** attach (snap together), **U** detach (pull apart), **Merge close points** to weld cracks, **Del** delete faces, **N** make a face.

## Claude and other AI assistants (optional)

- **Claude panel**: click **🤖 Claude** (top right) or press **Ctrl+`** to chat with [Claude Code](https://claude.com/claude-code) inside the editor. Install Claude Code first, then use **▾ → Sign in** with a Claude subscription or an Anthropic API account (the sign-in happens in your browser; the editor never sees your password or key). Claude works on your models in its own tab while you watch, and its questions show up as buttons.
- **Other AI assistants**: the panel is plugin-based. Claude Code is the built-in plugin; add another command-line assistant by dropping a small `.json` file into `%APPDATA%\simple-glb-editor\agents` (see [agents/README.md](agents/README.md)), then pick it in the **▾** menu.
- **MCP server**: `mcp/server.mjs` lets AI assistants that speak the [Model Context Protocol](https://modelcontextprotocol.io) open, edit, build, screenshot and save models in the running editor. For Claude Code: `claude mcp add -s user simple-glb -- node "<editor folder>\mcp\server.mjs"`. The full scripting API is in [CLAUDE.md](CLAUDE.md).

## Building from source

Needs [Node.js](https://nodejs.org) (20 or newer).

```
npm install
npm start                      # run the app without packaging
npm run dist                   # build dist\SimpleGLBEditor.exe
node scripts/selftest.mjs      # drive every major feature in a hidden copy and report pass / fail
```

`npm run server` serves the editor at http://localhost:5178 for working in a browser (the Claude panel needs the desktop app).

## License

Simple GLB Editor is licensed under the **[PolyForm Small Business License 1.0.0](LICENSE.md)**:

- **Free** for individuals, hobbyists, indie developers and companies with **fewer than 100 people and under about US$1 million revenue** in the previous year, including commercial work. What you make with the editor (models, games, assets) is yours.
- **Bigger companies** need a separate commercial license: please get in touch through this repository.

It is built on open-source components (three.js, three-mesh-bvh, three-bvh-csg, xterm.js, node-pty, qrcode-generator, Electron), all under the MIT license; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Not affiliated with or endorsed by Anthropic or Blockbench.
