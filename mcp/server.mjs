#!/usr/bin/env node
// MCP server for the Simple GLB Editor (stdio, no dependencies).
//   claude mcp add -s user simple-glb -- node "<editor folder>\mcp\server.mjs"
// It drives the real desktop app: it reuses an editor that is already open, or starts one
// (visible by default, so you can watch; pass visible:false to glb_start, or set GLB_MCP_HIDDEN=1, for no window).
// The app listens on 127.0.0.1 only and needs the random token it writes to %APPDATA%\simple-glb-editor\control.json.
// It never closes an editor it did not start.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const USERDATA = process.env.SIMPLE_GLB_USERDATA || path.join(APPDATA, 'simple-glb-editor'); // (same env as main.js)
const CONTROL = path.join(USERDATA, 'control.json');
const VERSION = '0.1.0';
let started = null; // { proc, hidden } — only an editor we started ourselves

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stderr.write('[simple-glb-mcp] ' + a.join(' ') + '\n');

const CTL_DIR = path.join(USERDATA, 'control'); // one file per running editor (<pid>.json)
const LOCK = path.join(USERDATA, 'starting.lock'); // only one session starts an editor at a time
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function readControl() { return readJSON(CONTROL); }
/** Ask an editor whether it is alive: its ping info ({pid, hidden, tag, focusedAt, ...}) or null. */
async function ping(c) {
  if (!c) return null;
  try { const r = await fetch(`http://127.0.0.1:${c.port}/ping`, { headers: { 'x-glb-token': c.token }, signal: AbortSignal.timeout(2500) }); const j = r.ok ? await r.json() : null; return j?.ok ? j : null; } catch { return null; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/**
 * Every running editor, best first: visible ones before hidden ones, then the one the user used last. Files of editors
 * that are gone are removed. Self-test copies (tag "selftest…") are never joined.
 */
async function findEditors() {
  const anc = await ancestors();
  const own = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => ({ ...readJSON(path.join(d, f)), _file: path.join(d, f) })); } catch { return []; } };
  // our own control folder, plus any other editor folder (e.g. the dev build's) — but an editor from another folder is
  // only used when THIS session runs inside its terminal (in-app Claude), so ordinary sessions never join a test copy
  let other = []; try { other = fs.readdirSync(path.dirname(USERDATA)).filter(n => /^simple-glb-editor/i.test(n) && path.join(path.dirname(USERDATA), n) !== USERDATA).flatMap(n => own(path.join(path.dirname(USERDATA), n, 'control')).map(c => ({ ...c, _other: true }))); } catch {}
  const seen = new Set(), out = [];
  for (const c of [...own(CTL_DIR), ...other, readControl()]) {
    if (!c || !c.port || seen.has(c.pid + ':' + c.token)) continue; seen.add(c.pid + ':' + c.token);
    const host = anc.has(c.pid); // we run inside this editor's Claude terminal
    if (c._other && !host) continue;
    const info = await ping(c);
    if (!info) { if (c.pid && !alive(c.pid) && c._file) try { fs.unlinkSync(c._file); } catch {} continue; }
    if (String(info.tag || c.tag || '').startsWith('selftest') && !host) continue; // (a self-test copy only for the Claude inside its own terminal)
    out.push({ ...c, ...info, port: c.port, token: c.token, host });
  }
  return out.sort((a, b) => (b.host - a.host) || (a.hidden - b.hidden) || ((b.focusedAt || 0) - (a.focusedAt || 0)));
}
/** Process ids above this one (Claude Code, the terminal, the editor window that runs it), looked up once. */
let ancCache = null;
function ancestors() {
  if (ancCache) return ancCache;
  return (ancCache = new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(new Set());
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { windowsHide: true });
    let out = ''; ps.stdout.on('data', d => { out += d; });
    const done = () => { const parent = new Map(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number)).filter(a => a.length === 2)); const set = new Set(); let p = process.ppid; for (let i = 0; i < 12 && p && !set.has(p); i++) { set.add(p); p = parent.get(p); } resolve(set); };
    ps.on('close', done); ps.on('error', () => resolve(new Set([process.ppid])));
    setTimeout(() => { try { ps.kill(); } catch {} }, 8000);
  }));
}
function findApp() {
  const list = [process.env.GLB_EDITOR_EXE, path.join(PROJECT, 'dist', 'win-unpacked', 'Simple GLB Editor.exe'), path.join(PROJECT, 'SimpleGLBEditor.exe')].filter(Boolean);
  return list.find(p => fs.existsSync(p));
}
async function startApp(visible = !process.env.GLB_MCP_HIDDEN) {
  // another session may be starting one right now: wait for it instead of opening a second window
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  let fd = null;
  for (let i = 0; i < 300 && fd === null; i++) {
    try { fd = fs.openSync(LOCK, 'wx'); }
    catch {
      const e = (await findEditors()).find(x => visible ? !x.hidden : true); if (e) return e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 70000) fs.unlinkSync(LOCK); } catch {} // a starter that died
      await sleep(250);
    }
  }
  try {
    const e = (await findEditors()).find(x => visible ? !x.hidden : true); if (e) return e; // appeared meanwhile
    const exe = findApp();
    if (!exe) throw new Error('Could not find the editor. Build it (npm run dist) or set GLB_EDITOR_EXE to SimpleGLBEditor.exe');
    const myTag = 'mcp-' + crypto.randomUUID();
    const proc = spawn(exe, [...(visible ? [] : ['--hidden']), '--tag=' + myTag], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    proc.unref();
    started = { proc, hidden: !visible };
    for (let i = 0; i < 1200; i++) { // up to 60 s (the single-file exe unpacks itself first)
      await sleep(50);
      const mine = (await findEditors()).find(x => x.tag === myTag) || (visible && i > 40 ? (await findEditors()).find(x => !x.hidden) : null); // (a second visible launch hands over to the open window)
      if (mine) return mine;
    }
    throw new Error('The editor started but did not answer within 60 s');
  } finally { if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(LOCK); } catch {} } }
}
let current = null; // the editor this session works in (its tab lives there): kept while it answers
async function connect(autoStart = true) {
  if (current && await ping(current)) return current;
  current = (await findEditors())[0] || null;
  if (current?.host) { SESSION.inApp = true; SESSION.name ||= 'In-app Claude'; } // started from the editor's own Claude terminal
  if (current) return current;
  if (!autoStart) return null;
  return (current = await startApp());
}
// Each MCP server process = one Claude session = its own tab in the editor (made on the first call, in the background).
const SESSION = { id: crypto.randomUUID(), name: process.env.GLB_SESSION_NAME || undefined, tab: undefined };
/** Run an async JS body inside the editor window, in this session's tab (`editor`, `glbAction`, `THREE` in scope). */
async function run(code) {
  const c = await connect();
  const r = await fetch(`http://127.0.0.1:${c.port}/run`, { method: 'POST', headers: { 'x-glb-token': c.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ code, session: SESSION }) });
  const out = await r.json();
  if (!out.ok) throw new Error(out.error + (out.stack ? '\n' + out.stack : ''));
  return out.value;
}
const J = v => JSON.stringify(v);

// ---------------------------------------------------------------- tools
const readDoc = () => {
  try { return fs.readFileSync(path.join(PROJECT, 'CLAUDE.md'), 'utf8'); } // everything: overview, modes, conventions, every API section
  catch { return 'See CLAUDE.md in the Simple GLB Editor folder.'; }
};

const TOOLS = [
  {
    name: 'glb_run',
    description: 'Run JavaScript in the editor: the body of an async function with `editor`, `glbAction(id)` and `THREE` in scope; `return` a JSON value. Each edit is one undo step; errors come back readable. Start with `return editor.info()`; Build mode is `editor.build`. Full API: glb_help.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Async function body; return a JSON-friendly value.' } }, required: ['code'] },
    run: async ({ code }) => text(JSON.stringify(await run(code), null, 2)),
  },
  {
    name: 'glb_info',
    description: 'What is loaded: meshes, bones (name, parent, world position), clips, selection, last undo steps.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => text(J(await run('return editor.info()'))),
  },
  {
    name: 'glb_open',
    description: 'Open a model: a Library path ("Folder/x.glb") or a full path to .glb / .gltf / .bbmodel. A .bbmodel is imported as a rigid animated model, or opened in Build mode with build:true. Replaces what is open.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, build: { type: 'boolean', description: '.bbmodel only: open it in Build mode for editing instead of importing it as a finished model.' } }, required: ['path'] },
    run: async ({ path: p, build }) => {
      const abs = /^[a-zA-Z]:[\\/]|^\\\\|^\//.test(p);
      if (build) { const src = abs ? `'/api/local?path=' + encodeURIComponent(${J(p)})` : J(p); return text(await run(`editor.setMode('build'); return await editor.build.open(${src}, ${J(p.split(/[\\/]/).pop())})`)); }
      const code = abs ? `return await editor.load('/api/local?path=' + encodeURIComponent(${J(p)}), ${J(p.split(/[\\/]/).pop())})` : `return await editor.load(${J(p)})`;
      return text(await run(code));
    },
  },
  {
    name: 'glb_save',
    description: 'Save the open model as Library/<folder>/<name>.glb (overwrites; rest pose + all clips). In Build mode use glb_build {do:"save"} for the .bbmodel, or {do:"make"} first.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, folder: { type: 'string', description: 'Library sub-folder, e.g. "Characters". Empty = library root.' } }, required: ['name'] },
    run: async ({ name, folder = '' }) => text(await run(`return await editor.save(${J(name)}, ${J(folder)})`)),
  },
  {
    name: 'glb_library',
    description: 'List the Library: folders, .glb models and .bbmodel Build projects, with sizes.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const tree = await run(`return await (await fetch('/api/lib/list')).json()`);
      const lines = [];
      const walk = (n, d) => { for (const f of n.files) lines.push('  '.repeat(d) + `${f.rel}  (${Math.round(f.size / 1024)} KB)`); for (const s of n.dirs) { lines.push('  '.repeat(d) + s.rel + '/'); walk(s, d + 1); } };
      walk(tree, 0);
      const root = await run(`return (await (await fetch('/api/lib/info')).json()).root`);
      return text(`Library: ${root}\n` + (lines.join('\n') || '(empty)'));
    },
  },
  {
    name: 'glb_screenshot',
    description: 'PNG of your tab, made off-screen (same size whatever the window looks like; the view is not moved). view: front|back|left|right|top|bottom|persp (camera on that side: "right" = camera on +X, so it shows the model\'s left side). views:[...] = one contact-sheet image of several views (cheaper than several shots). Fits the whole model unless frame:false (then the current camera). clip + time = a moment of an animation. width / height in px (default 800 × 600).',
    inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'bottom', 'persp'] }, views: { type: 'array', items: { type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'bottom', 'persp'] } }, frame: { type: 'boolean' }, time: { type: 'number' }, clip: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } } },
    run: async ({ view, views, frame, time, clip, width = 800, height }) => {
      const url = await run(`
        ${clip ? `editor.setAnimMode(true); editor.setClip(${J(clip)});` : ''}
        ${time !== undefined ? `editor.setAnimMode(true); editor.setTime(${+time});` : ''}
        return editor.snapshot ? editor.snapshot(${J({ width: Math.max(200, Math.min(2400, +width || 800)), height: height ? Math.max(150, Math.min(2400, +height)) : null, view: view || null, views: views || null, whole: frame !== false })})
          : (${view ? `editor.view(${J(view)}), ` : ''}${frame ? 'editor.frame(), ' : ''}editor.screenshotDataURL(${Math.max(200, Math.min(1600, +width || 800))})); // (older builds)`);
      return { content: [{ type: 'image', data: url.split(',')[1], mimeType: 'image/png' }] };
    },
  },
  {
    name: 'glb_action',
    description: 'Run a menu command by id, as if clicked (e.g. "undo", "frame", "bind", "makeWalk", "modeBuild"). id "list" returns every id with its help.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => {
      if (id === 'list') return text(await run(`return (window.ACTIONS || []).map(a => a.id + ' — ' + a.label + (a.help ? ': ' + a.help : '')).join('\\n') || 'No action list exposed'`));
      return text(J(await run(`return await glbAction(${J(id)}) ?? 'done'`)));
    },
  },
  {
    name: 'glb_build',
    description: 'Build mode (Blockbench-style modelling; 16 units = 1 m, +Y up, coordinates absolute). Pick `do`; `names` = the parts/groups to act on (group names win; empty = current pick). Sides: front (+Z) · back · left (+X, the model’s own left) · right · top · bottom (north/south/east/west/up/down also work). Commands {args}: info · new{name} · open{path} · add{shape,from,to|size,color,name,parent} · addMany{parts:[{shape,from,to,color,name,parent}],groupName} (returns names only) · select{names,add} · set{names,props} · group{names,groupName} · ungroup · moveTo{parent} · duplicate · copy · paste · delete · mirror{axis} (copies across the plane x=0 / y=0 / z=0, so mirror a part that is off-centre) · flip{axis} · combine{groupName} · paint{side,color} · locator{name,parent,position,rotation} · snap{at,name} · unsnap · snapmode{mode} · join{names:[moving,target]} · pushpull{side,area|points,depth (<0 cut a box-shaped hole, >0 add)} · hollow{side,wall,depth} (removes the inside in the part’s own shape — round for cylinders — leaving walls + a bottom; open on side, default top) · band{side,min,max,color} (stripe round any part, also round / cut ones: min..max = 0..1 of its height towards side) · slide{axis,min,max|from,to} · pixels{side,pixels:[[u,v,"#hex"]]} · rect{side,u,v,w,h,color} (cube sides only; node info lists sidePixels [w,h]) · line{side,from:[u,v],to:[u,v],color,width} · clearpaint{side?} · facesize{side} · density{value: 1|2|4|8 pixels per unit for newly painted sides; a saved setting} · addframe/setframe/removeframe{side,name} · frames{side} · layers · showlayer{name,visible} · save{name,folder} · make. Each change is one undo step. Details: glb_help {section:"Build mode"} (and "Pixel paint", "Expression frames", "Clothing layers", "Slide", "Colliders").',
    inputSchema: {
      type: 'object',
      properties: {
        do: { type: 'string', enum: ['info', 'new', 'open', 'add', 'select', 'set', 'group', 'ungroup', 'moveTo', 'duplicate', 'copy', 'paste', 'delete', 'mirror', 'flip', 'combine', 'paint', 'locator', 'snap', 'unsnap', 'snapmode', 'join', 'pushpull', 'slide', 'pixels', 'rect', 'line', 'clearpaint', 'facesize', 'layers', 'showlayer', 'addframe', 'setframe', 'frames', 'removeframe', 'save', 'make', 'addMany', 'hollow', 'band', 'density'] },
        names: { type: 'array', items: { type: 'string' }, },
        name: { type: 'string' }, path: { type: 'string' }, folder: { type: 'string' },
        shape: { type: 'string', enum: ['cube', 'cylinder', 'cone', 'sphere', 'pyramid', 'wedge', 'hexagon', 'pentagon'] },
        from: { type: 'array', items: { type: 'number' } }, to: { type: 'array', items: { type: 'number' } }, size: { type: 'array', items: { type: 'number' } },
        position: { type: 'array', items: { type: 'number' } }, rotation: { type: 'array', items: { type: 'number' } }, min: { type: 'number' }, max: { type: 'number' }, axis: {},
        pixels: { type: 'array', items: { type: 'array' } }, u: { type: 'number' }, v: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, width: { type: 'number' },
        area: { type: 'object' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, depth: { type: 'number' },
        at: {}, mode: { type: 'string', enum: ['all', 'points', 'off'] },
        color: { type: 'string' }, visible: { type: 'boolean' }, parent: { type: ['string', 'null'] }, groupName: { type: 'string' },
        props: { type: 'object' }, parts: { type: 'array', items: { type: 'object' } }, wall: { type: 'number' }, value: { type: 'number' },
        side: { type: ['string', 'null'] }, add: { type: 'boolean' },
      },
      required: ['do'],
    },
    run: async a => {
      const pick = `const B = editor.build; if (editor.mode !== 'build') editor.setMode('build'); const A = ${J(a)};
        const pid = x => (x === null || x === undefined ? null : B.find(x) || x);
        const pickNames = () => { if (A.names && A.names.length) { const ids = B.select(A.names); if (ids.length !== A.names.length) throw new Error('Not found: ' + A.names.filter(n => !B.find(n) && !B.node(n)).join(', ')); } };`;
      const body = {
        info: 'return B.info();',
        new: 'return B.newDoc(A.name || "new_model");',
        open: `const abs = /^[a-zA-Z]:[\\\\/]|^\\\\\\\\|^\\//.test(A.path || ''); return await B.open(abs ? '/api/local?path=' + encodeURIComponent(A.path) : A.path, (A.path || '').split(/[\\\\/]/).pop());`,
        add: 'const id = B.add(A.shape || "cube", { from: A.from, to: A.to, size: A.size, color: A.color, name: A.name, ...(A.parent !== undefined ? { parent: pid(A.parent) } : {}) }); return B.node(id);',
        select: 'const miss = (A.names || []).filter(n => !B.find(n) && !B.node(n)); if (miss.length) throw new Error("Not found: " + miss.join(", ")); B.select(A.names || [], !!A.add); return B.info().selection;',
        set: 'pickNames(); const id = B.sel[B.sel.length - 1]; if (!id) throw new Error("Pick something first (names)"); B.set(id, A.props || {}); return B.node(id);',
        group: 'pickNames(); return B.group(A.groupName || A.name || "group");',
        ungroup: 'pickNames(); return B.ungroup();',
        moveTo: 'pickNames(); B.moveTo(B.sel, pid(A.parent)); return B.info().outline;',
        duplicate: 'pickNames(); return B.duplicate();',
        copy: 'pickNames(); return B.copy();',
        paste: 'return B.paste();',
        delete: 'pickNames(); return B.remove();',
        mirror: 'pickNames(); return B.mirrorCopy(A.axis || "x");',
        flip: 'pickNames(); return B.flip(A.axis || "x");',
        combine: 'pickNames(); return await B.combine(A.groupName || A.name);',
        paint: 'pickNames(); if (A.side) { for (const id of B.sel) B.paint(id, A.side, A.color || B.color); return "Painted " + A.side; } return B.paintSelected(A.color || B.color) ?? "Painted";',
        locator: 'const id = B.addLocator(A.name || "attach_point", { position: A.position, ...(A.parent !== undefined ? { parent: pid(A.parent) } : {}) }); if (A.rotation) B.set(id, { rotation: A.rotation }); return B.node(id);',
        snap: 'pickNames(); const id = B.sel[B.sel.length - 1]; if (!id) throw new Error("Name the part (names)"); B.addSnap(id, A.at || "up", A.name); return B.node(id).snaps;',
        unsnap: 'pickNames(); return B.clearSnaps();',
        snapmode: 'return B.setSnapMode(A.mode || "all");',
        slide: 'pickNames(); const id = B.sel[B.sel.length - 1]; if (!id) throw new Error("Name the group (names)"); if (A.axis === null) return B.setSlide(id, null); return B.setSlide(id, A.from && A.to ? { from: A.from, to: A.to } : { axis: A.axis || "up", min: A.min ?? 0, max: A.max ?? 1 });',
        pixels: 'pickNames(); return B.paintPixels(B.sel[B.sel.length - 1], A.side, A.pixels || []);',
        rect: 'pickNames(); return B.paintRect(B.sel[B.sel.length - 1], A.side, { u: A.u, v: A.v, w: A.w, h: A.h, color: A.color });',
        line: 'pickNames(); return B.paintLine(B.sel[B.sel.length - 1], A.side, A.from, A.to, A.color, A.width || 1);',
        clearpaint: 'pickNames(); return A.names && A.names.length === 1 ? B.clearPaint(B.sel[0], A.side || null) : B.clearPaint(null, A.side || null);',
        facesize: 'pickNames(); return B.faceSize(B.sel[B.sel.length - 1], A.side);',
        layers: 'return B.layers();',
        addframe: 'pickNames(); return B.addFrame(B.sel[B.sel.length - 1], A.side, A.name);',
        setframe: 'pickNames(); return B.setFrame(B.sel[B.sel.length - 1], A.side, A.name);',
        frames: 'pickNames(); return B.frames(B.sel[B.sel.length - 1], A.side);',
        removeframe: 'pickNames(); return B.removeFrame(B.sel[B.sel.length - 1], A.side, A.name);',
        showlayer: 'return B.setLayerVisible(A.name, A.visible !== false);',
        pushpull: 'pickNames(); const id = B.sel[B.sel.length - 1]; if (!id) throw new Error("Name the part (names)"); const area = A.area || (A.points && { min: [0, 1, 2].map(i => Math.min(...A.points.map(q => q[i]))), max: [0, 1, 2].map(i => Math.max(...A.points.map(q => q[i]))) }); if (!area) throw new Error("Give area {min,max} or points"); return await B.pushPull(id, A.side, area, A.depth);',
        addMany: 'const made = []; for (const q of A.parts || []) { const id = B.add(q.shape || "cube", { from: q.from, to: q.to, size: q.size, color: q.color, name: q.name, ...(q.parent !== undefined ? { parent: pid(q.parent) } : {}) }); made.push(B.node(B.sel[B.sel.length - 1]).name); } if (A.groupName) { B.select(made); B.group(A.groupName); } return { added: made, group: A.groupName || null };',
        hollow: 'pickNames(); const id = B.sel[B.sel.length - 1]; if (!id) throw new Error("Name the part (names)"); return await B.hollow(id, { side: A.side || "up", wall: A.wall ?? 1, depth: A.depth ?? null });',
        band: 'pickNames(); if (!B.sel.length) throw new Error("Name the part(s) (names)"); const out = []; for (const id of [...B.sel]) out.push(B.paintBand(id, { side: A.side || "up", from: A.min ?? 0.4, to: A.max ?? 0.6, color: A.color })); return out.join("\\n");',
        density: 'return B.setPixelDensity(A.value ?? 2);',
        join: 'if (!A.names || A.names.length !== 2) throw new Error("join needs names: [moving part, target part]"); return B.join(A.names[0], A.names[1]);',
        save: 'return await B.save(A.name || B.doc.name, A.folder || "");',
        make: 'return await B.makeModel();',
      }[a.do];
      if (!body) throw new Error('Unknown do: ' + a.do);
      const v = await run(pick + '\n' + body);
      return text(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    },
  },
  {
    name: 'glb_start',
    description: 'Make sure the editor is running (reuses an open one; else starts it, visible:false = no window). You work in your own editor tab; tab:"name" names it, or switches to / shares the tab with that name. Other tools start it when needed.',
    inputSchema: { type: 'object', properties: { visible: { type: 'boolean' }, tab: { type: 'string' } } },
    run: async ({ visible, tab }) => {
      if (tab) SESSION.tab = String(tab);
      let c = await connect(false), msg;
      if (c) msg = `Editor already running (pid ${c.pid}${c.hidden ? ', no window' : ''}).`;
      else { c = current = await startApp(visible !== undefined ? visible : !process.env.GLB_MCP_HIDDEN); msg = `Started the editor (pid ${c.pid}${c.hidden ? ', no window' : ', window open'}).`; }
      const t = await run('const t = window.tabs && window.tabs.list.find(x => x.ed === editor); return t ? window.tabs.label(t) : null;'); // (older builds have no tabs)
      return text(t ? `${msg} Your tab: "${t}".` : msg);
    },
  },
  {
    name: 'glb_help',
    description: 'The editor\'s manual: modes, conventions, the whole editor.* / editor.build.* API. Optional section filter, e.g. "Build mode", "Pixel paint", "Expression frames", "Clothing layers", "Slide", "Colliders", "MCP".',
    inputSchema: { type: 'object', properties: { section: { type: 'string', description: 'Optional: only the sections whose text contains this (e.g. "Build mode").' } } },
    run: async ({ section }) => { // read fresh each time, so new features show up without restarting the MCP server
      const doc = readDoc(); if (!section) return text(doc);
      const parts = doc.split(/\n(?=## )/), q = String(section).toLowerCase(), head = parts.filter(x => x.split('\n')[0].toLowerCase().includes(q)), hit = head.length ? head : parts.filter(x => x.toLowerCase().includes(q)); // headings first
      return text(hit.length ? hit.join('\n') : `No section matching "${section}". Sections: ` + parts.map(x => x.split('\n')[0].replace(/^#+ /, '')).join(' · '));
    },
  },
];
const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : J(t) }] });

// ---------------------------------------------------------------- JSON-RPC over stdio
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'simple-glb-editor', version: VERSION },
      instructions: 'Drives the user\'s Simple GLB Editor (their default 3D tool): rigging, vertex repair, clean-up, painting, animation, Blockbench import and Build mode (Blockbench-style modelling). Start with glb_info / glb_open / glb_build {do:"info"}; anything else via glb_run (read glb_help first); check with glb_screenshot; save into the Library. You work in your own editor tab (the user watches; if they Take over, ask them). Never close the user\'s editor.',

    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params.name);
    if (!tool) return fail(id, -32602, 'Unknown tool ' + params.name);
    try { return reply(id, await tool.run(params.arguments || {})); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true }); }
  }
  if (id !== undefined) return fail(id, -32601, 'Method not found: ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(e => log('error', e.stack || e));
  }
});
process.stdin.on('end', () => {
  // close an editor WE started with no window; a visible one stays for the user
  if (started?.hidden && current?.tag?.startsWith('mcp-') && current.pid === started.proc.pid) { try { process.kill(current.pid); } catch {} try { fs.unlinkSync(path.join(CTL_DIR, current.pid + '.json')); } catch {} }
  process.exit(0);
});
