// Electron entry point: runs the editor as a desktop program.
// The embedded server only listens on 127.0.0.1; the window talks to it like a web page.
const { app, BrowserWindow, Menu, dialog, shell, nativeTheme, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { startServer, startWatchServer } = require('./server');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

let win = null;
// SIMPLE_GLB_USERDATA = a separate settings / control folder (tests; a second independent setup)
if (process.env.SIMPLE_GLB_USERDATA) app.setPath('userData', process.env.SIMPLE_GLB_USERDATA);

/** Library folder next to the exe; when run from the project's dist\ output, use the project folder. */
function defaultLibrary() {
  if (!app.isPackaged) return path.join(__dirname, 'Library');
  let base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const isProject = d => fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'server.js'));
  for (let i = 0; i < 2; i++) {
    const parent = path.dirname(base);
    if (/^(dist[\w-]*|win-unpacked)$/i.test(path.basename(base)) && (isProject(parent) || /^dist[\w-]*$/i.test(path.basename(parent)))) base = parent;
  }
  return path.join(base, 'Library');
}

// A .glb passed on the command line (drag onto the exe / "Open with").
const openArg = process.argv.slice(1).find(a => /\.(glb|gltf|bbmodel)$/i.test(a) && fs.existsSync(a));

// --hidden: no visible window (for automation / the MCP server); everything else works the same.
const hidden = process.argv.includes('--hidden');
// --tag=x: a name the starter (MCP server, self-test) uses to find THIS editor's control file.
const tag = (process.argv.find(a => a.startsWith('--tag=')) || '').slice(6) || null;
let focusedAt = Date.now(); // the editor the user used last is the one Claude sessions join

// One visible window: opening the exe again (or a .glb with it) brings the open editor forward and opens the file in a
// new tab there. Hidden automation copies (self-test, a hidden MCP editor) run on their own and never take the lock.
const primary = hidden || app.requestSingleInstanceLock();
if (!primary) app.quit();
else if (!hidden) app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  const f = argv.slice(1).find(a => /\.(glb|gltf|bbmodel)$/i.test(a) && fs.existsSync(a));
  if (f) win.webContents.executeJavaScript(`window.openPathInTab && window.openPathInTab(${JSON.stringify(path.resolve(f))})`).catch(() => {});
});

const act = id => win && win.webContents.executeJavaScript(`window.glbAction && window.glbAction(${JSON.stringify(id)})`).catch(() => {});

// No accelerators on purpose: every shortcut lives in the editor and can be rebound there (Keys…).
function buildMenu() {
  const item = (label, id) => ({ label, click: () => act(id) });
  const sep = { type: 'separator' };
  return Menu.buildFromTemplate([
    { label: 'File', submenu: [item('New tab', 'tabNew'), item('Close this tab', 'tabClose'), item('Open the picked group in a sub-tab', 'subTab'), item('New project (clear this tab)', 'newProject'), sep, item('Save into the library', 'save'), item('Save a copy as…', 'download'), sep, item('Open model…', 'open'), item('Export a sprite sheet…', 'spriteSheet'), item('Import a Blockbench model…', 'importBlockbench'), item('Open the model library', 'library'), item('Load the test dummy', 'dummy'), sep,
      item('Save into the library', 'save'), item('Save a copy as…', 'download'), sep, { label: 'Quit', click: () => app.quit() }] },
    { label: 'Edit', submenu: [item('Undo', 'undo'), item('Redo', 'redo'), sep, item('Clean up the model…', 'cleanup'), sep, item('Select everything', 'selectAll'), item('Clear selection', 'deselect'), sep,
      item('Keyboard shortcuts…', 'keys')] },
    { label: 'Mode', submenu: [item('Object', 'modeObject'), item('Vertex (points)', 'modeVertex'), item('Edge (lines)', 'modeEdge'), item('Bone (skeleton)', 'modeBone'),
      item('Draw bones', 'modeDraw'), item('Paint', 'modePaint'), item('Build (Blockbench style)', 'modeBuild'), sep, item('Switch Edit ↔ Animate', 'animToggle')] },
    { label: 'Build', submenu: [item('New build', 'bNew'), item('Open a Blockbench file to build…', 'bOpen'), item('Make model', 'bMake'), sep,
      item('Add a cube', 'bAddCube'), item('Add an attach point', 'bLocator'), sep, item('Move tool', 'gMove'), item('Stretch tool', 'gScale'), item('Rotate tool', 'gRotate'), item('Pivot tool', 'gPivot'), item('Colour tool', 'bPaintTool'), item('Snap point tool', 'bSnapTool'), item('Push / Pull tool (holes and blocks)', 'bPushTool'), item('Pixel paint tool', 'bPixelTool'), item('Clear pixel paint from picked', 'bClearPaint'), item('Remove snap points from picked', 'bClearSnaps'), sep,
      item('Copy', 'bCopy'), item('Paste', 'bPaste'), item('Duplicate', 'bDup'), item('Group', 'bGroup'), item('Ungroup', 'bUngroup'), item('Combine into one part', 'bCombine'), sep,
      item('Mirror copy (left ↔ right)', 'bMirror'), item('Flip left–right', 'bFlipX'), item('Flip upside down', 'bFlipY'), item('Flip front–back', 'bFlipZ')] },
    { label: 'Rig', submenu: [item('Rig and walk in one go', 'autoRigWalk'), { type: 'separator' }, item('Fit a skeleton to the model', 'fitSkeleton'), item('Add stick figure', 'stick'), item('Bind mesh to skeleton', 'bind'), sep, item('Attach joints', 'attach'), item('Detach joints', 'detach')] },
    { label: 'Animate', submenu: [item('Make a walk', 'makeWalk'), item('Copy animations from another model…', 'importClips'), sep, item('Play / pause', 'play'), item('Set a key', 'key'), item('Delete key', 'delKey'), item('Close the loop', 'closeLoop'), item('New animation', 'newClip')] },
    { label: 'View', submenu: [item('Frame selection', 'frame'), item('Front view', 'viewFront'), item('Side view', 'viewSide'), item('Top view', 'viewTop'), item('3D view', 'viewPersp'), sep,
      item('Show / hide Tools window', 'panelTools'), item('Show / hide Scene window', 'panelScene'), item('Show / hide Animations window', 'panelClips'),
      item('Put all windows back in place', 'resetLayout'), item('Arrange the buttons…', 'arrangeButtons'), sep,
      { label: 'Theme', submenu: [['Dark', 'dark', 'themeDark'], ['Light', 'light', 'themeLight'], ['Like Windows (light or dark)', 'system', 'themeSystem']].map(([label, v, id]) => ({ label, type: 'radio', checked: (readSettings().theme || 'dark') === v, click: () => act(id) })) }, sep,
      { label: 'Watch in a browser (view only)…', click: () => openWatch() },
      item('Watch on my phone (QR code)…', 'watchPhone'), item('Claude Code terminal', 'claudeTerm'), { label: 'Notify me when Claude finishes', type: 'checkbox', checked: readSettings().notify !== false, click: () => act('notifyToggle') },
      { label: 'Let phones / tablets on my Wi-Fi watch', type: 'checkbox', checked: !!readSettings().watchLan, click: m => setWatchLan(m.checked) }, sep,
      { label: 'Toggle full screen', role: 'togglefullscreen', accelerator: '' }, { label: 'Developer tools', role: 'toggleDevTools', accelerator: '' }] },
    { label: 'Help', submenu: [item('How to use the editor', 'help'), item('Keyboard shortcuts…', 'keys')] },
  ]);
}

// ---- Watch: a read-only web page showing what the editor shows, with its own camera (see server.js startWatchServer)
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; } };
const writeSettings = patch => { const s = { ...readSettings(), ...patch }; fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); return s; };
let watchSrv = null;
async function startWatch() {
  const s = readSettings(), lan = !!s.watchLan;
  let token = s.watchToken; if (lan && !token) token = writeSettings({ watchToken: require('crypto').randomBytes(9).toString('base64url') }).watchToken;
  if (watchSrv) { try { watchSrv.server.close(); } catch {} watchSrv = null; }
  for (const port of [5180, 0]) { try { watchSrv = await startWatchServer({ port, host: lan ? '0.0.0.0' : '127.0.0.1', token: lan ? token : '' }); watchSrv.token = lan ? token : ''; watchSrv.lan = lan; break; } catch {} }
}
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
const watchUrls = () => { if (!watchSrv) return []; const k = watchSrv.token ? `/?k=${watchSrv.token}` : '/'; return [`http://127.0.0.1:${watchSrv.port}${k}`, ...(watchSrv.lan ? lanAddresses().map(ip => `http://${ip}:${watchSrv.port}${k}`) : [])]; };
async function openWatch() {
  if (!watchSrv) await startWatch();
  const urls = watchUrls(); if (!urls.length) return dialog.showMessageBox(win, { message: 'The watch page could not start.' });
  shell.openExternal(urls[0]);
  if (watchSrv.lan) dialog.showMessageBox(win, { title: 'Watch from another device', message: 'Open one of these links on a phone or tablet on the same Wi-Fi (the key in the link is required):', detail: urls.slice(1).join('\n') || '(no network address found)' });
}
async function setWatchLan(on) {
  writeSettings({ watchLan: !!on }); await startWatch();
  if (on) act('watchPhone'); // the QR code window: scan instead of typing
}

app.whenReady().then(async () => {
  if (!primary) return; // another editor window is open: it was brought forward instead
  const { port } = await startServer({
    port: 0, host: '127.0.0.1',
    libraryRoot: defaultLibrary(),
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    hooks: {
      trash: p => shell.trashItem(p),
      reveal: p => (fs.statSync(p).isDirectory() ? shell.openPath(p) : shell.showItemInFolder(p)),
      theme: mode => { nativeTheme.themeSource = ['light', 'dark', 'system'].includes(mode) ? mode : 'dark'; Menu.setApplicationMenu(buildMenu()); },
      watchLinks: async () => { if (!watchSrv) await startWatch(); return { lan: !!watchSrv?.lan, urls: watchUrls() }; },
      watchLan: async on => { writeSettings({ watchLan: !!on }); await startWatch(); Menu.setApplicationMenu(buildMenu()); return { lan: !!watchSrv?.lan, urls: watchUrls() }; },
      chooseRoot: async cur => {
        const r = await dialog.showOpenDialog(win, { title: 'Choose where your model library is kept', defaultPath: cur, properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? null : r.filePaths[0];
      },
    },
  });
  Menu.setApplicationMenu(buildMenu());
  const theme = readSettings().theme; nativeTheme.themeSource = ['light', 'system'].includes(theme) ? theme : 'dark'; // menus + title bar match the editor
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 560,
    title: 'Simple GLB Editor', backgroundColor: nativeTheme.shouldUseDarkColors ? '#121418' : '#e9ebef',
    icon: path.join(__dirname, 'icon.png'),
    show: !hidden,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: !hidden, preload: path.join(__dirname, 'preload.js') },
  });
  startControl();
  startWatch();
  const q = openArg ? '?open=' + encodeURIComponent(path.resolve(openArg)) : '';
  win.loadURL(`http://127.0.0.1:${port}/${q}${hidden ? (q ? '&' : '?') + 'hidden' : ''}`);
  // Downloads ("Save a copy as…"): always ask where.
  win.webContents.session.on('will-download', (_e, dl) => {
    dl.setSaveDialogOptions({ title: 'Save a copy of the model', defaultPath: path.join(app.getPath('documents'), dl.getFilename()), filters: [{ name: 'GLB model', extensions: ['glb'] }] });
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('focus', () => { focusedAt = Date.now(); act('libRefresh'); });
  win.on('closed', () => { win = null; });
  if (process.env.SIMPLE_GLB_DEV) win.on('page-title-updated', e => { e.preventDefault(); win.setTitle('Simple GLB Editor'); }); // a test copy: easy to tell apart
});

// ---- AI assistant plugins + the in-app terminal. A plugin is a JSON file describing a command-line AI assistant (which
// program, its chat / sign-in / sign-out / status commands, environment): built-in ones in <app>/agents (Claude Code
// ships), user ones in <userData>/agents (a user file with the same id replaces the built-in one). The terminal panel
// (src/terminal.js, xterm.js) shows it; the process runs here with node-pty (ConPTY). Only commands a plugin defines are
// ever started, and sign-in is the assistant's own (browser) flow, so the editor never sees a password or key.
let ptyLib = null; const terms = new Map(); let termSeq = 0;
const agentDirs = () => [path.join(__dirname, 'agents'), path.join(app.getPath('userData'), 'agents')];
function loadAgents() {
  const out = new Map();
  agentDirs().forEach((d, i) => {
    let files = []; try { files = fs.readdirSync(d).filter(f => f.toLowerCase().endsWith('.json')); } catch {}
    for (const f of files) {
      try { const a = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if (!a.id || !a.find) continue; a.builtIn = i === 0; a.file = path.join(d, f); out.set(a.id, a); }
      catch (e) { console.warn('AI plugin', f, 'skipped:', e.message); }
    }
  });
  return out;
}
const agentById = id => { const all = loadAgents(); const a = all.get(id) || all.get('claude-code') || [...all.values()][0]; if (!a) throw new Error('No AI plugin found'); return a; };
/** The assistant's program: the first `where <command>` hit, else the first listed path that exists (~ = home folder). */
function findExe(a) {
  for (const c of a.find.commands || []) {
    try { const hit = require('child_process').execFileSync('where.exe', [c], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(x => x.trim()).find(l => /\.(exe|cmd|bat)$/i.test(l)); if (hit) return hit; } catch {}
  }
  for (const p of a.find.paths || []) { const full = p.replace(/^~(?=[\\/])/, os.homedir()); if (fs.existsSync(full)) return full; }
  return null;
}
const fill = (a, args) => (args || []).map(x => String(x).replace(/\{panelNote\}/g, a.panelNote || ''));
const plain = a => ({ id: a.id, name: a.name || a.id, program: a.program || a.name || a.id, icon: a.icon || '🤖', description: a.description || '', builtIn: !!a.builtIn,
  installed: !!findExe(a), install: a.install || null, signIn: (a.signIn || []).map(x => ({ id: x.id, label: x.label, tip: x.tip || '' })), signOut: a.signOut ? { confirm: a.signOut.confirm || null } : null, hasStatus: !!a.status });
ipcMain.handle('agents:list', () => [...loadAgents().values()].map(plain));
ipcMain.handle('agents:openFolder', async () => { // "Add another assistant…": your plugins folder, with the how-to guide in it
  const dir = agentDirs()[1]; fs.mkdirSync(dir, { recursive: true });
  const guide = path.join(dir, 'README.md'); if (!fs.existsSync(guide)) try { fs.copyFileSync(path.join(agentDirs()[0], 'README.md'), guide); } catch {}
  await shell.openPath(dir); return dir;
});
ipcMain.handle('term:info', (_e, id) => plain(agentById(id)));
ipcMain.handle('term:pickFolder', async (_e, start) => { const r = await dialog.showOpenDialog(win, { title: 'Where should the AI assistant work?', defaultPath: start || undefined, properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('term:folderExists', (_e, p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
ipcMain.on('win:focus', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
app.setAppUserModelId('local.simple-glb-editor'); // Windows shows the editor's notifications as its own toasts
const pick = (o, dotted) => String(dotted || '').split('.').reduce((v, k) => (v == null ? v : v[k]), o);
ipcMain.handle('term:status', (_e, id) => new Promise(resolve => {
  const a = agentById(id), exe = findExe(a); if (!exe) return resolve({ installed: false, loggedIn: false });
  if (!a.status) return resolve({ installed: true, loggedIn: null });
  require('child_process').execFile(exe, fill(a, a.status.args), { timeout: 20000, windowsHide: true, env: cleanEnv(a) }, (err, out) => {
    try { const j = JSON.parse(out), m = a.status.json || {}, raw = pick(j, m.method); resolve({ installed: true, loggedIn: !!pick(j, m.loggedIn), method: raw ? (a.status.methods || {})[raw] || raw : null }); }
    catch { resolve({ installed: true, loggedIn: false, error: String(err?.message || 'no answer') }); }
  });
}));
/** The environment for the assistant: this app's, minus what the plugin drops (e.g. markers of a session that opened the editor), plus its own. */
function cleanEnv(a) {
  const drop = (a.dropEnv || []).map(r => new RegExp(r, 'i'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.some(r => r.test(k))));
  return Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, a.env || {});
}
/** kind: 'chat' | 'signin' (with signInId) | 'signout' | 'version' — the args come from the plugin, never from the page. */
ipcMain.handle('term:start', (e, { agent, kind = 'chat', signInId, cwd, cols = 100, rows = 30 } = {}) => {
  const a = agentById(agent), exe = findExe(a); if (!exe) throw new Error((a.program || a.name) + ' is not installed');
  const spec = kind === 'chat' ? a.chat : kind === 'version' ? a.version : kind === 'signout' ? a.signOut : kind === 'signin' ? (a.signIn || []).find(x => x.id === signInId) : null;
  if (!spec) throw new Error(`${a.name} has no "${kind}" command`);
  ptyLib ||= require('node-pty');
  const p = ptyLib.spawn(exe, fill(a, spec.args), { name: 'xterm-256color', cols, rows, cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), env: cleanEnv(a) });
  const id = ++termSeq, wc = e.sender; terms.set(id, p);
  p.onData(d => { if (!wc.isDestroyed()) wc.send('term:data', id, d); });
  p.onExit(({ exitCode }) => { terms.delete(id); if (!wc.isDestroyed()) wc.send('term:exit', id, exitCode); });
  return id;
});
ipcMain.on('term:write', (_e, id, d) => { try { terms.get(id)?.write(d); } catch {} });
ipcMain.on('term:resize', (_e, id, c, r) => { try { if (c > 1 && r > 1) terms.get(id)?.resize(c, r); } catch {} });
ipcMain.on('term:kill', (_e, id) => { try { terms.get(id)?.kill(); } catch {} });
app.on('will-quit', () => { for (const p of terms.values()) try { p.kill(); } catch {} });

// ---- Automation control (used by mcp/server.mjs): POST /run {code} runs an async JS body in the window with
// `editor` and `glbAction` in scope and returns {ok, value} or {ok:false, error}. Only on 127.0.0.1, and only with the
// random token written to <userData>/control.json (readable by this Windows user only).
const controlFile = () => path.join(app.getPath('userData'), 'control.json');
function startControl() {
  const token = crypto.randomBytes(24).toString('hex');
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-glb-token'] !== token) return send(403, { ok: false, error: 'bad token' });
    if (req.method === 'GET' && req.url === '/ping') return send(200, { ok: true, pid: process.pid, hidden, ready: !!win, tag, focusedAt, version: app.getVersion() });
    if (req.method !== 'POST' || req.url !== '/run') return send(404, { ok: false, error: 'unknown' });
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      let code, session;
      try { ({ code, session } = JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { return send(400, { ok: false, error: 'bad JSON' }); }
      if (!win) return send(503, { ok: false, error: 'The editor window is closed' });
      if (win.isMinimized()) win.restore();
      const js = `(async () => {
        for (let i = 0; i < 400 && !(window.editor && window.glbAction); i++) await new Promise(r => setTimeout(r, 25));
        try {
          // a session ({id, name?, tab?}) works in its own tab, in the background; without one, in the tab you are looking at
          const S = ${JSON.stringify(session && typeof session === 'object' ? session : null)}, T = S && window.tabs ? window.tabs.sessionTab(S) : null;
          const editor = T ? T.ed : window.editor, glbAction = T ? (id => window.glbActionIn(T, id)) : window.glbAction, THREE = editor && editor.THREE;
          const value = await (async () => { ${code}
 })();
          return JSON.stringify({ ok: true, value: value === undefined ? null : value });
        } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\\n').slice(1, 6).join('\\n') }); }
      })()`;
      try { send(200, JSON.parse(await win.webContents.executeJavaScript(js, true))); }
      catch (e) { send(200, { ok: false, error: String(e.message || e) }); }
    });
  });
  // Each editor writes its OWN file (control/<pid>.json), so several editors never overwrite each other; the MCP server
  // and the self-test look through all of them. control.json (older MCP servers read only that) = the visible editor.
  const own = path.join(app.getPath('userData'), 'control', process.pid + '.json');
  srv.listen(0, '127.0.0.1', () => {
    const info = JSON.stringify({ port: srv.address().port, token, pid: process.pid, hidden, tag, started: Date.now() });
    try { fs.mkdirSync(path.dirname(own), { recursive: true }); fs.writeFileSync(own, info); } catch {}
    if (!hidden) try { fs.writeFileSync(controlFile(), info); } catch {}
  });
  app.on('will-quit', () => {
    try { fs.unlinkSync(own); } catch {}
    try { const c = JSON.parse(fs.readFileSync(controlFile(), 'utf8')); if (c.pid === process.pid) fs.unlinkSync(controlFile()); } catch {}
  });
}

app.on('window-all-closed', () => app.quit());
