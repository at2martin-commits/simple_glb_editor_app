// In-app Claude Code: a drop-down terminal (xterm.js, classic scripts in /vendor/xterm) over the editor, plus the
// "🤖 Claude ▾" toolbar menu (sign in with a Claude subscription or the Anthropic API, sign out, new conversation).
// The terminal process lives in main.js (node-pty); window.glbTerm (preload.js) is the bridge. Only `claude` is run.
// Claude Code started here finds this window through the simple-glb MCP server and works in its own editor tab.

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
import { notify, away } from './notify.js';
const T = window.glbTerm || null; // null in a plain browser (npm run server): the terminal needs the desktop app

export function initTerminal({ status, settings, workFolder, onShow, onHide }) {
  const panel = $('#term'), host = $('#termHost'), menu = $('#claudeMenu'), note = $('#claudeNote');
  let term = null, fit = null, cur = null, curKind = null, auth = null, starting = false;
  const prefs = { height: 46, width: 560, mode: 'drop', folder: null, folders: [], ...settings.get('terminal', {}) }; // mode: 'drop' (over the top) | 'side' (docked right)
  panel.style.setProperty('--term-h', prefs.height + 'vh');
  document.documentElement.style.setProperty('--term-w', prefs.width + 'px');
  /** Docked right: a full-height column, the editor shrinks beside it. Drop-down: over the top, under the toolbars. */
  function applyMode() {
    const side = prefs.mode === 'side';
    panel.classList.toggle('side', side);
    document.body.classList.toggle('termside', side && !panel.hidden);
    $('#btnClaude').classList.toggle('pressed', !panel.hidden); // pressed in while the panel is open
    window.dispatchEvent(new Event('term-placed'));
    $('#termMode').textContent = side ? '▤ Drop down' : '◨ Dock right';
    $('#termMode').title = side ? 'Show the terminal as a drop-down over the top of the editor instead.' : 'Dock the terminal on the right as a full-height column next to the editor (good for a long chat while you work).';
    $('#termHide').textContent = side ? '▶ Hide' : '▲ Hide';
    window.dispatchEvent(new Event('panels-changed')); // the 3D view resizes
    requestAnimationFrame(() => { try { fit?.fit(); } catch {} });
  }

  const theme = () => (document.documentElement.dataset.theme === 'light'
    ? { background: '#ffffff', foreground: '#1d2229', cursor: '#0277bd', cursorAccent: '#ffffff', selectionBackground: '#cfe3f7', black: '#1d2229', brightBlack: '#6b7380', white: '#5d6675', brightWhite: '#1d2229' }
    : { background: '#171a21', foreground: '#e3e7ee', cursor: '#4fc3f7', cursorAccent: '#171a21', selectionBackground: '#2a3f57', brightBlack: '#7d8696' });
  addEventListener('theme-changed', () => { if (term) term.options.theme = theme(); });

  function ensureTerm() {
    if (term) return term;
    term = new window.Terminal({ fontFamily: '"Cascadia Code", "Cascadia Mono", "Segoe UI Mono", Consolas, monospace', fontSize: 14, lineHeight: 1.25, cursorBlink: false, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'none', allowProposedApi: true, scrollback: 5000, theme: theme() });
    fit = new window.FitAddon.FitAddon(); term.loadAddon(fit);
    term.open(host);
    term.attachCustomKeyEventHandler(e => {
      if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) { // Space is sent straight away (xterm would wait for a keypress, which the app's keys can swallow)
        if (e.type === 'keydown') { e.preventDefault(); if (cur) T.write(cur, ' '); }
        return false;
      }
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { toggle(false); return false; }          // hide again
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; } // copy (else Ctrl+C stops Claude as usual)
      if (e.ctrlKey && e.key.toLowerCase() === 'v') return false; // the browser pastes (xterm reads the paste event)
      return true;
    });
    term.onData(d => { if (cur) T.write(cur, d); else if (d === '\r' && !starting) startClaude(); }); // Enter after a session ended = start again
    term.onResize(({ cols, rows }) => { if (cur) T.resize(cur, cols, rows); });
    new ResizeObserver(() => { if (!panel.hidden) try { fit.fit(); } catch {} }).observe(host);
    setTimeout(renderChoices);
    return term;
  }
  // ---- answer buttons: Claude Code asks with numbered menus ("❯ 1. Yes / 2. No") and sometimes with a) b) c) in its
  // text; the bar under the terminal turns what is on screen into buttons, so a click answers.
  const bar = $('#termChoices'); let scanTimer = 0, lastChoices = null;
  const clean = l => l.replace(/^[\s│┃|]+|[\s│┃|]+$/g, '');
  const tidy = t => t.replace(/\*\*/g, '').replace(/\s{2,}/g, ' · ').trim();
  const nextKey = (a, b) => (/^\d+$/.test(a) ? +b === +a + 1 : b.toLowerCase().charCodeAt(0) === a.toLowerCase().charCodeAt(0) + 1);
  function findChoices() {
    const b = term.buffer.active, raw = [];
    for (let y = b.baseY; y < b.baseY + term.rows && y < b.length; y++) raw.push(b.getLine(y)?.translateToString(true) || '');
    const lines = raw.map(clean);
    // 1) an interactive menu (permission prompt, AskUserQuestion, pickers): consecutive "N. text" with a ❯ on the picked one
    const menu = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^([❯›>]\s*)?(\d{1,2})[.)]\s+(.{1,160})$/);
      if (m) { menu.unshift({ key: m[2], text: tidy(m[3]), current: !!m[1] }); continue; }
      if (menu.length) { if (!lines[i] || /^\s{3,}\S/.test(raw[i])) continue; break; } // blank / indented description lines inside the menu
    }
    if (menu.length >= 2 && menu.some(o => o.current) && menu.every((o, i) => !i || nextKey(menu[i - 1].key, o.key))) return { kind: 'menu', options: menu };
    // 2) a question in Claude's own text: a numbered or lettered list at the END of its last message (just above the input box)
    let end = lines.length - 1;
    for (let i = lines.length - 1; i > 0; i--) if (/^[❯>]/.test(lines[i]) && /^[─━▔-]{10,}/.test(lines[i - 1])) { end = i - 2; break; } // the input box: ──── / ❯ prompt
    const list = [];
    for (let i = end, gap = 0; i >= 0 && i > end - 30; i--) {
      const m = lines[i].replace(/^[•●⏺\-*]\s*/, '').match(/^\**\(?([0-9]{1,2}|[A-Ha-h])[.):]\)?\**\s+(.{2,160})$/);
      if (m) { list.unshift({ key: m[1], text: tidy(m[2]) }); gap = 0; continue; }
      if (!list.length) { if (lines[i] && ++gap > 6) break; continue; }       // the list must be near the end of the message
      if (/^\s{3,}\S/.test(raw[i]) && !/^\s{3,}\S/.test(raw[i + 1] ?? '')) continue; // (a wrapped item line)
      if (!lines[i]) continue;
      break;
    }
    if (list.length >= 2 && list.every((o, i) => !i || nextKey(list[i - 1].key, o.key)) && /^(1|a)$/i.test(list[0].key)) return { kind: 'text', options: list };
    return null;
  }
  function renderChoices() {
    if (!term) return;
    const c = cur ? findChoices() : null, sig = c ? c.kind + c.options.map(o => o.key + o.text).join('|') : '';
    if (sig === lastChoices) return; lastChoices = sig; setState();
    const isOwn = o => /^(something else|other)\b|type (something|what you want|your own)/i.test(o.text); // "type what you want" choices (ours, or Claude Code's own "Type something.")
    $('#termOptions').innerHTML = c ? `<span class="muted">Answer:</span>` + c.options.filter(o => c.kind === 'menu' || !isOwn(o)).map(o => `<button data-answer="${esc(o.key)}" data-kind="${c.kind}" title="${esc(o.text)}\nClick = ${c.kind === 'menu' ? 'pick it' : 'send “' + esc(o.key) + '” to Claude'}">${esc(o.key)}. ${esc(o.text.length > 48 ? o.text.slice(0, 46) + '…' : o.text)}</button>`).join('')
      : '<span class="muted" title="When Claude shows a menu or asks with 1. 2. 3. / A) B) C), the choices appear here as buttons.">Choices Claude offers show up here as buttons</span>';
  }
  const queueScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(renderChoices, 120); lastOut = performance.now(); setState(); };
  // ---- status chip: working (output is flowing) / waiting for an answer (choices on screen) / your turn
  let lastOut = 0, stateTimer = 0, prevState = 'idle', busySince = 0;
  function setState() {
    clearTimeout(stateTimer);
    const el = $('#termState'); if (!el) return;
    const busy = cur && performance.now() - lastOut < 1500, asking = cur && !!lastChoices;
    const [cls, text] = !cur ? ['idle', curKind ? 'Starting…' : 'Not running'] : asking ? ['ask', 'Waiting for your answer'] : busy ? ['busy', curKind === 'signin' ? 'Signing in…' : 'Working…'] : ['ready', 'Your turn'];
    el.className = 'term-state ' + cls; el.textContent = text;
    if (cls === 'busy' && prevState !== 'busy') busySince = performance.now();
    if (prevState === 'busy' && (cls === 'ready' || cls === 'ask') && curKind === 'chat' && performance.now() - busySince > 4000 && (away() || panel.hidden)) // finished a real piece of work while you were elsewhere
      notify(cls === 'ask' ? `${A().name} is asking you something` : `${A().name} is done`, cls === 'ask' ? 'It is waiting for your answer in the editor’s AI panel.' : 'Your turn: it finished and is waiting in the editor’s AI panel.', () => open());
    prevState = cls;
    if (busy) stateTimer = setTimeout(setState, 1600);
  }
  // ---- the message box: Enter sends (as one paste, so several lines stay one message), Shift+Enter = new line
  const input = $('#termInput');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
  function send() {
    const text = input.value.replace(/\s+$/, ''); if (!text) { if (cur) T.write(cur, '\r'); return; }
    if (!cur) { status(`${A().name} is not running: press Enter in the conversation, or ▾ > Open ${A().program}`); return; }
    const ESC = String.fromCharCode(27);
    T.write(cur, text.includes('\n') ? ESC + '[200~' + text + ESC + '[201~' : text);
    setTimeout(() => T.write(cur, '\r'), 60);
    input.value = ''; grow();
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); toggle(false); }
    else if (e.key === 'Escape' && !input.value && cur) { T.write(cur, String.fromCharCode(27)); } // Esc in an empty box = Esc for Claude (stop / cancel)
  });
  $('#termSend').addEventListener('click', () => { send(); input.focus(); });
  bar.addEventListener('click', e => {
    const a = e.target.closest('[data-answer]'), k = e.target.closest('[data-key]');
    if (a && cur) { T.write(cur, a.dataset.kind === 'menu' ? a.dataset.answer : a.dataset.answer + '\r'); }
    if (k && cur) T.write(cur, { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t' }[k.dataset.key]);
    term?.focus();
  });
  if (T) {
    T.onData((id, d) => { if (id === cur) { term?.write(d); queueScan(); } });
    T.onExit((id, code) => {
      if (id !== cur) return;
      cur = null; queueScan();
      const was = curKind; curKind = null;
      if (was === 'signin' || was === 'signout') { refreshAuth().then(() => { term.write(`\r\n\x1b[2m${auth?.loggedIn ? 'Signed in ' + authText() : 'Not signed in'} — press Enter to start ${A().program}.\x1b[0m\r\n`); }); }
      else term.write(`\r\n\x1b[2m${A().program} ended${code ? ' (code ' + code + ')' : ''} — press Enter to start a new conversation.\x1b[0m\r\n`);
    });
  }

  // ---- AI assistant plugins (main.js loads them; Claude Code is the built-in one): everything assistant-specific comes from here
  let agents = [], agentId = prefs.agent || 'claude-code';
  const A = () => agents.find(a => a.id === agentId) || agents[0] || { id: 'claude-code', name: 'Claude', program: 'Claude Code', icon: '🤖', signIn: [], signOut: null };
  /** The toolbar button, the panel header and the ▾ menu show the picked assistant; the menu lists every plugin when there are several. */
  function renderAgent() {
    const a = A();
    $('#btnClaude').textContent = `${a.icon} ${a.name}`;
    $('#btnClaude').title = `Open or close the ${a.name} panel (Ctrl+\`): chat with ${a.program} inside the editor. It works on your models in its own tab. Pressed in = open.`;
    const head = $('.term-head b'); if (head) head.textContent = a.name;
    const av = $('.term-avatar'); if (av) av.textContent = a.icon;
    const items = $('#agentItems'); if (!items) return;
    items.innerHTML = a.signIn.map(x => `<button data-signin="${esc(x.id)}" title="${esc(x.tip)}">${esc(x.label)}</button>`).join('')
      + (a.signOut ? '<button data-claude="signout" title="Sign this assistant out on this computer.">Sign out</button>' : '')
      // "AI assistant": always there; opens the list of assistants (one per plugin) + Add another assistant…
      + `<hr><button data-claude="pick" class="menu-sub" title="Swap the AI assistant this panel uses. Each one is a plugin; Claude Code is built in.">🔀 AI assistant: ${esc(a.icon)} ${esc(a.name)} <span class="muted">${pickerOpen ? '▾' : '▸'}</span></button>`
      + (pickerOpen ? '<div class="menu-list">' + agents.map(x => `<button data-agent="${esc(x.id)}" title="${esc(x.description)}${x.installed ? '' : ' (not installed on this computer)'}">${x.id === a.id ? '● ' : '○ '}${esc(x.icon)} ${esc(x.name)}${x.builtIn ? '' : ' <span class="muted">(plugin)</span>'}${x.installed ? '' : ' <span class="muted">· not installed</span>'}</button>`).join('')
        + '<button data-claude="addAgent" title="Opens your plugins folder: drop in a .json file describing another command-line AI assistant (the guide is in that folder), then it shows up in this list.">➕ Add another assistant…</button></div>' : '');
  }
  let pickerOpen = false;
  async function loadAgents() { if (!T) { renderAgent(); return; } try { agents = await T.agents(); } catch { agents = []; } if (!agents.some(a => a.id === agentId)) agentId = agents[0]?.id || 'claude-code'; renderAgent(); }
  function useAgent(id) {
    if (id === agentId) return;
    if (cur && curKind === 'chat' && !confirm(`Switch to ${agents.find(a => a.id === id)?.name}? The conversation that is running now is closed.`)) return;
    if (cur) { T.kill(cur); cur = null; }
    agentId = id; prefs.agent = id; settings.set('terminal', prefs); renderAgent(); refreshAuth();
    status(`AI assistant: ${A().name}`);
  }
  function authText() {
    if (!auth) return '';
    if (!auth.installed) return `${A().program} is not installed`;
    if (auth.loggedIn === null) return `${A().program} is ready`;
    if (!auth.loggedIn) return 'Not signed in';
    return auth.method ? `with ${auth.method}` : ''; // (no email on screen: people record the editor)
  }
  async function refreshAuth() {
    if (!T) { note.textContent = 'The AI panel works in the desktop app.'; return null; }
    note.textContent = 'Checking sign-in…';
    try { auth = await T.status(agentId); } catch (e) { auth = { installed: false, loggedIn: false }; }
    note.textContent = auth.loggedIn ? ('Signed in ' + authText()).trim() : authText();
    $('#btnClaude').classList.toggle('on', !!auth.loggedIn);
    return auth;
  }

  /** Start the picked assistant (kind 'chat' | 'signin' | 'signout'; the command line comes from its plugin, in main.js). One at a time. */
  async function run(kind, signInId, intro) {
    if (!T) return status('The AI panel works in the desktop app (SimpleGLBEditor.exe), not in a browser');
    const info = await T.info(agentId);
    open();
    ensureTerm();
    if (!info.installed) {
      const ins = info.install || {};
      term.write(`\r\n\x1b[33m${info.program} is not installed on this computer.\x1b[0m\r\n` + (ins.command ? `Install it${ins.shell ? ' from ' + ins.shell : ''} with:\r\n\r\n    ${ins.command}\r\n\r\n` : '') + (ins.url ? `More: ${ins.url}\r\n` : '') + 'then press Enter here (or reopen the editor).\r\n');
      return;
    }
    if (cur) { if (curKind === 'chat' && kind !== 'chat' && !confirm(`Stop the ${info.name} conversation that is running in the terminal?`)) return; T.kill(cur); cur = null; }
    starting = true;
    try {
      if (intro) term.write(`\r\n\x1b[36m${intro}\x1b[0m\r\n`);
      fit.fit();
      cur = await T.start({ agent: agentId, kind, signInId, cwd: folder(), cols: term.cols, rows: term.rows });
      curKind = kind;
      $('#termInput').focus();
    } catch (e) { term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); }
    finally { starting = false; }
  }
  // (the plugin's chat command carries its panel note: choices as a numbered list the answer bar can read)
  const startClaude = () => run('chat', null, null);
  const signIn = id => { const x = A().signIn.find(s2 => s2.id === id); run('signin', id, x?.intro || `${x?.label || 'Signing in'}: your browser opens; finish there.`); };
  const signOut = () => { const c = A().signOut?.confirm || `Sign ${A().program} out on this computer?`; if (confirm(c)) run('signout', null, 'Signing out…'); };

  function open() {
    if (!panel.hidden) return;
    panel.hidden = false; onShow?.(); applyMode();
    requestAnimationFrame(() => { try { fit?.fit(); } catch {} term?.focus(); });
  }
  function toggle(on = panel.hidden) {
    if (on) { open(); if (!cur && T) { ensureTerm(); if (!term.buffer.active.length || term.buffer.active.length <= 1) startClaude(); } }
    else { panel.hidden = true; onHide?.(); applyMode(); document.activeElement?.blur?.(); }
  }

  // resize: drag the bottom edge (drop-down) or the left edge (docked right)
  $('#termGrip').addEventListener('pointerdown', e => {
    e.preventDefault(); const top = panel.getBoundingClientRect().top, grip = e.currentTarget; grip.setPointerCapture(e.pointerId);
    const move = ev => { prefs.height = Math.max(15, Math.min(90, (ev.clientY - top) / innerHeight * 100)); panel.style.setProperty('--term-h', prefs.height + 'vh'); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); settings.set('terminal', prefs); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  $('#termGripSide').addEventListener('pointerdown', e => {
    e.preventDefault(); const grip = e.currentTarget; grip.setPointerCapture(e.pointerId);
    const move = ev => { prefs.width = Math.round(Math.max(320, Math.min(innerWidth * 0.7, innerWidth - ev.clientX))); document.documentElement.style.setProperty('--term-w', prefs.width + 'px'); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); settings.set('terminal', prefs); window.dispatchEvent(new Event('panels-changed')); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  $('#termMode').addEventListener('click', () => { prefs.mode = prefs.mode === 'side' ? 'drop' : 'side'; settings.set('terminal', prefs); applyMode(); term?.focus(); });
  applyMode();

  // the toolbar menu
  $('#btnClaude').addEventListener('click', e => { e.stopPropagation(); menu.hidden = true; toggle(); });
  $('#btnClaudeMenu').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) refreshAuth(); });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('#claudeDropdown')) menu.hidden = true; }, true);
  menu.addEventListener('click', e => {
    const si = e.target.closest('[data-signin]'), ag = e.target.closest('[data-agent]'), b = e.target.closest('[data-claude]');
    if (si) { menu.hidden = true; return signIn(si.dataset.signin); }
    if (ag) { menu.hidden = true; return useAgent(ag.dataset.agent); }
    if (!b) return;
    if (b.dataset.claude === 'pick') { pickerOpen = !pickerOpen; renderAgent(); if (pickerOpen) loadAgents(); return; } // (the menu stays open: the list shows at once, then is re-read from the plugin folders)
    menu.hidden = true;
    if (b.dataset.claude === 'addAgent') { T?.openAgentsFolder().then(dir => status(`Plugins folder opened (${dir.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')}): drop in a .json file for another assistant (see README.md there), then pick it under AI assistant`)); return; }
    ({ open: () => toggle(true), new: () => newConversation(), signout: signOut }[b.dataset.claude])?.();
  });
  $('#termHide').addEventListener('click', () => toggle(false));
  loadAgents();
  $('#termNew').addEventListener('click', () => newConversation());

  // ---- where Claude works: asked on every New conversation (last folder picked, so Enter just goes); recent folders kept
  const lib = () => workFolder() || '';
  const folder = () => prefs.folder || lib();
  const nameOf = p => { const l = lib(); if (l && p.replace(/[\\/]+$/, '').toLowerCase() === l.replace(/[\\/]+$/, '').toLowerCase()) return 'Library'; return p.split(/[\\/]/).filter(Boolean).pop() || p; };
  const short = p => String(p || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~'); // no Windows user name on screen (people record the editor)
  function showFolder() { const f = folder(); const el = $('#termFolder'); if (el) { el.textContent = f ? nameOf(f) : '…'; el.title = short(f); } }
  function remember(p) { prefs.folder = p; prefs.folders = [p, ...prefs.folders.filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, 6); settings.set('terminal', prefs); showFolder(); }
  let wsPick = null;
  function renderWs() {
    const l = lib(), list = [...new Set([folder(), ...prefs.folders, l].filter(Boolean))];
    $('#wsList').innerHTML = list.map(p => `<button data-ws="${esc(p)}" class="${p === wsPick ? 'on' : ''}"><b>${p === l ? '📚 ' : '📁 '}${esc(nameOf(p))}</b><small>${esc(short(p))}</small></button>`).join('');
  }
  /** "Where should Claude work?" — resolves to a folder, or null when cancelled. */
  function askFolder() {
    return new Promise(resolve => {
      const box = $('#termWs'); wsPick = folder(); renderWs(); box.hidden = false; $('#wsStart').focus();
      const done = v => { box.hidden = true; box.onclick = box.onkeydown = null; resolve(v); };
      box.onclick = async e => {
        const b = e.target.closest('[data-ws]'); if (b) { wsPick = b.dataset.ws; renderWs(); if (e.detail === 2) done(wsPick); return; } // double-click = start there
        if (e.target.id === 'wsPick') { const p = await T.pickFolder(wsPick || folder()); if (p) { wsPick = p; if (!prefs.folders.includes(p)) prefs.folders.unshift(p); renderWs(); } return; }
        if (e.target.id === 'wsCancel' || e.target === box) return done(null);
        if (e.target.id === 'wsStart') return done(wsPick);
      };
      box.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(wsPick); } if (e.key === 'Escape') done(null); };
    });
  }
  async function newConversation() {
    if (!T) return status('The Claude terminal works in the desktop app');
    open(); ensureTerm();
    if (cur && curKind === 'chat' && !confirm('Start a new conversation? The one running now is closed.')) return;
    const p = await askFolder(); if (!p) return;
    if (!(await T.folderExists(p))) { status('That folder is gone: ' + p); prefs.folders = prefs.folders.filter(x => x !== p); settings.set('terminal', prefs); return; }
    remember(p);
    if (cur) { T.kill(cur); cur = null; }
    term.write(`\r\n\x1b[36mNew conversation in ${nameOf(p)} (${short(p)})\x1b[0m\r\n`);
    startClaude();
  }
  setTimeout(showFolder, 1500); // (the Library path arrives a moment after start)
  if (!T) $('#btnClaude').title += ' (desktop app only)';

  return { agents: () => agents, agent: () => A(), useAgent, newConversation, folder, get _term() { ensureTerm(); return term; }, _findChoices: () => term && findChoices(), _write: d => new Promise(r => { ensureTerm(); term.write(d, r); }), toggle, open, startClaude, signIn, signOut, refreshAuth, get running() { return !!cur; } };
}
