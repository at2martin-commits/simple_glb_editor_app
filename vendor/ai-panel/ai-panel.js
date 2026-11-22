// The shared AI panel (github.com/Marty-s-Stuff/ai-panel): a drop-down / docked terminal (xterm.js, classic scripts in
// xterm/) running a command-line AI assistant inside the app, plus the "🤖 <assistant> ▾" menu (sign in, sign out, new
// conversation, AI assistant plugins). The process runs in the app's engine (node/aipanel.js for Electron,
// python/aipanel.py for a Python server); `bridge` is the way to it (Electron: the preload's object; a web page:
// bridge-http.js). Only the picked plugin's program (agents/*.json) is ever run.
export const AI_PANEL_VERSION = '1.2.4';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const awayDefault = () => document.hidden || !document.hasFocus();
let lastNote = '';
function notifyDefault(title, body, onClick) {   // a Windows toast while you are looking elsewhere (apps with their own notifications pass `notify`)
  if (typeof Notification === 'undefined' || title + body === lastNote) return;
  lastNote = title + body;
  const go = () => { try { const n = new Notification(title, { body }); n.onclick = () => { window.focus(); onClick?.(); n.close(); }; } catch {} };
  if (Notification.permission === 'granted') go(); else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => p === 'granted' && go());
}

/** Options:
 *  status(text)            the app's status line / toast
 *  settings                {get(key, def), set(key, value)}: the panel keeps its layout, folders and picked assistant under 'terminal'
 *  workFolder()            the app's own work folder (offered first in "Where should it work?")
 *  bridge                  the engine (default window.aiPanelBridge, else window.glbTerm)
 *  appName                 e.g. 'Simple GLB Editor' (used in hints)
 *  workFolderName / Icon   how the app's own folder is shown, e.g. 'Library' / '📚'
 *  below()                 optional: the element the drop-down hangs under (else the app sets --term-top itself)
 *  notify(title, body, onClick), away()   optional: the app's own desktop notifications
 *  onShow, onHide          optional */
export function initTerminal({ status, settings, workFolder, bridge, appName = 'the app', workFolderName, workFolderIcon = '📁', below, notify = notifyDefault, away = awayDefault, onShow, onHide }) {
  const T = bridge || window.aiPanelBridge || window.glbTerm || null; // null in a plain browser page with no engine
  const panel = $('#term'), host = $('#termHost'), menu = $('#claudeMenu'), note = $('#claudeNote');
  let term = null, fit = null, cur = null, curKind = null, auth = null, starting = false;
  const prefs = { height: 46, width: 560, mode: 'drop', folder: null, folders: [], ...settings.get('terminal', {}) }; // mode: 'drop' (over the top) | 'side' (docked right) | 'float' (a window you move)
  prefs.float = { x: 80, y: 90, w: 640, h: 460, ...prefs.float };
  panel.style.setProperty('--term-h', prefs.height + 'vh');
  document.documentElement.style.setProperty('--term-w', prefs.width + 'px');
  const place = () => { const el = below?.(); if (!el) return; const y = Math.round(el.getBoundingClientRect().bottom) + 'px'; document.documentElement.style.setProperty('--term-top', y); document.documentElement.style.setProperty('--term-side-top', y); };
  if (below) addEventListener('resize', place);
  /** Docked right: a full-height column, the app shrinks beside it. Drop-down: over the top, under the app's bars. Float: a window you drag by its title row and resize at its corner. */
  const MODES = { drop: ['side', '◨ Dock right', 'Dock the terminal on the right as a full-height column next to your work (good for a long chat while you work).', '▲ Hide'],
    side: ['float', '⧉ Float', 'Undock the terminal into a window you can drag around (by its title row) and resize (at its bottom-right corner).', '▶ Hide'],
    float: ['drop', '▤ Drop down', 'Show the terminal as a drop-down over the top of the app instead.', '✕ Hide'] };
  function applyMode() {
    if (!MODES[prefs.mode]) prefs.mode = 'drop';
    const side = prefs.mode === 'side', float = prefs.mode === 'float', f = prefs.float;
    panel.classList.toggle('side', side);
    panel.classList.toggle('float', float);
    if (float) { // keep it on screen (the window may have shrunk since)
      f.w = Math.min(f.w, innerWidth - 20); f.h = Math.min(f.h, innerHeight - 20);
      f.x = Math.max(0, Math.min(f.x, innerWidth - f.w)); f.y = Math.max(0, Math.min(f.y, innerHeight - f.h));
    }
    Object.assign(panel.style, float ? { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' } : { left: '', top: '', width: '', height: '' });
    document.body.classList.toggle('termside', side && !panel.hidden);
    $('#btnClaude').classList.toggle('pressed', !panel.hidden); // pressed in while the panel is open
    place();
    window.dispatchEvent(new Event('term-placed'));
    const [, label, tip, hide] = MODES[prefs.mode];
    $('#termMode').textContent = label;
    $('#termMode').title = tip;
    $('#termHide').textContent = hide;
    window.dispatchEvent(new Event('panels-changed')); // the app's views resize
    requestAnimationFrame(() => { try { fit?.fit(); } catch {} });
  }

  /** The terminal's colours, read from the app's theme tokens. */
  const theme = () => {
    const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim() || undefined;
    const light = css.colorScheme === 'light' || document.documentElement.dataset.theme === 'light';
    // light: assistants print "white" for emphasis (Claude Code's title), which would vanish on a light background
    return { background: v('--field'), foreground: v('--text'), cursor: v('--accent'), cursorAccent: v('--field'), selectionBackground: v('--row-sel') || v('--tint2'), brightBlack: v('--muted'),
      ...(light ? { black: v('--text'), white: v('--muted'), brightWhite: v('--text') } : {}) };
  };
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
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; } // copy (else Ctrl+C stops the assistant as usual)
      if (e.ctrlKey && e.key.toLowerCase() === 'v') return false; // the browser pastes (xterm reads the paste event)
      return true;
    });
    term.onData(d => { if (cur) T.write(cur, d); else if (d === '\r' && !starting) startClaude(); }); // Enter after a session ended = start again
    term.onResize(({ cols, rows }) => { if (cur) T.resize(cur, cols, rows); });
    new ResizeObserver(() => { if (!panel.hidden) try { fit.fit(); } catch {} }).observe(host);
    setTimeout(renderChoices);
    return term;
  }
  // ---- answer buttons: assistants ask with numbered menus ("❯ 1. Yes / 2. No") and sometimes with a) b) c) in their
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
    // 1b) a menu without numbers ("❯ Yes, I trust this folder" with the other choices indented to the same column): a click
    // moves the highlight there with the arrow keys, then presses Enter. Such a menu takes the place of the assistant's
    // message box, so it never has the box's ──── border line below it (or right above it, "── History 11/11 ───"):
    // that rules out the message box itself (a wrapped message looks like two choices) and your earlier messages, which
    // Claude Code shows as "❯ /model sonnet" with its answer "⎿ …" indented below.
    const flat = raw.map(l => l.replace(/[│┃]/g, ' ').replace(/\s+$/, '')), border = l => /[─━▔]{10,}/.test(l || '');
    for (let i = flat.length - 1; i >= 0; i--) {
      const m = flat[i].match(/^(\s*)([❯›>])(\s+)(\S.{0,158})$/); if (!m || /^\d{1,2}[.)]\s/.test(m[4])) continue;
      const col = m[1].length + m[2].length + m[3].length, item = l => l.length > col && !l.slice(0, col).trim() && l[col] !== ' ';
      let a = i, z = i; while (a > 0 && item(flat[a - 1])) a--; while (z < flat.length - 1 && item(flat[z + 1])) z++;
      if (border(lines[a - 1]) || lines.slice(z + 1).some(border)) break;
      while (a < i && /[?:]$/.test(flat[a])) a++; // the question above the choices, at the same column (Kiro's "Login now?")
      if (z > a && z - a < 9) return { kind: 'move', options: flat.slice(a, z + 1).map((l, k) => ({ key: String(k + 1), text: tidy(l.slice(col)), current: a + k === i })) };
      break;
    }
    // 2) a question in the assistant's own text: a numbered or lettered list at the END of its last message (just above the input box)
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
    $('#termOptions').innerHTML = c ? `<span class="muted">Answer:</span>` + c.options.filter(o => c.kind !== 'text' || !isOwn(o)).map(o => `<button data-answer="${esc(o.key)}" data-kind="${c.kind}" title="${esc(o.text)}\nClick = ${c.kind !== 'text' ? 'pick it' : 'send “' + esc(o.key) + '” to ' + esc(A().name)}">${c.kind === 'move' ? '' : esc(o.key) + '. '}${esc(o.text.length > 48 ? o.text.slice(0, 46) + '…' : o.text)}</button>`).join('')
      : `<span class="muted" title="When ${esc(A().name)} shows a menu or asks with 1. 2. 3. / A) B) C), the choices appear here as buttons.">Choices ${esc(A().name)} offers show up here as buttons</span>`;
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
      notify(cls === 'ask' ? `${A().name} is asking you something` : `${A().name} is done`, cls === 'ask' ? `It is waiting for your answer in ${appName}'s AI panel.` : `Your turn: it finished and is waiting in ${appName}'s AI panel.`, () => open());
    prevState = cls;
    if (busy) stateTimer = setTimeout(setState, 1600);
  }
  // ---- the message box: Enter sends (as one paste, so several lines stay one message), Shift+Enter = new line
  const input = $('#termInput');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
  const ESC = String.fromCharCode(27);
  const type = text => { T.write(cur, text.includes('\n') ? ESC + '[200~' + text + ESC + '[201~' : text); const id = cur; setTimeout(() => T.write(id, '\r'), 60); };
  function sendBox() {
    const text = input.value.replace(/\s+$/, ''); if (!text) { if (cur) T.write(cur, '\r'); return; }
    if (!cur) { status(`${A().name} is not running: press Enter in the conversation, or ▾ > Open the AI panel`); return; }
    type(text);
    input.value = ''; grow();
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBox(); }
    else if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); toggle(false); }
    else if (e.key === 'Escape' && !input.value && cur) { T.write(cur, ESC); } // Esc in an empty box = Esc for the assistant (stop / cancel)
  });
  $('#termSend').addEventListener('click', () => { sendBox(); input.focus(); });
  bar.addEventListener('click', e => {
    const a = e.target.closest('[data-answer]'), k = e.target.closest('[data-key]');
    if (a && cur && a.dataset.kind === 'move') { // arrows from the highlighted choice to this one, then Enter
      const c = findChoices(), from = c?.kind === 'move' ? c.options.findIndex(o => o.current) : -1, to = +a.dataset.answer - 1;
      if (from >= 0) T.write(cur, (to > from ? ESC + '[B' : ESC + '[A').repeat(Math.abs(to - from)) + '\r');
    } else if (a && cur) { T.write(cur, a.dataset.kind === 'menu' ? a.dataset.answer : a.dataset.answer + '\r'); }
    if (k && cur) T.write(cur, { enter: '\r', esc: ESC, up: ESC + '[A', down: ESC + '[B', tab: '\t' }[k.dataset.key]);
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

  // ---- AI assistant plugins (the engine loads them; Claude Code is the built-in one): everything assistant-specific comes from here
  let agents = [], agentId = prefs.agent || 'claude-code';
  const A = () => agents.find(a => a.id === agentId) || agents[0] || { id: 'claude-code', name: 'Claude', program: 'Claude Code', icon: '🤖', signIn: [], signOut: null };
  /** The menu-line button, the panel header, the texts and the ▾ menu show the picked assistant; the menu lists every plugin. */
  function renderAgent() {
    const a = A();
    $('#btnClaude').textContent = `${a.icon} ${a.name}`;
    $('#btnClaude').title = `Open or close the ${a.name} panel (Ctrl+\`): chat with ${a.program} inside ${appName}. It works in the folder you pick. Pressed in = open.${T ? '' : ' (needs the desktop app)'}`;
    $('#btnClaudeMenu').title = `${a.name} options: sign in, sign out, new conversation, pick the AI assistant.`;
    const head = $('.term-head b'); if (head) head.textContent = a.name;
    const av = $('.term-avatar'); if (av) av.textContent = a.icon;
    document.querySelectorAll('#term .ai-name').forEach(el => { el.textContent = a.name; });
    input.placeholder = `Message ${a.name}…  (Enter sends · Shift+Enter = new line)`;
    $('#termSend').title = `Send to ${a.name} (Enter).`;
    lastChoices = null; renderChoices();
    const items = $('#agentItems'); if (!items) return;
    items.innerHTML = a.signIn.map(x => `<button data-signin="${esc(x.id)}" title="${esc(x.tip)}">${esc(x.label)}</button>`).join('')
      + (a.signOut ? '<button data-claude="signout" title="Sign this assistant out on this computer.">Sign out</button>' : '')
      // "AI assistant": always there; opens the list of assistants (one per plugin) + Add another assistant…
      + `<hr><button data-claude="pick" class="menu-sub" title="Swap the AI assistant this panel uses. Each one is a plugin; Claude Code is built in.">🔀 AI assistant: ${esc(a.icon)} ${esc(a.name)} <span class="muted">${pickerOpen ? '▾' : '▸'}</span></button>`
      + (pickerOpen ? '<div class="menu-list">' + agents.map(x => `<button data-agent="${esc(x.id)}" title="${esc(x.description)}${x.installed ? '' : ' (not installed on this computer)'}">${x.id === a.id ? '● ' : '○ '}${esc(x.icon)} ${esc(x.name)}${x.builtIn ? '' : ' <span class="muted">(plugin)</span>'}${x.installed ? '' : ' <span class="muted">· not installed</span>'}</button>`).join('')
        + '<button data-claude="addAgent" title="Opens your plugins folder: drop in a .json file describing another command-line AI assistant (the guide is in that folder), then it shows up in this list.">➕ Add another assistant…</button></div>' : '')
      + updateItems();
  }
  let pickerOpen = false;

  // ---- panel updates: at start the app's updater asks GitHub for a newer 1.x; you choose Install / Not now / Skip this
  // version. An installed version is used from the next start; "Use the built-in version" goes back.
  let upd = null, updLater = false;
  const offered = () => !!(upd?.latest && !updLater && prefs.skipUpdate !== upd.latest && upd.pending !== upd.latest);
  function updateItems() {
    $('#btnClaudeMenu').classList.toggle('has-update', offered());
    if (!upd) return '';
    const out = [];
    if (offered()) out.push(`<div class="ai-update"><b>⬆ AI panel ${esc(upd.latest)} is available</b> <span class="muted">(this is v${esc(upd.running)})</span>`
      + `<div class="ai-update-btns"><button data-upd="install" class="primary" title="Download it from GitHub now; ${esc(appName)} uses it from its next start.">Install</button><button data-upd="later" title="Ask again next time ${esc(appName)} starts.">Not now</button><button data-upd="skip" title="Don't offer this version again (a later one will be offered).">Skip this version</button></div>`
      + `<a href="${esc(upd.notes)}" target="_blank" rel="noopener">What's new</a></div>`);
    if (upd.pending) out.push(`<div class="menu-note" title="The panel can't swap itself while ${esc(appName)} runs.">${upd.pending === 'built-in' ? 'Back to the built-in AI panel' : 'AI panel ' + esc(upd.pending) + ' is installed'}: restart ${esc(appName)} to use it.</div>`);
    if (upd.active && upd.pending !== 'built-in') out.push(`<button data-upd="builtin" title="If the update misbehaves: go back to the AI panel ${esc(appName)} was built with (v${esc(upd.builtIn)}), from its next start.">↩ Use the built-in AI panel (v${esc(upd.builtIn)})</button>`);
    out.push(`<div class="menu-note">AI panel v${esc(upd.running)}${upd.active ? ' (updated)' : ' (built in)'}</div>`); // which copy runs, to check an update took
    return '<hr>' + out.join('');
  }
  async function checkUpdate() { if (!T?.update) return; try { upd = await T.update('check'); } catch { upd = null; } renderAgent(); }
  async function updateAction(what) {
    if (what === 'later') { updLater = true; renderAgent(); return; }
    if (what === 'skip') { prefs.skipUpdate = upd.latest; settings.set('terminal', prefs); renderAgent(); return; }
    if (what === 'builtin' && !confirm(`Go back to the AI panel ${appName} was built with (v${upd.builtIn})? It is used from the next start.`)) return;
    menu.hidden = true;
    status(what === 'install' ? `Downloading AI panel ${upd.latest}…` : 'Going back to the built-in AI panel…');
    try { const r = await T.update(what, upd.latest); upd.pending = r.pending; status(r.pending ? `Done: restart ${appName} to use ${r.pending === 'built-in' ? 'the built-in AI panel' : 'AI panel ' + r.pending}` : 'Nothing to change'); if (r.pending) askRestart(r.pending); }
    catch (e) { status('AI panel update failed: ' + e.message); }
    renderAgent();
  }
  /** After an install: "Restart now" (the app restarts itself, if it can) or "Later" (it's used from the next start anyway). */
  function askRestart(pending) {
    document.getElementById('aiRestart')?.remove();
    const can = !!upd.canRestart, chat = cur && curKind === 'chat', box = document.createElement('div');
    const what = pending === 'built-in' ? `to go back to the built-in AI panel (v${esc(upd.builtIn)})` : 'to use the latest terminal update';
    box.id = 'aiRestart';
    box.innerHTML = `<div class="ai-restart-box" role="dialog" aria-modal="true" aria-labelledby="aiRestartTitle"><h3 id="aiRestartTitle">⬆ ${pending === 'built-in' ? 'Back to the built-in AI panel' : 'AI panel ' + esc(pending) + ' is installed'}</h3>`
      + `<p>Restart ${esc(appName)} ${what}.${can && chat ? ' The conversation running in the AI panel will be closed.' : ''}</p>`
      + (can ? '' : `<p class="muted">Close ${esc(appName)} and open it again.</p>`)
      + `<div class="ws-btns"><span class="grow"></span>${can ? '<button data-r="later" title="It is used the next time you open ' + esc(appName) + '.">Later</button><button data-r="now" class="primary">Restart now</button>' : '<button data-r="later" class="primary">OK</button>'}</div></div>`;
    document.body.appendChild(box); box.querySelector('.primary').focus();
    box.onclick = async e => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      if (b.dataset.r === 'now') { b.disabled = true; status(`Restarting ${appName}…`); try { await T.update('restart'); return; } catch (err) { status('Restart failed: ' + err.message + ` (close ${appName} and open it again)`); } }
      box.remove();
    };
    box.onkeydown = e => { if (e.key === 'Escape') box.remove(); };
  }
  async function loadAgents() { if (!T) { renderAgent(); return; } try { agents = await T.agents(); } catch { agents = []; } if (!agents.some(a => a.id === agentId)) agentId = agents[0]?.id || 'claude-code'; renderAgent(); }
  function useAgent(id) {
    if (id === agentId) return;
    if (cur && curKind === 'chat' && !confirm(`Switch to ${agents.find(a => a.id === id)?.name}? The conversation that is running now is closed.`)) return;
    if (cur) { T.kill(cur); cur = null; }
    agentId = id; prefs.agent = id; settings.set('terminal', prefs); renderAgent(); refreshAuth();
    status(`AI assistant: ${A().name}`);
    if (!panel.hidden && !A().installed) run('chat'); // say at once how to install it, not only on the next start
  }
  function authText() {
    if (!auth) return '';
    if (!auth.installed) return `${A().program} is not installed`;
    if (auth.loggedIn === null) return `${A().program} is ready`;
    if (!auth.loggedIn) return 'Not signed in';
    return auth.method ? `with ${auth.method}` : ''; // (no email on screen: people record their screens)
  }
  async function refreshAuth() {
    if (!T) { note.textContent = 'The AI panel works in the desktop app.'; return null; }
    note.textContent = 'Checking sign-in…';
    try { auth = await T.status(agentId); } catch (e) { auth = { installed: false, loggedIn: false }; }
    note.textContent = auth.loggedIn ? ('Signed in ' + authText()).trim() : authText();
    $('#btnClaude').classList.toggle('on', !!auth.loggedIn);
    return auth;
  }

  /** Start the picked assistant (kind 'chat' | 'signin' | 'signout'; the command line comes from its plugin, in the engine). One at a time. */
  async function run(kind, signInId, intro) {
    if (!T) return status(`The AI panel needs ${appName}'s desktop app`);
    const info = await T.info(agentId);
    open();
    ensureTerm();
    if (!info.installed) {
      const ins = info.install || {};
      term.write(`\r\n\x1b[33m${info.program} is not installed on this computer.\x1b[0m\r\n` + (ins.command ? `Install it${ins.shell ? ' from ' + ins.shell : ''} with:\r\n\r\n    ${ins.command}\r\n\r\n` : '') + (ins.url ? `More: ${ins.url}\r\n` : '') + `then press Enter here (or reopen ${appName}).\r\n`);
      return;
    }
    if (cur) { if (curKind === 'chat' && kind !== 'chat' && !confirm(`Stop the ${info.name} conversation that is running in the terminal?`)) return; T.kill(cur); cur = null; }
    starting = true;
    try {
      if (intro) term.write(`\r\n\x1b[36m${intro}\x1b[0m\r\n`);
      fit.fit();
      cur = await T.start({ agent: agentId, kind, signInId, cwd: folder(), cols: term.cols, rows: term.rows });
      curKind = kind;
      input.focus();
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
    if (on) { open(); if (!cur && T && !term) { ensureTerm(); startClaude(); } } // the first open starts the assistant (or says how to install it)
    else { panel.hidden = true; onHide?.(); applyMode(); document.activeElement?.blur?.(); }
  }

  // resize: drag the bottom edge (drop-down) or the left edge (docked right)
  const gripDrag = (e, move, done) => {
    e.preventDefault(); const grip = e.currentTarget; grip.setPointerCapture(e.pointerId);
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); settings.set('terminal', prefs); done?.(); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  };
  $('#termGrip').addEventListener('pointerdown', e => {
    const top = panel.getBoundingClientRect().top;
    gripDrag(e, ev => { prefs.height = Math.max(15, Math.min(90, (ev.clientY - top) / innerHeight * 100)); panel.style.setProperty('--term-h', prefs.height + 'vh'); });
  });
  $('#termGripSide').addEventListener('pointerdown', e => gripDrag(e,
    ev => { prefs.width = Math.round(Math.max(320, Math.min(innerWidth * 0.7, innerWidth - ev.clientX))); document.documentElement.style.setProperty('--term-w', prefs.width + 'px'); },
    () => window.dispatchEvent(new Event('panels-changed'))));
  $('#termMode').addEventListener('click', () => { prefs.mode = MODES[prefs.mode][0]; settings.set('terminal', prefs); applyMode(); term?.focus(); });
  // float: drag the title row to move it; the browser's own corner grip resizes it (CSS resize), remembered when you let go
  $('.term-head').addEventListener('pointerdown', e => {
    if (prefs.mode !== 'float' || e.button || e.target.closest('button')) return;
    const f = prefs.float, dx = e.clientX - f.x, dy = e.clientY - f.y;
    gripDrag(e, ev => { f.x = Math.max(0, Math.min(ev.clientX - dx, innerWidth - 60)); f.y = Math.max(0, Math.min(ev.clientY - dy, innerHeight - 40)); panel.style.left = f.x + 'px'; panel.style.top = f.y + 'px'; });
  });
  let sizeTimer = 0;
  new ResizeObserver(() => {
    if (prefs.mode !== 'float' || panel.hidden) return;
    const f = prefs.float, w = panel.offsetWidth, h = panel.offsetHeight;
    if (w !== f.w || h !== f.h) { f.w = w; f.h = h; clearTimeout(sizeTimer); sizeTimer = setTimeout(() => settings.set('terminal', prefs), 400); }
  }).observe(panel);
  addEventListener('resize', () => { if (prefs.mode === 'float' && !panel.hidden) applyMode(); });
  applyMode();

  // the menu-line button and its ▾ menu
  $('#btnClaude').addEventListener('click', e => { e.stopPropagation(); menu.hidden = true; toggle(); });
  $('#btnClaudeMenu').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) refreshAuth(); });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('#claudeDropdown')) menu.hidden = true; }, true);
  menu.addEventListener('click', e => {
    const si = e.target.closest('[data-signin]'), ag = e.target.closest('[data-agent]'), b = e.target.closest('[data-claude]');
    if (si) { menu.hidden = true; return signIn(si.dataset.signin); }
    if (ag) { menu.hidden = true; return useAgent(ag.dataset.agent); }
    const up = e.target.closest('[data-upd]'); if (up) return updateAction(up.dataset.upd);
    if (!b) return;
    if (b.dataset.claude === 'pick') { pickerOpen = !pickerOpen; renderAgent(); if (pickerOpen) loadAgents(); return; } // (the menu stays open: the list shows at once, then is re-read from the plugin folders)
    menu.hidden = true;
    if (b.dataset.claude === 'addAgent') { T?.openAgentsFolder().then(dir => status(`Plugins folder opened (${dir.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')}): drop in a .json file for another assistant (see README.md there), then pick it under AI assistant`)); return; }
    ({ open: () => toggle(true), new: () => newConversation(), signout: signOut }[b.dataset.claude])?.();
  });
  $('#termHide').addEventListener('click', () => toggle(false));
  loadAgents();
  checkUpdate();
  $('#termNew').addEventListener('click', () => newConversation());

  // ---- where the assistant works: asked on every New conversation (last folder picked, so Enter just goes); recent folders kept
  const lib = () => workFolder?.() || '';
  const folder = () => prefs.folder || lib();
  const nameOf = p => { const l = lib(); if (l && workFolderName && p.replace(/[\\/]+$/, '').toLowerCase() === l.replace(/[\\/]+$/, '').toLowerCase()) return workFolderName; return p.split(/[\\/]/).filter(Boolean).pop() || p; };
  const short = p => String(p || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~'); // no Windows user name on screen (people record their screens)
  function showFolder() { const f = folder(); const el = $('#termFolder'); if (el) { el.textContent = f ? nameOf(f) : '…'; el.title = short(f); } }
  function remember(p) { prefs.folder = p; prefs.folders = [p, ...prefs.folders.filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, 6); settings.set('terminal', prefs); showFolder(); }
  let wsPick = null;
  function renderWs() {
    const l = lib(), list = [...new Set([folder(), ...prefs.folders, l].filter(Boolean))];
    $('#wsList').innerHTML = list.map(p => `<button data-ws="${esc(p)}" class="${p === wsPick ? 'on' : ''}"><b>${p === l ? workFolderIcon + ' ' : '📁 '}${esc(nameOf(p))}</b><small>${esc(short(p))}</small></button>`).join('');
  }
  /** "Where should it work?" — resolves to a folder, or null when cancelled. */
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
    if (!T) return status(`The AI panel needs ${appName}'s desktop app`);
    open(); ensureTerm();
    if (cur && curKind === 'chat' && !confirm('Start a new conversation? The one running now is closed.')) return;
    const p = await askFolder(); if (!p) return;
    if (!(await T.folderExists(p))) { status('That folder is gone: ' + p); prefs.folders = prefs.folders.filter(x => x !== p); settings.set('terminal', prefs); return; }
    remember(p);
    if (cur) { T.kill(cur); cur = null; }
    term.write(`\r\n\x1b[36mNew conversation in ${nameOf(p)} (${short(p)})\x1b[0m\r\n`);
    startClaude();
  }
  setTimeout(showFolder, 1500); // (the app's work folder may arrive a moment after start)

  /** Start that assistant in that folder, then type `message` once it waits for input
   *  (after any start-up question on screen, such as "Do you trust this folder?", has been answered). (Hollow Editor's "Set it up with your AI agent".) */
  async function startIn(dir, id, message) {
    if (id && id !== agentId) useAgent(id);
    if (cur && curKind === 'chat' && !confirm('Start a new conversation? The one running now is closed.')) return;
    if (cur) { T.kill(cur); cur = null; }
    remember(dir);
    await run('chat');
    if (!message || !cur) return;
    const id0 = cur;
    for (let i = 0; i < 600 && cur === id0; i++) {   // up to 5 minutes for a start-up question to be answered
      await new Promise(r => setTimeout(r, 500));
      if (lastOut && !lastChoices && performance.now() - lastOut > 1500) { type(message); return; }
    }
  }
  /** Into the running conversation when it works in `dir`, else a new one there. (Hollow Editor's "Send to your AI agent" buttons.) */
  function send(dir, message) {
    open();
    if (cur && curKind === 'chat' && folder().toLowerCase() === String(dir).toLowerCase()) { type(message); return; }
    return startIn(dir, null, message);
  }
  return { version: AI_PANEL_VERSION, checkUpdate, send, startIn, loadAgents: async () => { await loadAgents(); return agents; }, agents: () => agents, agent: () => A(), useAgent, newConversation, folder, get _term() { ensureTerm(); return term; }, _findChoices: () => term && findChoices(), _write: d => new Promise(r => { ensureTerm(); term.write(d, r); }), toggle, open, startClaude, signIn, signOut, refreshAuth, get running() { return !!cur; } };
}
