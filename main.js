// Electron entry point: runs the editor as a desktop program.
// The embedded server only listens on 127.0.0.1; the window talks to it like a web page.
const { app, BrowserWindow, Menu, dialog, shell, nativeTheme, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { startServer, startWatchServer, hashWatchPassword, watchViewerCount, readSettingsFile, mergeSettingsFile, MODEL_EXT } = require('./server');
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
const openArg = process.argv.slice(1).find(a => MODEL_EXT.test(a) && fs.existsSync(a));

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
  const f = argv.slice(1).find(a => MODEL_EXT.test(a) && fs.existsSync(a));
  if (f) win.webContents.executeJavaScript(`window.openPathInTab && window.openPathInTab(${JSON.stringify(path.resolve(f))})`).catch(() => {});
});

const act = id => win && win.webContents.executeJavaScript(`window.glbAction && window.glbAction(${JSON.stringify(id)})`).catch(() => {});

// The menu line in the page (under the logo row, ui.js) is drawn from this list; there is no Windows menu bar.
// Items with an id run that editor action (so shortcuts and the session-tab lock apply); `run` = something only main.js can do.
// No accelerators on purpose: every shortcut lives in the editor and can be rebound there (Keys…).
function menuTemplate() {
  const item = (label, id) => ({ label, id });
  const sep = { type: 'separator' };
  return [
    { label: 'File', submenu: [item('New tab', 'tabNew'), item('Close this tab', 'tabClose'), item('Open the picked group in a sub-tab', 'subTab'), item('New project (clear this tab)', 'newProject'), sep, item('Save into the library', 'save'), item('Save a copy as…', 'download'), sep, item('Open model…', 'open'), item('Export a sprite sheet…', 'spriteSheet'), item('Import a Blockbench model…', 'importBlockbench'), item('Open the model library', 'library'), item('Load the test dummy', 'dummy'), sep,
      { label: 'Quit', run: 'quit' }] },
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
      { label: 'Theme', submenu: [['Dark', 'dark', 'themeDark'], ['Light', 'light', 'themeLight'], ['Like Windows (light or dark)', 'system', 'themeSystem']].map(([label, v, id]) => ({ label, id, type: 'radio', checked: (readSettings().theme || 'dark') === v })) }, sep,
      { label: 'Watch in a browser (view only)…', run: 'watch' },
      item('Watch from other devices…', 'watchPhone'), item('Claude Code terminal', 'claudeTerm'), { label: 'Notify me when Claude finishes', id: 'notifyToggle', type: 'checkbox', checked: readSettings().notify !== false },
      { label: 'Let other devices watch (home Wi-Fi: no password)', run: 'watchLan', type: 'checkbox', checked: !!readSettings().watchLan }, sep,
      { label: 'Toggle full screen', run: 'full' }, { label: 'Developer tools', run: 'devtools' }] },
    { label: 'Help', submenu: [item('How to use the editor', 'help'), item('Keyboard shortcuts…', 'keys')] },
  ];
}

// ---- Watch: a read-only web page showing what the editor shows, with its own camera (see server.js startWatchServer)
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => readSettingsFile(settingsPath());
const writeSettings = patch => mergeSettingsFile(settingsPath(), patch);
let watchSrv = null;
// The watch password (for devices outside the home network) lives in its own file, never in settings.json (the editor page
// rewrites that): {salt, hash} = scrypt, secret = signs the sign-in cookies (new password = new secret = everyone signed out).
const authPath = () => path.join(app.getPath('userData'), 'watch-auth.json');
let watchAuth = (() => { try { const a = JSON.parse(fs.readFileSync(authPath(), 'utf8')); return a.hash && a.salt && a.secret ? a : null; } catch { return null; } })();
function setWatchPassword(pw) {
  if (pw == null || pw === '') { watchAuth = null; try { fs.unlinkSync(authPath()); } catch {} return { hasPassword: false }; }
  if (String(pw).length < 6) return { error: 'Use at least 6 characters.', hasPassword: !!watchAuth };
  watchAuth = { ...hashWatchPassword(pw), secret: crypto.randomBytes(32).toString('hex') };
  if (/^\d+$/.test(String(pw))) watchAuth.pin = String(pw).length; // all digits = the sign-in page shows a number pad and goes on its own
  fs.mkdirSync(path.dirname(authPath()), { recursive: true }); fs.writeFileSync(authPath(), JSON.stringify(watchAuth, null, 2));
  return { hasPassword: true };
}
async function startWatch() {
  const lan = !!readSettings().watchLan;
  if (watchSrv) { try { watchSrv.server.close(); watchSrv.server.closeAllConnections(); } catch {} watchSrv = null; }
  for (const port of [5180, 0]) { try { watchSrv = await startWatchServer({ port, host: lan ? '0.0.0.0' : '127.0.0.1', auth: { get: () => watchAuth } }); watchSrv.lan = lan; break; } catch {} }
}
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
const watchUrls = () => { if (!watchSrv) return []; return [`http://127.0.0.1:${watchSrv.port}/`, ...(watchSrv.lan ? lanAddresses().map(ip => `http://${ip}:${watchSrv.port}/`) : [])]; };
const watchInfo = () => ({ lan: !!watchSrv?.lan, urls: watchUrls(), port: watchSrv?.port, hasPassword: !!watchAuth });
async function openWatch() {
  if (!watchSrv) await startWatch();
  const urls = watchUrls(); if (!urls.length) return dialog.showMessageBox(win, { message: 'The watch page could not start.' });
  shell.openExternal(urls[0]);
  if (watchSrv.lan) act('watchPhone'); // the window with the links for other devices
}
async function setWatchLan(on) {
  writeSettings({ watchLan: !!on }); await startWatch();
  if (on) act('watchPhone');
}

app.whenReady().then(async () => {
  if (!primary) return; // another editor window is open: it was brought forward instead
  const { port } = await startServer({
    port: 0, host: '127.0.0.1',
    libraryRoot: defaultLibrary(),
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    aiPanelDir: aiBoot.dir, // the panel's page files come from the copy its engine runs from
    hooks: {
      trash: p => shell.trashItem(p),
      reveal: p => (fs.statSync(p).isDirectory() ? shell.openPath(p) : shell.showItemInFolder(p)),
      theme: mode => { nativeTheme.themeSource = ['light', 'dark', 'system'].includes(mode) ? mode : 'dark'; },
      watchLinks: async () => { if (!watchSrv) await startWatch(); return watchInfo(); },
      watchPassword: async pw => ({ ...watchInfo(), ...setWatchPassword(pw) }),
      watchLan: async on => { writeSettings({ watchLan: !!on }); await startWatch(); return watchInfo(); },
      chooseRoot: async cur => {
        const r = await dialog.showOpenDialog(win, { title: 'Choose where your model library is kept', defaultPath: cur, properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? null : r.filePaths[0];
      },
    },
  });
  Menu.setApplicationMenu(null); // the menu line is in the page (menuTemplate)
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
  // Someone watching (maybe from far away) while the window is minimized / the screen locked: Chromium would slow the editor's
  // timers to once a minute and the watch page would stall. Run at full speed while any watch page is open.
  let fullSpeed = hidden;
  setInterval(() => {
    if (!win || win.isDestroyed() || hidden) return;
    const want = watchViewerCount() > 0; if (want === fullSpeed) return;
    fullSpeed = want; win.webContents.setBackgroundThrottling(!want);
    if (want) win.webContents.executeJavaScript('window.watchKick && window.watchKick()').catch(() => {});
  }, 1000).unref();
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

// ---- the AI panel's engine: the shared github.com/Marty-s-Stuff/ai-panel (version = its tag in package.json). It runs the
// picked command-line AI assistant (plugins: its built-in ones, %APPDATA%\ai-agents, the old <userData>\agents) with node-pty;
// src/ui.js shows it through preload.js (window.glbTerm). GLB_SESSION_NAME names the assistant's tab in mcp/server.mjs.
// From v1.2.0 the panel can update itself (▾ menu: Install / Not now / Skip; used from the next start): aiBoot picks the copy,
// the built-in one or a newer 1.x the user installed into <userData>i-panel. The page's panel files come from the same copy (server.js aiPanelDir).
const aiBoot = require('ai-panel/node/boot.js').createBoot({ updateDir: path.join(app.getPath('userData'), 'ai-panel') });
require(path.join(aiBoot.dir, 'node', 'aipanel.js')).setup({ ipcMain, app, shell, dialog, getWin: () => win, appName: 'Simple GLB Editor', sessionVar: 'GLB_SESSION_NAME',
  boot: aiBoot, pty: require('node-pty'), extraDirs: [path.join(app.getPath('userData'), 'agents')] }); // (a test copy with SIMPLE_GLB_USERDATA keeps its own plugins folder)
ipcMain.handle('menu:get', () => menuTemplate());
ipcMain.on('menu:run', (_e, what, checked) => ({ quit: () => app.quit(), watch: () => openWatch(), watchLan: () => setWatchLan(checked),
  full: () => win?.setFullScreen(!win.isFullScreen()), devtools: () => win?.webContents.toggleDevTools() })[what]?.());
ipcMain.on('win:focus', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
app.setAppUserModelId('local.simple-glb-editor'); // Windows shows the editor's notifications as its own toasts

// ---- Automation control (used by mcp/server.mjs): POST /run {code} runs an async JS body in the window with
// `editor` and `glbAction` in scope and returns {ok, value} or {ok:false, error}. Only on 127.0.0.1, and only with the
// random token written to <userData>/control/<pid>.json (readable by this Windows user only).
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
          const S = ${JSON.stringify(session && typeof session === 'object' ? session : null)}, T = S && window.tabs && !S.noTab ? window.tabs.sessionTab(S) : null;
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
