#!/usr/bin/env node
// Self-test: drives the real editor (its own hidden copy) through every major feature and prints pass/fail + timings.
//   node scripts/selftest.mjs                 -> runs the app from source (electron .)
//   node scripts/selftest.mjs --exe <path>    -> runs a packaged build instead (e.g. dist\win-unpacked\Simple GLB Editor.exe)
//   node scripts/selftest.mjs --json out.json -> also writes the results as JSON (to compare timings between runs)
// It never touches an editor you have open, and only writes into Library/_selftest (removed at the end).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const exe = opt('--exe'), jsonOut = opt('--json');
// Its hidden editor has its own control file (control/<pid>.json) with a tag; other editors' files are never touched.
const CTL_DIR = path.join(process.env.APPDATA || '', 'simple-glb-editor', 'control'), TAG = 'selftest-' + Date.now();
const app = exe ? spawn(exe, ['--hidden', '--tag=' + TAG], { stdio: 'ignore' }) : spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--hidden', '--tag=' + TAG], { cwd: ROOT, stdio: 'ignore' });
let ctl = null;
for (let i = 0; i < 600 && !ctl; i++) { await new Promise(r => setTimeout(r, 100)); try { for (const f of fs.readdirSync(CTL_DIR)) { const j = JSON.parse(fs.readFileSync(path.join(CTL_DIR, f), 'utf8')); if (j.tag === TAG) ctl = j; } } catch {} }
if (!ctl) { console.error('The editor did not start'); app.kill(); process.exit(2); }
const run = async (code, session) => { const r = await (await fetch(`http://127.0.0.1:${ctl.port}/run`, { method: 'POST', headers: { 'x-glb-token': ctl.token }, body: JSON.stringify({ code, session }) })).json(); if (!r.ok) throw new Error(r.error); return r.value; };

const results = [];
async function test(name, code, check) {
  const t0 = Date.now(); let value, err = null;
  try { value = await run(code); const bad = check ? check(value) : null; if (bad) err = bad; } catch (e) { err = e.message; }
  const ms = Date.now() - t0; results.push({ name, ok: !err, ms, err, value: err ? value : undefined });
  console.log(`${err ? 'FAIL' : ' ok '}  ${String(ms).padStart(6)} ms  ${name}${err ? '\n        ' + String(err).slice(0, 300) : ''}`);
}
const has = (rel) => fs.existsSync(path.join(ROOT, 'Library', rel));

// ---------------------------------------------------------------- model editing
await test('dummy: load', `editor.loadDummy(); const i = editor.info(); return { meshes: i.meshes.length };`, v => v.meshes ? null : 'no mesh');
await test('rig: fit skeleton + bind + walk', `editor.setMode('bone'); editor.fitSkeleton(); editor.bind(); editor.makeWalk(); const i = editor.info(); return { bones: i.bones.length, clips: i.clips.length };`, v => v.bones >= 10 && v.clips >= 1 ? null : JSON.stringify(v));
await test('anim: pose + key + close loop + undo', `editor.setAnimMode(true); editor.newClip('Wave', 1); editor.pose('UpperArm_L', [0,0,60], 0.5); editor.closeLoop(); const k = editor.keyTimes('UpperArm_L').length; editor.undo(); return { k };`, v => v.k >= 1 ? null : 'no keys');
await test('vertex: find / move / undo', `editor.setAnimMode(false); editor.setMode('vertex'); const m = editor.meshes()[0]; const f = editor.findPoints([0, 1.5, 0], 0.3)[0]; editor.selectPoints(f.mesh, f.pids.slice(0, 5)); const a = editor.getPoints(f.mesh, f.pids.slice(0, 1))[0]; editor.movePoints([0, 0.05, 0]); const b2 = editor.getPoints(f.mesh, f.pids.slice(0, 1))[0]; editor.undo(); const c = editor.getPoints(f.mesh, f.pids.slice(0, 1))[0]; return { moved: +(b2[2] - a[2]).toFixed(4), back: +(c[2] - a[2]).toFixed(4) };`, v => Math.abs(v.moved - 0.05) < 1e-3 && Math.abs(v.back) < 1e-4 ? null : JSON.stringify(v));
await test('cleanup: plan (strength 0.5)', `const { planCleanup } = await import('/src/cleanup.js'); const p = planCleanup(editor, 0.5); return p.totals;`, v => v ? null : 'no plan');
await test('save + reload .glb', `await editor.save('dummy_walk', '_selftest'); await editor.load('_selftest/dummy_walk.glb'); const i = editor.info(); return { bones: i.bones.length, clips: i.clips.length };`, v => v.bones >= 10 && v.clips >= 1 ? null : JSON.stringify(v));
await test('undo / redo stress (40 steps)', `editor.setMode('bone'); const b = editor.allBones()[3]; for (let i = 0; i < 20; i++) editor.setBonePosition(b.name, b.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.001, 0)).toArray()); for (let i = 0; i < 20; i++) editor.undo(); for (let i = 0; i < 20; i++) editor.redo(); return editor.undoStack.length;`, v => v >= 20 ? null : 'undo stack ' + v);

// ---------------------------------------------------------------- Build mode
await test('build: every shape + group + mirror + duplicate', `editor.newProject('selftest'); editor.setMode('build'); const B = editor.build;
  const shapes = ['cube','cylinder','cone','sphere','pyramid','wedge','hexagon','pentagon']; shapes.forEach((s, i) => B.add(s, { from: [i * 5, 0, 0], to: [i * 5 + 4, 4, 4], name: 'p_' + s, parent: null }));
  B.add('cube', { from: [-4,12,-2], to: [4,24,2], name: 'torso', parent: null }); B.select('torso'); B.group('chest');
  B.add('cube', { from: [4,13,-1.5], to: [7,23,1.5], name: 'sleeve_right', parent: B.find('chest') }); B.select('sleeve_right'); B.group('arm_right'); B.set(B.find('arm_right'), { origin: [5.5, 23, 0] });
  B.select('arm_right'); B.mirrorCopy('x'); B.select('p_cube'); B.duplicate(); return B.info();`, v => v.parts >= 12 && v.groups >= 3 ? null : JSON.stringify({ parts: v.parts, groups: v.groups }));
await test('build: slide, collider, snap, text, frames, push/pull, combine', `const B = editor.build;
  B.add('cube', { from: [-3,22,-4], to: [3,23.4,2], name: 'chin', parent: B.find('chest') }); B.select('chin'); B.group('jaw'); B.setSlide(B.find('jaw'), { axis: 'up', min: 0, max: 0.6 });
  B.select('chest'); B.addCollider('box'); B.addSnap(B.find('torso'), 'up');
  B.paintText(B.find('torso'), 'north', 'AB', { size: 8, color: '#000000' });
  const e = B.add('cube', { from: [-3,20,-2.2], to: [3,22,-2], name: 'face_eyes', parent: B.find('chest') }); B.paintPixels(e, 'north', [[2,1,'#000000']]); B.addFrame(e, 'north', 'neutral'); B.addFrame(e, 'north', 'blink');
  const w = B.add('cube', { from: [40,0,0], to: [52,8,2], name: 'wall', parent: null }); await B.pushPull(w, 'south', { min: [44,2,2], max: [48,6,2] }, -2);
  B.add('cube', { from: [60,0,0], to: [64,4,4], name: 'c1', parent: null }); B.add('sphere', { from: [62,2,2], to: [66,6,6], name: 'c2', parent: null }); B.select(['c1','c2']); const c = await B.combine('combo');
  const i = B.info(); return { parts: i.parts, colliders: i.colliders, painted: i.paintedSides, snaps: i.snapPoints, combine: c };`, v => v.colliders === 1 && v.painted >= 2 && v.snaps === 1 ? null : JSON.stringify(v));
await test('build: layers (slot__set__piece)', `const B = editor.build; B.add('cube', { from: [-4.5,30,-4.5], to: [4.5,32,4.5], name: 'hat__cap__crown', parent: B.find('chest') }); return B.layers();`, v => v.length === 1 && v[0].layer === 'hat__cap' ? null : JSON.stringify(v));
await test('build: save .bbmodel + reopen', `const B = editor.build; await B.save('selftest', '_selftest'); const a = B.info(); await B.open('_selftest/selftest.bbmodel'); const b2 = B.info(); return { a: [a.parts, a.groups, a.colliders, a.paintedSides], b: [b2.parts, b2.groups, b2.colliders, b2.paintedSides] };`, v => JSON.stringify(v.a) === JSON.stringify(v.b) ? null : JSON.stringify(v));
await test('build: make model (layers, frames, colliders, slide)', `await editor.build.makeModel(); const L = editor.layers().map(l => l.name); return { meshes: L, colliders: editor.colliders().length, framed: editor.frames('face_eyes').frames, slide: !!editor.bone('jaw').userData.slide };`, v => v.meshes.includes('hat__cap') && v.colliders === 1 && v.framed.length === 2 && v.slide ? null : JSON.stringify(v));
await test('anim: slide + frame keys + .glb round trip', `editor.newClip('Talk', 1); editor.slide('jaw', 1, 0.5); editor.frameKey('face_eyes', 'blink', 0.8); await editor.save('selftest', '_selftest'); await editor.load('_selftest/selftest.glb'); editor.setClip('Talk'); editor.setAnimMode(true); editor.setTime(0.9); return { frame: editor.frames('face_eyes').current, slide: +editor.slideValue('jaw').toFixed(2) };`, v => v.frame === 'blink' ? null : JSON.stringify(v));

await test('build: gizmo drags (move snaps, rotate group keeps parts)', `editor.setMode('build'); const B = editor.build, { tc, proxy } = B._internals; B.newDoc('drag');
  const drag = fn => { tc.dispatchEvent({ type: 'mouseDown' }); fn(); tc.dispatchEvent({ type: 'objectChange' }); tc.dispatchEvent({ type: 'mouseUp' }); };
  const a = B.add('cube', { from: [0,0,0], to: [4,4,4], parent: null }); const grid0 = B.gridStep; B.gridStep = 1; B.setTool('move'); drag(() => proxy.position.x += 0.3); const moved = B.node(a).from[0];
  B.select(a); B.group('g'); B.set(B.sel[0], { origin: [0,0,0] }); B.setTool('rotate'); drag(() => proxy.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI/2)));
  const box = new THREE.Box3().setFromObject(editor.scene.getObjectByName('__build')); B.setTool('move'); B.gridStep = grid0;
  return { moved, z: [Math.round(box.min.z * 16), Math.round(box.max.z * 16)] };`, v => v.moved === 5 && v.z[0] === -9 && v.z[1] === -5 ? null : JSON.stringify(v));
await test('memory: 10 loads do not pile up GPU geometries', `editor.setMode('object'); const r = editor.renderer; editor.loadDummy(); r.render(editor.scene, editor.camera); const g0 = r.info.memory.geometries; for (let i = 0; i < 10; i++) { editor.loadDummy(); r.render(editor.scene, editor.camera); } return { before: g0, after: r.info.memory.geometries };`, v => v.after <= v.before + 2 ? null : JSON.stringify(v));

// ---------------------------------------------------------------- big files (only if they are in the Library)
if (has('Blockbench/toon_base_f.bbmodel')) {
  await test('big: open toon_base_f in Build mode', `editor.setAnimMode(false); editor.setMode('build'); return await editor.build.open('Blockbench/toon_base_f.bbmodel');`);
  await test('big: make toon_base_f', `return (await editor.build.makeModel()).slice(0, 80);`);
}
if (has('Blockbench/toon_base_m.glb') && has('Blockbench/toon_base_f.glb'))
  await test('big: importClips toon_f -> toon_m', `await editor.load('Blockbench/toon_base_m.glb'); const r = await editor.importClips('Blockbench/toon_base_f.glb'); return { copied: r.copied.length, skipped: r.skippedTracks.length };`, v => v.copied > 0 && v.skipped === 0 ? null : JSON.stringify(v));
// ---------------------------------------------------------------- tabs
await test('tabs: open in a new tab, unsaved dot, switch, close (x6)', `const a = tabs.active, n0 = tabs.list.length;
  await tabs.openInNewTab(e => e.load('_selftest/dummy_walk.glb')); const b = tabs.active; const title = tabs.title(b);
  editor.setMode('object'); editor.setObjectTransform(editor.meshes()[0].name, { position: [0.1, 0, 0] }); const dirty = tabs.dirty(b);
  tabs.select(a); const drawing = tabs.list.filter(t => t.ed.active).length; tabs.close(b, { force: true });
  for (let i = 0; i < 5; i++) { tabs.add(); tabs.close(tabs.active, { force: true }); }
  return { n0, n: tabs.list.length, title, dirty, drawing, back: tabs.active === a };`, v => v.n === v.n0 && v.title === 'dummy_walk' && v.dirty && v.drawing === 1 && v.back ? null : JSON.stringify(v));
{ // a Claude session works in its own background tab; the user's tab stays as it is; Take over / close are reported to the session
  const t0 = Date.now(), S = { id: 'selftest-session', name: 'Selftest' }; let err = null, value;
  try {
    const before = await run('return tabs.list.indexOf(tabs.active)');
    const a = await run(`editor.loadDummy(); await glbAction('frame'); return { label: tabs.label(tabs.list.find(t => t.ed === editor)), shot: editor.screenshotDataURL(200).length, view: editor.viewOnly }`, S);
    const still = await run('return tabs.list.indexOf(tabs.active)');
    await run('tabs.takeOver(tabs.list.find(t => t.session), true)');
    let taken = ''; try { await run('return 1', S); } catch (e) { taken = e.message; }
    await run('const t = tabs.list.find(t => t.session); tabs.takeOver(t, false); tabs.close(t, { force: true })');
    let closed = ''; try { await run('return 1', S); } catch (e) { closed = e.message; }
    const again = await run('return tabs.label(tabs.list.find(t => t.ed === editor))', S);
    await run('tabs.close(tabs.list.find(t => t.session), { force: true })');
    value = { before, still, a, taken: /took over/.test(taken), closed: /closed your tab/.test(closed), again };
    if (before !== still || !a.view || a.shot < 1000 || !value.taken || !value.closed || !/^Selftest/.test(again)) err = JSON.stringify(value);
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0; results.push({ name: 'tabs: Claude session in its own tab (+ Take over, close)', ok: !err, ms, err, value: err ? value : undefined });
  console.log(`${err ? 'FAIL' : ' ok '}  ${String(ms).padStart(6)} ms  tabs: Claude session in its own tab (+ Take over, close)${err ? '\n        ' + String(err).slice(0, 300) : ''}`);
}
await test('tabs: sub-tab of a Build group (filter, new parts land in it, shared undo)', `const main = tabs.add(); editor.setMode('build'); const B = editor.build; B.newDoc('subtest');
  B.add('cube', { from: [-4,12,-2], to: [4,24,2], name: 'torso', parent: null }); B.add('cube', { from: [4,13,-1], to: [7,23,1], name: 'sleeve', parent: null }); B.select('sleeve'); B.group('arm');
  const sub = tabs.openSub('arm'); B.selectAll(); const visible = B.sel.length; B.clear(); B.add('cube', { from: [5,10,-1], to: [6,13,1], name: 'hand', parent: undefined });
  const inArm = B.node(B.find('hand')).parent === B.find('arm'), label = editor.undoStack.at(-1).label;
  tabs.select(main); const iso = B.isolate; editor.undo(); const undone = !B.find('hand');
  tabs.close(main, { force: true }); return { visible, inArm, label, iso, undone, subsLeft: tabs.list.filter(t => t.parent === main).length };`,
  v => v.visible === 1 && v.inArm && v.label.startsWith('[arm]') && v.iso === null && v.undone && v.subsLeft === 0 ? null : JSON.stringify(v));
await test('sprites: sheet + json from the walking dummy (4 directions, pixel art)', `const t = await tabs.openInNewTab(e => e.load('_selftest/dummy_walk.glb'));
  const r = await editor.renderSprites({ folder: '_selftest', name: 'dummy_sprites', directions: 4, size: 32, fps: 8, style: 'pixel', outline: true });
  const j = await (await fetch('/api/lib/file?rel=' + encodeURIComponent(r.json))).json(); tabs.close(tabs.active, { force: true });
  return { clips: r.clips, frames: r.frames, tags: j.meta.frameTags.length, keys: Object.keys(j.frames).length, png: r.png, mode: editor.mode };`,
  v => v.frames > 0 && v.keys === v.frames && v.tags % 4 === 0 && v.png === '_selftest/dummy_sprites.png' ? null : JSON.stringify(v));
await test('build: hollow (round), band paint, plain side names, side pixel sizes, contact-sheet snapshot', `const t = tabs.add(); editor.setMode('build'); const B = editor.build; B.newDoc('mug');
  B.add('cylinder', { from: [-4, 0, -4], to: [4, 10, 4], name: 'mug', parent: null }); await B.hollow('mug', { side: 'top', wall: 1 }); B.paintBand('mug', { side: 'top', from: 0.5, to: 0.7, color: '#c62828' });
  const mug = B.node('mug'); B.add('cube', { from: [8, 0, -3], to: [14, 6, 3], name: 'box', parent: null }); B.paintRect('box', 'front', { u: 1, v: 1, w: 4, h: 2, color: '#000000' });
  let err = ''; try { B.paintRect('box', 'left', { u: 99, v: 0 }); } catch (e) { err = e.message; }
  const shot = editor.snapshot({ views: ['front', 'back', 'left', 'bottom'], width: 400 }); tabs.close(t, { force: true });
  return { shape: mug.shape, red: mug.mesh.tris.filter(x => x.color === '#c62828').length, err: / × [0-9]+ pixels/.test(err), shot: shot.length };`,
  v => v.shape === 'mesh' && v.red > 0 && v.err && v.shot > 5000 ? null : JSON.stringify(v));
await test('AI plugins: the built-in Claude Code plugin loads and the panel shows it', `if (!window.glbTerm) return { skip: 'no desktop bridge' };
  const list = await glbTerm.agents(), c = list.find(a => a.id === 'claude-code');
  return { count: list.length, builtIn: !!c?.builtIn, signIn: (c?.signIn || []).map(s => s.id).join(','), button: document.querySelector('#btnClaude').textContent.trim(), menuItems: document.querySelectorAll('#agentItems [data-signin]').length };`,
  v => v.skip || (v.builtIn && v.signIn === 'claudeai,api' && /Claude/.test(v.button) && v.menuItems === 2) ? null : JSON.stringify(v));
await test('terminal: claude starts in the in-app terminal; answer buttons read menus and a) b) c)', `if (!window.glbTerm) return { skip: 'no desktop bridge' };
  const info = await glbTerm.info('claude-code'); if (!info.installed) return { skip: 'Claude Code not installed' };
  let out = ''; glbTerm.onData((id, d) => { out += d; }); const id = await glbTerm.start({ agent: 'claude-code', kind: 'version', cols: 80, rows: 10 });
  for (let i = 0; i < 100 && !/Claude Code/.test(out); i++) await new Promise(r => setTimeout(r, 100));
  const T = window.claudeTerm, E = String.fromCharCode(27), NL = String.fromCharCode(13, 10), CLS = E + '[2J' + E + '[H';
  await T._write(CLS + ['Do you want to proceed?', String.fromCharCode(0x276f) + ' 1. Yes', '  2. Yes, and do not ask again', '  3. No'].join(NL) + NL);
  const menu = T._findChoices(); await T._write(CLS + ['Which colour?', 'a) Red', 'b) Green', 'c) Blue'].join(NL) + NL); const letters = T._findChoices();
  return { version: /Claude Code/.test(out), menu: menu && menu.kind + ':' + menu.options.map(o => o.key).join(''), letters: letters && letters.kind + ':' + letters.options.map(o => o.key).join('') };`,
  v => v.skip || (v.version && v.menu === 'menu:123' && v.letters === 'text:abc') ? null : JSON.stringify(v));
await test('render: 30 frames of the current view', `const r = editor.renderer, g = r.getContext(); const t0 = performance.now(); for (let i = 0; i < 30; i++) r.render(editor.scene, editor.camera); g.finish(); return +((performance.now() - t0) / 30).toFixed(2);`);
await test('memory (JS heap MB)', `return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;`);

// ---------------------------------------------------------------- done
try { await run(`await fetch('/api/lib/delete', { method: 'POST', body: JSON.stringify(['_selftest']) }); return 'ok';`); } catch {}
try { process.kill(ctl.pid); } catch {} app.kill(); try { fs.unlinkSync(path.join(CTL_DIR, ctl.pid + '.json')); } catch {}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed, total ${results.reduce((s, r) => s + r.ms, 0)} ms`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), exe: exe || 'source', results }, null, 2));
process.exit(failed ? 1 : 0);
