// Simple GLB Editor — window, toolbars, panels, timeline. Every action goes through the
// action list below, so buttons, the native menu and (rebindable) keyboard shortcuts all match.
import { Editor, PREVIEW } from './editor.js';
import { WALK_STYLES } from './autorig.js';
import { loadSettings, settings } from './settings.js';
import { Panels } from './panels.js';
import { Keymap } from './keys.js';
import { initLibrary, MIME_LIB } from './library.js';
import { planCleanup, showPlan, applyCleanup } from './cleanup.js';
import { initPaint } from './paint.js';
import { initBuild, SHAPES } from './build.js';
import { initWatch } from './watch.js';
import { Tabs } from './tabs.js';
import { initTerminal } from '../vendor/ai-panel/ai-panel.js'; // the shared AI panel (github.com/Marty-s-Stuff/ai-panel, tag in package.json)
import { notify, away } from './notify.js';
import { initArrange } from './arrange.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
await loadSettings();

const status = t => { $('#status').textContent = t; };
const run = async fn => { try { return await fn(); } catch (err) { console.error(err); status('⚠ ' + err.message); } };

// ---------------- preferences ----------------
const prefs = { fps: 30, speed: 1, autoKey: true, loop: true, xray: false, childrenFollow: true, showBones: true, ...settings.get('prefs', {}) };
const mouse = settings.get('mouse', { rotate: 'middle', pan: 'right' });
// ---------------- light / dark ----------------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const themeChoice = () => settings.get('theme', 'dark'); // 'dark' | 'light' | 'system'
const isLight = () => (themeChoice() === 'system' ? !darkQuery.matches : themeChoice() === 'light');
function applyTheme() {
  const light = isLight();
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  for (const e of tabs?.all?.() || []) e.setTheme(light);
  window.dispatchEvent(new Event('theme-changed'));
}
function setTheme(t) { settings.set('theme', t); applyTheme(); fetch('/api/theme?mode=' + t, { method: 'POST' }).catch(() => {}); status({ dark: 'Dark mode', light: 'Light mode', system: 'Follows the Windows setting (light or dark)' }[t]); }
darkQuery.addEventListener('change', () => { if (themeChoice() === 'system') applyTheme(); });
document.documentElement.dataset.theme = isLight() ? 'light' : 'dark';

// ---------------- tabs: one Editor per tab; `ed` / `build` always mean the tab you are looking at ----------------
/** Everything a new tab's editor needs: your preferences, the paint brush, Build mode, the watch page. */
function setupEditor(e) {
  Object.assign(e, { fps: prefs.fps, speed: prefs.speed, autoKey: prefs.autoKey, childrenFollow: prefs.childrenFollow, showBones: prefs.showBones });
  e.setLoop(prefs.loop); e.setXray(prefs.xray); e.setPointSize(prefs.pointSize ?? 11);
  initPaint(e); Object.assign(e.brush, settings.get('brush', {}));
  e.build = initBuild(e, { saved: () => library.refresh() });
  Object.assign(e.build, settings.get('build', {}));
  initWatch(e); // keeps the read-only watch page (watch.html) up to date (one feed per tab, only for tabs someone watches)
  e.setMouseButtons(mouse.rotate, mouse.pan);
  e.setTheme(isLight());
}
const tabs = new Tabs($('#view'), $('#tabbar'), setupEditor);
const ed = tabs.ed, build = tabs.build;
window.editor = ed; window.tabs = tabs;
tabs.add();
ed.addEventListener('message', e => status(e.detail));
/** Open something (fn gets the tab's editor) in its own tab — the empty start tab is reused. */
const openTab = fn => run(() => tabs.openInNewTab(fn));
tabs.addEventListener('select', () => { closeCleanup(); status('Tab: ' + tabs.label(tabs.active)); });
const walkStyle = () => (WALK_STYLES[prefs.walkStyle] ? prefs.walkStyle : 'normal'); // chosen in the Rig section
const paintPrefs = { color: '#7b4f33', keep: 0.55, rim: true, width: 0.025, joint: 'Chest' }; // the Paint section remembers its last settings this session
const savePrefs = () => settings.set('prefs', { fps: ed.fps, speed: ed.speed, autoKey: ed.autoKey, loop: ed.loop, xray: ed.xray, childrenFollow: ed.childrenFollow, showBones: ed.showBones, walkStyle: prefs.walkStyle, pointSize: ed.pointSize, cleanStrength: prefs.cleanStrength });
const saveBuildPrefs = () => settings.set('build', { gridStep: build.gridStep, rotStep: build.rotStep, color: build.color, snapMode: build.snapMode, pixelDensity: build.pixelDensity, pixelBrush: build.pixelBrush });
const inBuild = () => ed.mode === 'build';
const saveBrush = () => settings.set('brush', { ...ed.brush });
$('#fps').value = ed.fps; $('#speed').value = ed.speed;

// ---------------- small right-click menu ----------------
function showCtxMenu(x, y, items) {
  let m = $('#uiCtx'); if (!m) { m = document.createElement('div'); m.id = 'uiCtx'; m.className = 'menu ctx'; document.body.appendChild(m); addEventListener('pointerdown', e => { if (!m.contains(e.target)) m.hidden = true; }, true); }
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" title="${esc(it.tip || '')}">${it.colour ? `<span class="sw" style="background:${it.colour}"></span>` : ''}${esc(it.label)}</button>`)).join('');
  m.hidden = false; m.style.left = `${Math.min(x, innerWidth - 240)}px`; m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
  m.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; m.hidden = true; items[+b.dataset.i].run(); };
}

// ---------------- small text prompt ----------------
function askText(title, value = '') {
  return new Promise(resolve => {
    const box = $('#ask'), inp = $('#askInput');
    $('#askTitle').textContent = title; inp.value = value; box.hidden = false; inp.focus(); inp.select();
    const done = ok => { box.hidden = true; box.onclick = inp.onkeydown = null; resolve(ok ? inp.value.trim() || null : null); };
    box.onclick = e => { if (e.target === box || e.target.id === 'askCancel') done(false); if (e.target.id === 'askOk') done(true); };
    inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  });
}

// ---------------- windows ----------------
const panels = new Panels({
  tools: { title: 'Tools', dock: 'left', open: true, tip: 'The buttons for what you are doing right now. Drag here to move it out into its own window; double-click to pop out or dock back.' },
  scene: { title: 'Scene', dock: 'right', open: true, tip: 'Everything in your model: its parts and its skeleton joints. Click a name to pick it.' },
  clips: { title: 'Animations', dock: 'right', open: true, tip: 'Your animations. Each one is a separate movement, like "Walk" or "Wave".' },
  library: { title: '📚 Model library', dock: null, open: false, w: 380, h: 520, tip: 'Your model library. Drag here to move the window; drag any edge or corner to resize it.' },
  sprites: { title: '🎞 Sprite sheet', dock: null, open: false, w: 400, h: 640, tip: 'Turn the animations into 2D sprite sheets for a game. Drag here to move the window; drag any edge or corner to resize it.' },
  cleanup: { title: '🧹 Clean up', dock: null, open: false, w: 340, h: 470, tip: 'Clean up the model. Drag here to move the window; drag any edge or corner to resize it.' },
}, () => queueRender());

window.panels = panels; // handy for automation
// ---------------- actions ----------------
const boneish = () => ed.mode === 'bone' || ed.mode === 'draw';
const pointish = () => ed.mode === 'vertex' || ed.mode === 'edge';
const notHere = what => status(`${what} works in ${ed.mode === 'object' ? 'Vertex, Edge or Bone' : 'another'} mode`);
function jumpKey(dir) {
  const ts = ed.keyTimes(); if (!ts.length) return status('There are no keys yet');
  const t = dir > 0 ? ts.find(t => t > ed.time + 1e-4) ?? ts[0] : [...ts].reverse().find(t => t < ed.time - 1e-4) ?? ts[ts.length - 1];
  if (!ed.animMode) ed.setAnimMode(true);
  ed.pause(); ed.setTime(t);
}
function stepFrame(n) { if (!ed.animMode) ed.setAnimMode(true); ed.pause(); ed.setTime(Math.round(ed.time * ed.fps + n) / ed.fps); }
async function saveFlow() {
  if (inBuild()) { const n = await askText(`Save the build into ${library.target() ? 'Library / ' + library.target().split('/').join(' / ') : 'Library'} as:`, build.doc.name); if (n) await build.save(n, library.target()); return; }
  const where = library.target() ? `Library / ${library.target().split('/').join(' / ')}` : 'Library';
  const n = await askText(`Save into ${where} as:`, ed.fileName.replace(/\.glb$/i, ''));
  if (n) await ed.save(n, library.target());
}
const A = (group, id, label, defaults, run, help, extra = {}) => ({ group, id, label, defaults, run, help, ...extra });
const ACTIONS = [
  A('File', 'newProject', 'New project', ['Ctrl+N'], () => { const unsaved = ed.dirty || build.dirty; if (unsaved && !confirm('Start a new project? The model, its animations and the Build mode project are cleared. Anything you have not saved is lost.')) return; return ed.newProject(); }, 'Start over with an empty scene: clears the open model, its animations and the Build mode project (asks first if there are unsaved changes).'),
  A('View', 'themeDark', 'Dark mode', [], () => setTheme('dark'), 'Dark windows and a dark 3D view.'),
  A('View', 'themeLight', 'Light mode', [], () => setTheme('light'), 'Light windows and a light 3D view.'),
  A('View', 'themeSystem', 'Light or dark like Windows', [], () => setTheme('system'), 'Follow the Windows setting (Settings > Personalisation > Colours).'),
  A('View', 'themeToggle', 'Switch light / dark', [], () => setTheme(isLight() ? 'dark' : 'light'), 'Switch between light and dark mode.'),
  A('View', 'arrangeButtons', 'Arrange the buttons…', [], () => arrange.toggle(), 'Move the toolbar buttons where you like them: drag a button to a new spot, drop it on the middle of another button to make a menu button holding both, double-click a menu button to rename it. Done saves; Reset to default puts everything back.'),
  A('View', 'notifyToggle', 'Notify me when Claude finishes', [], () => { const on = settings.get('notify', true) === false; settings.set('notify', on); status(on ? 'Notifications on: one comes when Claude finishes or asks something while you look elsewhere' : 'Notifications off'); }, 'A desktop notification when Claude finishes or asks you something while you are not looking at it (the editor in the background, the Claude panel hidden, or another tab picked).'),
  A('View', 'claudeTerm', 'Claude Code terminal', ['Ctrl+`'], () => claude?.toggle(), 'Show or hide the drop-down terminal where you chat with Claude Code inside the editor (sign in from the 🤖 Claude menu). Claude works on your models in its own tab.'),
  A('Tabs', 'tabNew', 'New tab', ['Ctrl+T'], () => tabs.add(), 'Open a new empty tab next to the others. Every tab is its own project with its own undo; files you open always get their own tab.'),
  A('Tabs', 'takeOver', 'Take over this tab', [], () => { tabs.takeOver(tabs.active, !(tabs.active.session?.takenOver)); queueRender(); }, 'In a tab a Claude session is working in: edit it yourself (the session is told and stops changing it). Again = give it back.'),
  A('Tabs', 'subTab', 'Open the picked group in a sub-tab', ['Ctrl+Shift+T'], () => buildOnly(() => { const g = build.sel.map(id => build.node(id)).find(n => n?.kind === 'group') || build.sel.map(id => build.node(id)?.parent && build.node(build.node(id).parent)).find(Boolean); if (!g) return status('Pick a group (or a part inside one) first'); tabs.openSub(g.id); }), 'Work on one group (an arm, the head…) on its own in a sub-tab under this project: only it is shown and clickable (the rest greyed or hidden), with its own camera. Everything you do there is already in the project; Undo is shared.'),
  A('Tabs', 'tabClose', 'Close this tab', ['Ctrl+W'], () => tabs.close(tabs.active), 'Close the tab you are looking at (asks first if it is not saved).'),
  A('Tabs', 'tabNext', 'Next tab', ['Ctrl+Tab'], () => tabs.next(1), 'Switch to the tab on the right.'),
  A('Tabs', 'tabPrev', 'Previous tab', ['Ctrl+Shift+Tab'], () => tabs.next(-1), 'Switch to the tab on the left.'),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => A('Tabs', 'tab' + n, 'Tab ' + n, ['Ctrl+' + n], () => tabs.nth(n - 1), `Switch to tab ${n}.`, { hidden: true })),
  A('File', 'open', 'Open a model…', ['Ctrl+O'], () => $('#file').click(), 'Pick a .glb model file from anywhere on your computer (Blockbench .bbmodel files work too).'),
  A('File', 'importBlockbench', 'Import a Blockbench model…', [], () => $('#bbFile').click(), 'Bring in a Blockbench .bbmodel as one light, rigid model: each group becomes a joint and a solid part (no stretching), hidden faces are dropped, flat colours merged, animations and attach points kept. Save it afterwards to put it in the library.'),
  A('File', 'library', 'Show / hide the model library', ['B'], () => panels.toggle('library'), 'The library is a folder of your models, organised into folders.'),
  A('File', 'libraryMenu', 'Library options menu', [], () => library.toggleMenu(), '', { hidden: true }),
  A('File', 'dummy', 'Load the test dummy', [], () => ed.loadDummy(), 'A plain figure to practise on.'),
  A('File', 'spriteSheet', 'Export a sprite sheet…', [], () => openSprites(), 'Turn the animations into 2D sprite sheets for a game: every frame, from 1, 4 or 8 directions, packed into a PNG + a JSON (Phaser, PixiJS, Godot / Unity importers). Saved in Library / Sprites.'),
  A('File', 'save', 'Save into the library', ['Ctrl+S'], saveFlow, 'Saves the model, skeleton and animations as a .glb in your library.'),
  A('File', 'download', 'Save a copy as…', ['Ctrl+Shift+S'], () => ed.download(), 'Save a .glb anywhere on your computer.'),
  A('Edit', 'undo', 'Undo', ['Ctrl+Z'], () => ed.undo(), 'Take back the last change.'),
  A('Edit', 'redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], () => ed.redo(), 'Bring back a change you undid.'),
  A('Edit', 'selectAll', 'Pick everything', ['A'], () => (inBuild() ? build.selectAll() : ed.selectAll()), 'Picks every point, line, joint or part (depending on the mode).'),
  A('Edit', 'deselect', 'Pick nothing / end a bone chain', ['Escape'], () => { if (inBuild()) return build.clear(); ed.clearSelection(); if (ed.mode === 'draw') status('Chain ended — the next click starts a new one'); }, 'Clears what is picked. In Draw bones mode it also finishes the current chain of joints.'),
  A('Edit', 'delete', 'Delete', ['Delete', 'Backspace'], () => (inBuild() ? build.remove() : boneish() ? ed.deleteBones() : pointish() ? ed.deleteFaces() : notHere('Delete')), 'Bone mode: removes the picked joints. Vertex/Edge mode: removes the surface faces touching what you picked.'),
  A('Edit', 'attach', 'Attach (join together)', ['J'], () => (boneish() ? ed.attachBones() : pointish() ? ed.attachPoints() : notHere('Attach')), 'Points: snaps the picked points onto the last one you clicked so they become one. Joints: hooks the picked joints onto the last joint you clicked, so they move with it.'),
  A('Edit', 'detach', 'Detach (pull apart)', ['U'], () => (boneish() ? ed.detachBones() : pointish() ? ed.detachPoints() : notHere('Detach')), 'Points: splits a point so the faces around it can be pulled apart. Joints: unhooks the picked joints from their parent.'),
  A('Edit', 'makeFace', 'Make a face', ['N'], () => ed.makeFace(), 'Fills in a new surface between 3 or 4 picked points (in the order you clicked them).'),
  A('Edit', 'cleanup', 'Clean up the model…', ['C'], () => openCleanup(),
    'Finds the usual problems in AI-made models (points almost on top of each other, folds, bits poking through, hidden junk inside) and fixes them. A slider sets how hard it cleans; coloured points show what will change before you apply.'),
  A('Edit', 'merge', 'Merge points that are very close', [], () => ed.mergeByDistance(parseFloat($('#mergeT')?.value) || 0.001), 'Welds together points that are almost on top of each other. Closes little cracks in downloaded models.'),
  A('Mode', 'modeObject', 'Object mode', ['1'], () => ed.setMode('object'), 'Pick whole parts of the model.'),
  A('Mode', 'modeVertex', 'Vertex (points) mode', ['2'], () => ed.setMode('vertex'), 'Pick and move the corner points of the surface.'),
  A('Mode', 'modeEdge', 'Edge (lines) mode', ['3'], () => ed.setMode('edge'), 'Pick and move the lines between points.'),
  A('Mode', 'modeBone', 'Bone mode', ['4'], () => ed.setMode('bone'), 'Pick skeleton joints to move or turn them.'),
  A('Mode', 'modeDraw', 'Draw bones mode', ['5'], () => ed.setMode('draw'), 'Click on the model to drop joints inside it.'),
  A('Mode', 'modePaint', 'Paint mode', ['6'], () => ed.setMode('paint'), 'Paint, smudge or blur straight onto the model\'s surface with a brush.'),
  A('Mode', 'modeBuild', 'Build mode', ['7'], () => ed.setMode('build'), 'Build a model from shapes, the Blockbench way: cubes, cylinders, cones, spheres, pyramids and wedges on a grid, grouped into parts that bend. Saves as a Blockbench file; Make model turns it into a rigged model.'),
  A('Build', 'gPivot', 'Pivot tool', ['P'], () => buildOnly(() => build.setTool('pivot')), 'Drag to set the point a part or group turns around (for a group: where the joint bends, like a shoulder or knee).'),
  A('Build', 'bPaintTool', 'Colour tool', ['I'], () => buildOnly(() => build.setTool('paint')), 'Click a side of a part to give it the current colour. Shift+click colours the whole part. Alt+click picks up a colour.'),
  A('Build', 'bPushTool', 'Push / Pull tool (cut holes, add blocks)', ['Q'], () => buildOnly(() => build.setTool('push')), 'Click 2 to 4 points on a flat side of a part to mark a pane (they snap to the grid and the edges). Then drag the pane INTO the part to cut a pocket — or all the way through for a hole — or OUT of it to add a block. Cubes stay cubes (they are split around the hole); other shapes get a clean solid cut. Esc starts again.'),
  A('Build', 'bPixelTool', 'Pixel paint tool', ['D'], () => buildOnly(() => build.setTool('pixel')), 'Draw pixels straight onto the sides of cubes, like Blockbench\'s Paint tab: lines, abs, scars, stitching, trim. Pencil, Fill and Eraser are in the Tools window; Alt+click picks up a colour; Mirror paints the other side too. Each stroke is one Undo. Painted sides keep their pixels in the saved file and in the made model.'),
  A('Build', 'bClearPaint', 'Clear pixel paint from picked', [], () => buildOnly(() => build.clearPaint()), 'Takes the drawn pixels off the picked parts (or everything in the picked groups); their sides go back to plain colours.'),
  A('Build', 'bSnapTool', 'Snap point tool', ['O'], () => buildOnly(() => build.setTool('snap')), 'Click a part to put a snap point on it (it lands on middles and edges); click a dot to remove it. When you move a part, its snap points click onto other parts\' snap points — so pieces join exactly.'),
  A('Build', 'bClearSnaps', 'Remove snap points from picked', [], () => buildOnly(() => build.clearSnaps()), 'Takes the snap points off the picked parts (or everything in the picked groups).'),
  A('Build', 'bAddCube', 'Add a cube', ['Shift+A'], () => buildOnly(() => build.add('cube')), 'Adds a cube. If a part is picked, the new one sits on top of it.'),
  A('Build', 'bLocator', 'Add an attach point', [], () => buildOnly(async () => { const n = await askText('Name for the attach point (e.g. attach_hand_right):', 'attach_point'); if (n) build.addLocator(n); }), 'An invisible point where something can be held or attached later (a sword in a hand, a hat on a head). It moves with its group.'),
  A('Build', 'bCopy', 'Copy', ['Ctrl+C'], () => buildOnly(() => build.copy()), 'Remember the picked parts or groups so you can paste them.'),
  A('Build', 'bPaste', 'Paste', ['Ctrl+V'], () => buildOnly(() => build.paste()), 'Put a copy of what you copied into the picked group.'),
  A('Build', 'bDup', 'Duplicate', ['Ctrl+D'], () => buildOnly(() => build.duplicate()), 'Make a copy of what is picked, right on top of it — then move it.'),
  A('Build', 'bGroup', 'Group', ['Ctrl+G'], () => buildOnly(() => build.group()), 'Put the picked parts in a new group. A group is a piece that bends as one (an arm, a leg, the head) and becomes a joint when you make the model.'),
  A('Build', 'bCombine', 'Combine into one part', ['Ctrl+J'], () => buildOnly(() => build.combine()), 'Fuses everything in the picked group (or the picked parts) into ONE solid part and removes every face and point that ends up inside. Groups inside the group stay separate, because they bend. Lighter and cleaner, but the pieces can no longer be moved one by one (Undo works).'),
  A('Build', 'bUngroup', 'Ungroup', ['Ctrl+Shift+G'], () => buildOnly(() => build.ungroup()), 'Take the parts out of the picked group and remove the group.'),
  A('Build', 'bMirror', 'Mirror copy (left ↔ right)', ['M'], () => buildOnly(() => build.mirrorCopy('x')), 'Makes a mirrored twin on the other side of the middle line — build one arm, get the other. Names with left/right are swapped.'),
  A('Build', 'bFlipX', 'Flip left–right', [], () => buildOnly(() => build.flip('x')), 'Mirror what is picked in place, left to right.'),
  A('Build', 'bFlipY', 'Flip upside down', [], () => buildOnly(() => build.flip('y')), 'Mirror what is picked in place, top to bottom.'),
  A('Build', 'bFlipZ', 'Flip front–back', [], () => buildOnly(() => build.flip('z')), 'Mirror what is picked in place, front to back.'),
  A('Build', 'bNew', 'New build', [], () => { if (build.dirty && !confirm('Start a new build? Unsaved changes to this one are lost.')) return; ed.setMode('build'); return build.newDoc('new_model'); }, 'Start an empty build.'),
  A('Build', 'bOpen', 'Open a Blockbench file to build…', [], () => { $('#bbEditFile').click(); }, 'Open a .bbmodel to keep building it here (cubes keep their main colour per side).'),
  A('Build', 'bMake', 'Make model', ['Ctrl+Enter'], () => buildOnly(async () => { if (ed.root.children.length && !confirm('Make the model? It replaces the model open in the editor now (save that first if you need it).')) return; return build.makeModel(); }), 'Turns the build into a real model: each group becomes a joint, parts are solid and follow their joint. Hidden faces are dropped and flat colours merged, so it stays light. Then save it as a .glb.'),
  A('Paint', 'brushPaint', 'Brush: paint', [], () => setTool('paint'), 'Lay down colour where you drag.'),
  A('Paint', 'brushSmudge', 'Brush: smudge', [], () => setTool('smudge'), 'Drag colour along, like smudging wet paint with a finger.'),
  A('Paint', 'brushBlur', 'Brush: blur', [], () => setTool('blur'), 'Soften the texture under the brush (hides rough spots and hard seams).'),
  A('Paint', 'brushBigger', 'Bigger brush', [']'], () => sizeBrush(1.2), 'Make the brush bigger. Ctrl+mouse wheel also works.'),
  A('Paint', 'brushSmaller', 'Smaller brush', ['['], () => sizeBrush(1 / 1.2), 'Make the brush smaller. Ctrl+mouse wheel also works.'),
  A('Mode', 'animToggle', 'Switch Edit ↔ Animate', ['Tab'], () => ed.setAnimMode(!ed.animMode), 'Edit = the model at rest, where you build. Animate = pose it over time.'),
  A('Tools', 'gMove', 'Move tool', ['G'], () => (inBuild() ? build.setTool('move') : ed.setGizmo('translate')), 'Drag the arrows to slide what you picked.'),
  A('Tools', 'gRotate', 'Rotate tool', ['R'], () => (inBuild() ? build.setTool('rotate') : ed.setGizmo('rotate')), 'Drag the rings to turn what you picked.'),
  A('Tools', 'gScale', 'Scale / Stretch tool', ['S'], () => (inBuild() ? build.setTool('stretch') : ed.setGizmo('scale')), 'Drag the handles to resize what you picked. In Build mode: drag a round handle to pull that side of the part out or in (Shift pulls both sides).'),
  A('Tools', 'snapHold', 'Snap & merge (hold while dragging)', ['V'], () => { ed.snapHeld = true; status('Snap & merge: drag a point onto another point, then let go to join them'); queueRender(); },
    'Hold this key while dragging a point: it jumps onto the nearest other point under your mouse (yellow ring). Let go of the mouse and the two become one point — the faces and texture stretch to follow.',
    { release: () => { ed.snapHeld = false; queueRender(); } }),
  A('Tools', 'snapToggle', 'Snap & merge on / off', [], () => { ed.snapMerge = !ed.snapMerge; status(ed.snapMerge ? 'Snap & merge is ON: drop a dragged point onto another to join them' : 'Snap & merge is off'); queueRender(); },
    'Turns Snap & merge on for every drag, so you do not need to hold the key.'),
  A('Tools', 'smoothShape', 'Smooth the shape', [], () => ed.smoothPoints(),
    'Evens out lumps, dents and sharp creases. Works on the points you picked (their edge stays put so it blends in), or on the whole model if nothing is picked. The model keeps its size. Press again for more.'),
  A('Tools', 'smoothShadingOn', 'Smooth shading', [], () => ed.smoothShading(true),
    'Lights the surface as soft curves instead of flat facets, so a low-poly model looks rounded. Nothing moves; it is saved with the model.'),
  A('Tools', 'flatShadingOn', 'Flat shading (low-poly look)', [], () => ed.smoothShading(false),
    'Shows crisp flat facets again.'),
  A('Tools', 'xray', 'See-through (X-ray)', ['X'], () => { ed.setXray(!ed.xray); savePrefs(); }, 'Shows and lets you pick points on the back of the model.'),
  A('Rig', 'fitSkeleton', 'Fit a skeleton to the model', [], () => { if (!boneish()) ed.setMode('bone'); return ed.fitSkeleton(); },
    'Looks at the shape of the model (feet, knees, hips, armpits, neck, wrists) and puts a human skeleton inside it, in the right places.'),
  A('Rig', 'stick', 'Add a stick-figure skeleton', [], () => { if (!boneish()) ed.setMode('bone'); return ed.stickFigure(); }, 'Puts a ready-made human skeleton inside the model, sized to fit. Then drag the joints to line them up.'),
  A('Rig', 'bind', 'Bind (attach the skin to the skeleton)', ['Ctrl+B'], () => ed.bind(), 'Connects the model\'s surface to the skeleton so it bends when the joints move. Do this after the joints are in place (and again if you move them).'),
  A('Animate', 'makeWalk', 'Make a walk', [], () => ed.makeWalk({ style: walkStyle() }),
    'Makes a looping walk for a human skeleton: feet stay planted on the ground, knees and elbows bend, arms swing and the head bobs a little. Pick the Walk style in the Tools window first (Normal or Tough guy).'),
  A('Rig', 'autoRigWalk', 'Rig and walk in one go', [], () => { if (!boneish()) ed.setMode('bone'); ed.fitSkeleton(); ed.bind(); return ed.makeWalk({ style: walkStyle() }); },
    'Does it all: fits a skeleton to the model, attaches the skin to it, and makes a looping walk.'),
  A('Animate', 'play', 'Play / pause', ['Space'], () => ed.togglePlay(), 'Watch the animation.'),
  A('Animate', 'loopToggle', 'Loop on / off', ['L'], () => { ed.setLoop(!ed.loop); savePrefs(); }, 'When on, the animation repeats forever while playing.'),
  A('Animate', 'key', 'Set a key', ['K'], () => ed.key(), 'Saves the pose of the picked joints at this moment on the timeline.'),
  A('Animate', 'delKey', 'Delete key', ['Alt+K'], () => ed.deleteKeys(), 'Removes the keys at this moment (for the picked joints, or all).'),
  A('Animate', 'importClips', 'Copy animations from another model…', [], () => { const inp = $('#clipFile'); inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) run(async () => { const r = await ed.importClips(f); if (r.skippedTracks.length) status(`Copied ${r.copied.length} animations; skipped ${r.skippedTracks.length} tracks for joints this model does not have`); }); }; inp.click(); }, 'Copy the animations of another .glb onto this model, joint by joint (by name). Works when both models share the same skeleton names, e.g. a male and a female made the same way. Expression keys come too when the face parts have the same frames.'),
  A('Animate', 'closeLoop', 'Close the loop', [], () => ed.closeLoop(), 'Copies the first pose to the end so the loop has no jump.'),
  A('Animate', 'autoKey', 'Auto-key on / off', [], () => { ed.autoKey = !ed.autoKey; savePrefs(); ed.changed(); }, 'When on, posing a joint saves a key automatically.'),
  A('Animate', 'newClip', 'New animation', [], async () => { const n = await askText('Name for the new animation:', 'Action'); if (n) ed.newClip(n, ed.clip?.duration || 2); }, 'Start another separate animation (like Walk, Run, Wave).'),
  A('Animate', 'goStart', 'Go to start', ['Home'], () => { ed.pause(); ed.setTime(0); }),
  A('Animate', 'goEnd', 'Go to end', ['End'], () => { ed.pause(); ed.setTime(ed.clip?.duration || 0); }),
  A('Animate', 'prevKey', 'Previous key', [','], () => jumpKey(-1)),
  A('Animate', 'nextKey', 'Next key', ['.'], () => jumpKey(1)),
  A('Animate', 'prevFrame', 'Back one frame', ['ArrowLeft'], () => stepFrame(-1)),
  A('Animate', 'nextFrame', 'Forward one frame', ['ArrowRight'], () => stepFrame(1)),
  A('View', 'frame', 'Frame what is picked', ['F'], () => ed.frame(), 'Zooms the camera in on what you picked.'),
  A('View', 'viewFront', 'Front view', ['Alt+1'], () => ed.view('front')),
  A('View', 'viewSide', 'Side view', ['Alt+3'], () => ed.view('right')),
  A('View', 'viewTop', 'Top view', ['Alt+7'], () => ed.view('top')),
  A('View', 'viewPersp', '3D view', ['Alt+0'], () => ed.view('persp')),
  A('Windows', 'panelTools', 'Show / hide Tools window', [], () => panels.toggle('tools')),
  A('Windows', 'panelScene', 'Show / hide Scene window', [], () => panels.toggle('scene')),
  A('Windows', 'panelClips', 'Show / hide Animations window', [], () => panels.toggle('clips')),
  A('View', 'watchPhone', 'Watch from other devices…', [], () => openWatchPhone(), 'Let phones, tablets and other computers watch the view-only page: on your home Wi-Fi they just open the address; from outside your network they sign in with a password you set here.'),
  A('Windows', 'resetLayout', 'Put all windows back in place', [], () => panels.reset(), 'Docks every window back where it started.'),
  A('Help', 'help', 'Help', ['?', 'F1'], () => { $('#help').hidden = false; }),
  A('Help', 'keys', 'Keyboard shortcuts & mouse…', ['Ctrl+K'], () => keymap.open(), 'Change any shortcut, and choose which mouse button turns the view.'),
];
function buildOnly(fn) { if (!inBuild()) return status('That works in Build mode (press 7)'); return fn(); }
const keymap = new Keymap(ACTIONS, status);
/** In a Claude session's tab (until you Take over) only looking around works: tabs, views, framing, windows, theme, the Claude panel. */
const LOOK_ONLY = /^(tab|view|watch|theme|panel)|^(frame|help|keys|library|libraryMenu|takeOver|resetLayout|arrangeButtons|notifyToggle|claudeTerm)$/;
const allowed = id => { if (!ed.viewOnly || LOOK_ONLY.test(id)) return true; status('🤖 A Claude session is working in this tab — press Take over (in the bar above the view) to edit here'); return false; };
keymap.allow = allowed;
document.querySelectorAll('.toolbar [data-act]').forEach(b => b.classList.toggle('editonly', !LOOK_ONLY.test(b.dataset.act))); // greyed in a session's tab (styles.css body.viewonly)
const arrange = initArrange({ settings, status, askText, onChange: () => keymap.decorate(document) }); // (View > Arrange the buttons…)
tabs.showMenu = showCtxMenu;
tabs.banner = $('#tabBanner'); tabs.applyViewOnly();
const library = initLibrary({ editor: ed, panels, status, run, openTab: fn => tabs.openInNewTab(fn) });
window.glbAction = id => (id === 'libRefresh' ? library.refresh() : run(() => keymap.run(id)));
// ---------------- the menu line (under the logo row): main.js menuTemplate, read fresh on each open so ticks are current ----------------
if (window.glbApp?.menu) {
  const names = $('#menuNames'); let open = null;
  const item = it => it.type === 'separator' ? '<hr>' : it.submenu ? `<div class="menu-note">${esc(it.label)}</div><div class="msub">${it.submenu.map(item).join('')}</div>`
    : `<button ${it.id ? `data-act="${it.id}"${LOOK_ONLY.test(it.id) ? '' : ' class="editonly"'}` : `data-mrun="${it.run}"${it.checked ? ' data-checked="1"' : ''}`}><span class="tick">${it.checked ? '✓' : ''}</span>${esc(it.label)}<kbd class="sc"></kbd></button>`;
  const close = () => { if (!open) return; open.querySelector('.menu').hidden = true; open.querySelector('.mb-btn').classList.remove('open'); open = null; };
  const show = async dd => {
    close(); open = dd; const tpl = await window.glbApp.menu(), m = dd.querySelector('.menu');
    m.innerHTML = tpl[+dd.dataset.i].submenu.map(item).join(''); keymap.decorate(m); m.hidden = false; dd.querySelector('.mb-btn').classList.add('open');
  };
  window.glbApp.menu().then(tpl => {
    names.innerHTML = tpl.map((t, i) => `<div class="dropdown" data-i="${i}"><button class="mb-btn">${esc(t.label)}</button><div class="menu" hidden></div></div>`).join('');
    for (const dd of names.children) {
      dd.querySelector('.mb-btn').onclick = e => { e.stopPropagation(); open === dd ? close() : show(dd); };
      dd.querySelector('.mb-btn').onmouseenter = () => { if (open && open !== dd) show(dd); }; // slide along the menu line like a desktop app
      dd.querySelector('.menu').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.mrun) window.glbApp.menuRun(b.dataset.mrun, !b.dataset.checked); close(); }); // (data-act items run through the click handler below)
    }
  });
  document.addEventListener('pointerdown', e => { if (open && !e.target.closest('#menuNames .dropdown')) close(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}
// ---------------- the AI panel (shared: vendor/ai-panel, copied from node_modules/ai-panel by scripts/vendor.js) ----------------
let libRoot = ''; fetch('/api/lib/info').then(r => r.json()).then(j => { libRoot = j.root || ''; }).catch(() => {});
// opening the Claude panel leaves only the 3D view: the other windows are hidden, and come back when it is hidden again
const reopenAfterClaude = () => { const ids = settings.get('termHiddenPanels', []); settings.set('termHiddenPanels', []); for (const id of ids) if (panels.state[id] && !panels.isOpen(id) && !['sprites', 'cleanup'].includes(id)) panels.open(id); }; // (windows whose content is made when opened stay closed)
let claude = null; // set once its markup has loaded; loading it must not hold up the rest of ui.js (the control endpoint calls glbActionIn as soon as glbAction exists)
(async () => { // its markup: the 🤖 ▾ button goes at the end of the menu line, the panel at the end of the page
  const tpl = document.createElement('template'); tpl.innerHTML = await (await fetch('/vendor/ai-panel/ai-panel.html')).text();
  const [button, panel] = tpl.content.children; $('#aiPanelButton').replaceWith(button); $('#aiPanelHost').replaceWith(panel);
  claude = initTerminal({ appName: 'Simple GLB Editor', status, settings, workFolder: () => libRoot, workFolderName: 'Library', workFolderIcon: '📚', notify, away,
  onShow: () => { const ids = Object.keys(panels.state).filter(id => panels.isOpen(id)); if (ids.length) { settings.set('termHiddenPanels', [...new Set([...settings.get('termHiddenPanels', []), ...ids])]); ids.forEach(id => panels.close(id)); } },
  onHide: reopenAfterClaude });
  reopenAfterClaude(); // (quit while the Claude panel was open: the windows come back)
  window.claudeTerm = claude;
})().catch(e => status('⚠ The AI panel could not load: ' + e.message));
// where the Claude panel goes: drop-down under the toolbars; docked = from the top of the 3D view to just above the status line
const placeTerm = () => {
  const root = document.documentElement.style, px = v => Math.round(v) + 'px';
  const below = px(document.querySelector('.toolbar.second').getBoundingClientRect().bottom);
  root.setProperty('--term-top', below);
  root.setProperty('--term-side-top', below); // level with the top of the 3D view
  root.setProperty('--term-side-bottom', px(innerHeight - document.querySelector('footer').getBoundingClientRect().top + 4));
};
placeTerm(); addEventListener('resize', placeTerm); addEventListener('term-placed', () => requestAnimationFrame(placeTerm));
window.openPathInTab = p => openTab(t => t.load('/api/local?path=' + encodeURIComponent(p), p.split(/[\\/]/).pop())); // (opening the exe again with a file)
window.glbActionIn = (t, id) => tabs.runIn(t, () => window.glbAction(id)); // (control endpoint: a session's menu command, in its tab)
window.ACTIONS = ACTIONS.map(({ group, id, label, help }) => ({ group, id, label, help })); // for automation (mcp/server.mjs glb_action list)

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) { b.blur(); if (allowed(b.dataset.act)) run(() => keymap.run(b.dataset.act)); }
  const sm = e.target.closest('[data-submode]'); if (sm) { tabs.setSubMode(tabs.active, sm.dataset.submode); queueRender(); }
  if (e.target.closest('[data-subback]') && tabs.active?.parent) tabs.select(tabs.active.parent);
  const tk = e.target.closest('[data-takeover]'); if (tk) { tabs.takeOver(tabs.active, tk.dataset.takeover === '1'); queueRender(); status(tk.dataset.takeover === '1' ? 'You took over this tab' : 'The Claude session can work in this tab again'); }
  const c = e.target.closest('[data-close]'); if (c) $('#' + c.dataset.close).hidden = true;
});
$('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').hidden = true; });

// mouse buttons (in the Keys window)
const setMouse = () => {
  let rotate = $('#mouseRotate').value, pan = $('#mousePan').value;
  if (pan === rotate) { pan = ['right', 'middle', 'left'].find(b => b !== rotate); $('#mousePan').value = pan; }
  Object.assign(mouse, { rotate, pan }); for (const e of tabs.all()) e.setMouseButtons(rotate, pan); settings.set('mouse', { rotate, pan }); renderMouseHelp(); queueRender();
};
$('#mouseRotate').value = ed.mouse.rotate; $('#mousePan').value = ed.mouse.pan;
$('#mouseRotate').addEventListener('change', setMouse); $('#mousePan').addEventListener('change', setMouse);
const BTN = { left: 'Left', middle: 'Middle (wheel)', right: 'Right' };
function renderMouseHelp() {
  const leftFree = ed.mouse.rotate !== 'left' && ed.mouse.pan !== 'left';
  $('#helpMouse').innerHTML = `
    <li><b>${BTN[ed.mouse.rotate]}-drag</b> turns the view around the model.</li>
    <li><b>${BTN[ed.mouse.pan]}-drag</b> (or Shift + ${BTN[ed.mouse.rotate]}-drag) slides the view.</li>
    <li><b>Wheel</b> zooms in and out.</li>
    <li><b>Click</b> picks things; <b>Shift+click</b> adds to what is picked.</li>
    <li><b>${leftFree ? 'Left-drag on empty space' : 'Ctrl + left-drag'}</b> draws a box to pick many points, lines or joints.</li>
    <li>Drag the coloured arrows / rings to move or turn what is picked.</li>
    <li>Change the mouse buttons in <b>⌨ Keys</b>.</li>`;
}
renderMouseHelp();

// ---------------- files: open / drop ----------------
$('#bbEditFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openTab(async e => { e.setMode('build'); return e.build.open(f); }); });
$('#bbFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openTab(t => t.load(f)); });
$('#file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openTab(t => t.load(f)); });
const view = $('#view'), dropHint = $('#dropHint');
view.addEventListener('dragover', e => {
  const t = [...e.dataTransfer.types]; if (!t.includes('Files') && !t.includes(MIME_LIB)) return;
  e.preventDefault(); dropHint.hidden = false;
});
view.addEventListener('dragleave', e => { if (!view.contains(e.relatedTarget)) dropHint.hidden = true; });
view.addEventListener('drop', e => {
  e.preventDefault(); dropHint.hidden = true;
  const lib = e.dataTransfer.getData(MIME_LIB);
  if (lib) { const rels = JSON.parse(lib), bb = rels.find(r => /\.bbmodel$/i.test(r)); if (bb) { openTab(async t => { t.setMode('build'); return t.build.open(bb); }); return; } const rel = rels.find(r => /\.(glb|gltf)$/i.test(r)); if (rel) openTab(t => t.load(rel)); return; }
  const bbf = [...e.dataTransfer.files].find(f => /\.bbmodel$/i.test(f.name));
  if (bbf) { openTab(async t => { t.setMode('build'); return t.build.open(bbf); }); return; }
  const f = [...e.dataTransfer.files].find(f => /\.(glb|gltf)$/i.test(f.name));
  if (f) openTab(t => t.load(f)); else status('Only .glb / .gltf / .bbmodel files can be opened');
});
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => e.preventDefault());

// ---------------- panel contents ----------------
const fmt = n => (Math.round(n * 1000) / 1000).toString();
const btn = (act, label, extra = '') => `<button data-act="${act}" ${extra}>${label}<kbd class="sc"></kbd></button>`;
const xyz = (key, v, tip, step = '0.01') => v.map((x, i) => `<input type="number" step="${step}" data-f="${key}" data-i="${i}" value="${fmt(x)}" title="${tip} (${'XYZ'[i]}: ${['left/right', 'up/down', 'front/back'][i]})">`).join('');
const readXYZ = key => [...document.querySelectorAll(`[data-f="${key}"]`)].map(i => parseFloat(i.value) || 0);
const deg = r => r * 180 / Math.PI;

function renderTools() {
  const m = ed.mode; let h = '';
  if (m === 'build') { $('#toolsBody').innerHTML = buildToolsHtml(); keymap.decorate($('#toolsBody')); return; }
  if (m === 'object') {
    const o = ed.sel.meshes[ed.sel.meshes.length - 1];
    h += `<h4>Object</h4><div class="hint">Click a part of the model to pick it. Then drag the arrows to move it.</div>`;
    if (o) h += `<div class="row"><label>Name</label><input type="text" data-f="objname" value="${esc(o.name)}" title="The name of this part. Type a new one and press Enter."></div>
      <div class="row"><label title="Where the part is">Place</label>${xyz('objpos', o.position.toArray(), 'Position')}</div>
      <div class="row"><label title="How the part is turned, in degrees">Turn°</label>${xyz('objrot', [o.rotation.x, o.rotation.y, o.rotation.z].map(deg), 'Rotation in degrees', '1')}</div>
      <div class="row"><label title="How big the part is (1 = normal)">Size</label>${xyz('objscale', o.scale.toArray(), 'Scale (1 = normal size)')}</div>`;
    h += mergeBlock();
  } else if (pointish()) {
    const n = ed.selectedPointCount();
    h += `<h4>${m === 'vertex' ? 'Points' : 'Lines'}</h4>
      <div class="hint">Click to pick, Shift+click to add more, drag a box on empty space to pick many. Then drag the arrows to move them. <b>${n}</b> point${n === 1 ? '' : 's'} picked.</div>
      <div class="btns"><button data-act="snapToggle" class="toggle${ed.snapping ? ' on' : ''}" style="grid-column:span 2">🧲 Snap &amp; merge${ed.snapHeld ? ' (key held)' : ''}<kbd class="sc"></kbd></button></div>
      <div class="hint">Hold <b>${keymap.combos('snapHold')[0] || '(no key)'}</b> while dragging a point onto another point to join them.</div>
      <div class="btns">${btn('attach', 'Attach')}${btn('detach', 'Detach')}${btn('delete', 'Delete faces')}${btn('makeFace', 'Make face', m === 'vertex' ? '' : 'disabled')}${btn('selectAll', 'Pick all')}${btn('deselect', 'Pick none')}</div>
      <div class="row"><label class="lbl chk" title="Show and let you pick points on the back of the model too. Without it, only points you can see can be picked."><input type="checkbox" data-f="xray" ${ed.xray ? 'checked' : ''}> See-through (X-ray)</label></div>
      <div class="row"><label title="How big the points are drawn. Bigger points are also easier to click.">Point size</label><input type="range" id="ptSize" min="4" max="24" step="1" value="${ed.pointSize}" title="Drag to make the points bigger or smaller. The area you can click to pick a point grows with them."><span class="muted" style="min-width:34px">${ed.pointSize} px</span></div>
      <h4>Nudge</h4>
      <div class="row"><label title="How far to move">Move by</label>${xyz('nudge', [0, 0, 0], 'Distance to move')}</div>
      <div class="btns"><button data-f="nudgeGo" title="Move the picked points by exactly the amounts typed above.">Move picked points</button></div>
      ${ed.meshes().some(x => x.isSkinnedMesh) ? `<h4>Weights</h4>
      <div class="row"><label title="The joint the picked skin should follow">Joint</label><select id="wJoint" title="Pick the joint that the picked points should move with.">${[...new Set(ed.meshes().filter(x => x.isSkinnedMesh).flatMap(x => x.skeleton.bones.map(b => b.name)))].map(n => `<option${n === paintPrefs.joint ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div class="btns"><button data-f="assignW" title="The picked points will move only with the joint chosen above (e.g. make a backpack follow the chest, not an arm).">Give picked to joint</button><button data-f="smoothW" title="Blends how skin hands over from one joint to the next, so bends don't pinch. Works on the picked points, or the whole model if none are picked.">Smooth weights</button></div>` : ''}
      <h4>Paint</h4>
      <div class="row"><label title="The colour to paint the picked area">Colour</label><input type="color" id="paintC" value="${paintPrefs.color}" title="Pick the paint colour."></div>
      <div class="row"><label title="How much of the old folds and shading still shows through the paint">Keep detail</label><input type="range" id="paintK" min="0" max="1" step="0.05" value="${paintPrefs.keep}" title="Left = solid colour, right = the old light and dark detail shows through."></div>
      <div class="row"><label class="lbl chk" title="Draw a darker seam round the edge of the painted area, like stitching."><input type="checkbox" id="paintR" ${paintPrefs.rim ? 'checked' : ''}> Seam round the edge</label></div>
      <div class="row"><label title="How wide a painted stroke is, in model units">Stroke width</label><input type="number" id="paintW" step="0.005" min="0.002" value="${paintPrefs.width}" title="Width of the band that Paint stroke draws (e.g. a strap)."></div>
      <div class="btns"><button data-f="paintGo" title="Paints every face whose corners are all picked, straight into the model's texture. Undo works.">Paint picked area</button><button data-f="strokeGo" title="Click points one after another along the surface (Shift+click to add), then press this: a band is painted through them in that order, like a strap or a stripe.">Paint stroke</button></div>
      ${mergeBlock()}`;
  } else if (m === 'paint') {
    const B = ed.brush, tb = (t, label, tip) => `<button data-f="tool" data-tool="${t}" class="toggle${B.tool === t ? ' on' : ''}" title="${tip}">${label}</button>`;
    h += `<h4>Paint brush</h4>
      <div class="hint">Drag on the model to paint. <b>Alt+click</b> picks a colour off the model. <b>Ctrl+wheel</b> (or <b>[</b> and <b>]</b>) changes the brush size. Each stroke is one Undo.</div>
      <div class="btns three">${tb('paint', '🖌 Paint', 'Lay down colour where you drag.')}${tb('smudge', '👆 Smudge', 'Drag colour along, like smudging wet paint with a finger.')}${tb('blur', '💧 Blur', 'Soften the texture under the brush: hides rough spots and hard seams.')}</div>
      <div class="row"><label title="The paint colour">Colour</label><input type="color" id="brushC" value="${B.color}" title="Pick the paint colour (or Alt+click the model to pick one off it)."></div>
      <div class="row"><label title="How big the brush is, in screen pixels">Size</label><input type="range" id="brushS" min="2" max="200" step="1" value="${B.size}" title="How big the brush is on screen."><span class="muted" style="min-width:44px" id="brushSv">${B.size} px</span></div>
      <div class="row"><label title="How strongly each stroke works">Strength</label><input type="range" id="brushA" min="0.05" max="1" step="0.05" value="${B.strength}" title="Left = a light touch that builds up slowly, right = full strength at once."></div>
      <div class="row"><label title="How soft the edge of the brush is">Softness</label><input type="range" id="brushH" min="0" max="1" step="0.05" value="${B.softness}" title="Left = a hard, crisp edge. Right = a soft edge that fades out."></div>
      <div class="hint">The brush only paints surfaces facing you, so an arm resting on the body won't pick up paint meant for the body.</div>`;
  } else {
    const b = ed.activeBone;
    h += `<h4>Skeleton</h4>`;
    h += m === 'draw'
      ? `<div class="hint">Click on the model to drop a joint <i>inside</i> it — each click adds a joint connected to the yellow one, like drawing a stick figure. Click an existing joint to branch off from it. Right-click or Esc ends the chain.</div>`
      : `<div class="hint">Click joints to pick them (Shift adds more). ${ed.animMode ? 'Turn joints to pose the model — keys are saved for you.' : 'Drag joints to line them up with the model.'}</div>`;
    h += `<div class="btns"><button data-act="autoRigWalk" class="primary" style="grid-column:span 2">🚶 Rig &amp; walk in one go<kbd class="sc"></kbd></button></div>
      <div class="btns">${btn('fitSkeleton', 'Fit skeleton')}${btn('stick', 'Stick figure')}${btn('bind', 'Bind')}${btn('makeWalk', 'Make walk')}${btn('attach', 'Attach')}${btn('detach', 'Detach')}${btn('delete', 'Delete')}${btn('selectAll', 'Pick all')}</div>
      <div class="row"><label title="How the walk looks when you press Make walk (or Rig &amp; walk)">Walk style</label><select data-f="walkStyle" title="${esc(Object.values(WALK_STYLES).map(w => w.label + ': ' + w.help).join('  '))}">${Object.entries(WALK_STYLES).map(([k, w]) => `<option value="${k}"${k === walkStyle() ? ' selected' : ''}>${esc(w.label)}</option>`).join('')}</select></div>
      <div class="hint">${esc(WALK_STYLES[walkStyle()].help)}</div>
      <div class="row"><label class="lbl chk" title="When on, moving a joint also moves everything hanging off it (like moving a shoulder moves the whole arm). Turn off to move just that one joint."><input type="checkbox" data-f="follow" ${ed.childrenFollow ? 'checked' : ''}> Moving a joint moves its children</label></div>
      <div class="row"><label class="lbl chk" title="Keep the skeleton visible in every mode, not just Bone mode."><input type="checkbox" data-f="showbones" ${ed.showBones ? 'checked' : ''}> Always show the skeleton</label></div>`;
    if (b) {
      const w = b.getWorldPosition(new ed.THREE.Vector3());
      h += `<h4>Picked joint</h4>
        <div class="row"><label>Name</label><input type="text" data-f="bname" value="${esc(b.name)}" title="The joint's name. Type a new one and press Enter."></div>
        <div class="row"><label title="Where the joint is">Place</label>${xyz('bpos', w.toArray(), 'Position')}</div>
        <div class="row"><label title="How the joint is turned, in degrees">Turn°</label>${xyz('brot', [b.rotation.x, b.rotation.y, b.rotation.z].map(deg), 'Rotation in degrees', '1')}</div>
        ${b.userData.slide ? `<div class="row"><label title="Where it is along its rail: 0 = start, 1 = end">Slide</label><input type="range" min="0" max="1" step="0.01" data-f="slideV" value="${ed.slideValue(b.name) ?? 0}" title="${ed.animMode ? 'Drag to slide the joint along its rail — a position key is saved at this moment.' : 'Switch to Animate to slide it (in Edit mode the rail starts here).'}" ${ed.animMode ? '' : 'disabled'}><span class="muted" style="min-width:34px">${(ed.slideValue(b.name) ?? 0).toFixed(2)}</span></div>
        <div class="hint">Slide joint: it moves only along its rail (${fmt(b.userData.slide.max - b.userData.slide.min)} long) and never turns. Dragging it in Animate mode stays on the rail.</div>` : ''}
        <div class="hint">Hangs off: ${b.parent?.isBone ? esc(b.parent.name) : '— (nothing, it is a starting joint)'} · Children: ${b.children.filter(c => c.isBone).map(c => esc(c.name)).join(', ') || '—'}</div>`;
    }
  }
  $('#toolsBody').innerHTML = h;
}
function mergeBlock() {
  return `<h4>Repair</h4>
    <div class="btns"><button data-act="cleanup" class="primary" style="grid-column:span 2">🧹 Clean up…<kbd class="sc"></kbd></button></div>
    <div class="row"><label title="Points closer together than this get welded into one">Closer than</label><input type="number" step="0.0005" value="0.001" id="mergeT" title="How close (in model units) two points must be to be welded together."></div>
    <div class="btns">${btn('merge', 'Merge close points')}${btn('smoothShape', 'Smooth shape')}${btn('smoothShadingOn', 'Smooth shading')}${btn('flatShadingOn', 'Flat shading')}</div>`;
}
function renderScene() {
  if (inBuild()) return renderOutliner();
  let h = `<h4>Model parts</h4>`;
  const meshes = []; ed.root.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) h += `<div class="tree-row ${ed.sel.meshes.includes(m) ? 'sel' : ''}" data-mesh="${esc(m.name)}" title="A part of the model. Click to pick it.${m.userData.layer ? ' A switchable clothing set: the eye shows or hides it (the saved .glb always has it; the game picks).' : ''}"><input type="checkbox" data-eye="${esc(m.name)}" ${m.visible ? 'checked' : ''} title="Show / hide" style="margin-right:4px">▣ ${esc(m.name)}${m.isSkinnedMesh ? ' <span class="muted">(bound)</span>' : ''}${m.userData.frames ? ` <select data-frame="${esc(m.name)}" title="${ed.animMode ? 'Pick a picture: it is keyed at this moment of the animation (holds until the next key).' : 'Preview a picture. In Animate mode picking one keys it at the current time.'}" style="margin-left:4px">${Object.keys(m.userData.frames).map(f => `<option${f === m.userData.frame ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>` : ''}</div>`;
  if (!meshes.length) h += `<div class="hint">Nothing loaded yet. Click <b>Open…</b>, the <b>Library</b>, or <b>Dummy</b>.</div>`;
  h += `<h4>Skeleton</h4>`;
  const walk = (o, depth) => {
    for (const c of o.children) {
      if (c.isBone) {
        const cls = c === ed.activeBone ? 'act' : ed.sel.bones.includes(c) ? 'sel' : '';
        h += `<div class="tree-row ${cls}" data-bone="${esc(c.name)}" style="padding-left:${6 + depth * 12}px" title="A skeleton joint. Click to pick it, Shift+click to add it.">● ${esc(c.name)}</div>`;
        walk(c, depth + 1);
      } else walk(c, depth);
    }
  };
  walk(ed.root, 0);
  if (!ed.allBones().length) h += `<div class="hint">No skeleton yet — use <b>Stick figure</b> or <b>Draw bones</b>.</div>`;
  const cols = ed.colliders();
  if (cols.length) h += `<h4>Colliders</h4><div class="row"><label class="lbl chk" title="Show or hide the collider wireframes (they are always saved in the .glb)."><input type="checkbox" data-f="colShowModel" ${ed.showColliders !== false ? 'checked' : ''}> Show colliders</label></div>${cols.map(c => `<div class="tree-row" ${c.joint ? `data-bone="${esc(c.joint)}"` : ''} title="A ${c.shape} collider${c.joint ? ' that moves with ' + esc(c.joint) : ''}.">⬚ ${esc(c.name)} <span class="muted">${c.shape}${c.joint ? ' on ' + esc(c.joint) : ''}</span></div>`).join('')}`;
  const attach = []; ed.root.traverse(o => { if (!o.isBone && !o.isMesh && o.parent?.isBone && !o.children.some(c => c.isMesh) && !o.userData.collider) attach.push(o); });
  if (attach.length) {
    h += `<h4>Attach points</h4>`;
    for (const o of attach) h += `<div class="tree-row" data-bone="${esc(o.parent.name)}" title="An attach point: something held or worn goes here (it moves with the joint ${esc(o.parent.name)}). Click to pick its joint.">✚ ${esc(o.name)} <span class="muted">on ${esc(o.parent.name)}</span></div>`;
  }
  $('#sceneBody').innerHTML = h;
}
function renderClips() {
  let h = '';
  ed.clips.forEach((c, i) => {
    h += `<div class="clip-row ${i === ed.clipIndex ? 'act' : ''}"><button data-clip="${i}" title="Switch to this animation.">${i === ed.clipIndex ? '▶ ' : ''}${esc(c.name)}</button><span class="muted">${c.duration}s</span></div>`;
  });
  if (!ed.clips.length) h += `<div class="hint">No animations yet. Switch to <b>Animate</b> (or press New) to start one.</div>`;
  h += `<div class="btns" style="margin-top:6px">${btn('newClip', '+ New')}<button data-f="delclip" ${ed.clip ? '' : 'disabled'} title="Throw away this animation.">Delete</button></div>`;
  if (ed.clip) h += `<div class="row"><label>Name</label><input type="text" data-f="clipname" value="${esc(ed.clip.name)}" title="The animation's name, e.g. Walk or Wave."></div>
    <div class="row"><label>Length</label><input type="number" step="0.1" min="0.1" data-f="clipdur" value="${ed.clip.duration}" title="How long the animation lasts, in seconds."></div>`;
  $('#clipsBody').innerHTML = h;
}
for (const id of ['#toolsBody', '#sceneBody', '#clipsBody']) {
  $(id).addEventListener('change', e => {
    if (e.target.dataset.frame) { const n = e.target.dataset.frame, v = e.target.value; return run(() => (ed.animMode ? ed.frameKey(n, v) : ed.setFrame(n, v))); }
    const f = e.target.dataset.f; if (!f) return;
    run(() => {
      const o = ed.sel.meshes[ed.sel.meshes.length - 1], b = ed.activeBone;
      if (f === 'xray') { ed.setXray(e.target.checked); savePrefs(); }
      if (f === 'colShowModel') { ed.showColliders = e.target.checked; ed.changed(); }
      if (f === 'follow') { ed.childrenFollow = e.target.checked; savePrefs(); }
      if (f === 'showbones') { ed.showBones = e.target.checked; savePrefs(); }
      if (f === 'walkStyle') { prefs.walkStyle = e.target.value; savePrefs(); ed.changed(); status('Walk style: ' + WALK_STYLES[walkStyle()].label + '. Press Make walk to use it.'); }
      if (f === 'bname') ed.rename(b.name, e.target.value);
      if (f === 'slideV') ed.slide(b.name, +e.target.value);
      if (f === 'bpos') ed.setBonePosition(b.name, readXYZ('bpos'));
      if (f === 'brot') ed.setBoneRotation(b.name, readXYZ('brot'));
      if (f === 'objname') ed.rename(o.name, e.target.value);
      if (f === 'objpos') ed.setObjectTransform(o.name, { position: readXYZ('objpos') });
      if (f === 'objrot') ed.setObjectTransform(o.name, { rotation: readXYZ('objrot') });
      if (f === 'objscale') ed.setObjectTransform(o.name, { scale: readXYZ('objscale') });
      if (f === 'clipname') ed.setClipProps({ name: e.target.value });
      if (f === 'clipdur') ed.setClipProps({ duration: parseFloat(e.target.value) });
    });
  });
  $(id).addEventListener('click', e => {
    if (e.target.dataset?.eye) { e.stopPropagation(); run(() => ed.setLayer(e.target.dataset.eye, e.target.checked)); return; }
    const t = e.target.closest('[data-bone],[data-mesh],[data-clip],[data-f]'); if (!t) return;
    run(() => {
      if (t.dataset.bone) { if (!boneish()) ed.setMode('bone'); ed.selectBones(t.dataset.bone, e.shiftKey); }
      else if (t.dataset.mesh) { if (ed.mode !== 'object') ed.setMode('object'); ed.selectMeshes(t.dataset.mesh, e.shiftKey); }
      else if (t.dataset.clip) ed.setClip(+t.dataset.clip);
      else if (t.dataset.f === 'nudgeGo') ed.movePoints(readXYZ('nudge'));
      else if (t.dataset.f === 'tool') setTool(t.dataset.tool);
      else if (t.dataset.f === 'paintGo') {
        Object.assign(paintPrefs, { color: $('#paintC').value, keep: +$('#paintK').value, rim: $('#paintR').checked });
        ed.paintFaces({ color: paintPrefs.color, keep: paintPrefs.keep, rim: paintPrefs.rim ? 4 : 0 });
      } else if (t.dataset.f === 'assignW') { paintPrefs.joint = $('#wJoint').value; ed.assignWeights(paintPrefs.joint); }
      else if (t.dataset.f === 'smoothW') ed.smoothWeights();
      else if (t.dataset.f === 'strokeGo') {
        Object.assign(paintPrefs, { color: $('#paintC').value, keep: +$('#paintK').value, rim: $('#paintR').checked, width: +$('#paintW').value || 0.02 });
        const sel = ed.selectedPoints(); if (sel.size !== 1) return status('Pick 2 or more points on one part, in order along the stroke');
        const [mesh, s] = [...sel][0], w = ed.topo(mesh).world, path = [...s].map(p => [w[p * 3], w[p * 3 + 1], w[p * 3 + 2]]);
        if (path.length < 2) return status('Pick 2 or more points, in order along the stroke');
        ed.paintStroke(path, { meshName: mesh.name, width: paintPrefs.width, color: paintPrefs.color, keep: paintPrefs.keep, rim: paintPrefs.rim ? 0.22 : 0 });
      }
      else if (t.dataset.f === 'delclip' && confirm(`Throw away the animation “${ed.clip.name}”?`)) ed.deleteClip();
    });
  });
}

// ---------------- Build mode panels ----------------
const bxyz = (key, v, tip, step = '0.25') => v.map((x, i) => `<input type="number" step="${step}" data-b="${key}" data-i="${i}" value="${fmt(x)}" title="${tip} (${'XYZ'[i]}: ${['left/right', 'up/down', 'front/back'][i]})">`).join('');
const readB = key => [...document.querySelectorAll(`[data-b="${key}"]`)].map(i => parseFloat(i.value) || 0);
const outlineOpen = new Set(); let outlineDocName = null;
function buildToolsHtml() {
  const B = build, sel = B.sel.map(id => B.node(id)).filter(Boolean), p = sel[sel.length - 1];
  const tb = (act, label, tool, tip) => `<button data-act="${act}" class="toggle${B.tool === tool ? ' on' : ''}" title="${tip}">${label}<kbd class="sc"></kbd></button>`;
  const opt = (vals, cur, lab) => vals.map(v => `<option value="${v}"${+v === +cur ? ' selected' : ''}>${lab(v)}</option>`).join('');
  const used = [...new Set(Object.values(B.doc.nodes).flatMap(n => n.kind !== 'part' ? [] : n.shape === 'mesh' ? n.mesh.tris.map(t => t.color) : Object.values(n.colors)).filter(Boolean))].slice(0, 32);
  let h = `<h4>Build</h4>
    <div class="hint">Add shapes, then move, stretch and turn them. Put parts that bend together in a <b>group</b> and set its <b>pivot</b> (where it bends). <b>Make model</b> turns it into a rigged model.</div>
    <div class="btns three">${Object.entries(SHAPES).map(([k, s]) => `<button data-b="add" data-shape="${k}" title="Add a ${s.label.toLowerCase()}. ${esc(s.help)} If a part is picked, the new one sits on top of it.">${s.icon} ${s.label}</button>`).join('')}</div>
    <h4>Tool</h4>
    <div class="btns three">${tb('gMove', '✥ Move', 'move', 'Drag the arrows to slide what you picked.')}${tb('gScale', '⇲ Stretch', 'stretch', 'Drag a round handle to pull that side of the part out or in. Shift = both sides.')}${tb('gRotate', '⟳ Rotate', 'rotate', 'Drag the rings to turn what you picked around its pivot.')}${tb('gPivot', '⊕ Pivot', 'pivot', 'Drag to set where the part or group turns (for a group: where it bends).')}${tb('bPaintTool', '🪣 Colour', 'paint', 'Click a side to colour it. Shift+click = whole part, Alt+click = pick up a colour.')}${tb('bSnapTool', '📍 Snap point', 'snap', 'Click a part to add a snap point, click a dot to remove it.')}${tb('bPushTool', '⇳ Push / Pull', 'push', 'Click corners on a flat side to mark a pane, then drag it in to cut a hole or out to add a block.')}${tb('bPixelTool', '✏ Pixel paint', 'pixel', 'Draw pixels on the sides of cubes.')}</div>
    ${B.tool === 'pixel' ? `<h4>Pixel paint</h4>
    <div class="hint">Drag on a side of a cube to draw. <b>Alt+click</b> picks up a colour. Each stroke is one Undo. A side painted back to one colour becomes a plain side again.</div>
    <div class="btns three">${[['pencil', '✏ Pencil', 'Draw pixels where you drag.'], ['fill', '🪣 Fill', 'Fill the touching pixels of the same colour.'], ['erase', '⌫ Eraser', 'Paint back the side\'s own plain colour.'], ['text', '🔤 Text', 'Click a side to write the text below there (its top-left lands on the pixel you click).']].map(([k, l, t]) => `<button data-b="pxmode" data-mode="${k}" class="toggle${B.pixelBrush.mode === k ? ' on' : ''}" title="${t}">${l}</button>`).join('')}</div>
    ${B.pixelBrush.mode === 'text' ? `<div class="row"><label title="What to write">Text</label><input type="text" data-b="pxtext" value="${esc(B.pixelBrush.text || '')}" title="The text to stamp. Click a side to write it there."></div>
    <div class="row"><label title="How tall the letters are, in pixels">Size / font</label><select data-b="pxtsize" title="Letter height in pixels.">${[5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24].map(v => `<option value="${v}"${(B.pixelBrush.textSize || 7) === v ? ' selected' : ''}>${v} px</option>`).join('')}</select><select data-b="pxfont" title="Letter style.">${[['sans', 'Plain'], ['serif', 'Serif'], ['mono', 'Typewriter']].map(([v, l]) => `<option value="${v}"${(B.pixelBrush.font || 'sans') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="row"><label class="lbl chk" title="Thicker letters (easier to read when small)"><input type="checkbox" data-b="pxbold" ${B.pixelBrush.bold ? 'checked' : ''}> Bold</label></div>` : ''}
    <div class="row"><label title="How many pixels wide the pencil and eraser are">Brush</label><select data-b="pxsize" title="Pencil / eraser size in pixels.">${[1, 2, 3, 4].map(v => `<option value="${v}"${B.pixelBrush.size === v ? ' selected' : ''}>${v} px</option>`).join('')}</select></div>
    <div class="row"><label title="How fine the pixel grid is on a side you paint for the first time">Pixels per unit</label><select data-b="pxppu" title="Pixels per Blockbench unit for sides painted for the first time (16 units = 1 block). Sides already painted keep their grid.">${[1, 2, 4, 8].map(v => `<option value="${v}"${B.pixelDensity === v ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><label class="lbl chk" title="Also paint the same spot on the other side of the middle line (left ↔ right)"><input type="checkbox" data-b="pxmirror" ${B.pixelBrush.mirror ? 'checked' : ''}> Mirror left ↔ right</label></div>
    <div class="btns">${btn('bClearPaint', 'Clear paint on picked')}</div>${framesHtml(B)}` : ''}
    <div class="row"><label title="Moving and stretching jump in steps this big (16 = one block)">Grid step</label><select data-b="grid" title="Moving and stretching jump in steps this big. 16 units = one block / one metre.">${opt([4, 2, 1, 0.5, 0.25, 0], B.gridStep, v => (+v ? v + ' unit' + (+v === 1 ? '' : 's') : 'Off (free)'))}</select></div>
    <div class="row"><label title="When you move a part, it clicks onto points of other parts that it comes close to on screen">Snap parts</label><select data-b="snapmode" title="When you move a part it clicks onto other parts. Hold Alt while dragging to move freely.">${[['all', 'Snap points, corners, side middles'], ['points', 'Snap points only'], ['off', 'Off']].map(([v, l]) => `<option value="${v}"${B.snapMode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="row"><label title="Turning jumps in steps this big">Turn step</label><select data-b="rotstep" title="Turning jumps in steps this many degrees.">${opt([90, 45, 22.5, 15, 5, 0], B.rotStep, v => (+v ? v + '°' : 'Off (free)'))}</select></div>
    <h4>Colour</h4>
    <div class="row"><label title="The colour new shapes get, and the Colour tool paints with">Colour</label><input type="color" data-b="color" value="${B.color}" title="The colour for new shapes and for the Colour tool."><button data-b="paintSel" title="Give the picked parts (or everything in the picked groups) this colour on every side.">Colour picked</button></div>
    ${used.length ? `<div class="swatches">${used.map(c => `<button class="sw${c === B.color ? ' on' : ''}" data-b="swatch" data-c="${c}" style="background:${c}" title="Use ${c}"></button>`).join('')}</div>` : ''}
    <h4>Edit</h4>
    <div class="btns three">${btn('bCopy', 'Copy')}${btn('bPaste', 'Paste')}${btn('bDup', 'Duplicate')}${btn('bGroup', 'Group')}${btn('bUngroup', 'Ungroup')}${btn('delete', 'Delete')}</div>
    <div class="btns three">${btn('bCombine', '⧉ Combine')}${btn('bMirror', '⇆ Mirror copy')}${btn('bLocator', '✚ Attach point')}</div>
    <div class="btns">${btn('bClearSnaps', 'Remove snap points')}</div>
    <div class="btns three">${btn('bFlipX', 'Flip ↔')}${btn('bFlipY', 'Flip ↕')}${btn('bFlipZ', 'Flip front/back')}</div>`;
  if (sel.length === 1) {
    if (p.kind === 'part') {
      const size = p.to.map((t, i) => t - p.from[i]);
      h += `<h4>Picked part</h4>
        <div class="row"><label>Name</label><input type="text" data-b="name" value="${esc(p.name)}" title="The part's name. Type a new one and press Enter."></div>
        ${p.shape !== 'mesh' ? `<div class="row"><label>Shape</label><select data-b="shape" title="Change what shape this part is (it keeps its size and place).">${Object.entries(SHAPES).map(([k, s]) => `<option value="${k}"${k === p.shape ? ' selected' : ''}>${s.label}</option>`).join('')}</select></div>` : ''}
        <div class="row"><label title="The corner the part starts from">Place</label>${bxyz('from', p.from, 'Start corner')}</div>
        <div class="row"><label title="How big the part is">Size</label>${bxyz('size', size, 'Size')}</div>
        <div class="row"><label title="The point it turns around">Pivot</label>${bxyz('origin', p.origin, 'Pivot point')}</div>
        <div class="row"><label title="How it is turned, in degrees">Turn°</label>${bxyz('rotation', p.rotation, 'Turn in degrees', '1')}</div>
        ${p.snaps?.length ? `<div class="hint">📍 ${p.snaps.length} snap point${p.snaps.length === 1 ? '' : 's'} on this part.</div>` : ''}
        ${['cylinder', 'cone', 'sphere'].includes(p.shape) ? `<div class="row"><label title="How round it is: more sides = smoother but heavier">Sides</label><input type="number" min="3" max="48" step="1" data-b="sides" value="${p.sides}" title="More sides = rounder (and more triangles)."></div>` : ''}`;
    } else if (p.kind === 'group') {
      h += `<h4>Picked group</h4>
        <div class="row"><label>Name</label><input type="text" data-b="name" value="${esc(p.name)}" title="The group's name — it becomes the joint name (e.g. arm_upper_right)."></div>
        <div class="row"><label title="Where the group bends">Pivot</label>${bxyz('origin', p.origin, 'Pivot point (the joint)')}</div>
        <div class="row"><label title="How the whole group is turned, in degrees">Turn°</label>${bxyz('rotation', p.rotation, 'Turn in degrees', '1')}</div>
        <div class="row"><label class="lbl chk" title="A slide joint moves along a straight line and never turns: a jaw, eyelid, visor, drawer, piston, a sword in its scabbard."><input type="checkbox" data-b="slideOn" ${p.slide ? 'checked' : ''}> Slide joint (moves in a line, no turning)</label></div>
        ${p.slide ? (() => { const dirs = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }, cur = Object.keys(dirs).find(k => dirs[k].every((v, i) => Math.abs(v - p.slide.axis[i]) < 1e-3)) || '';
          return `<div class="row"><label title="Which way it slides">Direction</label><select data-b="slideAxis" title="The direction of the rail (in the frame of the group it hangs off, so it turns along with it).">${['up', 'down', 'north', 'south', 'east', 'west'].map(k => `<option value="${k}"${k === cur ? ' selected' : ''}>${{ up: 'Up', down: 'Down', north: 'North (−Z)', south: 'South (+Z)', east: 'East (+X)', west: 'West (−X)' }[k]}</option>`).join('')}${cur ? '' : '<option selected value="">Custom (set by points)</option>'}</select></div>
          <div class="row"><label title="How far along the rail it can go, in units from where it is now (0 = this pose)">Start / End</label><input type="number" step="0.1" data-b="slideMin" value="${fmt(p.slide.min)}" title="Start of the rail (0 = where it is now). Slider value 0 puts it here."><input type="number" step="0.1" data-b="slideMax" value="${fmt(p.slide.max)}" title="End of the rail. Slider value 1 puts it here."></div>
          <div class="hint">The purple line in the view is the rail. After <b>Make model</b>, pick this joint in Animate mode and use its <b>Slide</b> slider (0 = start, 1 = end).</div>`; })() : ''}
        <div class="hint">Double-click a part in the view to pick its group.</div>`;
    } else {
      h += `<h4>Picked attach point</h4>
        <div class="row"><label>Name</label><input type="text" data-b="name" value="${esc(p.name)}" title="Its name, e.g. attach_hand_right."></div>
        <div class="row"><label>Place</label>${bxyz('position', p.position, 'Position')}</div>
        <div class="row"><label title="Which way it points: a held item points along the green arrow, with its top along the thin line">Turn°</label>${bxyz('rotation', p.rotation || [0, 0, 0], 'Turn in degrees', '1')}</div>
        <div class="hint">The green arrow shows which way a held item points (a tool's grip sits on the point, the tool along the arrow). Use the Rotate tool to turn it.</div>`;
    }
  } else if (sel.length > 1) h += `<div class="hint">${sel.length} things picked. Move, turn, stretch, colour, copy, group or mirror them together.</div>`;
  h += `<h4>Colliders</h4><div class="hint">Invisible shapes the game uses for bumping and hits. They wrap what is picked and move with its group (joint). Edit them like parts.</div>
    <div class="btns three">${[['box', '▢ Box'], ['sphere', '◯ Sphere'], ['capsule', '⬭ Capsule']].map(([k, l]) => `<button data-b="addCol" data-shape="${k}" title="Add a ${k} collider around what is picked.">${l}</button>`).join('')}</div>
    <div class="row"><label class="lbl chk" title="Show or hide the collider wireframes (they are always saved)."><input type="checkbox" data-b="colShow" ${B.showColliders ? 'checked' : ''}> Show colliders${B.colliders().length ? ` (${B.colliders().length})` : ''}</label></div>`;
  const lays = B.layers();
  if (lays.length) h += `<h4>Clothing layers</h4><div class="hint">Parts named <b>slot__set__piece</b> (e.g. hat__cap__visor) form switchable sets. Make model keeps each set as its own mesh on the shared skeleton.</div>
    ${lays.map(l => `<div class="row"><label class="lbl chk" title="Show or hide the ${esc(l.layer)} set while you build (Make model always includes it)."><input type="checkbox" data-b="layerVis" data-layer="${esc(l.layer)}" ${l.visible ? 'checked' : ''}> ${esc(l.slot)} · ${esc(l.set)} <span class="muted">(${l.parts})</span></label></div>`).join('')}`;
  h += `<h4>File</h4>
    <div class="btns">${btn('bMake', '🧍 Make model', 'class="primary" style="grid-column:span 2"')}</div>
    <div class="btns three">${btn('bNew', 'New')}${btn('bOpen', 'Open…')}${btn('save', 'Save')}</div>
    <div class="hint">Saves as a Blockbench file (.bbmodel) in your library — it opens in Blockbench too.</div>`;
  return h;
}
let frameSide = 'north';
function framesHtml(B) {
  const p = B.sel.length ? B.node(B.sel[B.sel.length - 1]) : null;
  if (!p || p.kind !== 'part' || p.shape !== 'cube') return `<h4>Frames (expressions)</h4><div class="hint">Pick a cube to give one of its sides several drawn pictures (eyes: open / blink / happy…). Each framed side becomes its own mesh in the made model, so animations and the game can swap the picture.</div>`;
  const sides = ['north', 'south', 'east', 'west', 'up', 'down'], fr = B.frames(p.id, frameSide);
  return `<h4>Frames (expressions)</h4>
    <div class="row"><label title="Which side of the picked cube">Side</label><select data-b="frSide" title="The side whose pictures you are working on.">${sides.map(s => `<option value="${s}"${s === frameSide ? ' selected' : ''}>${s}${p.pix?.[s] ? (p.pix[s].frames ? ` (${Object.keys(p.pix[s].frames).length} frames)` : ' (painted)') : ''}</option>`).join('')}</select></div>
    ${fr.frames.length ? `<div class="btns three">${fr.frames.map(f => `<button data-b="frSel" data-name="${esc(f)}" class="toggle${f === fr.current ? ' on' : ''}" title="Show “${esc(f)}” — painting now draws into it. Double-click to rename.">${esc(f)}</button>`).join('')}</div>` : `<div class="hint">No frames on this side yet. <b>+ New frame</b> names the picture that is there now; add more frames for other expressions.</div>`}
    <div class="btns">${'<button data-b="frAdd" title="A new frame: a copy of the picture showing now, ready to repaint (the first one just names the current picture).">+ New frame</button>'}${fr.frames.length ? '<button data-b="frDel" title="Delete the frame showing now.">Delete frame</button>' : ''}</div>`;
}
async function openWatchPhone() {
  const box = document.createElement('div');
  box.className = 'watchqr';
  const close = () => box.remove();
  document.body.appendChild(box);
  let showQr = null, note = '';
  const render = async () => {
    const info = await (await fetch('/api/watch/links')).json();
    const urls = (info.urls || []).filter(u => !/127\.0\.0\.1|localhost/.test(u) || info.dev);
    const qr = u => { if (!window.qrcode) return ''; const q = window.qrcode(0, 'M'); q.addData(u); q.make(); return q.createSvgTag({ cellSize: 5, margin: 3, scalable: true }); };
    box.innerHTML = `<div class="watchqr-card"><button class="watchqr-x" data-x title="Close">✕</button><h3>Watch from other devices</h3>
      ${!info.lan && !info.dev ? `<p>Only this PC can watch now. Turn this on to let phones, tablets and other computers watch (view only, nothing on the page can edit).</p><div class="btns"><button data-on class="primary">Let other devices watch</button></div>`
        : `<h4>📶 On your home Wi-Fi: no password</h4><p>Open this address in the browser on the phone or tablet. Bookmark it or <b>Add to Home Screen</b> to keep it.</p>
      <div class="watch-links">${urls.map(u => `<div class="watch-link"><code>${esc(u)}</code><button data-copy="${esc(u)}" title="Copy the address">Copy</button><button data-qr="${esc(u)}" title="Show a QR code of this address (scan it instead of typing)">QR</button></div>${showQr === u ? `<div class="watchqr-code">${qr(u)}</div>` : ''}`).join('') || '<p>No network address found. Is the PC on Wi-Fi or a network cable?</p>'}</div>
      <h4>🌍 From outside your network: password</h4>
      <p>Anything that is not on your home network (another Wi-Fi, mobile data through a tunnel or port forwarding) gets a sign-in page. ${info.hasPassword ? '<b>A password is set.</b> Changing it signs every device out.' : '<b>No password is set</b>, so nobody can watch from outside.'} At least 6 characters; a PIN of 6+ digits gets a number pad and signs in as soon as it is typed.</p>
      <div class="watch-warn">
        <b>⚠️ You are responsible for your computer's safety.</b> Letting devices outside your home reach this PC opens a way in from the internet.
        Simple GLB Editor is free software provided <b>“as is”, without any warranty</b> (see LICENSE.md): you alone are responsible for protecting your computer, network, tunnel and password, and for anything that happens if someone gets in. The watch page can only show models, but no software is perfectly secure.
        <ul><li>Prefer a tunnel with https and its own sign-in (for example <a href="https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/" target="_blank" rel="noopener">Cloudflare Access</a>) over opening a port on your router.</li>
        <li>Use a password or PIN you use nowhere else. Keep Windows, your browser and your antivirus up to date.</li>
        <li>How to protect your computer, from the U.S. Cybersecurity and Infrastructure Security Agency (CISA): <a href="https://www.cisa.gov/secure-our-world" target="_blank" rel="noopener">Secure Our World</a> · <a href="https://www.cisa.gov/secure-our-world/use-strong-passwords" target="_blank" rel="noopener">Use strong passwords</a> · <a href="https://www.cisa.gov/secure-our-world/update-software" target="_blank" rel="noopener">Update software</a></li></ul>
        <label class="watch-accept"><input type="checkbox" id="watchRisk"> I understand that I am responsible for protecting my computer, and I accept the risk of letting devices outside my home watch.</label>
      </div>
      <div class="watch-pw"><input type="password" id="watchPw" placeholder="${info.hasPassword ? 'New password or PIN' : 'Password or PIN'}" autocomplete="new-password"><input type="password" id="watchPw2" placeholder="Type it again" autocomplete="new-password">
        <button data-setpw class="primary">${info.hasPassword ? 'Change password' : 'Set password'}</button>${info.hasPassword ? '<button data-clearpw title="Remove the password: nobody can watch from outside any more">Remove</button>' : ''}</div>
      <div class="watch-note">${esc(note)}</div>
      <p class="muted">How the password is protected: it is never stored. This PC keeps only a salted scrypt hash (a one-way scramble that cannot be turned back into the password), and sign-ins are limited to 5 wrong tries per device and 30 per hour from outside. On the way it is only encrypted if the link starts with https (Cloudflare Tunnel and Tailscale do this; a port forwarded on the router does not). Point the tunnel at http://localhost:${info.port || 5180}.</p>
      ${info.lan ? '<div class="btns"><button data-off>Stop other devices watching</button></div>' : ''}`}</div>`;
  };
  box.addEventListener('click', async e => {
    if (e.target === box || e.target.dataset.x !== undefined) return close();
    const t = e.target.closest('[data-copy],[data-on],[data-off],[data-qr],[data-setpw],[data-clearpw]'); if (!t) return;
    if (t.dataset.copy) { await navigator.clipboard.writeText(t.dataset.copy).catch(() => {}); status('Watch address copied'); return; }
    if (t.dataset.qr) { showQr = showQr === t.dataset.qr ? null : t.dataset.qr; return render(); }
    if (t.dataset.setpw !== undefined || t.dataset.clearpw !== undefined) {
      let password = null;
      if (t.dataset.setpw !== undefined) {
        if (!$('#watchRisk').checked) { note = 'Tick the box to confirm you are responsible for protecting your computer first.'; return render(); }
        password = $('#watchPw').value;
        if (password !== $('#watchPw2').value) { note = 'The two passwords are not the same.'; return render(); }
      } else if (!confirm('Remove the watch password? Nobody can watch from outside your network any more.')) return;
      const r = await (await fetch('/api/watch/password', { method: 'POST', body: JSON.stringify({ password }) })).json();
      note = r.error || (r.hasPassword ? 'Password saved. Devices from outside sign in with it.' : 'Password removed.');
      return render();
    }
    await fetch('/api/watch/lan?on=' + (t.dataset.on !== undefined ? '1' : '0'), { method: 'POST' }); render();
  });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id?.startsWith('watchPw')) box.querySelector('[data-setpw]')?.click(); });
  render();
}
function renderOutliner() {
  const B = build, d = B.doc;
  if (outlineDocName !== d) { outlineDocName = d; outlineOpen.clear(); const nodes = Object.values(d.nodes); if (nodes.length <= 300) nodes.filter(n => n.kind === 'group').forEach(n => outlineOpen.add(n.id)); }
  B.sel.forEach(id => { let n = B.node(id); while (n && n.parent) { outlineOpen.add(n.parent); n = B.node(n.parent); } });
  let h = `<h4>Outliner</h4><div class="btns">${btn('bGroup', '📁 Group')}${btn('bLocator', '✚ Attach point')}</div>
    <div class="outline" data-drop="">`;
  const walk = (ids, depth) => {
    for (const id of ids) {
      const n = B.node(id); if (!n) continue;
      const icon = n.kind === 'group' ? (outlineOpen.has(id) ? '📂' : '📁') : n.kind === 'locator' ? '✚' : (SHAPES[n.shape]?.icon || '◆');
      const tw = n.kind === 'group' ? `<span class="tw" data-tw="${id}">${outlineOpen.has(id) ? '▾' : '▸'}</span>` : '<span class="tw"></span>';
      h += `<div class="tree-row bn${B.sel.includes(id) ? ' sel' : ''}" draggable="true" data-bn="${id}" ${n.kind === 'group' ? `data-drop="${id}"` : ''} style="padding-left:${4 + depth * 14}px" title="${n.kind === 'group' ? 'A group: everything in it bends together around its pivot. Drag parts onto it to put them inside.' : n.kind === 'locator' ? 'An attach point.' : 'A part.'} Click to pick (Shift adds), double-click to rename, drag to move it into a group.">${tw}${icon} ${esc(n.name)}</div>`;
      if (n.kind === 'group' && outlineOpen.has(id)) walk(n.children, depth + 1);
    }
  };
  walk(B.isolate && d.nodes[B.isolate.group] ? [B.isolate.group] : d.roots, 0); // a sub-tab lists only its group
  if (!d.roots.length) h += `<div class="hint">Empty. Add a shape from the Tools window.</div>`;
  h += `</div><div class="hint">Drag a row onto a 📁 group to put it inside, or onto this empty space to take it out.</div>`;
  $('#sceneBody').innerHTML = h; keymap.decorate($('#sceneBody'));
}
$('#toolsBody').addEventListener('change', e => {
  const k = e.target.dataset.b; if (!k || !inBuild()) return;
  run(() => {
    const id = build.sel[build.sel.length - 1];
    if (k === 'grid') { build.gridStep = +e.target.value; saveBuildPrefs(); return build.refresh(); }
    if (k === 'rotstep') { build.rotStep = +e.target.value; saveBuildPrefs(); return build.refresh(); }
    if (k === 'snapmode') { build.setSnapMode(e.target.value); saveBuildPrefs(); return; }
    if (k === 'pxsize') { build.pixelBrush.size = +e.target.value; saveBuildPrefs(); return ed.changed(); }
    if (k === 'pxtext') { build.pixelBrush.text = e.target.value; saveBuildPrefs(); return; }
    if (k === 'pxtsize') { build.pixelBrush.textSize = +e.target.value; saveBuildPrefs(); return ed.changed(); }
    if (k === 'pxfont') { build.pixelBrush.font = e.target.value; saveBuildPrefs(); return ed.changed(); }
    if (k === 'pxbold') { build.pixelBrush.bold = e.target.checked; saveBuildPrefs(); return ed.changed(); }
    if (k === 'colShow') return build.setCollidersVisible(e.target.checked);
    if (k === 'pxppu') { build.setPixelDensity(+e.target.value); saveBuildPrefs(); return; }
    if (k === 'pxmirror') { build.pixelBrush.mirror = e.target.checked; saveBuildPrefs(); return ed.changed(); }
    if (k === 'color') { build.color = e.target.value; saveBuildPrefs(); return ed.changed(); }
    if (!id) return;
    if (k === 'layerVis') return build.setLayerVisible(e.target.dataset.layer, e.target.checked);
    if (k === 'frSide') { frameSide = e.target.value; return ed.changed(); }
    if (k === 'name') return build.rename(id, e.target.value);
    if (k === 'slideOn') return build.setSlide(id, e.target.checked ? { axis: 'up', min: 0, max: 1 } : null);
    if (k === 'slideAxis' || k === 'slideMin' || k === 'slideMax') { const sl = build.node(id).slide; const val = k === 'slideAxis' ? e.target.value : null; if (k === 'slideAxis' && !val) return; return build.setSlide(id, { axis: val || sl.axis, min: k === 'slideMin' ? +e.target.value : sl.min, max: k === 'slideMax' ? +e.target.value : sl.max }); }
    if (k === 'shape') return build.set(id, { shape: e.target.value });
    if (k === 'sides') return build.set(id, { sides: +e.target.value });
    if (['from', 'size', 'origin', 'rotation', 'position'].includes(k)) return build.set(id, { [k]: readB(k) });
  });
});
$('#toolsBody').addEventListener('click', e => {
  const t = e.target.closest('[data-b]'); if (!t || !inBuild()) return;
  const k = t.dataset.b;
  if (k === 'add') run(() => build.add(t.dataset.shape));
  else if (k === 'swatch') { build.color = t.dataset.c; saveBuildPrefs(); ed.changed(); }
  else if (k === 'paintSel') run(() => build.paintSelected(build.color));
  else if (k === 'addCol') run(() => build.addCollider(t.dataset.shape));
  else if (k === 'pxmode') { build.pixelBrush.mode = t.dataset.mode; saveBuildPrefs(); ed.changed(); }
  else if (k === 'frSel' || k === 'frAdd' || k === 'frDel') {
    const id = build.sel[build.sel.length - 1]; if (!id) return;
    if (k === 'frSel') { if (e.detail === 2) { askText('New name for this frame:', t.dataset.name).then(v => { if (v) run(() => build.renameFrame(id, frameSide, t.dataset.name, v)); }); return; } run(() => build.setFrame(id, frameSide, t.dataset.name)); }
    if (k === 'frAdd') { const has = build.frames(id, frameSide).frames.length; askText(has ? 'Name for the new frame (e.g. happy, blink):' : 'Name for the picture that is there now (e.g. neutral):', has ? '' : 'neutral').then(v => { if (v) run(() => build.addFrame(id, frameSide, v)); }); }
    if (k === 'frDel') { const cur = build.frames(id, frameSide).current; if (cur && confirm(`Delete the frame “${cur}”?`)) run(() => build.removeFrame(id, frameSide, cur)); }
  }
});
{
  const sb = $('#sceneBody');
  sb.addEventListener('click', e => {
    if (!inBuild()) return;
    const tw = e.target.closest('[data-tw]'); if (tw) { const id = tw.dataset.tw; outlineOpen.has(id) ? outlineOpen.delete(id) : outlineOpen.add(id); renderOutliner(); return; }
    const r = e.target.closest('[data-bn]'); if (r) build.select(r.dataset.bn, e.shiftKey);
    else if (e.target.closest('.outline')) build.clear();
  });
  sb.addEventListener('dblclick', e => {
    const r = e.target.closest('[data-bn]'); if (!r || !inBuild()) return;
    const n = build.node(r.dataset.bn);
    askText('New name:', n.name).then(v => { if (v) run(() => build.rename(n.id, v)); });
  });
  let dragIds = null;
  sb.addEventListener('contextmenu', e => {
    const r = e.target.closest('[data-bn]'); if (!r || !inBuild()) return;
    const n = build.node(r.dataset.bn); if (!n) return;
    e.preventDefault();
    const g = n.kind === 'group' ? n : n.parent && build.node(n.parent);
    if (!g) return status('A part that is not in a group: put it in a group to open it in a sub-tab');
    showCtxMenu(e.clientX, e.clientY, [
      { label: `Open “${g.name}” in a sub-tab`, tip: 'Work on this group alone (rest greyed), with its own camera. Changes go straight into the project.', run: () => run(() => tabs.openSub(g.id, { mode: 'context' })) },
      { label: `Open “${g.name}” alone in a sub-tab`, tip: 'Same, with everything else hidden.', run: () => run(() => tabs.openSub(g.id, { mode: 'alone' })) },
    ]);
  });
  sb.addEventListener('dragstart', e => { const r = e.target.closest('[data-bn]'); if (!r) return; const id = r.dataset.bn; dragIds = build.sel.includes(id) ? [...build.sel] : [id]; e.dataTransfer.setData('text/plain', 'build'); e.dataTransfer.effectAllowed = 'move'; });
  sb.addEventListener('dragover', e => { if (!dragIds) return; const t = e.target.closest('[data-drop]'); if (!t) return; e.preventDefault(); sb.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); t.classList.add('drop'); });
  sb.addEventListener('dragleave', e => { if (!sb.contains(e.relatedTarget)) sb.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); });
  sb.addEventListener('drop', e => {
    if (!dragIds) return; e.preventDefault();
    const t = e.target.closest('[data-drop]'), ids = dragIds; dragIds = null;
    sb.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
    if (!t) return;
    const pid = t.dataset.drop || null;
    if (pid) outlineOpen.add(pid);
    run(() => build.moveTo(ids.filter(id => id !== pid), pid));
  });
  sb.addEventListener('dragend', () => { dragIds = null; });
}

// ---------------- toolbar state + hints ----------------
const MODE_ACT = { object: 'modeObject', vertex: 'modeVertex', edge: 'modeEdge', bone: 'modeBone', draw: 'modeDraw', paint: 'modePaint', build: 'modeBuild' };
const GIZ_ACT = { translate: 'gMove', rotate: 'gRotate', scale: 'gScale' };
const HINTS = {
  object: 'Click a part to pick it',
  vertex: 'Click a point to pick it · Shift+click adds · drag a box to pick many · hold V while dragging to snap & merge',
  edge: 'Click a line to pick it · Shift+click adds · drag a box to pick many',
  bone: 'Click a joint to pick it · Shift+click adds · drag a box to pick many',
  draw: 'Click on the model to drop a joint inside it · Right-click / Esc ends the chain',
  paint: 'Drag on the model to paint · Alt+click picks a colour · Ctrl+wheel or [ ] = brush size',
  build: 'Click a part to pick it · double-click picks its group · Shift+click adds · drag a box to pick many · G move (parts click together; Alt = free) · S stretch · R rotate · P pivot · I colour · O snap point · Q push/pull (pick corners on a side, drag the pane in = hole, out = block) · D pixel paint (Alt+click picks a colour)',
};
function renderBars() {
  const on = (act, v) => document.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.classList.toggle('on', !!v));
  for (const [m, a] of Object.entries(MODE_ACT)) on(a, ed.mode === m);
  if (inBuild()) { on('gMove', build.tool === 'move'); on('gRotate', build.tool === 'rotate'); on('gScale', build.tool === 'stretch'); on('gPivot', build.tool === 'pivot'); on('bPaintTool', build.tool === 'paint'); }
  else for (const [g, a] of Object.entries(GIZ_ACT)) on(a, ed.gizmoMode === g);
  on('xray', ed.xray); on('loopToggle', ed.loop); on('autoKey', ed.autoKey);
  on('panelTools', panels.isOpen('tools')); on('panelScene', panels.isOpen('scene')); on('panelClips', panels.isOpen('clips')); on('library', panels.isOpen('library'));
  const an = $('#btnAnim'); an.classList.toggle('on', ed.animMode); an.textContent = ed.animMode ? '● Animate' : 'Edit';
  document.querySelectorAll('[data-act="undo"]').forEach(b => { b.disabled = !ed.undoStack.length; });
  document.querySelectorAll('[data-act="redo"]').forEach(b => { b.disabled = !ed.redoStack.length; });
  $('#fileName').textContent = inBuild() ? `Build: ${build.libRel ? 'Library / ' + build.libRel : build.doc.name + '.bbmodel'}${build.dirty ? ' •' : ''}` : ed.libRel ? `Library / ${ed.libRel}` : ed.fileName;
  $('#modeTag').textContent = inBuild() ? 'BUILD' : `${ed.mode === 'draw' ? 'DRAW BONES' : ed.mode.toUpperCase()} · ${ed.animMode ? 'ANIMATE' : 'EDIT'}`;
  $('#modeTag').className = ed.animMode ? 'anim' : '';
  const leftFree = ed.mouse.rotate !== 'left' && ed.mouse.pan !== 'left';
  let hint = HINTS[ed.mode]; if (!leftFree) hint = hint.replace('drag a box', 'Ctrl+drag a box');
  $('#hint').textContent = `${hint}  ·  ${BTN[ed.mouse.rotate]}-drag: turn view · ${BTN[ed.mouse.pan]}-drag: slide · Wheel: zoom`;
  const s = ed.sel, n = ed.selectedPointCount();
  $('#inspector').textContent = inBuild() ? (build.sel.length ? `Picked: ${build.sel.map(id => build.node(id)?.name).join(', ')}` : 'Nothing picked')
    : ed.mode === 'object' ? (s.meshes.length ? `Picked: ${s.meshes.map(m => m.name).join(', ')}` : 'Nothing picked')
    : boneish() ? (s.bones.length ? `Picked joints: ${s.bones.map(b => b.name).join(', ')}` : 'No joints picked')
    : n ? `${n} point${n === 1 ? '' : 's'} picked` : 'Nothing picked';
}
var queued = false; // var: panels can ask for a render before this line runs
function cleanupWatch() {
  if (!panels.isOpen('cleanup') && cleanPlan) { cleanPlan = null; showPlan(ed, null); }
  else if (panels.isOpen('cleanup') && cleanPlan && ed.undoStack.length !== cleanUndoLen) planNow();
}
function queueRender() {
  if (queued) return; queued = true;
  requestAnimationFrame(() => {
    queued = false;
    renderBars();
    cleanupWatch();
    const focus = document.activeElement;
    for (const [id, fn] of [['#toolsBody', renderTools], ['#sceneBody', renderScene], ['#clipsBody', renderClips]]) {
      const el = $(id);
      if (!(el.contains(focus) && focus.matches('input'))) { fn(); keymap.decorate(el); }
    }
  });
}
ed.addEventListener('change', queueRender);
ed.addEventListener('objectChange', () => { if (!$('#toolsBody').contains(document.activeElement)) { renderTools(); keymap.decorate($('#toolsBody')); } });
$('#fps').addEventListener('change', e => { ed.fps = Math.max(1, parseInt(e.target.value) || 30); savePrefs(); });
$('#speed').addEventListener('change', e => { ed.speed = Math.max(0.05, parseFloat(e.target.value) || 1); savePrefs(); });

// ---------------- brush settings ----------------
function setTool(t) { if (ed.mode !== 'paint') ed.setMode('paint'); ed.brush.tool = t; saveBrush(); queueRender(); status({ paint: 'Paint', smudge: 'Smudge', blur: 'Blur' }[t] + ' brush'); }
function sizeBrush(f) { ed.brush.size = Math.min(300, Math.max(2, Math.round(ed.brush.size * f))); saveBrush(); queueRender(); }
$('#toolsBody').addEventListener('input', e => {
  const id = e.target.id, v = e.target.value, B = ed.brush;
  if (id === 'ptSize') { ed.setPointSize(+v); e.target.nextElementSibling.textContent = ed.pointSize + ' px'; savePrefs(); }
  if (id === 'brushC') { B.color = v; saveBrush(); }
  if (id === 'brushS') { B.size = +v; $('#brushSv').textContent = v + ' px'; saveBrush(); }
  if (id === 'brushA') { B.strength = +v; saveBrush(); }
  if (id === 'brushH') { B.softness = +v; saveBrush(); }
});

// ---------------- clean up window ----------------
let cleanPlan = null, cleanTimer = 0, cleanUndoLen = -1;
const dot = c => `<span class="dot" style="background:#${c.getHexString()}"></span>`;
function openCleanup() {
  if (!ed.meshes().length) return status('Load a model first');
  if (!pointish()) ed.setMode('vertex');
  $('#cleanBody').innerHTML = `
    <div class="hint">Finds the usual problems in AI-made models and fixes them. The coloured points show what will change. Nothing changes until you press <b>Apply</b>, and one Undo puts it all back.</div>
    <h4>How hard to clean</h4>
    <div class="row"><span class="muted">Gentle</span><input type="range" id="cleanS" min="0" max="100" step="1" value="${prefs.cleanStrength ?? 35}" title="Gentle only fixes clear mistakes: points right on top of each other, surfaces flipped inside out. Further right it also closes small gaps, eases deeper folds, removes bigger hidden bits, and at the far end lightly smooths the whole model."><span class="muted">Aggressive</span></div>
    <div id="cleanCounts" class="clean-list"></div>
    <div class="row"><label class="lbl chk" title="Colour the points that will change, so you can see what Clean up will do before you press Apply."><input type="checkbox" id="cleanShow" checked> Show what will change on the model</label></div>
    <div class="btns"><button id="cleanApply" class="primary" title="Make the changes. One Undo puts it all back.">Apply</button><button id="cleanCancel" title="Close without changing anything.">Cancel</button></div>`;
  panels.open('cleanup');
  planNow(0);
}
function planNow(delay = 150) {
  clearTimeout(cleanTimer);
  $('#cleanCounts').innerHTML = '<div class="muted">Looking…</div>';
  cleanTimer = setTimeout(() => run(() => {
    const t0 = performance.now();
    cleanPlan = planCleanup(ed, (+$('#cleanS').value) / 100); cleanUndoLen = ed.undoStack.length;
    showPlan(ed, $('#cleanShow').checked ? cleanPlan : null);
    renderCleanCounts(performance.now() - t0);
  }), delay);
}
function renderCleanCounts(ms) {
  const T = cleanPlan.totals, rows = [], C = PREVIEW;
  if (T.welded) rows.push(`${dot(C.weld)}Weld <b>${T.welded}</b> point${T.welded === 1 ? ' that is' : 's that are'} almost on top of others`);
  if (T.slivers) rows.push(`${dot(C.weld)}Fold away <b>${T.slivers}</b> paper-thin sliver face${T.slivers === 1 ? '' : 's'}`);
  if (T.folds) rows.push(`${dot(C.fix)}Fix <b>${T.foldsFixed}</b> of ${T.folds} fold${T.folds === 1 ? '' : 's'} (surface tucked under itself)`);
  if (T.passThroughs) rows.push(`${dot(C.fix)}Fix <b>${T.passFixed}</b> of ${T.passThroughs} place${T.passThroughs === 1 ? '' : 's'} where the surface pokes through itself`);
  if (T.junkPieces) rows.push(`${dot(C.junk)}Remove <b>${T.junkPieces}</b> hidden piece${T.junkPieces === 1 ? '' : 's'} inside the body (${T.junkFaces} faces)`);
  if (T.strayPieces) rows.push(`${dot(C.junk)}Remove <b>${T.strayPieces}</b> tiny loose bit${T.strayPieces === 1 ? '' : 's'} floating outside`);
  if (T.fins) rows.push(`${dot(C.junk)}Remove <b>${T.fins}</b> zero-thickness fin${T.fins === 1 ? '' : 's'} (two faces back to back)`);
  if (T.smoothed) rows.push(`${dot(C.smooth)}Lightly smooth <b>${T.smoothed}</b> point${T.smoothed === 1 ? '' : 's'}`);
  const left = (T.folds - T.foldsFixed) + (T.passThroughs - T.passFixed);
  $('#cleanCounts').innerHTML = (rows.length ? rows.map(r => `<div>${r}</div>`).join('') : '<div class="muted">Nothing to fix at this setting.</div>')
    + (left > 0 ? `<div class="muted">${left} problem spot${left === 1 ? '' : 's'} can't be fixed automatically at this setting. Try further right, or fix them by hand with Snap &amp; merge.</div>` : '')
    + cleanPlan.notes.map(n => `<div class="muted">${esc(n)}</div>`).join('')
    + `<div class="muted" style="margin-top:4px">Checked in ${Math.round(ms)} ms</div>`;
  $('#cleanApply').disabled = !rows.length;
}
$('#cleanBody').addEventListener('input', e => { if (e.target.id === 'cleanS') { prefs.cleanStrength = +e.target.value; savePrefs(); planNow(); } });
$('#cleanBody').addEventListener('change', e => { if (e.target.id === 'cleanShow') showPlan(ed, e.target.checked ? cleanPlan : null); });
$('#cleanBody').addEventListener('click', e => {
  if (e.target.id === 'cleanApply' && cleanPlan) { const plan = cleanPlan; closeCleanup(); run(() => applyCleanup(ed, plan)); }
  if (e.target.id === 'cleanCancel') closeCleanup();
});
// ---------------- sprite sheets ----------------
const spritePrefs = { front: 'auto', directions: 4, view: 'rpg', size: 64, fps: 12, style: 'smooth', outline: true, bg: '', ...settings.get('sprites', {}) };
let spriteTimer = 0;
function openSprites() {
  if (inBuild()) return status('Sprite sheets are made from a finished model: Make model first (Ctrl+Enter)');
  if (!ed.meshes().length) return status('Open a model first');
  const sp = spritePrefs, clips = ed.clips.map(c => c.name), opt = (v, l, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${l}</option>`;
  $('#spritesBody').innerHTML = `
    <div class="hint">Every frame of the animations you tick, seen from each direction, packed into one PNG + a JSON for your game engine. The model keeps one size and stands on the same spot in every frame.</div>
    <h4>Animations</h4>
    <div class="spr-clips">${clips.length ? clips.map(c => `<label class="lbl chk"><input type="checkbox" data-sclip="${esc(c)}" checked> ${esc(c)}</label>`).join('') : '<span class="muted">No animations: one still picture per direction.</span>'}</div>
    ${clips.length > 1 ? '<div class="row"><button id="sprAll">All</button><button id="sprNone">None</button></div>' : ''}
    <h4>Look</h4>
    <div class="row"><span class="lbl" title="How many ways the character faces. 4 = down (towards you), right, up, left; 8 adds the diagonals.">Directions</span><select id="sprDirs">${opt(1, '1 (facing you)', sp.directions)}${opt(2, '2 (right, left)', sp.directions)}${opt(4, '4', sp.directions)}${opt(8, '8', sp.directions)}</select></div>
    <div class="row"><span class="lbl" title="Which way the model's face points. Auto looks at the feet (they stick out forward). Blockbench models usually face -Z.">Model faces</span><select id="sprFront">${opt('auto', 'Auto (from the feet)', sp.front)}${opt('+z', '+Z', sp.front)}${opt('-z', '-Z (Blockbench)', sp.front)}</select></div>
    <div class="row"><span class="lbl" title="Where the camera looks from (no perspective, like most 2D games).">Camera</span><select id="sprView">${opt('side', 'Side-on (platformer)', sp.view)}${opt('rpg', '3/4 from above (RPG)', sp.view)}${opt('iso', 'Isometric (2:1)', sp.view)}${opt('top', 'Top-down', sp.view)}</select></div>
    <div class="row"><span class="lbl" title="Each frame is this many pixels wide and high.">Frame size</span><select id="sprSize">${[32, 48, 64, 96, 128, 192, 256].map(s => opt(s, s + ' px', sp.size)).join('')}</select></div>
    <div class="row"><span class="lbl" title="Frames per second of animation: more = smoother, bigger sheet.">Frames / s</span><select id="sprFps">${[6, 8, 12, 15, 24, 30].map(s => opt(s, s, sp.fps)).join('')}</select></div>
    <div class="row"><span class="lbl" title="Smooth = soft anti-aliased edges. Pixel art = hard pixels, crisp edges.">Style</span><select id="sprStyle">${opt('smooth', 'Smooth', sp.style)}${opt('pixel', 'Pixel art', sp.style)}</select></div>
    <div class="row"><label class="lbl chk" title="Pixel art: a 1-pixel dark line around the figure."><input type="checkbox" id="sprOutline"${sp.outline ? ' checked' : ''}> Outline (pixel art)</label></div>
    <div class="row"><label class="lbl chk" title="Off = see-through background (usual for games)."><input type="checkbox" id="sprBgOn"${sp.bg ? ' checked' : ''}> Background colour</label><input type="color" id="sprBg" value="${sp.bg || '#2b2d31'}"></div>
    <div class="btns"><button id="sprPreview" title="Draw the sheet here without saving it.">Preview</button><button id="sprExport" class="primary" title="Save the PNG and JSON into Library / Sprites / ${esc((ed.fileName || 'model').replace(/\.glb$/i, ''))}.">Export to the library</button></div>
    <div id="sprInfo" class="muted"></div>
    <div class="spr-preview"><canvas id="sprAnim" title="The picked row playing."></canvas><select id="sprRow" hidden title="Which animation and direction to play."></select></div>
    <div class="spr-sheet"><img id="sprSheet" alt="" title="The whole sheet: rows = animation × direction, columns = frames."></div>`;
  panels.open('sprites');
}
function spriteOpts() {
  const sp = spritePrefs;
  Object.assign(sp, { front: $('#sprFront').value, directions: +$('#sprDirs').value, view: $('#sprView').value, size: +$('#sprSize').value, fps: +$('#sprFps').value, style: $('#sprStyle').value, outline: $('#sprOutline').checked, bg: $('#sprBgOn').checked ? $('#sprBg').value : '' });
  settings.set('sprites', sp);
  const picked = [...document.querySelectorAll('[data-sclip]')].filter(c => c.checked).map(c => c.dataset.sclip);
  if (ed.clips.length && !picked.length) throw new Error('Tick at least one animation');
  return { front: sp.front, clips: ed.clips.length ? picked : null, directions: sp.directions, view: sp.view, size: sp.size, fps: sp.fps, style: sp.style, outline: sp.outline, background: sp.bg || null, onProgress: (d, t) => { $('#sprInfo').textContent = `Drawing ${d} / ${t} frames…`; } };
}
function showSpritePreview(canvas, json) {
  const img = $('#sprSheet'); img.src = canvas ? canvas.toDataURL('image/png') : ''; img.style.imageRendering = spritePrefs.style === 'pixel' ? 'pixelated' : '';
  const tags = json.meta.frameTags, sel = $('#sprRow');
  sel.innerHTML = tags.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join(''); sel.hidden = tags.length < 2;
  const cv = $('#sprAnim'), { w, h } = json.meta.frameSize, k = Math.max(1, Math.floor(160 / Math.max(w, h))); cv.width = w * k; cv.height = h * k;
  const cx = cv.getContext('2d'); cx.imageSmoothingEnabled = spritePrefs.style !== 'pixel';
  clearInterval(spriteTimer); let f = 0;
  spriteTimer = setInterval(() => {
    if (!panels.isOpen('sprites')) return clearInterval(spriteTimer);
    const tag = tags[+sel.value || 0], keys = Object.keys(json.frames).slice(tag.from, tag.to + 1), fr = json.frames[keys[f++ % keys.length]].frame;
    cx.clearRect(0, 0, cv.width, cv.height); cx.drawImage(canvas, fr.x, fr.y, fr.w, fr.h, 0, 0, cv.width, cv.height);
  }, 1000 / json.meta.fps);
}
document.addEventListener('click', e => {
  if (!e.target.closest('#spritesBody')) return;
  const id = e.target.id;
  if (id === 'sprAll' || id === 'sprNone') document.querySelectorAll('[data-sclip]').forEach(c => { c.checked = id === 'sprAll'; });
  if (id === 'sprPreview' || id === 'sprExport') run(async () => {
    const save = id === 'sprExport', btns = document.querySelectorAll('#sprPreview, #sprExport'); btns.forEach(b => { b.disabled = true; });
    try {
      const r = await ed.renderSprites({ ...spriteOpts(), save, keepCanvas: true });
      const sheet = r.sheetCanvases?.[0] || null;
      $('#sprInfo').textContent = `${r.frames} frames, ${r.frameSize[0]}×${r.frameSize[1]} px, sheet ${r.sheets.map(s => s.w + '×' + s.h).join(', ')} px, ${r.ms} ms` + (save ? ` — saved to Library / ${r.sheets.map(s => s.png).join(', ')} (+ .json)` : '');
      if (sheet) showSpritePreview(sheet, r.sheetJsons[0]);
    } finally { btns.forEach(b => { b.disabled = false; }); }
  });
});

function closeCleanup() { clearTimeout(cleanTimer); cleanPlan = null; showPlan(ed, null); panels.close('cleanup'); }

// ---------------- timeline ----------------
const tl = $('#tl'), g = tl.getContext('2d'), PAD = 12;
const dur = () => ed.clip?.duration || 2;
const tX = t => PAD + t / dur() * (tl.clientWidth - PAD * 2);
const xT = x => Math.max(0, Math.min(dur(), (x - PAD) / (tl.clientWidth - PAD * 2) * dur()));
const snap = t => Math.round(t * ed.fps) / ed.fps;
let tlDrag = null;
const tlRows = () => {
  const rows = [{ y: 38, times: ed.keyTimes() }];
  const b = ed.activeBone || ed.sel.meshes[ed.sel.meshes.length - 1];
  if (b) rows.push({ y: 56, times: ed.keyTimes(b.name), name: b.name });
  return rows;
};
let tlC = null;
addEventListener('theme-changed', () => { tlC = null; });
function tlColours() { // the timeline is a canvas: it reads the theme's colours once per theme change
  if (tlC) return tlC;
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  return (tlC = { bg: v('--clock'), major: v('--scroll-thumb'), minor: v('--border'), muted: v('--muted'), row: v('--panel'), accent2: v('--accent2'), text: v('--text'), danger: v('--danger'), accent: v('--accent') });
}
let tlVer = 0, tlKey = ''; ed.addEventListener('change', () => tlVer++); // edits / tab switches change the keys shown
function drawTimeline() {
  requestAnimationFrame(drawTimeline);
  const w = tl.clientWidth, h = tl.clientHeight, dpr = devicePixelRatio;
  const key = [w, h, dpr, ed.time, dur(), ed.fps, ed.animMode, ed.playing, tlVer, tlDrag?.moving, tlDrag?.to, document.documentElement.dataset.theme].join();
  if (key === tlKey) return; // nothing changed: skip the redraw (it ran every frame)
  tlKey = key;
  if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const C = tlColours(); g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  const frames = Math.round(dur() * ed.fps);
  const every = [1, 2, 5, 10, 15, 30, 60, 120].find(s => (w - PAD * 2) / Math.max(frames, 1) * s >= 6) || 120;
  g.font = '10px system-ui'; g.textAlign = 'center';
  for (let f = 0; f <= frames; f += every) {
    const x = tX(f / ed.fps), major = f % (every * 5) === 0;
    g.fillStyle = major ? C.major : C.minor; g.fillRect(Math.round(x), 0, 1, major ? 12 : 7);
    if (major) { g.fillStyle = C.muted; g.fillText(f, x, 23); }
  }
  g.fillStyle = C.row; g.fillRect(0, 30, w, 16); g.fillRect(0, 48, w, 16);
  for (const r of tlRows()) {
    for (const t of r.times) {
      let x = tX(t);
      if (tlDrag?.moving && tlDrag.row.y === r.y && Math.abs(t - tlDrag.from) < 1e-4) x = tX(tlDrag.to);
      g.fillStyle = r.name ? C.accent2 : C.text;
      g.beginPath(); g.moveTo(x, r.y - 5); g.lineTo(x + 5, r.y); g.lineTo(x, r.y + 5); g.lineTo(x - 5, r.y); g.fill();
    }
    if (r.name) { g.fillStyle = C.muted; g.textAlign = 'left'; g.fillText(r.name, 4, r.y + 4); }
  }
  g.fillStyle = ed.animMode ? C.danger : C.accent; g.fillRect(Math.round(tX(ed.time)) - 1, 0, 2, h);
  $('#timecode').textContent = `f ${Math.round(ed.time * ed.fps)}`;
  $('#timesec').textContent = ed.clip ? `${ed.time.toFixed(2)} / ${(+dur().toFixed(2))} s` : 'no animation';
  const pb = $('#btnPlay'), lbl = ed.playing ? '❚❚' : '▶'; if (pb.textContent !== lbl) pb.textContent = lbl;
}
requestAnimationFrame(drawTimeline);
tl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  if (!ed.clip) ed.newClip();
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  tl.setPointerCapture(e.pointerId);
  for (const row of tlRows()) {
    if (Math.abs(y - row.y) > 8) continue;
    const t = row.times.find(t => Math.abs(tX(t) - x) < 6);
    if (t !== undefined) { tlDrag = { key: true, from: t, to: t, row, moving: false }; return; }
  }
  tlDrag = { key: false };
  if (!ed.animMode) ed.setAnimMode(true);
  ed.pause(); ed.setTime(snap(xT(x)));
});
tl.addEventListener('pointermove', e => {
  if (!tlDrag) return;
  const t = snap(xT(e.clientX - tl.getBoundingClientRect().left));
  if (tlDrag.key) { if (Math.abs(t - tlDrag.from) > 1e-4) tlDrag.moving = true; tlDrag.to = t; } else ed.setTime(t);
});
tl.addEventListener('pointerup', () => {
  const d = tlDrag; tlDrag = null; if (!d || !d.key) return;
  run(() => {
    if (!ed.animMode) ed.setAnimMode(true);
    if (d.moving) ed.moveKeys(d.from, d.to, d.row.name ? [d.row.name] : undefined); else { ed.pause(); ed.setTime(d.from); }
  });
});
window.addEventListener('panels-changed', () => ed._resize());

// ---------------- start ----------------
keymap.decorate(document);
queueRender();
const q = new URLSearchParams(location.search);
if (panels.isOpen('sprites')) panels.close('sprites'); // its contents are made when it is opened
// tabs you had open last time come back (not for hidden automation windows or test URLs)
tabs.hiddenApp = q.has('hidden');
if (!q.has('hidden') && !q.get('load') && !q.has('dummy')) await tabs.restore(settings.get('tabs', null));
tabs.persist = st => settings.set('tabs', st); tabs.save();
if (q.get('open')) openTab(t => t.load('/api/local?path=' + encodeURIComponent(q.get('open')), q.get('open').split(/[\\/]/).pop()));
else if (q.get('load')) run(() => ed.load(q.get('load')));
else if (q.has('dummy')) run(() => ed.loadDummy());
