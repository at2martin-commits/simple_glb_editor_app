#!/usr/bin/env python3
"""Simple GLB Editor's copy of the author's Test Bench (from Maple Hollow): pick test parts, run them, watch them tick off,
read the results in plain words.

    python scripts/testbench.py              the window (a page on http://127.0.0.1:8798, opened in your browser)
    python scripts/testbench.py --no-browser the window's server only (open the page yourself)
    python scripts/testbench.py run [part…]  no window: runs the parts (none named = all but the heavy ones) and records the result
    python scripts/testbench.py run --profile "Everything"   the same with a profile's parts
    python scripts/testbench.py last         prints the last result

It runs the command and parts in testbench.json (the editor's self-test, which starts its own hidden editor).
Its own port, lock and history (scripts/.testbench/), so it never meets Maple Hollow's bench (port 8797).
"""
import ctypes, json, os, re, subprocess, sys, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(ROOT, 'testbench.json'), encoding='utf-8'))

PORT = 8798
HIST = os.path.join(HERE, '.testbench', 'history.json')
PROFILES_FILE = os.path.join(HERE, '.testbench', 'profiles.json')   # the ones saved from the page
LOCK = os.path.join(HERE, '.testbench', 'run.lock')   # one run at a time (window or command line): they share Library/_selftest
PARTS = [p['name'] for p in CFG['parts'] if not p.get('heavy')]
EXTRA = [p['name'] for p in CFG['parts'] if p.get('heavy')]   # heavy parts: not ticked by default
BUILT_IN = {'Everything': PARTS + EXTRA, 'Usual (not heavy)': PARTS}
ABOUT = {p['name']: p.get('about', '') for p in CFG['parts']}


def free_ram_gb():
    class M(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in ('tot', 'avail', 'tpage', 'apage', 'tvirt', 'avirt', 'ext')]
    m = M(); m.len = ctypes.sizeof(M)
    return m.avail / 2 ** 30 if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)) else None

job = {'running': False, 'proc': None, 'parts': [], 'now': '', 'results': {}, 'failing': [], 'log': [], 'summary': '', 'started': 0, 'stopped': False}
lock = threading.Lock()


def history():
    try:
        return json.load(open(HIST, encoding='utf-8'))
    except (OSError, ValueError):
        return []


def saved_profiles():
    try:
        d = json.load(open(PROFILES_FILE, encoding='utf-8'))
        return {k: [x for x in v if x in PARTS + EXTRA] for k, v in d.items() if k not in BUILT_IN and isinstance(v, list)}
    except (OSError, ValueError, AttributeError):
        return {}


def save_profiles(d):
    os.makedirs(os.path.dirname(PROFILES_FILE), exist_ok=True)
    with open(PROFILES_FILE + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(d, f, indent=1)
    os.replace(PROFILES_FILE + '.tmp', PROFILES_FILE)


def profiles():
    return {**BUILT_IN, **saved_profiles()}


def record(entry):
    h = ([entry] + history())[:20]
    os.makedirs(os.path.dirname(HIST), exist_ok=True)
    with open(HIST + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(h, f, indent=1)
    os.replace(HIST + '.tmp', HIST)


def other_run():
    """The pid of a test run that is not ours (another window, or `run` from the command line), or None."""
    try:
        pid = int(open(LOCK).read())
        if pid == os.getpid():
            return None
    except (OSError, ValueError):
        return None
    alive = str(pid) in subprocess.run(['tasklist', '/FI', f'PID eq {pid}'], capture_output=True, text=True).stdout
    return pid if alive else None


def run(parts, echo=False):
    """Run the parts with testbench.json's command; fills `job` line by line and records the result. Blocks until done."""
    with lock:
        job.update(running=True, parts=parts, now='', results={}, failing=[], log=[], summary='', started=time.time(), stopped=False)
        os.makedirs(os.path.dirname(LOCK), exist_ok=True)
        open(LOCK, 'w').write(str(os.getpid()))
        job['proc'] = p = subprocess.Popen([*CFG['command'], *(parts or PARTS)], cwd=ROOT, shell=os.name == 'nt', stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
    for line in p.stdout:
        line = line.rstrip('\n')
        if echo:
            print(line, flush=True)
        job['log'] = (job['log'] + [line])[-400:]
        if m := re.match(r'^== (.+) ==$', line):
            job['now'] = m.group(1)
        elif m := re.match(r'^-- (.+): (\d+) passed, (\d+) failed', line):
            job['results'][m.group(1)] = {'passed': int(m.group(2)), 'failed': int(m.group(3))}
        elif m := re.match(r'^  FAILED: (.+)$', line):
            job['failing'].append(m.group(1))
        elif line.startswith('SUITE:'):
            job['summary'] = line[6:].strip()
    code = p.wait()
    ok = code == 0 and not job['stopped']
    entry = {'at': time.strftime('%Y-%m-%d %H:%M'), 'parts': parts or PARTS, 'ok': ok, 'stopped': job['stopped'], 'summary': job['summary'] or f'stopped (exit code {code})',
             'results': job['results'], 'failing': job['failing'], 'minutes': round((time.time() - job['started']) / 60, 1)}
    record(entry)
    try:
        os.remove(LOCK)
    except OSError:
        pass
    job.update(running=False, proc=None, now='')
    return entry


def stop():
    p = job['proc']
    if p:   # the whole tree: the self-test's hidden editor too
        job['stopped'] = True
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)


def state():
    return {'running': job['running'], 'parts': job['parts'] or PARTS, 'now': job['now'], 'results': job['results'], 'failing': job['failing'],
            'log': job['log'][-60:], 'summary': job['summary'], 'elapsed': round(time.time() - job['started']) if job['running'] else 0,
            'ram': round(free_ram_gb() or 0, 1), 'other': None if job['running'] else other_run(), 'history': history()[:8],
            'all': [{'name': n, 'about': ABOUT.get(n, ''), 'extra': n in EXTRA} for n in PARTS + EXTRA],
            'profiles': [{'name': k, 'parts': v, 'own': k not in BUILT_IN} for k, v in profiles().items()]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, kind='application/json'):
        b = body.encode('utf-8') if isinstance(body, str) else json.dumps(body).encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', kind + '; charset=utf-8'); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path == '/api/state':
            return self.send(200, state())
        if self.path in ('/', '/index.html'):
            return self.send(200, PAGE, 'text/html')
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        d = json.loads(self.rfile.read(n) or b'{}')
        if self.path == '/api/run':
            parts = [x for x in d.get('parts', []) if x in PARTS + EXTRA]
            if job['running']:
                return self.send(409, {'error': 'A run is already going.'})
            if not parts:
                return self.send(400, {'error': 'Tick at least one part.'})
            if pid := other_run():
                return self.send(409, {'error': f'Another test run is going (process {pid}). Wait for it to finish.'})
            threading.Thread(target=run, args=(parts,), daemon=True).start()
            return self.send(200, {'ok': True})
        if self.path in ('/api/profile/save', '/api/profile/delete'):
            name, d2 = str(d.get('name') or '').strip()[:40], saved_profiles()
            if not name or name in BUILT_IN:
                return self.send(400, {'error': 'Pick a name that is not one of the built-in profiles.'})
            if self.path.endswith('save'):
                d2[name] = [x for x in d.get('parts', []) if x in PARTS + EXTRA]
            else:
                d2.pop(name, None)
            save_profiles(d2)
            return self.send(200, {'ok': True})
        if self.path == '/api/stop':
            stop()
            return self.send(200, {'ok': True})
        self.send(404, {'error': 'not found'})


PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simple GLB Editor Test Bench</title><style>
:root{--bg:#f4ead6;--card:#fffaf0;--ink:#3b2a1a;--soft:#7a6650;--line:#d9c6a3;--ok:#2e7d4f;--bad:#b8382a;--run:#c98a1c}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 2px}.sub{color:var(--soft);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.part{display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed var(--line)}.part:last-child{border:0}
.part b{display:block}.part small{color:var(--soft)}.st{margin-left:auto;white-space:nowrap;font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.run{color:var(--run)}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer;margin-right:6px}
button.ghost{background:transparent;color:var(--ink)}button:disabled{opacity:.45;cursor:default}
pre{background:#2b2119;color:#efe3c4;padding:10px;border-radius:8px;max-height:260px;overflow:auto;font-size:12px;white-space:pre-wrap}
.big{font-size:18px;font-weight:700}ul{margin:6px 0 0;padding-left:20px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style></head><body><main>
<h1>🧪 Simple GLB Editor Test Bench</h1><p class="sub">Tick the parts to test, press Run. One run at a time; it starts its own hidden editor, and heavy parts wait until at least 4 GB of memory is free.</p>
<div class="card" id="status"></div>
<div class="card"><div id="parts"></div><div class="row" style="margin-top:10px">
<button id="go">Run</button><button class="ghost" id="stop">Stop</button></div>
<div style="margin-top:10px"><b>Profiles</b> <small>(click one to tick its parts)</small><div class="row" id="profs" style="margin-top:6px"></div></div></div>
<div class="card"><b>What the tests are printing</b><pre id="log">(nothing yet)</pre></div>
<div class="card"><b>Earlier runs</b><div id="hist"></div></div>
</main><script>
const $ = id => document.getElementById(id), esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let S = null, picked = null;
const mins = s => s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s';
function partState(n) {
  const r = S.results[n];
  if (r) return r.failed ? `<span class="st bad">✗ ${r.failed} failed, ${r.passed} passed</span>` : `<span class="st ok">✓ ${r.passed} passed</span>`;
  if (S.running && S.now === n) return '<span class="st run">⏳ running…</span>';
  if (S.running && S.parts.includes(n)) return '<span class="st" style="color:var(--soft)">waiting</span>';
  return '';
}
function draw() {
  if (!picked) picked = new Set(S.all.filter(p => !p.extra).map(p => p.name));
  const done = !S.running && S.history[0];
  $('status').innerHTML = S.running ? `<div class="big run">Running ${esc(S.now || '…')} (${mins(S.elapsed)})</div><small>Free memory ${S.ram} GB</small>`
    : S.other ? `<div class="big bad">Another test run is going (process ${S.other}).</div><small>Wait for it to finish before starting one here.</small>`
    : done ? `<div class="big ${done.ok ? 'ok' : 'bad'}">${done.ok ? '✓ All passed' : done.stopped ? 'Stopped' : '✗ Some checks failed'}: ${esc(done.summary)}</div><small>${esc(done.at)}, ${done.minutes} min. Free memory now ${S.ram} GB.</small>`
      + (done.failing.length ? `<ul>${done.failing.slice(0, 15).map(f => `<li class="bad">${esc(f)}</li>`).join('')}</ul>` : '')
    : `<div class="big">Ready.</div><small>Free memory ${S.ram} GB.</small>`;
  $('parts').innerHTML = S.all.map(p => `<label class="part"><input type="checkbox" data-n="${esc(p.name)}" ${picked.has(p.name) ? 'checked' : ''} ${S.running ? 'disabled' : ''}>
    <span><b>${esc(p.name)}${p.extra ? ' <small>(heavy)</small>' : ''}</b><small>${esc(p.about)}</small></span>${partState(p.name)}</label>`).join('');
  for (const c of document.querySelectorAll('[data-n]')) c.onchange = () => { c.checked ? picked.add(c.dataset.n) : picked.delete(c.dataset.n); drawProfiles(); };
  drawProfiles();
  $('go').disabled = S.running || !!S.other; $('stop').disabled = !S.running;
  const log = $('log'), atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = S.log.length ? S.log.join('\n') : '(nothing yet)'; if (atEnd) log.scrollTop = log.scrollHeight;
  $('hist').innerHTML = S.history.length ? S.history.map(h => `<div class="part"><span><b class="${h.ok ? 'ok' : 'bad'}">${h.ok ? '✓' : '✗'} ${esc(h.summary)}</b><small>${esc(h.at)} · ${h.minutes} min · ${esc(h.parts.join(', '))}</small></span></div>`).join('') : '<small>None yet.</small>';
}
async function tick() { try { S = await (await fetch('/api/state')).json(); draw(); } catch (e) { $('status').innerHTML = '<div class="big bad">The test bench program was closed.</div>'; } }
const post = async (u, b) => { const r = await (await fetch(u, { method: 'POST', body: JSON.stringify(b || {}) })).json(); if (r.error) alert(r.error); tick(); };
$('go').onclick = () => post('/api/run', { parts: S.all.map(p => p.name).filter(n => picked.has(n)) });
$('stop').onclick = () => confirm('Stop the run? Nothing from it will count as passed.') && post('/api/stop');
function drawProfiles() {
  const same = p => p.parts.length === picked.size && p.parts.every(n => picked.has(n));
  $('profs').innerHTML = S.profiles.map(p => `<span><button class="${same(p) ? '' : 'ghost'}" data-prof="${esc(p.name)}" title="${esc(p.parts.join(', '))}" ${S.running ? 'disabled' : ''}>${esc(p.name)}</button>${p.own ? `<button class="ghost" data-del="${esc(p.name)}" title="Delete this profile">×</button>` : ''}</span>`).join('')
    + `<button class="ghost" id="saveProf" ${S.running ? 'disabled' : ''}>+ Save the ticks as a profile</button>`;
  for (const b of document.querySelectorAll('[data-prof]')) b.onclick = () => { picked = new Set(S.profiles.find(p => p.name === b.dataset.prof).parts); draw(); };
  for (const b of document.querySelectorAll('[data-del]')) b.onclick = () => confirm(`Delete the profile "${b.dataset.del}"?`) && post('/api/profile/delete', { name: b.dataset.del });
  $('saveProf').onclick = () => { const n = prompt('Name for this profile:'); if (n) post('/api/profile/save', { name: n, parts: [...picked] }); };
}
tick(); setInterval(tick, 1500);
</script></body></html>"""


def main():
    a = sys.argv[1:]
    if a[:1] == ['run']:
        if a[1:2] == ['--profile']:
            name = ' '.join(a[2:])
            if name not in profiles():
                sys.exit('No profile called "' + name + '". The profiles are: ' + ', '.join(profiles()))
            a = ['run', *profiles()[name]]
        e = run(a[1:], echo=True)
        return 0 if e['ok'] else 1
    if a[:1] == ['last']:
        h = history()
        print(json.dumps(h[0], indent=1) if h else 'No runs yet.')
        return 0
    url = f'http://127.0.0.1:{PORT}/'
    try:
        srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    except OSError:   # already open: just show it again
        webbrowser.open(url)
        return 0
    print(f'Test bench: {url}  (close this window to quit; a run going on is stopped)')
    if '--no-browser' not in a:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
