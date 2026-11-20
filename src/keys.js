// Rebindable keyboard shortcuts (same behaviour as Claudio Editor's "⌨ Keys" window).
// Every action has an id; buttons with data-act="<id>" run it and show its shortcut in their tooltip.
import { settings } from './settings.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Turn a keydown into a combo string such as "Ctrl+Shift+V", "Space" or "?". */
export function comboFromEvent(e) {
  let k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process'].includes(k)) return null;
  if (k === ' ') k = 'Space';
  const isChar = k.length === 1;
  if (isChar) k = k.toUpperCase();
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift is already part of punctuation like "?" or "+", so record it only for letters, digits and named keys
  if (e.shiftKey && (!isChar || /[A-Z0-9]/.test(k))) mods.push('Shift');
  return [...mods, k].join('+');
}
export const prettyCombo = c => c.replace(/Arrow(Left|Right|Up|Down)/, (_, d) => ({ Left: '←', Right: '→', Up: '↑', Down: '↓' }[d]))
  .replace(/Delete/, 'Del').replace(/Escape/, 'Esc').replace(/Backspace/, '⌫');

export class Keymap {
  /** actions: [{ id, label, defaults:[combos], run, group, help }] */
  constructor(actions, status) {
    this.actions = actions; this.byId = new Map(actions.map(a => [a.id, a])); this.status = status;
    this.recording = null;
    const saved = settings.get('keymap', {});
    this.map = new Map(actions.map(a => [a.id, Array.isArray(saved[a.id]) ? saved[a.id].slice() : a.defaults.slice()]));
    this._reindex();
    this._initEditor();
    document.addEventListener('keydown', e => this._onKey(e), true);
    // "hold" actions (e.g. Snap & merge): on while the key is down, off when it is released
    const baseKey = e => (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    document.addEventListener('keyup', e => { if (this.held && baseKey(e) === this.held.key) this._release(); }, true);
    window.addEventListener('blur', () => this._release());
    this._baseKey = baseKey;
  }
  run(id) { const a = this.byId.get(id); if (a) return a.run(); }
  _release() { if (!this.held) return; const a = this.byId.get(this.held.id); this.held = null; a?.release?.(); }
  combos(id) { return this.map.get(id) || []; }
  _save() {
    settings.set('keymap', Object.fromEntries(this.map));
    this._reindex();
  }
  _reindex() {
    this.index = new Map();
    for (const [id, combos] of this.map) for (const c of combos) this.index.set(c, id);
    this.decorate(document);
    const hk = $('#helpKeys');
    if (hk) hk.innerHTML = this.actions.filter(a => this.combos(a.id).length)
      .map(a => `<li>${this.combos(a.id).map(c => `<kbd>${esc(prettyCombo(c))}</kbd>`).join(' ')} ${esc(a.label)}</li>`).join('');
  }
  /** Add "Keyboard shortcut: X" to the tooltip of every [data-act] button under root. */
  decorate(root) {
    for (const b of root.querySelectorAll('[data-act]')) {
      if (b.dataset.baseTitle == null) b.dataset.baseTitle = b.title || this.byId.get(b.dataset.act)?.help || '';
      const combos = this.combos(b.dataset.act);
      b.title = combos.length ? `${b.dataset.baseTitle}\n\nKeyboard shortcut: ${combos.map(prettyCombo).join(' or ')}` : b.dataset.baseTitle;
      const k = b.querySelector('kbd.sc'); if (k) k.textContent = combos[0] ? prettyCombo(combos[0]) : '';
    }
  }

  // ---------------- editor window ----------------
  open() { $('#help').hidden = true; $('#shortcuts').hidden = false; this._render(); $('#scFilter').focus(); }
  close() { this.recording = null; $('#shortcuts').hidden = true; }
  _render() {
    const filter = ($('#scFilter').value || '').toLowerCase();
    const isRec = (id, i) => this.recording && this.recording.id === id && this.recording.i === i;
    let html = '', group = null;
    for (const a of this.actions) {
      if (a.hidden) continue;
      const combos = this.combos(a.id);
      if (filter && !a.label.toLowerCase().includes(filter) && !(a.help || '').toLowerCase().includes(filter) && !combos.some(c => c.toLowerCase().includes(filter))) continue;
      if (a.group !== group) { group = a.group; html += `<div class="sc-group">${esc(group)}</div>`; }
      const chips = combos.map((c, i) => isRec(a.id, i) ? '<span class="chip rec">Press keys…</span>'
        : `<span class="chip" data-chip="${a.id}" data-i="${i}" title="Click, then press the new key(s) to change this shortcut.">${esc(prettyCombo(c))}<button class="x" data-del="${a.id}" data-i="${i}" title="Remove this shortcut.">×</button></span>`).join('');
      const isDefault = JSON.stringify(combos) === JSON.stringify(a.defaults);
      html += `<div class="sc-row" title="${esc(a.help || '')}">
        <span class="sc-label">${esc(a.label)}${a.help ? `<small>${esc(a.help)}</small>` : ''}</span>
        <span class="sc-keys">${chips}${isRec(a.id, -1) ? '<span class="chip rec">Press keys…</span>' : `<button class="sc-add" data-add="${a.id}" title="Add another shortcut for this.">+</button>`}</span>
        <button class="sc-reset" data-reset="${a.id}" ${isDefault ? 'disabled' : ''} title="Put this shortcut back to how it came.">↺</button></div>`;
    }
    $('#scList').innerHTML = html;
    $('#scHint').textContent = this.recording
      ? 'Press the new key combination now (any key works, including Esc and Space). Click anywhere to cancel.'
      : 'Click a shortcut to change it, + to add another, × to remove it. Changes are saved automatically.';
  }
  _initEditor() {
    $('#scList').addEventListener('click', e => {
      const t = e.target.closest('[data-del],[data-add],[data-chip],[data-reset]');
      e.stopPropagation();
      if (!t) this.recording = null;
      else if (t.dataset.del) { this.map.get(t.dataset.del).splice(+t.dataset.i, 1); this.recording = null; this._save(); }
      else if (t.dataset.add) this.recording = { id: t.dataset.add, i: -1 };
      else if (t.dataset.chip) this.recording = { id: t.dataset.chip, i: +t.dataset.i };
      else if (t.dataset.reset) {
        const a = this.byId.get(t.dataset.reset);
        for (const c of a.defaults) { const owner = this.index.get(c); if (owner && owner !== a.id) this.map.get(owner).splice(this.map.get(owner).indexOf(c), 1); }
        this.map.set(a.id, a.defaults.slice()); this.recording = null; this._save();
      }
      this._render();
    });
    $('#shortcuts').addEventListener('click', e => {
      if (e.target.id === 'shortcuts') this.close();
      else if (this.recording && !e.target.closest('#scList')) { this.recording = null; this._render(); }
    });
    $('#scFilter').addEventListener('input', () => this._render());
    $('#scResetAll').addEventListener('click', () => {
      for (const a of this.actions) this.map.set(a.id, a.defaults.slice());
      this.recording = null; this._save(); this._render(); this.status('All shortcuts put back to how they came');
    });
  }
  _record(combo) {
    const { id, i } = this.recording; this.recording = null;
    const prev = this.index.get(combo);
    if (prev && prev !== id) { const l = this.map.get(prev); l.splice(l.indexOf(combo), 1); this.status(`${prettyCombo(combo)} was taken from “${this.byId.get(prev).label}”`); }
    const mine = this.map.get(id);
    if (!mine.includes(combo)) { if (i >= 0 && i < mine.length) mine[i] = combo; else mine.push(combo); }
    this._save(); this._render();
  }
  _onKey(e) {
    if (this.recording) { const c = comboFromEvent(e); e.preventDefault(); e.stopPropagation(); if (c) this._record(c); return; }
    const tg = e.target;
    const typing = (tg.tagName === 'INPUT' && !['checkbox', 'button', 'range'].includes(tg.type)) || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA';
    if (typing) { if (e.key === 'Escape') tg.blur(); return; }
    if (tg.closest && tg.closest('[data-panel="library"], #term')) return; // the library window and the Claude terminal have their own keys
    if (!$('#ask').hidden) return;
    if (!$('#shortcuts').hidden) { if (e.key === 'Escape') this.close(); return; }
    const combo = comboFromEvent(e);
    if (!$('#help').hidden) { if (e.key === 'Escape' || this.index.get(combo) === 'help') { e.preventDefault(); $('#help').hidden = true; } return; }
    if (!combo) return;
    const id = this.index.get(combo);
    if (!id) return;
    e.preventDefault();
    if (this.allow && !this.allow(id)) return; // e.g. a Claude session's tab: look only
    const act = this.byId.get(id);
    if (act.release) { // hold-to-use action
      if (!e.repeat && !this.held) { this.held = { id, key: this._baseKey(e) }; act.run(); }
      return;
    }
    if (tg.blur && tg !== document.body) tg.blur();
    Promise.resolve(this.run(id)).catch(err => this.status('⚠ ' + err.message));
  }
}
