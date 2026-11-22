// Tabs: several projects open at once. Each tab is a whole Editor (own scene, camera, undo, Build project) with its own
// canvas inside #view; only the picked tab is shown and only it runs its draw loop. The rest of the app talks to
// `tabs.ed` / `tabs.build` — stand-ins that always mean "the editor of the tab you are looking at" — and listens on them
// for 'change' / 'message' / 'time' / 'library' / 'objectChange', which only the picked tab sends on.
import { Editor } from './editor.js';
import { notify, away } from './notify.js';

const EVENTS = ['change', 'message', 'time', 'library'];
/** Tab colours (shown on the tab and as a frame round the 3D view). Claude sessions get the first one no other tab uses. */
export const TAB_COLOURS = { Blue: '#4fc3f7', Purple: '#b388ff', Green: '#81c784', Orange: '#ffb74d', Pink: '#f06292', Teal: '#4db6ac', Red: '#e57373', Yellow: '#ffee58', Grey: '#90a4ae' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Tabs extends EventTarget {
  /** host = #view; setup(editor) prepares a new tab's editor (preferences, paint, Build mode, watch). */
  constructor(host, bar, setup) {
    super();
    this.host = host; this.bar = bar; this.setup = setup; this.list = []; this.active = null; this.nextId = 1;
    this.hub = new EventTarget(); // events of the picked tab only
    const self = this;
    const stand = pick => new Proxy({}, {
      get(_, k) {
        if (k === 'addEventListener' || k === 'removeEventListener') return (...a) => self.hub[k](...a);
        const t = pick(); const v = t?.[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(_, k, v) { pick()[k] = v; return true; },
      has(_, k) { return k in pick(); },
    });
    this.ed = stand(() => (this.forced || this.active)?.ed);
    this.build = stand(() => (this.forced || this.active)?.ed.build);
    this.closedSessions = new Map(); this.sessionCount = 0;
    setInterval(() => { if (this.active?.session) this.renderBanner(); }, 1000);
    setInterval(() => { // a session that worked and then went quiet: tell you, if you are not looking at its tab
      for (const t of this.list) {
        const s = t.session; if (!s || s.inApp || s.takenOver || !s.last || (s.steps || 0) < 3 || s.notifiedFor === s.last || Date.now() - s.last < 20000) continue;
        s.notifiedFor = s.last; s.steps = 0;
        if (away() || this.active !== t) notify('🤖 ' + s.name + ' has stopped', 'No steps for 20 s in “' + this.label(t) + '”: it finished, or it is waiting for you in its own terminal.', () => this.select(t));
      }
    }, 5000);
    bar.addEventListener('click', e => {
      const x = e.target.closest('[data-tabclose]'); if (x) { this.close(this.byId(+x.dataset.tabclose)); return; }
      if (e.target.closest('[data-newtab]')) { this.add(); return; }
      const dot = e.target.closest('[data-tabcolour]'); if (dot && this.showMenu) { const r = dot.getBoundingClientRect(); this.tabMenu(this.byId(+dot.dataset.tabcolour), r.left, r.bottom + 4); return; }
    });
    // pick a tab on mouse DOWN (like browser tabs): busy sessions re-draw the bar many times a second, and a click whose
    // down and up land on two different drawings of the same tab never arrives. No re-draw while a button is held on the bar.
    bar.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('[data-tabclose],[data-newtab],[data-tabcolour]')) { this._barHeld = true; return; }
      const t = e.target.closest('[data-tab]'); if (t) this.select(this.byId(+t.dataset.tab));
      this._barHeld = true;
    });
    addEventListener('pointerup', () => { if (this._barHeld) { this._barHeld = false; if (this._barStale) this.renderBar(); } }, true);
    bar.addEventListener('contextmenu', e => { const el = e.target.closest('[data-tab]'); if (!el || !this.showMenu) return; e.preventDefault(); this.tabMenu(this.byId(+el.dataset.tab), e.clientX, e.clientY); });
    bar.addEventListener('auxclick', e => { const t = e.target.closest('[data-tab]'); if (e.button === 1 && t) { e.preventDefault(); this.close(this.byId(+t.dataset.tab)); } }); // middle-click closes
  }
  /** Two tabs with the same Library file: the second one to save is warned instead of silently overwriting the other's work. */
  guardSaves(t) {
    const e = t.ed, b = e.build, self = this; t.opened = new Map(); this.lastSave ||= new Map();
    const key = rel => String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const check = rel => {
      const last = self.lastSave.get(key(rel));
      if (!last || last.tab === t || !self.list.includes(last.tab) || last.t <= (t.opened.get(key(rel)) || 0)) return;
      const msg = `“${rel}” was saved from the tab “${self.label(last.tab)}” after this tab opened it, so saving here would overwrite those changes.`;
      if (e.viewOnly) throw new Error(msg + ' Save under another name, or ask the user.'); // a Claude session
      if (!confirm(msg + '\n\nSave anyway?')) throw new Error('Not saved');
    };
    const opened = rel => { if (rel) t.opened.set(key(rel), Date.now()); };
    const saved = rel => { if (!rel) return; opened(rel); self.lastSave.set(key(rel), { t: Date.now(), tab: t }); };
    const load = e.load; e.load = async (...a) => { const r = await load.apply(e, a); opened(e.libRel); return r; };
    const save = e.save; e.save = async (name = e.fileName, dir) => {
      const d = dir === undefined ? e._saveDir() : dir;
      check((d ? d + '/' : '') + (/\.glb$/i.test(name) ? name : name + '.glb'));
      const r = await save.call(e, name, dir); saved(e.libRel); return r;
    };
    if (!b) return;
    const bopen = b.open; b.open = async (...a) => { const r = await bopen.apply(b, a); opened(b.libRel); return r; };
    const bsave = b.save; b.save = async (name = b.doc?.name, folder = '') => {
      check((folder ? folder + '/' : '') + String(name || 'model').replace(/\.bbmodel$/i, '') + '.bbmodel');
      const r = await bsave.call(b, name, folder); saved(b.libRel); return r;
    };
  }
  /** Right-click menu of a tab: its colour, close. */
  tabMenu(t, x, y) {
    if (!t) return;
    const cur = this.colourOf(t), items = Object.entries(TAB_COLOURS).map(([n, c]) => ({ label: `${c === cur ? '● ' : '○ '}${n}`, tip: `Colour this tab (and the frame round the view) ${n.toLowerCase()}.`, run: () => this.setColour(t, c), colour: c }));
    items.push({ label: (cur ? '○ ' : '● ') + 'No colour', run: () => this.setColour(t, null) }, '-', { label: t.parent ? 'Close this sub-tab' : 'Close this tab', run: () => this.close(t) });
    this.showMenu(x, y, items);
  }
  byId(id) { return this.list.find(t => t.id === id) || null; }
  all() { return this.list.filter(t => !t.parent).map(t => t.ed); }

  /** A new tab with an empty project. */
  add({ activate = true } = {}) {
    const div = document.createElement('div'); div.className = 'tabview';
    this.host.insertBefore(div, this.host.firstChild);
    const ed = new Editor(div), t = { id: this.nextId++, ed, div };
    for (const type of EVENTS) ed.addEventListener(type, ev => {
      if (this.active?.ed === ed) this.hub.dispatchEvent(ev instanceof CustomEvent ? new CustomEvent(type, { detail: ev.detail }) : new Event(type));
      if (type === 'change' || type === 'library') this.queueBar();
    });
    ed.gizmo.addEventListener('objectChange', () => { if (this.active?.ed === ed) this.hub.dispatchEvent(new Event('objectChange')); });
    this.setup(ed);
    this.guardSaves(t);
    ed.watchInfo = () => ({ key: 'tab' + t.id, label: (t.session && !t.session.takenOver ? '🤖 ' : '') + this.label(t), claude: !!t.session && !t.session.takenOver, active: this.active?.ed === ed });
    this.list.push(t);
    if (activate || !this.active) this.select(t); else { ed.setActive(false); div.classList.add('off'); this.queueBar(); }
    return t;
  }
  select(t) {
    if (!t) return;
    if (this.active && this.active.ed !== t.ed) { this.active.ed.pause?.(); }
    // a project and its sub-tabs share one editor: switching between them swaps only the view (camera, picks, tool, filter)
    const owner = t.ed._viewOwner;
    if (owner && owner !== t && this.list.includes(owner)) owner.view = this.captureView(owner);
    this.active = t;
    for (const x of this.list) { if (x.parent) continue; const on = x.ed === t.ed; x.div.classList.toggle('off', !on); x.ed.setActive(on); }
    if (owner !== t) { t.ed._viewOwner = t; if ((owner && this.list.includes(owner)) || t.parent) try { this.applyView(t); } catch (e) { console.warn(e); } }
    this.applyViewOnly(); this.applyColour();
    this.hub.dispatchEvent(new Event('change'));
    this.dispatchEvent(new Event('select'));
    this.renderBar(); this.save();
  }
  next(step = 1) { if (this.list.length < 2) return; const i = this.list.indexOf(this.active); this.select(this.list[(i + step + this.list.length) % this.list.length]); }
  nth(i) { if (this.list[i]) this.select(this.list[i]); }

  // ---------------- sub-tabs: one Build-mode group of a project on its own (same project, same undo; own camera / picks / tool)
  /** Open a group (id or name) of the picked project in a sub-tab; mode 'context' (rest greyed) or 'alone' (rest hidden). */
  openSub(group, { mode = 'context', from = this.active } = {}) {
    const main = from?.parent || from, e = main?.ed, b = e?.build;
    if (!b?.doc || e.mode !== 'build') throw new Error('Sub-tabs are for Build mode: open the project in Build mode (7) and pick a group');
    const n = b.node(group) || b.node(b.find(group));
    if (!n || n.kind !== 'group') throw new Error('Pick a group (a joint, e.g. an arm) to open it in a sub-tab');
    const there = this.list.find(x => x.parent === main && x.sub.group === n.id);
    if (there) { this.select(there); return there; }
    const t = { id: this.nextId++, ed: e, div: main.div, parent: main, sub: { group: n.id, mode: mode === 'alone' ? 'alone' : 'context' }, view: null };
    let i = this.list.indexOf(main); while (this.list[i + 1]?.parent === main) i++;
    this.list.splice(i + 1, 0, t);
    this.select(t);
    return t;
  }
  setSubMode(t = this.active, mode) { if (!t?.parent) return; t.sub.mode = mode === 'alone' ? 'alone' : 'context'; if (this.active === t) t.ed.build.setIsolate(t.sub.group, t.sub.mode); this.renderBanner(); }
  captureView(t) {
    const e = t.ed, b = e.build;
    return { pos: e.camera.position.toArray(), target: e.orbit.target.toArray(), mode: e.mode, sel: b ? [...b.sel] : [], tool: b?.tool };
  }
  applyView(t) {
    const e = t.ed, b = e.build, v = t.view;
    if (t.parent) { if (e.mode !== 'build') e.setMode('build'); b.setIsolate(b.node(t.sub.group) ? t.sub.group : null, t.sub.mode); }
    else { if (b?.isolate) b.setIsolate(null); if (v?.mode && v.mode !== e.mode) e.setMode(v.mode); }
    if (!v) { if (t.parent) { b.select([]); e.frame(); } return; } // a new sub-tab: its group, centred
    e.camera.position.fromArray(v.pos); e.orbit.target.fromArray(v.target); e.orbit.update();
    if (b && e.mode === 'build') { b.select(v.sel.filter(id => b.node(id))); if (v.tool && v.tool !== b.tool) b.setTool(v.tool); }
  }

  // ---------------- Claude sessions: each works in its own tab, in the background ----------------
  /** The tab of an automation session {id, name?, tab?} (made on its first call). Throws if you took it over or closed it. */
  sessionTab(S) {
    let t = this.list.find(x => !x.parent && x.session?.ids.has(S.id));
    if (S.tab && !(t && (t.session.name === S.tab || this.title(t) === S.tab))) { // the session asked for a tab by name
      if (t) { t.session.ids.delete(S.id); t = null; }
      const named = this.list.find(x => !x.parent && (x.session?.name === S.tab || this.title(x) === S.tab));
      if (named) { t = named; if (!t.session) t.session = { ids: new Set(), name: S.tab, takenOver: false }; t.session.ids.add(S.id); t.session.takenOver = false; this.applyViewOnly(); }
    }
    if (!t && this.closedSessions.has(S.id)) { const name = this.closedSessions.get(S.id); this.closedSessions.delete(S.id); throw new Error(`The user closed your tab “${name}”. Call again to carry on in a new empty tab (glb_start {tab:"name"} to name it).`); }
    if (!t) {
      const reuse = this.hiddenApp && this.list.length === 1 && this.pristine(this.list[0]) && !this.list[0].session; // an editor started just for automation
      t = reuse ? this.list[0] : this.add({ activate: !!S.inApp }); // the in-app Claude's tab opens in front: you are chatting with it
      t.session = { ids: new Set([S.id]), name: S.tab || S.name || 'Claude ' + ++this.sessionCount, takenOver: false };
      const sib = this.list.find(x => x !== t && x.color && x.session?.by?.has(S.id)); // a session's tabs share its colour
      if (!t.color && sib) t.color = sib.color;
      if (!t.color) { const used = new Set(this.list.map(x => x.color)), all = Object.values(TAB_COLOURS).slice(1); t.color = all.find(c => !used.has(c)) || all[this.sessionCount % all.length]; } // its own colour
      this.applyViewOnly();
    }
    (t.session.by ||= new Set()).add(S.id); // every session that worked here (it may close the tab later)
    if (t.session.takenOver) throw new Error(`The user took over the tab “${this.label(t)}”, so you can't change it now. Ask them, or work in another tab: glb_start {tab:"new name"}.`);
    t.session.last = Date.now(); t.session.steps = (t.session.steps || 0) + 1; if (S.inApp) t.session.inApp = true;
    this.queueBar(); if (t === this.active) this.renderBanner();
    return t;
  }
  /** The tabs a session opened or worked in: [{name, current, unsaved, file, takenOver}]. */
  sessionTabs(S) {
    return this.list.filter(x => !x.parent && x.session?.by?.has(S.id)).map(x => ({
      name: x.session.name, current: x.session.ids.has(S.id), unsaved: this.dirty(x), takenOver: !!x.session.takenOver,
      file: x.ed.mode === 'build' ? x.ed.build?.libRel || null : x.ed.libRel || null }));
  }
  /** A session closes its own tabs (names, or 'all'); never asks the user: unsaved tabs are kept unless force. */
  closeSessionTabs(S, names = 'all', force = false) {
    const mine = this.list.filter(x => !x.parent && x.session?.by?.has(S.id)), want = names === 'all' ? null : [].concat(names).map(String);
    const closed = [], kept = [];
    for (const n of want || []) if (!mine.some(x => x.session.name === n || this.title(x) === n)) kept.push({ name: n, why: 'not one of your tabs' });
    for (const x of mine) {
      const name = x.session.name; if (want && !want.includes(name) && !want.includes(this.title(x))) continue;
      if (x.session.takenOver) { kept.push({ name, why: 'the user took it over' }); continue; }
      if (this.dirty(x) && !force) { kept.push({ name, why: 'not saved (save it first, or force:true to drop the changes)' }); continue; }
      const ids = [...x.session.ids]; this.close(x, { force: true }); ids.forEach(id => id === S.id && this.closedSessions.delete(id)); closed.push(name);
    }
    return { closed, kept };
  }
  /** Run fn with the stand-in `editor` / `build` pointing at tab t (menu commands a session runs in its tab). */
  runIn(t, fn) { const prev = this.forced; this.forced = t; try { return fn(); } finally { this.forced = prev; } }
  takeOver(t = this.active, on = true) { if (!t?.session) return; t.session.takenOver = on; this.applyViewOnly(); this.renderBar(); this.save(); }
  /** A session's tab you have not taken over: you can look around, not edit. */
  applyViewOnly() {
    for (const x of this.list) {
      if (x.parent) continue;
      const vo = !!(x.session && !x.session.takenOver);
      x.ed.viewOnly = vo; x.ed.gizmo.enabled = !vo; const tc = x.ed.build?._internals?.tc; if (tc) tc.enabled = !vo;
    }
    document.body.classList.toggle('viewonly', !!this.active?.ed.viewOnly);
    this.renderBanner();
  }
  renderBanner() {
    const el = this.banner; if (!el) return;
    const s = this.active?.session, sub = this.active?.parent ? this.active : null;
    if (sub) {
      const html = `<span>🔎 Only <b>${esc(this.groupName(sub))}</b> of “${esc(this.title(sub.parent))}” — changes go straight into the project (one shared Undo).</span>` +
        `<span class="seg"><button data-submode="context" class="${sub.sub.mode === 'context' ? 'on' : ''}" title="Show the rest of the model greyed (not clickable), so the part still fits.">In context</button><button data-submode="alone" class="${sub.sub.mode === 'alone' ? 'on' : ''}" title="Hide everything else.">Alone</button></span>` +
        `<button data-subback title="Back to the whole model (this sub-tab stays open).">Whole model</button>`;
      el.hidden = false; el.classList.add('sub'); if (html !== this._bannerHtml) { this._bannerHtml = html; el.innerHTML = html; } return;
    }
    el.classList.remove('sub');
    if (!s) { el.hidden = true; this._bannerHtml = ''; return; }
    el.hidden = false;
    const ago = s.last ? Math.round((Date.now() - s.last) / 1000) : null, when = ago == null ? 'not started yet' : ago < 3 ? 'working now' : ago < 90 ? `last step ${ago} s ago` : `last step ${Math.round(ago / 60)} min ago`;
    const html = s.takenOver
      ? `<span>✋ You took over this tab from <b>🤖 ${esc(s.name)}</b>; it can't change it now.</span><button data-takeover="0" title="Let the Claude session work in this tab again (your changes stay).">Give it back</button>`
      : `<span>🤖 <b>${esc(s.name)}</b> is working in this tab (${when}). You can look around; editing is off here.</span><button data-takeover="1" title="Edit this tab yourself. The Claude session is told and stops changing it.">Take over</button>`;
    if (html !== this._bannerHtml) { this._bannerHtml = html; el.innerHTML = html; }
  }
  groupName(t) { return t.ed.build?.node(t.sub.group)?.name || '(removed group)'; }
  colourOf(t) { return (t?.parent || t)?.color || null; }
  setColour(t, c) { t = t?.parent || t; if (!t) return; t.color = c || null; this.renderBar(); this.applyColour(); this.save(); }
  applyColour() { const c = this.colourOf(this.active); document.documentElement.style.setProperty('--tab-color', c || 'transparent'); if (this.banner) this.banner.style.borderColor = c || ''; }
  label(t) { if (t.parent) return this.title(t.parent) + ' › ' + this.groupName(t); return t.session ? t.session.name + (this.pristine(t) ? '' : ' · ' + this.title(t)) : this.title(t); }

  title(t) {
    const e = t.ed, b = e.build;
    if (e.mode === 'build' && b) return (b.libRel ? b.libRel.split('/').pop() : (b.doc?.name || 'build') + '.bbmodel').replace(/\.bbmodel$/i, '');
    if (e.libRel) return e.libRel.split('/').pop().replace(/\.glb$/i, '');
    return this.pristine(t) ? 'New' : e.fileName.replace(/\.glb$/i, '');
  }
  dirty(t) { return !!(t.ed.dirty || t.ed.build?.dirty); }
  /** Nothing loaded, nothing built, nothing to undo: opening a file may reuse this tab. */
  pristine(t) { const e = t.ed; return !e.root.children.length && !e.undoStack.length && !e.libRel && !e.build?.libRel && !Object.keys(e.build?.doc?.nodes || {}).length; }

  /** Close a tab (asks first if it has unsaved changes). The last tab is replaced by an empty one. */
  close(t, { force = false } = {}) {
    if (!t) return false;
    if (t.parent) { // just the view
      const i = this.list.indexOf(t); this.list.splice(i, 1);
      if (t.ed._viewOwner === t) t.ed._viewOwner = null;
      if (this.active === t) { t.ed.build?.setIsolate(null); this.select(t.parent); } else this.renderBar();
      return true;
    }
    if (!force && this.dirty(t) && !confirm(`Close “${this.title(t)}”?\n\nChanges you have not saved are lost.`)) return false;
    this.list = this.list.filter(x => x.parent !== t); // its sub-tabs go with it
    const i = this.list.indexOf(t);
    this.list.splice(i, 1);
    if (t.session) for (const id of t.session.ids) this.closedSessions.set(id, this.label(t));
    t.ed.dispose(); t.div.remove();
    if (!this.list.length) this.add();
    else if (this.active === t) this.select(this.list[Math.min(i, this.list.length - 1)]);
    else this.renderBar();
    this.save();
    return true;
  }

  /** Run fn (which opens something into tabs.ed) in a fresh tab — or in the picked tab if it is still empty. If it fails, the new tab goes away again. */
  async openInNewTab(fn) {
    const prev = this.active, reuse = prev && this.pristine(prev);
    const t = reuse ? prev : this.add();
    try { const r = await fn(t.ed); this.renderBar(); this.save(); return r; }
    catch (e) { if (!reuse) { this.close(t, { force: true }); if (prev && this.list.includes(prev)) this.select(prev); } throw e; }
  }

  queueBar() { if (this._barQueued) return; this._barQueued = true; requestAnimationFrame(() => { this._barQueued = false; this.renderBar(); this.save(); }); }
  renderBar() {
    if (this._barHeld) { this._barStale = true; return; } // (drawn on pointer-up)
    this._barStale = false;
    const html = this.list.map((t, i) => {
      const name = this.label(t), d = this.dirty(t), key = i < 9 ? ` (Ctrl+${i + 1})` : '', s = t.session, busy = s && !s.takenOver && Date.now() - (s.last || 0) < 4000;
      const c = this.colourOf(t);
      return `<div style="${c ? `--c:${c}` : ''}" class="tab${t === this.active ? ' on' : ''}${t.parent ? ' sub' : ''}${s ? ' claude' : ''}${busy ? ' busy' : ''}" data-tab="${t.id}" title="${esc(name)}${d ? ' — not saved' : ''}${key}${s ? (s.takenOver ? '\nA Claude session worked here; you took it over.' : '\nA Claude session works in this tab; you can watch, or Take over to edit.') : ''}\nClick to switch to it; middle-click or ✕ closes it.">` +
        (c && !t.parent ? `<span class="tab-dot" data-tabcolour="${t.id}" title="This tab's colour (also the frame round the view). Click or right-click the tab to change it."></span>` : '') +
        `<span class="tab-name">${s ? (s.takenOver ? '✋ ' : '🤖 ') : ''}${t.ed.mode === 'build' ? '🧱 ' : ''}${esc(name)}</span>${d ? '<span class="tab-dirty" title="Not saved">●</span>' : ''}` +
        `<button class="tab-x" data-tabclose="${t.id}" title="Close this tab (Ctrl+W). Asks first if it is not saved.">✕</button></div>`;
    }).join('') + `<button class="tab-new" data-newtab title="Open a new empty tab (Ctrl+T).">+</button>`;
    if (html !== this._barHtml) { this._barHtml = html; this.bar.innerHTML = html; } // unchanged = leave the elements alone
  }

  /** Remember the tabs that are saved in the library, to reopen them next time. */
  save() {
    if (!this.persist) return;
    const mains = this.list.filter(t => !t.parent); // (sub-tabs are views, not reopened)
    const open = mains.map(t => { const x = t.session && !t.session.takenOver ? null : t.ed.mode === 'build' && t.ed.build?.libRel ? { build: t.ed.build.libRel } : t.ed.libRel ? { glb: t.ed.libRel } : null; if (x && t.color) x.color = t.color; return x; });
    const keep = open.filter(Boolean), act = open[mains.indexOf(this.active?.parent || this.active)];
    const json = JSON.stringify({ open: keep, active: act ? keep.indexOf(act) : -1 });
    if (json !== this._saved) { this._saved = json; this.persist(JSON.parse(json)); }
  }
  /** Reopen remembered tabs (missing files are skipped). */
  async restore(state, open) {
    for (const x of state?.open || []) {
      try {
        if (x.build) await this.openInNewTab(async ed => { ed.setMode('build'); await ed.build.open(x.build); });
        else if (x.glb) await this.openInNewTab(ed => ed.load(x.glb));
        if (x.color) this.setColour(this.active, x.color);
      } catch (e) { console.warn('could not reopen', x, e); }
    }
    if (state?.active >= 0 && this.list[state.active]) this.select(this.list[state.active]);
  }
}
