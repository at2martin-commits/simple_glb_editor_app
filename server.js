// Tiny zero-dependency server for the Simple GLB Editor.
// Used two ways:
//   node server.js        -> dev/automation mode at http://localhost:5178 (Library/ next to this file)
//   require('./server')   -> embedded in the desktop app (main.js), which passes hooks for
//                            Recycle Bin, Explorer and folder pickers.
//
// Model library (a folder of .glb files, organised in sub-folders); every `rel` is library-relative:
//   GET  /api/lib/info                     -> { root }
//   GET  /api/lib/list                     -> { name, rel, dirs:[...], files:[{name, rel, size, mtime}] }
//   GET  /api/lib/file?rel=a/b.glb         -> bytes
//   PUT  /api/lib/file?dir=a&name=b.glb[&overwrite=1] -> { rel }
//   POST /api/lib/mkdir?parent=a&name=x    -> { rel }
//   POST /api/lib/rename?rel=a/b.glb&name=c -> { rel }
//   POST /api/lib/move?dest=a   body ["rel", ...]  -> { moved:[rel] }
//   POST /api/lib/delete        body ["rel", ...]  -> Recycle Bin (desktop) / Library/.trash (dev)
//   POST /api/lib/reveal?rel=   (desktop only)     POST /api/lib/chooseRoot (desktop only) -> { root }
// Other:
//   GET  /api/local?path=C:\x.glb          -> open a .glb by absolute path (drag onto the exe / Open with)
//   GET/PUT /api/settings                  -> JSON settings (key bindings, window layout, ...)
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = __dirname;
const MODEL_EXT = /\.(glb|gltf|bbmodel)$/i; // .bbmodel = Build mode projects (Blockbench files)
// settings.json is shared by this server and main.js: one reader and one merge-writer for both
const readSettingsFile = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const mergeSettingsFile = (f, patch) => { const s = { ...readSettingsFile(f), ...patch }; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s, null, 2)); return s; };
/** Stream a static file (both servers); the caller has already checked the path. */
const sendFile = (res, file) => fs.stat(file, (err, st) => {
  if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown', '.wasm': 'application/wasm',
};

const cleanName = n => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || 'Untitled';
function uniquePath(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let p = path.join(dir, name), n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${stem} (${n++})${ext}`);
  return p;
}
// ---- Watch: a read-only live view of the editor. The editor (on the main, 127.0.0.1-only server) publishes its scene
// (.glb) and a small state; viewers read them from /watch.html — on the main server (this computer) or on the separate
// watch server below, which serves ONLY the viewer page, three.js and the read-only watch endpoints (no library, no writes).
// One feed per editor tab ({ver, glb, state, label, claude}); `active` = the tab shown in the editor. A viewer follows the
// active tab (?tab=follow, default) or sticks to one tab (?tab=<key>).
const watch = { feeds: new Map(), active: null, clients: new Set() };
const watchTabs = () => [...watch.feeds].map(([key, f]) => ({ key, label: f.label || key, claude: !!f.claude }));
const watchMsg = () => JSON.stringify({ active: watch.active, tabs: watchTabs(), feeds: Object.fromEntries([...watch.feeds].map(([k, f]) => [k, { ver: f.ver, state: f.state }])) });
function watchNotify() {
  const msg = `data: ${watchMsg()}\n\n`;
  for (const res of watch.clients) { try { res.write(msg); } catch { watch.clients.delete(res); } }
}
const watchFeed = key => { if (!watch.feeds.has(key)) watch.feeds.set(key, { ver: 0, glb: null, state: {} }); return watch.feeds.get(key); };
/** How many viewers look at this tab right now (following viewers count for the active tab). */
const watchers = key => [...watch.clients].filter(r => r.watchTab === key || (r.watchTab === 'follow' && watch.active === key)).length;
setInterval(() => { let gone = false; for (const [k, f] of watch.feeds) if (Date.now() - (f.at || 0) > 15000) { watch.feeds.delete(k); gone = true; } if (gone) watchNotify(); }, 5000).unref(); // closed tabs / a closed editor
/** GET-only watch routes shared by both servers. Returns true when handled. */
function watchRoute(req, res, url) {
  const tab = url.searchParams.get('tab');
  if (url.pathname === '/api/watch/scene') {
    const f = watch.feeds.get(tab && tab !== 'follow' ? tab : watch.active);
    if (!f?.glb) { res.writeHead(204); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-store' }); res.end(f.glb); return true;
  }
  if (url.pathname === '/api/watch/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(watchMsg()); return true; }
  if (url.pathname === '/api/watch/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.watchTab = tab || 'follow';
    res.write(`data: ${watchMsg()}\n\n`);
    watch.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); watch.clients.delete(res); });
    return true;
  }
  return false;
}

/**
 * The separate read-only watch server. host '127.0.0.1' = this computer only; '0.0.0.0' = other devices too:
 * - this PC and devices on the home network (private addresses 10.x, 172.16-31.x, 192.168.x, 169.254.x) get straight in;
 * - anything else (port forwarding, a tunnel, any request a proxy passed on) gets a login page and needs the password set
 *   in the editor (`auth.get()` -> {salt, hash, secret} | null, scrypt hash; no password = nobody from outside).
 * Serves: / and /watch.html, /src/watch-viewer.js, /vendor/three/*, GET /api/watch/*, POST /login. Nothing else.
 */
const crypto = require('crypto');
const ipOf = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-forwarded-host', 'tailscale-user-login'];
/** At home = this PC or the local network, and not passed on by a proxy / tunnel (those connect from this PC). */
function watchAtHome(req) {
  if (PROXY_HEADERS.some(h => req.headers[h])) return false;
  const ip = ipOf(req), m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return ip === '::1' || /^(fe80|f[cd][0-9a-f]{2}):/i.test(ip);
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
/** scrypt hash for the watch password: {salt, hash} (hex). */
function hashWatchPassword(pw, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') }; }
const sign = (secret, exp) => crypto.createHmac('sha256', secret).update('watch:' + exp).digest('base64url');
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const cookieOf = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)glbwatch=([^;]+)/) || [])[1];
function signedIn(req, a) {
  const c = cookieOf(req); if (!a || !c) return false;
  const [exp, mac] = c.split('.'); return +exp > Date.now() && eq(mac, sign(a.secret, exp));
}
const LOGIN_TRIES = 5, LOGIN_WINDOW = 10 * 60e3, ALL_TRIES = 30, ALL_WINDOW = 60 * 60e3; // per visitor / everyone from outside together
/** Who is signing in: behind a tunnel (cloudflared, …) every request comes from this PC, so use the address the tunnel passes on. */
const visitorOf = req => { const ip = ipOf(req); if (!/^(127\.|::1$)/.test(ip)) return ip; return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || ip).trim(); };
const loginPage = (hasPassword, pin = 0) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watch · Simple GLB Editor</title><link rel="icon" href="/icon.png"><style>
:root{--bg:#121418;--card:#1c1f26;--line:#2e333e;--text:#dfe3ea;--muted:#8b93a3;--accent:#4fc3f7;--on-accent:#0b1a22;--bad:#ff5252}
@media (prefers-color-scheme: light){:root{--bg:#e9ebef;--card:#fff;--line:#d3d7de;--text:#1d2026;--muted:#5d6470;--bad:#c33}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 22px}
h1{font-size:19px;margin:0 0 4px;display:flex;gap:10px;align-items:center}h1 img{width:28px;height:28px}p{margin:6px 0 16px;color:var(--muted)}
input[type=password]{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}label{display:flex;gap:8px;align-items:center;margin:12px 0 16px;color:var(--muted);font-size:14px}
button{width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:16px;font-weight:600;cursor:pointer}button:disabled{opacity:.6}
.err{color:var(--bad);min-height:1.4em;margin:10px 0 0;font-size:14px}</style></head><body><div class="card">
<h1><img src="/icon.png" alt="">Simple GLB Editor</h1>
${hasPassword ? `<p>View only. Enter the watch password set in the editor.</p>
<form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="${pin ? 'PIN' : 'Password'}"${pin ? ` inputmode="numeric" pattern="[0-9]*" maxlength="${pin}"` : ''} autofocus required>
<label><input id="keep" type="checkbox" checked> Keep me signed in on this device (30 days)</label><button id="go">Sign in</button><div class="err" id="err"></div></form>
<script>${pin ? `pw.oninput=()=>{if(pw.value.length===${pin})f.requestSubmit()};` : ''}f.onsubmit=async e=>{e.preventDefault();go.disabled=true;err.textContent='';try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value,keep:keep.checked})});const j=await r.json().catch(()=>({}));if(r.ok)return location.reload();err.textContent=j.error||'Could not sign in';}catch{err.textContent='The editor did not answer. Is it still running?'}go.disabled=false;pw.select();}</script>`
  : `<p>Watching from outside the home network is not set up. On the PC, open <b>View › Watch from other devices…</b> and set a password.</p>`}
</div></body></html>`;

function startWatchServer({ port = 5180, host = '127.0.0.1', auth = { get: () => null } } = {}) {
  const allowed = p => p === '/watch.html' || p === '/src/watch-viewer.js' || p.startsWith('/vendor/three/') || p === '/icon.png';
  const open = p => p.startsWith('/vendor/') || p === '/src/watch-viewer.js' || p === '/icon.png'; // public code, no model data
  const fails = new Map(); // visitor -> times of wrong passwords
  let allFails = []; // every wrong password from outside (a 6-digit PIN must not be guessable by many visitors at once)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), ip = visitorOf(req), home = watchAtHome(req);
    let p; try { p = path.posix.normalize(decodeURIComponent(url.pathname)); } catch { p = '\\'; } // checks below must see the real path ("..%2f" is "../")
    if (p.includes('\\')) { res.writeHead(400); return res.end(); }
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
    if (req.method === 'POST' && p === '/login') {
      const a = auth.get(), now = Date.now(), list = (fails.get(ip) || []).filter(t => now - t < LOGIN_WINDOW);
      allFails = allFails.filter(t => now - t < ALL_WINDOW);
      if (allFails.length >= ALL_TRIES) return send(429, 'application/json', JSON.stringify({ error: `Too many wrong tries from outside: sign-in is paused for ${Math.ceil((ALL_WINDOW - (now - allFails[0])) / 60e3)} min. (Signed-in devices keep working.)` }));
      if (list.length >= LOGIN_TRIES) return send(429, 'application/json', JSON.stringify({ error: `Too many wrong passwords. Try again in ${Math.ceil((LOGIN_WINDOW - (now - list[0])) / 60e3)} min.` }));
      let body = {}; try { body = JSON.parse((await readBody(req, 4096)).toString() || '{}'); } catch {}
      if (!a) return send(403, 'application/json', JSON.stringify({ error: 'No watch password is set in the editor.' }));
      if (!body.password || !eq(hashWatchPassword(body.password, a.salt).hash, a.hash)) {
        list.push(now); fails.set(ip, list); allFails.push(now); if (fails.size > 5000) fails.clear();
        return send(401, 'application/json', JSON.stringify({ error: list.length >= LOGIN_TRIES ? 'Wrong password. Too many tries: wait 10 minutes.' : 'Wrong password.' }));
      }
      fails.delete(ip);
      const exp = now + 30 * 864e5, secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(200, 'application/json', '{"ok":true}', { 'Set-Cookie': `glbwatch=${exp}.${sign(a.secret, exp)}; Path=/; HttpOnly; SameSite=Strict${body.keep ? '; Max-Age=' + 30 * 86400 : ''}${secure}` });
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (!open(p) && !home && !signedIn(req, auth.get())) {
      if (p.startsWith('/api/')) return send(401, 'application/json', JSON.stringify({ error: 'Sign in first' }));
      const a = auth.get(); return send(401, 'text/html; charset=utf-8', loginPage(!!a, a?.pin || 0));
    }
    if (p.startsWith('/api/watch/')) { if (!watchRoute(req, res, url)) { res.writeHead(404); res.end(); } return; }
    const rel = p === '/' ? '/watch.html' : p;
    if (!allowed(rel)) { res.writeHead(404); return res.end('not found'); }
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    sendFile(res, file);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, host }));
  });
}

const readBody = (req, max = Infinity) => new Promise((res, rej) => { const c = []; let n = 0; req.on('data', d => { if ((n += d.length) > max) { req.destroy(); return rej(new Error('Request too large')); } c.push(d); }); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });

function startServer({
  port = 5178, host,
  libraryRoot = path.join(ROOT, 'Library'),
  settingsFile = path.join(ROOT, '.settings.json'),
  hooks = {}, // { trash(absPath), reveal(absPath), chooseRoot(current) -> newRoot|null }
  aiPanelDir = null, // desktop app: the AI panel copy in use (built-in or an installed update, main.js aiBoot.dir) answers /vendor/ai-panel/
} = {}) {
  const readSettings = () => readSettingsFile(settingsFile);
  let root = path.resolve(readSettings().libraryRoot || libraryRoot);
  const getRoot = () => { fs.mkdirSync(root, { recursive: true }); return root; };
  const abs = (rel = '') => {
    const r = getRoot(), p = path.resolve(r, rel || '.');
    if (p !== r && !p.startsWith(r + path.sep)) throw Object.assign(new Error('Path is outside the library'), { code: 400 });
    return p;
  };
  const relOf = p => path.relative(getRoot(), p).split(path.sep).join('/');

  async function listDir(dir) {
    const node = { name: path.basename(dir), rel: relOf(dir), dirs: [], files: [] };
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return node; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) node.dirs.push(await listDir(p));
      else if (e.isFile() && MODEL_EXT.test(e.name)) {
        const st = await fsp.stat(p).catch(() => ({ size: 0, mtimeMs: 0 }));
        node.files.push({ name: e.name, rel: relOf(p), size: st.size, mtime: st.mtimeMs });
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    node.dirs.sort(byName); node.files.sort(byName);
    return node;
  }

  const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  async function api(req, res, url) {
    const p = url.pathname, q = k => url.searchParams.get(k) || '', m = req.method;
    if (p === '/api/settings') {
      if (m === 'GET') return json(res, readSettings());
      const s = JSON.parse((await readBody(req)).toString() || '{}');
      mergeSettingsFile(settingsFile, s);
      return json(res, { ok: true });
    }
    if (p === '/api/local') {
      const f = q('path');
      if (!MODEL_EXT.test(f) || !fs.statSync(f, { throwIfNoEntry: false })?.isFile()) return json(res, { error: 'not found' }, 404); // read-only; a folder would crash the stream (EISDIR)
      res.writeHead(200, { 'Content-Type': /\.(bbmodel|json)$/i.test(f) ? 'application/json' : /\.png$/i.test(f) ? 'image/png' : 'model/gltf-binary' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/watch/scene' && m === 'PUT') { const key = q('tab') || 'main', f = watchFeed(key); f.glb = await readBody(req); f.ver++; f.at = Date.now(); watchNotify(); return json(res, { ver: f.ver }); }
    if (p === '/api/watch/state' && m === 'POST') {
      const key = q('tab') || 'main', body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.gone) { watch.feeds.delete(key); if (watch.active === key) watch.active = null; watchNotify(); return json(res, { ok: true }); }
      const f = watchFeed(key), { label, claude, active, ...state } = body;
      Object.assign(f, { state: { ...state, ver: f.ver }, label, claude, at: Date.now() }); if (active) watch.active = key;
      watchNotify(); return json(res, { ok: true, viewers: watchers(key) });
    }
    if (p === '/api/theme' && m === 'POST') { hooks.theme?.(q('mode')); return json(res, { ok: true }); }
    if (p === '/api/watch/links') return json(res, hooks.watchLinks ? await hooks.watchLinks() : { lan: false, urls: [`http://localhost:${req.socket.localPort}/watch.html`], dev: true });
    if (p === '/api/watch/password' && m === 'POST') { if (!hooks.watchPassword) return json(res, { error: 'Only in the desktop app' }, 400); const b = JSON.parse((await readBody(req)).toString() || '{}'); return json(res, await hooks.watchPassword(b.password ?? null)); }
    if (p === '/api/watch/lan' && m === 'POST') { if (!hooks.watchLan) return json(res, { error: 'Only in the desktop app' }, 400); return json(res, await hooks.watchLan(q('on') === '1')); }
    if (p.startsWith('/api/watch/') && m === 'GET' && watchRoute(req, res, url)) return;
    if (p === '/api/lib/info') return json(res, { root: getRoot(), desktop: !!hooks.reveal });
    if (p === '/api/lib/list') return json(res, await listDir(getRoot()));
    if (p === '/api/lib/file' && m === 'GET') {
      const f = abs(q('rel'));
      if (!fs.statSync(f, { throwIfNoEntry: false })?.isFile()) return json(res, { error: 'not found' }, 404); // a folder would crash the stream (EISDIR)
      res.writeHead(200, { 'Content-Type': /\.(bbmodel|json)$/i.test(f) ? 'application/json' : /\.png$/i.test(f) ? 'image/png' : 'model/gltf-binary' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/lib/file' && m === 'PUT') {
      const dir = abs(q('dir')); await fsp.mkdir(dir, { recursive: true });
      let name = cleanName(q('name')); if (!MODEL_EXT.test(name) && !/\.(png|json)$/i.test(name)) name += '.glb'; // (.png / .json: sprite sheets)
      const target = q('overwrite') ? path.join(dir, name) : uniquePath(dir, name);
      const buf = await readBody(req);
      await fsp.writeFile(target, buf);
      return json(res, { rel: relOf(target), bytes: buf.length, path: target });
    }
    if (p === '/api/lib/mkdir') {
      const t = uniquePath(abs(q('parent')), cleanName(q('name') || 'New folder'));
      await fsp.mkdir(t, { recursive: true });
      return json(res, { rel: relOf(t) });
    }
    if (p === '/api/lib/rename') {
      const src = abs(q('rel'));
      if (src === getRoot()) return json(res, { error: 'The library folder itself cannot be renamed' }, 400);
      let name = cleanName(q('name'));
      if ((await fsp.stat(src)).isFile() && !path.extname(name)) name += path.extname(src);
      if (name === path.basename(src)) return json(res, { rel: q('rel') });
      const t = uniquePath(path.dirname(src), name);
      await fsp.rename(src, t);
      return json(res, { rel: relOf(t) });
    }
    if (p === '/api/lib/move') {
      const dest = abs(q('dest')), moved = [];
      for (const rel of JSON.parse((await readBody(req)).toString() || '[]')) {
        const src = abs(rel);
        if (src === getRoot() || path.dirname(src) === dest || dest === src || dest.startsWith(src + path.sep)) continue;
        const t = uniquePath(dest, path.basename(src));
        await fsp.rename(src, t); moved.push(relOf(t));
      }
      return json(res, { moved });
    }
    if (p === '/api/lib/delete') {
      for (const rel of JSON.parse((await readBody(req)).toString() || '[]')) {
        const src = abs(rel); if (src === getRoot()) continue;
        if (hooks.trash) await hooks.trash(src);
        else { const bin = path.join(getRoot(), '.trash'); await fsp.mkdir(bin, { recursive: true }); await fsp.rename(src, uniquePath(bin, path.basename(src))); }
      }
      return json(res, { ok: true });
    }
    if (p === '/api/lib/reveal') { if (hooks.reveal) await hooks.reveal(abs(q('rel'))); return json(res, { ok: !!hooks.reveal }); }
    if (p === '/api/lib/chooseRoot') {
      const r = hooks.chooseRoot ? await hooks.chooseRoot(getRoot()) : null;
      if (r) {
        root = path.resolve(r);
        mergeSettingsFile(settingsFile, { libraryRoot: root });
      }
      return json(res, { root: r ? getRoot() : null });
    }
    return json(res, { error: 'unknown api' }, 404);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch(err => json(res, { error: err.message }, err.code || 500));
      return;
    }
    let rel; try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { res.writeHead(400); return res.end(); }
    const AIP = '/vendor/ai-panel/', base = aiPanelDir && rel.startsWith(AIP) ? path.resolve(aiPanelDir) : ROOT; // (else the build-time copy, e.g. npm run server)
    const file = path.normalize(path.join(base, base === ROOT ? rel : rel.slice(AIP.length)));
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    sendFile(res, file);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, getRoot }));
  });
}

/** How many watch pages are open right now (main.js keeps the editor running at full speed while any are). */
const watchViewerCount = () => watch.clients.size;
module.exports = { startServer, startWatchServer, hashWatchPassword, watchViewerCount, readSettingsFile, mergeSettingsFile, MODEL_EXT };

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || 5178, host: '127.0.0.1' })
    .then(({ port, getRoot }) => console.log(`Simple GLB Editor running at http://localhost:${port}  (library: ${getRoot()})`));
}
