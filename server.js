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
 * The separate read-only watch server. host '127.0.0.1' = this computer only; '0.0.0.0' = also phones / tablets on the
 * same network, and then every request needs ?k=<token>. Serves: / and /watch.html, /src/watch-viewer.js, /vendor/three/*,
 * GET /api/watch/*. Nothing else (no library, no settings, no writes).
 */
function startWatchServer({ port = 5180, host = '127.0.0.1', token = '' } = {}) {
  const allowed = p => p === '/watch.html' || p === '/src/watch-viewer.js' || p.startsWith('/vendor/three/') || p === '/icon.png';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (token && url.searchParams.get('k') !== token && !(url.pathname.startsWith('/vendor/') || url.pathname === '/src/watch-viewer.js' || url.pathname === '/icon.png')) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('This watch link needs its key (?k=…). Copy the full link from the editor: View > Watch in a browser.'); }
    if (url.pathname.startsWith('/api/watch/')) { if (!watchRoute(req, res, url)) { res.writeHead(404); res.end(); } return; }
    const rel = url.pathname === '/' ? '/watch.html' : decodeURIComponent(url.pathname);
    if (!allowed(rel)) { res.writeHead(404); return res.end('not found'); }
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, host }));
  });
}

const readBody = req => new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });

function startServer({
  port = 5178, host,
  libraryRoot = path.join(ROOT, 'Library'),
  settingsFile = path.join(ROOT, '.settings.json'),
  hooks = {}, // { trash(absPath), reveal(absPath), chooseRoot(current) -> newRoot|null }
} = {}) {
  const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
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
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...s }, null, 2));
      return json(res, { ok: true });
    }
    if (p === '/api/local') {
      const f = q('path');
      if (!/\.(glb|gltf|bbmodel)$/i.test(f) || !fs.existsSync(f)) return json(res, { error: 'not found' }, 404); // read-only
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
    if (p === '/api/watch/lan' && m === 'POST') { if (!hooks.watchLan) return json(res, { error: 'Only in the desktop app' }, 400); return json(res, await hooks.watchLan(q('on') === '1')); }
    if (p.startsWith('/api/watch/') && m === 'GET' && watchRoute(req, res, url)) return;
    if (p === '/api/lib/info') return json(res, { root: getRoot(), desktop: !!hooks.reveal });
    if (p === '/api/lib/list') return json(res, await listDir(getRoot()));
    if (p === '/api/lib/file' && m === 'GET') {
      const f = abs(q('rel'));
      if (!fs.existsSync(f)) return json(res, { error: 'not found' }, 404);
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
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), libraryRoot: root }, null, 2));
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
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, getRoot }));
  });
}

module.exports = { startServer, startWatchServer };

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || 5178 })
    .then(({ port, getRoot }) => console.log(`Simple GLB Editor running at http://localhost:${port}  (library: ${getRoot()})`));
}
