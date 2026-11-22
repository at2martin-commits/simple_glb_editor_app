# Simple GLB Editor

Desktop .glb editor (three.js 0.160, no build step). Modes: Object, Vertex, Edge, Bone, Draw bones, Paint, Build (Blockbench-style modelling). Look & feel matches the author's Claudio Editor (an audio editor): same palette, two toolbars, a menu line without accelerators (under a logo + name row: the author's house style), rebindable keys, floating resizable windows, plain-English tooltips. Rig with a stick-figure skeleton, edit vertices/edges, attach/detach points and joints, keyframe animation with looped playback, export .glb.

- Delivered as a desktop exe (Electron, portable): `SimpleGLBEditor.exe` in the project root. `npm run dist` rebuilds → `dist\SimpleGLBEditor.exe` (copy to root). `npm start` = unpackaged Electron.
- NEVER Stop-Process the user's running editor. Builds go to dist\ and don't need it closed; ask before replacing the root exe.
- `main.js` — Electron entry; embeds `server.js` on 127.0.0.1:<random port> with hooks (Recycle Bin, Explorer, folder picker); the menu line is in the page (house style, like Hollow Editor: logo + name row, then File … Help with the Claude button on the right, then the toolbars): `menuTemplate()` in main.js is the one list (IPC `menu:get`, re-read on each open so ticks are current; items with an `id` run `glbAction`-style through the click handler, so shortcuts show and the session-tab lock greys them; `run` items = quit / watch / watchLan / full / devtools via `menu:run`); no Windows menu bar (`Menu.setApplicationMenu(null)`), and in a plain browser (`npm run server`) the line has only the Claude button; a .glb on the command line opens via `?open=<path>`. Settings in %APPDATA%/simple-glb-editor/settings.json.
- Library = `Library/` next to the exe (project folder when run from dist\); user can relocate it. Dev/automation: `npm run server` → http://localhost:5178 (preview `glb-editor`), same `Library/`, settings in `.settings.json`.
- `server.js` — static files + `/api/lib/*` (list, file GET/PUT, mkdir, rename, move, delete, reveal, chooseRoot), `/api/settings`, `/api/local?path=`.
- Front end: `src/ui.js` (ACTIONS list = every command: id, label, plain-English help, default keys), `src/keys.js` (Claudio-style keymap + editor), `src/panels.js` (dock left/right or float; drag to screen edge to dock), `src/library.js`, `src/settings.js`. Run any command: `glbAction('modeBone')`. `window.panels` controls windows.
- Mouse: middle-drag orbits, right-drag pans, wheel zooms, left-drag on empty space box-selects (`editor.setMouseButtons(rotate, pan)`; saved under settings.mouse).
- three.js is vendored into `vendor/three` (`scripts/vendor.js`, runs in `npm run dist`) because electron-builder strips `node_modules/**/examples`.
- Electron binary unzip fails under Node 26: if `node_modules/electron/dist/electron.exe` is missing, Expand-Archive the zip from `%LOCALAPPDATA%\electron\Cache` into it and write `electron.exe` to `node_modules/electron/path.txt`.
- `src/editor.js` — all 3D logic (class `Editor`).
- URL params: `?dummy`, `?load=Folder/name.glb` (library path).
- **Self-test**: `node scripts/selftest.mjs` (app from source, hidden; `--exe <path>` for a packaged build, `--json out.json` for timings) drives every major feature in its own copy; it only writes Library/_selftest (removed after). Run it after any change, and before packaging. Output follows the author's Test Bench rules (`== part ==`, `PASS` / `FAIL name   reason`, `-- part: N passed, M failed`, `SUITE:`); parts are listed in `testbench.json` (name them to run only those: `node scripts/selftest.mjs tabs "AI panel"`; each part runs on its own, 2-minute limit, heavy parts wait for 4 GB free). **Test Bench**: `python scripts/testbench.py` (window on http://127.0.0.1:8798, `--no-browser` = server only) / `python scripts/testbench.py run [part…]` / `last`: the editor's own copy of the bench (own port, lock and history in scripts/.testbench/).

## Driving it from automation (preferred over clicking)

`window.editor` is the Editor. Use the browser `javascript_tool` and read results as JSON; take a screenshot only to check visuals. Every mutating method is a single undo step; errors are thrown with a readable message.

```js
await editor.load('Folder/name.glb') // library path (or '/url', File). editor.loadDummy() for a test figure
editor.info()                        // {meshes, bones[{name,parent,world}], clips, selection, undo} — start here
editor.newProject(name?)             // File > New project (Ctrl+N): empty scene, no clips, fresh Build project, no undo
await editor.save('out', 'Folder')   // writes Library/Folder/out.glb (overwrites); editor.listFiles(); editor.download()

// Rig
editor.setMode('bone')               // 'object' | 'vertex' | 'edge' | 'bone' | 'draw' | 'paint' | 'build'
editor.stickFigure()                 // humanoid skeleton fitted to bbox (Hips, Spine, Chest, Neck, Head, *_L/_R arms+legs)
editor.addBone(name|null, parentName|null, [x,y,z])   // world position; parent null = new chain
editor.setBonePosition('Hand_L', [x,y,z])             // edit mode: moves rest joint, mesh stays put
editor.attachBones(['Child'], 'Parent'); editor.detachBones(['Child']); editor.deleteBones(['X']); editor.rename('Old','New')
editor.childrenFollow = false        // move a joint without dragging its children
editor.fitSkeleton()                 // humanoid joints read off the model's shape (src/autorig.js landmarks)
editor.bind()                        // skin weights measured along the surface (default; {method:'distance'} = old); clears undo history
                                     // bones only claim skin they can "see" through the body; *End joints don't reach past their tip
editor.makeWalk({frames:24})         // looping in-place walk on the humanoid names: leg IK, bends, arm swing, head bob
editor.makeWalk({style:'tough'})     // walk styles live in autorig.js WALK_STYLES ('normal' default, 'tough' swagger); any option overrides
                                     // feet: planted soles stay flat/untwisted; a skin check lifts any foot whose real skin dips below the floor
editor.assignWeights('Chest')        // picked points follow that joint (or a mix: {Chest:0.7, Spine:0.3})
editor.smoothWeights()               // blend joint hand-overs (picked points, else all); run twice after bind() for chunky models

// Vertices ("points" = vertices welded by position, so UV seams move together)
editor.findPoints([x,y,z], radius, meshName?) // -> [{mesh, pids}]
editor.selectPointsNear([x,y,z], radius); editor.selectPoints('Mesh', [pids], add)
editor.getPoints('Mesh', [pids])     // -> [[pid,x,y,z]] world
editor.movePoints([dx,dy,dz]); editor.setPoint('Mesh', pid, [x,y,z])
editor.attachPoints()                // snap selection onto active point (or centroid); edge mode w/ 2 edges: edge onto edge
editor.detachPoints()                // rip: each face corner gets its own vertex
editor.mergeByDistance(0.001)        // weld near-duplicates (selection, else selected/all meshes)
editor.deleteFaces(); editor.makeFace()   // deleteFaces also strips the points left unused; makeFace: 3–4 points in click order
editor.snapMerge = true              // (or hold V) gizmo-dragged points snap onto the point under the cursor and weld on release
editor.smoothPoints({iterations:3, strength:0.3}) // even out lumps without shrinking (picked points; their border stays put)
editor.smoothShading(true|false)     // soft normals averaged per point (across UV seams) / flat facets; saved in the .glb

// Texture painting (writes into the mesh's texture; undoable)
editor.paintFaces({color:'#7b4f33', keep:0.55, rim:4})  // faces whose corners are all picked; keep = old shading showing through
editor.paintStroke([[x,y,z],...], {width:0.025, color, keep:0.5, rim:0.22}) // band along a surface path (straps, stripes);
                                     // only paints surfaces facing the same way as the stroke, so a touching arm stays clean
// pids change after attach/detach/merge/delete (topology rebuilt) — re-query with findPoints.

// Animation
editor.setAnimMode(true)             // Animate mode (pose); false = Edit/rest pose
editor.newClip('Walk', 1.2); editor.setClipProps({name, duration}); editor.setClip(i|name)
editor.pose('UpperArm_L', [x,y,z]deg, t)  // local euler degrees, keys quaternion at time t
editor.setTime(t); editor.key(['Bone'], ['position','quaternion','scale'])
editor.deleteKeys(t, names?); editor.moveKeys(fromT, toT, names?); editor.keyTimes(name?)
editor.closeLoop()                   // copy t=0 keys to the end -> seamless loop
await editor.importClips('Folder/other.glb' | full path | File, {names?: [...], replace?: true})  // copy clips by joint name (no retargeting) + expression frameKeys -> {copied, skippedTracks, frameKeys, skippedFrames}
editor.setLoop(true); editor.play(); editor.pause()
editor.slide('jaw', 0..1, t)        // slide joint: put it at that point of its rail (clamped) and key its POSITION; pose() refuses slide joints
editor.slideValue('jaw')             // 0..1 now; editor.setSlide('jaw', {axis:[x,y,z], min, max} (model units, parent's frame) | null)

// Misc
editor.undo(); editor.redo(); editor.view('front'|'right'|'top'|'persp'); editor.frame()
editor.setObjectTransform('Mesh', {position, rotation(deg), scale})
editor.clickAt(x, y, {shift, button}) // simulate a viewport click (canvas pixels; editor.toScreen(vec3) gives them)
```

## Conventions / gotchas
- Character faces +Z, Y up; `_L` = +X side.
- Bone/track names must be unique and contain no dots — `rename` keeps animation tracks in sync.
- Edit mode = rest pose. Moving joints there recomputes inverse bind matrices so the skinned mesh doesn't move; call `bind()` again to recompute weights for the new joint layout.
- Vertex/edge/draw modes force Edit mode. Vertex edits on skinned meshes are converted back through the skin matrix.
- Export always writes the rest pose + all clips.
- three r160 `Texture.clone()` shares the picture (`source`): give an edited copy its own `new THREE.Source(canvas)` or undo can't restore it.

## Clean up, paint brush, picking (added after the tough-guy session)
```js
import('/src/cleanup.js') -> planCleanup(editor, 0..1) // plan only: {totals:{welded,slivers,fins,junkPieces,junkFaces,strayPieces,folds,foldsFixed,passThroughs,passFixed,smoothed}, meshes:[...]}
                           applyCleanup(editor, plan)  // one undo step; showPlan(editor, plan|null) colours the points
glbAction('cleanup')                 // opens the 🧹 Clean up window (slider + preview + Apply)
editor.setMode('paint'); editor.brush = {tool:'paint'|'smudge'|'blur', color, size(px), strength, softness}
editor.setPointSize(px); editor.pickRadius; editor.pickPoint(x,y) // nearest VISIBLE point within pickRadius (X-ray: any)
editor._visibility()                 // per-point visible flags from a depth render (cached per view)
```
- Cleanup welds only crack-edge points / exact duplicates (scaled by the model's median edge), so detail and separate overlapping parts are left alone; poke-throughs count only within one connected piece; a piece is "hidden junk" only if its centre AND its outermost points are enclosed by other pieces.
- Paint dabs are drawn per nearby camera-facing face at that face's own UV spot (crosses texture seams without bleeding onto other atlas islands). Each stroke = one undo (ImageData before/after).

## Blockbench import (`src/bbimport.js`)
```js
await editor.load('/api/local?path=' + encodeURIComponent('C:/x/model.bbmodel'), 'model.bbmodel') // or a File; glbAction('importBlockbench')
editor.importReport  // {bones, cubes, meshes, locators, culled, merged, trianglesOut, atlas, colours, animations, notes}
await editor.save('model', 'Blockbench')
```
- Rigid: one SkinnedMesh, every vertex 100% on its group's bone; bones = outliner groups (pivot = `origin`), names kept.
- Straight flat faces are merged on the SURFACE per bone + plane, across cube boundaries: the plane is cut into cells, cells with a same-bone cube right in front are hidden (and quads may run across them), then greedy rectangles per colour (u-first and v-first, fewer wins). Faces against a different bone stay (they show when a joint bends); `importBlockbench(bb, {cullBetweenBones:true})` drops those too (adventurer: 19.2k -> 13.0k tris).
- Rotated cubes and textured (non-flat) faces are kept exact; a whole face is dropped only if 3x3 spots just outside it sit inside the same bone's cubes. Cube corners must wind counter-clockwise from outside (FACES table is clockwise, reversed at push).
- Shared corners, 8-bit joints, byte weights, 16-bit UVs (all core glTF). Checked: depth renders identical to Blockbench's export in 9 views.
- 16 BB units = 1 unit, no axis flip, rotations Euler 'ZYX' degrees. Animations sampled at 24 fps (catmull-rom/linear/step); looping clips wrap their catmull neighbours like Blockbench. Matches Blockbench's own glb export to 0.04° at its frames.
- Locators (`attach_*`) become empty nodes under their bone. Molang formulas in keys read as 0 (noted in `notes`).

## MCP server (`mcp/server.mjs`)
Registered for all projects: `claude mcp add -s user simple-glb -- node "<editor folder>\mcp\server.mjs"` (zero dependencies, stdio).
- Tools: `glb_run` (async JS body with `editor`, `glbAction`, `THREE`; `return` a JSON value), `glb_info`, `glb_open` (library path or absolute .glb/.gltf/.bbmodel; `build:true` opens a .bbmodel in Build mode), `glb_save`, `glb_library` (.glb + .bbmodel), `glb_screenshot` (view/frame/clip/time → PNG), `glb_action` (menu id, or "list"), `glb_tabs` (open / list / close your own tabs, see Tabs), `glb_build` (Build mode: `do` = info/new/open/add/select/set/group/ungroup/moveTo/duplicate/copy/paste/delete/mirror/flip/combine/paint/locator/save/make), `glb_start` (visible true/false), `glb_help` (this whole file, read fresh each call; `section` filters by heading).
- Keep this file current: it IS the MCP help. New editor features must be documented here (and, if common, given a glb_build/glb_* entry in mcp/server.mjs).
- It drives the real desktop app: `main.js` runs a control endpoint on 127.0.0.1 (random port + token in `%APPDATA%\simple-glb-editor\control\<pid>.json`, see below; removed on quit); POST /run executes code in the window. The MCP reuses a running editor (new builds only) or starts `dist\win-unpacked` (fast) / the root exe (`GLB_EDITOR_EXE` overrides). Visible by default; `GLB_MCP_HIDDEN=1` or `glb_start {visible:false}` = `--hidden` window.
- It only closes an editor it started hidden, when the MCP client disconnects; never the user's.
- **Finding the editor (one window for everyone):** every editor writes its own `%APPDATA%\simple-glb-editor\control\<pid>.json` ({port, token, pid, hidden, tag, started}); visible editors also write the old `control.json` (older MCP servers read only that). The MCP server pings every file (stale ones of dead editors are removed; `selftest*` tags skipped) and joins the best: visible before hidden, then the window the user focused last (`/ping` returns `focusedAt`); it stays with that editor while it answers (its tab lives there). Only when none answers does it start one, under `starting.lock` (another session starting at the same moment waits for that editor instead of opening a second window); it finds its new editor by `--tag=mcp-<uuid>`.
- One visible window: the exe takes Electron's single-instance lock; opening it again focuses the open window and a .glb passed to it opens in a new tab there (`window.openPathInTab`). `--hidden` copies (self-test, hidden MCP editors) skip the lock.
- `SIMPLE_GLB_USERDATA=<dir>` (env, read by main.js and the MCP server) = a separate settings / control folder, e.g. for tests that must not meet the user's editor.
- Self-test: starts its hidden editor with `--tag=selftest-<time>`, finds it by that tag, never reads or writes `control.json`.

## Build mode (`src/build.js`, Blockbench-style modelling) — `editor.build`
```js
editor.setMode('build'); const B = editor.build      // B.newDoc('name'); await B.open('Folder/x.bbmodel' | File | parsed json)
B.add('cube'|'cylinder'|'cone'|'sphere'|'pyramid'|'wedge'|'hexagon'|'pentagon', {from:[x,y,z], to:[x,y,z], color, name, parent:groupId|null})  // Blockbench units (16 = 1 m)
B.select(idOrName|[..], add); B.selectAll(); B.clear(); B.find(name)  // names: groups win
B.set(id, {name, shape, from, to, size, origin, rotation:[deg], sides, color, position})
B.group('arm_right'); B.ungroup(); B.moveTo([ids], groupId|null)   // keeps the look (pivot/rotation compensated)
B.copy(); B.paste(); B.duplicate(); B.remove(); B.mirrorCopy('x'); B.flip('x'|'y'|'z')  // mirror copy swaps left/right names
await B.combine(name?)          // picked group (its direct parts) or 2+ parts of one group -> ONE 'mesh' part, inside faces/points removed
B.paint(id, 'north'|...|null, '#hex'); B.paintSelected('#hex')
B.addLocator('attach_hand_right', {position, parent}); B.set(id, {position, rotation})  // attach point: held item points along its +Z arrow, up +Y
B.addSnap(partId, [u,v,w] 0..1 in its box | 'up'|'north'|..., name); B.removeSnap(partId, snapId); B.clearSnaps()   // snap points (stored per part in unit box coords: follow move/stretch/rotate/mirror/combine)
B.setSnapMode('all'|'points'|'off')  // Move-tool drags click onto snap points (+ corners & side middles for 'all') of other parts within 16 px; Alt = free
B.join(movingPartOrGroup, targetPart)  // move so a snap point sits exactly on the target's nearest snap point
await B.pushPull(partId, 'up'|..., {min:[x,y,z], max:[x,y,z]} pane in the part's own frame, depth)  // < 0 cut (hole once past the far side), > 0 add a block
B.setSlide(groupId, {axis:'up'|...|[x,y,z], min, max} | {from:[x,y,z], to:[x,y,z]} | null)  // slide joint: moves along a rail (BB units from its current pose, parent's frame), never turns
B.paintPixels(part, side, [[u, v, '#hex'], ...]); B.paintRect(part, side, {u, v, w, h, color}); B.paintLine(part, side, [u0,v0], [u1,v1], color, width)
B.clearPaint(part|null (= picked), side|null); B.faceSize(part, side) -> {w, h, painted}; B.pixelAt(part, side, u, v); B.setPixelDensity(1|2|4|8)  // pixel paint on CUBE sides; u,v = pixels from the side's top-left seen from outside
B.setTool('move'|'stretch'|'rotate'|'pivot'|'paint'); B.gridStep = 1; B.rotStep = 22.5; B.color = '#c8a46e'
await B.save('name', 'Folder')   // Library/Folder/name.bbmodel (real Blockbench file; other shapes saved as meshes + glb_shape to reopen editable)
await B.makeModel()              // -> bbimport -> rigid rigged model in the editor (groups = bones); then editor.save(...)
B.info(); B.node(id); B.toBBModel()
```
- Data like Blockbench: coordinates are absolute; a group only adds rotation about its pivot (`origin`). Every node change = one editor undo step (JSON snapshot).
- Each part is its own mesh (colour per side via vertex colours; a triangle's colour = its dominant normal side, so round shapes colour by side too). ~40 ms/frame at 5,600 parts.
- Mouse: click picks, double-click picks the group, Shift adds, box-drag picks many; Stretch = round handles (Shift both sides); Alt+click in Colour tool picks a colour. Keys: 7 Build, G/S/R/P/I tools, Shift+A cube, Ctrl+C/V/D/G, Ctrl+Shift+G, M mirror, Ctrl+Enter make model.
- Library lists `.bbmodel` (🧱) and opens them in Build mode; `editor.load(x.bbmodel)` still imports straight to a rigid model.
- Combine: straight cubes -> `boxSurface` (exact outside cells, greedy rectangles over visible cells only); with turned/round parts -> straight cubes as one watertight shell (`watertight`, no T-junctions) + others, unioned with three-bvh-csg (vendored with three-mesh-bvh into vendor/, import map in index.html). Adventurer head: 1,188 parts in ~1 s. Combined parts are triangle meshes, so Make model can't re-merge their faces (more triangles than a plain Make model of cubes).
- Hexagon / pentagon = regular prisms squeezed to fill the box; new ones start at regular proportions (NATURAL).
- Snap points: `part.snaps = [{id, name, u}]`, saved in the .bbmodel as `glb_snaps` on the element (Blockbench ignores it); Build-only (not exported to the .glb). Snap tool (O): click a part to add (u rounds to 0/.25/.5/.75/1 near them), click a dot to remove. Targets are projected once at mouse-down (camera fixed while dragging).
- Attach points (locators) have `rotation`; marker = diamond + green arrow (+Z, the way a held item points) + thin up line (+Y). The Rotate tool turns them; mirror/reparent keep their place and direction; after Make model they are empty nodes under their joint and are listed in the Scene window.
- Push / Pull (tool 'push', key Q): click 2-4 points on a flat side (snap to grid + edges; slopes/curves refused) -> pane; drag it along the side normal. Cube parts (no flip) split into up to 6 cubes around the cut box (hole walls get the colour of the side cut into; snap points go to the piece holding them); other shapes = three-bvh-csg SUBTRACTION -> one 'mesh' part (rotation baked in). Pull out = new cube part with the same pivot/turn. Works on turned parts (done in the part's own frame).

## Slide joints (rails)
- A slide joint moves along a straight line and never turns (jaw, eyelids, brows, visor, drawer, piston, sword in a scabbard).
- Build mode: group `slide = {axis, min, max}` (Blockbench units along the axis from the group's current pose, axis in the PARENT group's frame, so it turns with the parent). Picked group panel: "Slide joint" + Direction + Start/End; purple rail line in the view. Mirror flips the axis, reparent rotates it. Saved in the .bbmodel as `glb_slide` on the outliner group.
- bbimport: `glb_slide` -> `bone.userData.slide = {axis, min, max (metres), rest:[x,y,z], restQ:[x,y,z,w]}`; GLTFExporter writes userData as node `extras`, GLTFLoader reads it back, so .glb keeps the rail. Animation is plain position keys.
- Animate: `editor.slide(name, v, t)` (UI: Slide slider on the picked joint, 0 = start, 1 = end). Gizmo drags of a slide joint in Animate mode are projected onto the rail, clamped, and keep restQ (only position is keyed). Moving it in Edit mode moves the rail with it (rest updated).
- `setAnimMode(true)` while in Build mode now switches to Object mode (if a model is loaded) instead of refusing, so clip/time screenshots show the animated model.

## Pixel paint (Build mode, cube sides)
- `part.pix = {side: {w, h, rgba}}` (rgba = base64 of w*h*4 bytes, sRGB, opaque). A side gets a grid on first paint: size = side size (BB units) x `B.pixelDensity` (default 2), filled with its flat colour; stretching keeps the grid (pixels stretch). After every stroke/call a side that is one colour again turns back into a plain side (`colors[side]`), so it still merges in Make model.
- Face orientation = Blockbench's (`FACE` table: TL, TR, BL corners as seen from outside), u right, v down.
- Tool 'pixel' (key D): Pencil / Fill (flood, 4-neighbour) / Eraser (paints the side's flat colour), brush 1-4 px, Alt+click picks a colour, "Mirror left/right" also paints the mirrored spot on whichever cube side is there. Strokes draw straight into the face canvas (CanvasTexture, nearest) and are written back + one undo at pointer-up.
- Rendering: painted cubes use `pixGeometry` (a quad per side with uvs, material groups: vertex-colour material for plain sides, one textured material per painted side, cached in `faceCache`).
- Mirror/flip of cubes no longer toggles `flip` (a box mirrors to a box): pixel grids are remapped (`mirrorPix`) and snap points mirrored. Copy/duplicate/move/rotate keep paint. Combine and Push/Pull refuse painted parts (they would lose the paint).
- .bbmodel: painted sides are packed into a second texture `paint.png` (texture 1, uv_width/height = its pixel size, face uv = its rectangle), so Blockbench shows them. Opening a .bbmodel turns any multi-colour cube side into a pixel grid (uv flips honoured; uv rotation ignored, noted). Make model: bbimport keeps non-flat faces as their own texture islands (nearest filter), so the .glb has the pixels.

## Clothing layers (switchable sets on one skeleton)
- Naming rule (Build mode / any .bbmodel): a part named `<slot>__<set>__<piece>` (e.g. `hat__cap__visor`, `legs__trousers__thigh_left`) belongs to the layer `slot__set`; a part with no `__` is the base body. Pieces sit in the joint group they move with, so one set can span several bones.
- Make model / Blockbench import (`bbimport`): one SkinnedMesh per layer, named by the layer (`hat__cap`, `userData.layer` -> glTF extras), plus one `body` mesh (plain models without layers keep one mesh named after the file). All share ONE skeleton and the atlas. Face culling and surface merging only happen within the same bone AND layer, so the body is never cut under clothing (it may be switched off). `importBlockbench(bb, {layers:false})` merges everything as before. Mesh names are made unique against joints/attach points.
- Build mode (view only): `B.layers()` -> [{layer, slot, set, parts, visible}]; `B.setLayerVisible('hat__cap' | 'hat', false)`; hidden parts can't be clicked; Tools window "Clothing layers" checkboxes.
- Made model: `editor.layers()` -> [{name, layer, visible, triangles}]; `editor.setLayer('hat__cap' | 'hat', on)` (eye checkbox in the Scene window); the .glb always contains every layer (glTF has no hidden flag; the game shows/hides meshes by name). `await editor.saveLayer('hat__cap', 'hat__cap', 'Clothes')` saves just that set + the shared skeleton (+ clips) as its own .glb.
- Pixel-painted sides work per layer as before.

## Expression frames (swappable drawn pictures on a painted side)
- Build: `B.addFrame(part, side, name)` (first call names the picture already there; later calls copy the current picture into a new frame and show it), `B.setFrame(part, side, name)` (show it; paint calls/strokes then draw into it), `B.frames(part, side)` -> {frames, current}, `B.removeFrame(part, side, name)`, `B.renameFrame(part, side, from, to)`. Data: `pix[side].frames = {name: rgba}`, `pix[side].frame`; `rgba` is always the picture showing (synced into frames on switch/save). Framed sides never collapse into plain sides; mirror remaps every frame. Pixel paint section of the Tools window has the Frames list (+ New frame, click to show, double-click to rename, Delete).
- .bbmodel: every frame is packed into paint.png; the element gets `glb_frames = {side: {current, frames: {name: [x, y, w, h]}}}` (paint.png pixels); the face uv points at the current frame (Blockbench shows that one).
- Make model (bbimport): each framed side becomes its OWN SkinnedMesh on the shared skeleton, named after the part (or `part_side` when a part has several framed sides), never merged/culled, with `userData` (= glTF node extras) `frames = {name: [u, v, w, h]}` (atlas uv rects, 0..1, v down as the texture is stored, flipY false), `frame`, `frameDefault`, and `layer` if the part is a clothing piece. Game: show frame X by adding (rect[X] - rect[frameDefault]) to the quad's uvs (the saved uvs are at frameDefault).
- Editor: `editor.frames(mesh)`, `editor.setFrame(mesh, frame)` (preview), `editor.setDefaultFrame(mesh, frame)`, `editor.frameKey(mesh, frame, t)` (step key in the current clip: holds until the next key; `clip.frames[mesh] = [{t, frame}]`, part of undo, deleteKeys/keyTimes include them). Scene window: a frame picker on each framed mesh (Edit mode = preview, Animate mode = key at the current time). Saved in the .glb as `extras.frameKeys = {clipName: [[t, frame], ...]}` on the framed mesh (export at the default frames), read back on load.

## Copying animations between models
- `editor.importClips(src, {names, replace})`: parses the other .glb without touching the scene; each clip keeps its name and length; tracks are copied as stored (rotation / position / scale) only for nodes whose name exists in the open model, the rest are listed in `skippedTracks`; `extras.frameKeys` come along when a framed mesh of the same name has all those frames (else `skippedFrames`). `replace` (default true) overwrites a clip of the same name, false adds `name_2`. One undo step. Menu: Animate > Copy animations from another model…
- Build mode `B.makeModel()` now keeps the clips of the model that was open (same joint-name rule, same-named clips from the .bbmodel are replaced by the open model's version); `B.makeModel({keepClips:false})` drops them. File > New project clears clips, so a new character doesn't inherit them.

## Text in pixel paint
- `B.paintText(part, side, text, {u, v, color, size: 7 (px), font: 'sans'|'serif'|'mono'|css family, bold, align: 'left'|'center'})` -> {w, h}. Crisp pixels (system font drawn on a canvas, alpha >= 50% = ink), '\n' for more lines. Pixel paint tool: brush "Text" (type the text, size, font, bold), click a side = top-left of the text on that pixel.

## Colliders (invisible shapes for the game)
- Build: `B.addCollider('box'|'sphere'|'capsule', {from, to, name, parent})` — without from/to it wraps the picked parts (else an 8-unit box); it sits in the picked group (= joint) and moves with it. It is a part with `collider` set (cube / sphere / cylinder shape), drawn as a cyan wireframe, so move / stretch / rotate / copy / mirror / snap all work; paint, combine and push/pull refuse it. `B.colliders()`, `B.setCollidersVisible(on)`; Tools window "Colliders" buttons.
- .bbmodel: element with `glb_collider: shape` and `export: false` (Blockbench won't export it). Make model / import: an empty node under its joint at the shape's centre (turn kept), `extras.collider = {shape, size: [x,y,z] metres, radius (sphere: max/2; capsule: max(x,z)/2), height (capsule: y)}`; never in the mesh.
- Finished model: `editor.colliders()`, `editor.addCollider(name, {shape, joint, center (world), size, radius, height})`, `editor.setCollider(name, {...})`, `editor.removeCollider(name)` (undoable), `editor.showColliders = false` hides the wireframes (Scene window checkbox). Always saved in the .glb.
- MCP: no extra commands on purpose (keep it lean) — use glb_run with the calls above.

## Watch page (read-only live viewer)
- `watch.html` + `src/watch-viewer.js`: shows what the editor shows (its model, or Build mode parts; colliders/markers left out), live, with its OWN camera (orbit/zoom/pan, Frame, Bones). Nothing on it can edit.
- Publisher `src/watch.js` (in the editor): after any editing step (wraps `_pushUndo`, undo/redo, load, clear, setMode, setLayer, setFrame, build open/newDoc/…) it exports the visible scene (onlyVisible; model + clips, or the `__build` group) as .glb → `PUT /api/watch/scene` (main server, 127.0.0.1 only), and a small state (mode, anim, clip, time, playing, speed, loop, file, last message) → `POST /api/watch/state` a few times a second. The page plays animations itself from {clip, time, playing}.
- Servers: the main server also answers GET /watch.html + `GET /api/watch/scene|state|events` (SSE). The desktop app starts a separate read-only watch server (`startWatchServer` in server.js) on port 5180 (else random): serves only the page, the viewer, /vendor/three and GET /api/watch/*, no library/settings/writes. Local by default; View > "Let other devices watch (home Wi-Fi: no password)" (`settings.watchLan`) binds 0.0.0.0. Then this PC and home-network addresses (10.x, 172.16–31.x, 192.168.x, 169.254.x, fe80/fc00 IPv6) get straight in; anything else, and ANY request carrying a proxy header (X-Forwarded-For, Forwarded, CF-Connecting-IP, Tailscale-User-Login…, since tunnels connect from this PC), gets a login page (`loginPage`, POST /login, 5 wrong tries per IP per 10 min → 429) and needs the watch password. Password: `<userData>\watch-auth.json` = {salt, hash (scrypt), secret} (own file, not settings.json; main.js `setWatchPassword`, main server `POST /api/watch/password {password|null}`, min 6 chars); sign-in = HttpOnly SameSite=Strict cookie `glbwatch=<exp>.<HMAC(secret)>`, 30 days with "keep me signed in", new password = new secret = everyone signed out. No password = nobody from outside. A password of digits only (``watch-auth.json`` ``pin`` = its length) gives the sign-in page a number pad that submits by itself. Limits: 5 wrong per visitor / 10 min (behind a tunnel the visitor = CF-Connecting-IP / X-Real-IP / first X-Forwarded-For, since the tunnel connects from this PC) AND 30 wrong from outside in total per hour (then sign-in pauses; signed-in devices keep working). Remote watching (e.g. Cloudflare Tunnel to ``http://localhost:5180``) works even with Wi-Fi watching off. While any watch page is open, main.js turns background throttling off (``setBackgroundThrottling(false)`` + ``window.watchKick()``) so a minimized window / locked screen keeps feeding it. Public files (/vendor, the viewer script, icon) need no sign-in; every path is decoded and normalised before these checks. Test: scratchpad-style script with `startWatchServer({auth:{get}})` + an X-Forwarded-For header. View > "Watch in a browser (view only)…" opens it. Dev: http://localhost:5178/watch.html.
- View > "Watch from other devices…" (`watchPhone`): the home-Wi-Fi addresses (Copy, optional QR per address: vendored qrcode-generator, MIT), the outside-network password (set / change / remove), turn other-device watching on/off (`/api/watch/links` -> {lan, urls, port, hasPassword}, `POST /api/watch/lan?on=1|0`, `POST /api/watch/password` → main.js hooks). Turning it on from the menu opens this window.
- No MCP command (kept lean): it is for people watching.
- **Showing the user an animation (also remotely):** the page only animates a tab that is in Animate mode with a clip picked, and only moves while the editor plays it; Edit mode or paused = a still pose. So leave the tab with `editor.setAnimMode(true); editor.setClip('Walk'); editor.setLoop(true); editor.play()`. Expression frames (swapped face pictures) do not show on the watch page yet.

## Tabs (several projects; each Claude session in its own tab) — `src/tabs.js`
- Every tab is its own `Editor` (scene, clips, undo, Build project, camera) with its own canvas in `#view`; only the picked tab draws (`ed.setActive`). `window.editor` / ui.js `ed` / `build` are stand-ins (Proxies) for the picked tab; UI listens on them ('change', 'message', 'time', 'library', 'objectChange' — only the picked tab sends).
- `window.tabs`: `add()`, `select(t)`, `close(t, {force})` (asks if unsaved; last tab -> a new empty one), `next(±1)`, `nth(i)`, `list`, `active`, `title(t)`, `label(t)`, `dirty(t)` (`ed.dirty` = model changed since save/open, Build steps excluded; `build.dirty`), `pristine(t)`, `await openInNewTab(ed => ...)` (reuses an empty picked tab; a failed open removes the new tab).
- UI: tab bar over the view (● unsaved, ✕ / middle-click closes, + new), keys Ctrl+T / Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1..9, File > New tab / Close this tab. Opening a file (Open, drag-in, library double-click) always uses a new tab; a library file already open just switches to its tab. Tabs saved in the library come back on the next start (`settings.tabs`; not in `?hidden` / `?load` / `?dummy` windows).
- Same Library file in two tabs: the second one to save is warned (confirm for the user, an error for a session).
- **Claude sessions**: the control endpoint takes `{code, session: {id, name?, tab?}}`; the MCP server sends one per process (`GLB_SESSION_NAME` env = name, else "Claude 1", "Claude 2"…). Each session works in its own background tab (🤖, made on its first call; a hidden automation editor reuses its empty start tab), never in the tab the user looks at. `glb_start {tab:"name"}` names the tab or joins the tab with that name. `glbAction` in a session runs in its tab (`tabs.runIn`). Screenshots of a background tab render a full frame (`screenshotDataURL` runs `_tick`).
- In a session's tab the user can look (orbit, views, frame, switch tabs) but not edit (`ed.viewOnly`, panels dimmed, banner) until **Take over** (`tabs.takeOver(t, true)`); then the session's calls fail with "The user took over the tab…" until **Give it back**. If the user closes a session's tab, its next call says so, and the call after that starts a new tab. Session tabs stay after the session ends (not reopened on restart unless taken over).
- **Several tabs per session** (MCP `glb_tabs`): one tab per item (e.g. 10 props), so the user can look at each in 3D, also remotely on the watch page. `{do:'open', name}` = switch to / make that tab (`SESSION.tab`; later calls work there), `{do:'list'}` = `tabs.sessionTabs(S)` {name, current, unsaved, file, takenOver}, `{do:'close', names:[…]|'all', force}` = `tabs.closeSessionTabs(S, names, force)` -> {closed, kept:[{name, why}]}: only tabs that session worked in (`t.session.by`), never taken-over ones, never a confirm box (unsaved = kept unless force). A session's tabs share its colour. Typical flow: open a tab per prop, build + save each, tell the user, close them after they approve. MCP calls with `session.noTab` run without making / switching a tab.
- Watch page: one feed per tab (`PUT /api/watch/scene?tab=tabN`, `POST /api/watch/state?tab=tabN` with label / claude / active); a tab only exports while someone watches it. The page has a tab picker ("Follow the editor" = the picked tab, default; or stick to one tab, `watch.html?tab=tabN`).
- **Sub-tabs** (Build mode): `tabs.openSub(group | name, {mode: 'context' | 'alone'})` — Tabs > "Open the picked group in a sub-tab" (Ctrl+Shift+T) or right-click a group in the Outliner. A sub-tab is a VIEW of the same project (same editor, Build doc and undo), listed after its project ("toon_f › arm"): its own camera / picks / tool (swapped on switch: `captureView` / `applyView`), only that group shown and clickable (`B.setIsolate(group, mode)`; 'context' greys the rest, 'alone' hides it; banner toggles, "Whole model" goes back). Picking, box-select, Select all, `B.select` and the Outliner are limited to the group; new shapes with nothing picked land in it; undo labels get `[group]`. Closing a sub-tab only closes the view; closing the project closes its sub-tabs; sub-tabs are not reopened on restart.

## Sprite sheets (`src/sprites.js`)
```js
await editor.renderSprites({ clips, directions: 4, view: 'rpg', size: 64, fps: 12, style: 'smooth' | 'pixel', outline, background, front: 'auto', folder, name, save })
// -> {png, json, sheets:[{png, json, w, h}], frames, frameSize, directions, clips, front, ms}; File > Export a sprite sheet… = window with preview
```
- Finished model only (not Build mode). Default output `Library/Sprites/<model>/<model>.png + .json`; `save:false` returns `sheetCanvases` / `sheetJsons` instead.
- `clips`: names (default all; none = one still of the rest pose). `directions`: 1 | 2 | 4 | 8 or a list of `down, down_right, right, up_right, up, up_left, left, down_left` (= the way the character faces ON SCREEN; down = towards the viewer) or azimuth degrees. `view`: side (0°) | rpg (30°) | iso (26.57°, 2:1) | top, or `elevation` in degrees. Orthographic camera.
- `front`: 'auto' looks at the feet (foot/toe-weighted points vs the ankle joint) — Blockbench / Build-mode models usually face −Z, editor-made ones +Z; or '+z' / '-z'.
- One scale (pixels per metre) and one ground anchor (feet centre, `meta.pivot`) for every frame of every direction, fitted over every sampled frame, so nothing jitters. Frames = clip length × fps (a loop's end frame left out); expression frames, slide joints and the clothing layers that are switched on show as in the editor.
- Packing: each animation × direction starts a new line (`<clip>_<direction>`, wrapped past `maxSheet` 8192 px); if the whole sheet is taller than 8192 px, one sheet per animation (`<name>_<clip>`).
- JSON: TexturePacker "hash" `frames` (`<clip>_<dir>_<i>`: frame, sourceSize, pivot 0..1, duration ms) — Phaser / PixiJS load it directly — plus `animations` {tag: [frame names]} and `meta.frameTags` (Aseprite style: name, from, to, clip, facing), `meta.fps`, `frameSize`, `pixelsPerMetre`, `modelFront`.
- Pixel style: no anti-aliasing, hard alpha, optional 1-px outline (`outlineColor`). Smooth: 4× MSAA, edges un-premultiplied.

## Plain side names, hollow, band paint, side sizes (asked for by the AI trainer)
- Sides can be named **front (+Z = south) · back (−Z = north) · left (+X = east, the model's own left, like `_L`) · right (−X = west) · top (up) · bottom (down)** in every Build call that takes a side (paint*, faceSize, pixelAt, frames, pushPull, addSnap, setSlide axis) and in glb_build. `SIDE_ALIAS` / `sideName` in build.js.
- `B.node(id).sidePixels` = `{front:[w,h], back, left, right, top, bottom}` pixels of each cube side at the current density (painted sides: their own grid). paintPixels / paintRect / paintLine that would miss the side throw "the front side is W × H pixels (u 0..W-1, v 0..H-1)", and their messages end with the side size.
- `B.pixelDensity` (1|2|4|8, pixels per unit for newly painted sides) is a SAVED setting (settings.build), so it may not be the default 2; `B.setPixelDensity(n)` / glb_build `density{value}`.
- `await B.hollow(part, {side: 'top', wall: 1, depth})`: removes the inside following the part's own shape (round for cylinder / cone / sphere; three-bvh-csg), leaving walls `wall` thick and a bottom; default depth = height − wall. Result: one 'mesh' part (rotation baked). glb_build `hollow{names,side,wall,depth}`.
- `B.paintBand(part, {side: 'top', from: 0.4, to: 0.6, color})`: a stripe round ANY part (round, hollowed, combined) — from..to are fractions of the part's height towards `side`; triangles are split exactly at the band edges and the part becomes a 'mesh' part. Pixel paint stays cube-only (the refusal says to use paintBand). glb_build `band{names,side,min,max,color}`.
- `B.mirrorCopy(axis)` copies across the plane x = 0 (or y / z = 0) of the model, not the part's own centre: mirror a part that sits off-centre.
- glb_build `addMany{parts:[{shape,from,to,color,name,parent}], groupName}` returns just `{added: [names], group}`.
- `editor.snapshot({width, height, view, views, whole})` (glb_screenshot): drawn off-screen at a fixed size (default 800 × 600) whatever the window / docked panels look like, without moving the tab's camera; `whole` (default) fits the whole model ignoring the selection; `views: [...]` = one contact-sheet image with labelled cells. Views: front, back, left, right, top, bottom, persp = where the CAMERA sits (Blender style: 'right' = camera on +X = shows the model's left side). The watch page has its own camera; a session's screenshots use its own tab's camera.

## Light / dark, tab colours
- View > Theme: Dark (default) / Light / Like Windows (`settings.theme` = 'dark' | 'light' | 'system'; actions themeDark / themeLight / themeSystem / themeToggle). CSS tokens on `:root` with `:root[data-theme="light"]` overrides in styles.css; `editor.setTheme(light)` recolours the 3D background and grids (Build grid: `B.setTheme`); the timeline canvas reads the CSS tokens; main.js sets `nativeTheme.themeSource` (menus, title bar) at start and via `POST /api/theme?mode=`.
- Tab colours (`TAB_COLOURS` in tabs.js): each Claude session's tab gets the first colour no other tab uses (purple, green, orange…); it shows as a stripe + dot on the tab and as a frame round the 3D view (`--tab-color`) while that tab is picked; sub-tabs use their project's colour. Right-click a tab (or click its dot) to pick a colour or none; `tabs.setColour(t, '#hex' | null)`. Colours of reopened tabs are remembered.

## In-app AI panel (the shared `ai-panel`, github.com/Marty-s-Stuff/ai-panel)
- **Where the code is:** NOT in this repo. `package.json` names one tag (`"ai-panel": "github:Marty-s-Stuff/ai-panel#v1.2.4"` = the built-in version; to change it: the tag, `npm install`, rebuild). **It also updates itself without a rebuild** (from v1.2.0): at start it asks GitHub for a newer 1.x, the ▾ menu shows a dot and Install / Not now / Skip this version; an installed copy lives in `<userData>\ai-panel\versions\` and is used from the next start; "↩ Use the built-in AI panel" goes back; the menu ends with "AI panel vX (built in | updated)". main.js `aiBoot = require('ai-panel/node/boot.js').createBoot(…)` picks the copy; its `aipanel.js` is loaded from `aiBoot.dir`, and server.js `aiPanelDir` serves `/vendor/ai-panel/` from that same copy (the build-time `vendor/ai-panel` copy is only for `npm run server`). preload `glbTerm.update(what, tag)` = IPC `aipanel:update`. main.js `…/aipanel.js` `.setup({…, appName: 'Simple GLB Editor', sessionVar: 'GLB_SESSION_NAME', boot: aiBoot, pty, extraDirs: [<userData>\agents]})` = the engine (plugins, node-pty, IPC `agents:*` / `term:*`); `scripts/vendor.js` copies its page files to `vendor/ai-panel/` (ai-panel.html / .css / .js; xterm stays ours in `vendor/xterm`); ui.js loads `ai-panel.html` at start into `#aiPanelButton` (end of the menu line) and `#aiPanelHost` (end of the page) and calls `initTerminal({appName, status, settings, workFolder, workFolderName: 'Library', notify, away, onShow, onHide})` → `window.claudeTerm`; preload.js keeps the bridge as `window.glbTerm` (the panel finds it). Our own styles.css only adds `--ai` / `--ok` tokens, `body.termside` room-making and flat ▾ menu rows. Fixes and new assistants go into the ai-panel repo, not here. **Plugins** (format: node_modules/ai-panel/agents/README.md): built-in ones ship with the panel (Claude Code, Codex, Copilot, Kiro, Antigravity); the user's own in `%APPDATA%\ai-agents` (shared by all the author's apps; "➕ Add another assistant…" opens it), old `%APPDATA%\simple-glb-editor\agents` still read. The picked one = `settings.terminal.agent`. `claudeTerm.agents()`, `.agent()`, `.useAgent(id)`, `.toggle()`, `.newConversation()`. The bullets below describe how the panel behaves with the Claude plugin.
- Toolbar split button (top right): "🤖 Claude" opens / closes the panel (looks pressed in while open, `.pressed`); "▾" = the menu: sign-in status (`claude auth status`), Open Claude Code, New conversation, Sign in with Claude (Pro / Max subscription) = `claude auth login --claudeai`, Sign in with Anthropic API (Console, pay per token) = `claude auth login --console`, Sign out = `claude auth logout`. Sign-in happens in the browser (Claude Code's own flow); the editor never sees a password or key. Ctrl+` (action `claudeTerm`, View menu) shows / hides the terminal.
- The terminal is xterm.js (vendored to `vendor/xterm`, classic scripts) in a panel that drops down under the toolbars or docks on the right as a full-height column (the Claude button sits at the right end of the menu line; docked: level with the top of the 3D view, under the full-width second toolbar, to just above the status line, 6 px in from the right, purple border all round, `--term-side-top/bottom` set by ui.js `placeTerm`; `body.termside` gives the second toolbar, #main and #timeline a right margin; header button switches; width / height draggable; `settings.terminal` = {mode, width, height}). The process runs in the main process (ai-panel's engine) with node-pty (prebuilt ConPTY binaries, `npmRebuild: false`, `asarUnpack` node-pty); `window.glbTerm` (preload, contextBridge) = info / status / start / write / resize / kill / onData / onExit. Only commands the picked plugin defines are ever started; a missing program shows its install command when a conversation starts. Modes: drop-down / docked right / floating window (header button cycles; `settings.terminal.mode`).
- Where Claude works: New conversation (header button / ▾ menu) asks "Where should Claude work?" — the last folder picked (Enter = go), recent folders (`settings.terminal.folders`, 6), Choose another folder… (`glbTerm.pickFolder` = Windows folder dialog); Claude starts there (its CLAUDE.md, files, per-folder history). Default and first start: the Library. The header shows the folder ("in Library", full path on hover). Opening the panel keeps the running conversation and does not ask.
- Claude runs with `GLB_SESSION_NAME=In-app Claude`. Its simple-glb MCP server looks up its parent processes (`ancestors()`, one PowerShell CIM query) and joins the editor whose terminal it runs in, even a dev / test copy in another `simple-glb-editor*` folder (other sessions never join those); the session is flagged `inApp`, so its tab opens in front.
- Look: the terminal sits in a rounded card (theme colours, Cascadia Code 14 px, bar cursor); header = avatar, status chip (Not running / Working… / Waiting for your answer / Your turn, from output activity and the answer bar), folder; a message box under it (Enter sends, Shift+Enter new line, multi-line text goes in as one bracketed paste, Esc in an empty box = Esc for Claude); typing straight into the conversation still works. Ctrl+C copies when text is selected (else it interrupts Claude), Ctrl+V pastes; Enter after a conversation ended starts a new one.
- Answer bar under the terminal: buttons for the choices on screen — Claude Code's menus (permission prompts, questions, pickers: consecutive "N. text" lines with a ❯ on one; click sends the number) and a question in Claude's own text (a 1. 2. 3. or A) B) C) list at the END of its last message, just above the ──── / ❯ input box, starting at 1 or A; click sends the key + Enter; older lists further up are ignored) — plus ↑ ↓ Tab Esc Enter. `claudeTerm._findChoices()` / `_write()` / `_term` for tests.
- The in-app Claude starts with `--append-system-prompt` (the plugin's `panelNote`): offer choices as a numbered list at the end of the message, always ending with "Something else - type what you want". That last line gets no button in the answer bar (type in the message box instead); in a Claude Code menu its own "Type something" line stays a button (it must be picked first).
- Opening the panel hides every other window (Tools, Scene, Animations, Library…) so only the 3D view is left; hiding it opens them again (list kept in `settings.termHiddenPanels`, so they also come back after a restart; Sprite sheet / Clean up stay closed).
- Space is sent by the terminal's own key handler (xterm would wait for a keypress); keys.js ignores keys inside `#term`. The pty env drops `CLAUDECODE` / `CLAUDE_CODE_*` (an editor opened by a Claude session would otherwise hand its session markers to the in-app Claude).

## Dev build (test without disturbing the sessions)
- `npx electron-builder --win portable --config.directories.output=dist-dev`, then run `Start dev build.cmd`: sets `SIMPLE_GLB_USERDATA=%APPDATA%\simple-glb-editor-dev` (own settings, own control files, own single-instance lock, so Claude sessions never find or join it) and `SIMPLE_GLB_DEV=1`. It shares the project Library. Claude started in its terminal inherits the env, so it drives the dev window only.

## Notifications (`src/notify.js`)
- Desktop notifications (Windows toasts; `app.setAppUserModelId('local.simple-glb-editor')`), only while you are not looking (`away()` = window hidden / not focused): the in-app Claude going from Working… (at least 4 s) to "Your turn" or to choices on screen (also when its panel is hidden); a session tab that made ≥ 3 steps and then had none for 20 s ("finished, or waiting for you in its own terminal"), when that tab is not the one picked. Clicking one brings the window forward (`window.glbApp.focus()` → main `win:focus`) and opens the panel / picks the tab. Same message not repeated within 8 s.
- Switch: View > "Notify me when Claude finishes" (action `notifyToggle`, `settings.notify`, default on).

## Arrange the buttons (`src/arrange.js`)
- View > "Arrange the buttons…" (action `arrangeButtons`): drag toolbar buttons (click-hold or just drag) within a group, to another group or toolbar (purple line = where it lands); drop on the MIDDLE of a button = a parent button (dropdown) holding both (asks for a name); drop on a parent button = into it; open one and drag buttons out; double-click a parent button = rename; empty ones vanish. Buttons do not run while arranging. Bar at the bottom: Reset to default / Done.
- Saved as `settings.toolbarLayout` = {groups: {g0…: [unit keys]}, menus: {mid: {name, items}}} (unit keys `act:<id>`, `id:<dropdown id>`, `menu:<mid>`; groups = the toolbars' `.group` boxes in page order, the Claude button is in the menu line, not arrangeable), applied at start; Reset = the layout as built (captured before applying). Parent buttons work outside arrange mode too (click opens, a click inside runs and closes).
- To make an arrangement the built-in default: arrange the buttons in a build, then read `toolbarLayout` from that build's settings.json (`%APPDATA%\simple-glb-editor[-dev]\settings.json`) and bake it into index.html.
