// Panels that sit docked at the left/right of the viewport, or pop out into floating windows
// that can be moved, resized from any edge or corner, and docked back by dragging them to a screen edge.
import { settings } from './settings.js';

const MIN_W = 220, MIN_H = 160;
const $ = s => document.querySelector(s);

export class Panels {
  /** defs: { id: { title, dock: 'left'|'right'|null, open, w, h, tip } } in display order */
  constructor(defs, onChange = () => {}) {
    this.defs = defs; this.onChange = onChange; this.z = 20;
    const saved = settings.get('panels', {});
    this.state = {};
    for (const [id, d] of Object.entries(defs)) {
      this.state[id] = { ...this._defaultState(d), ...(saved[id] || {}) };
      this._build(id);
    }
    const dockW = settings.get('dockWidths', {});
    for (const side of ['left', 'right']) if (dockW[side]) document.documentElement.style.setProperty(`--dock-${side}`, dockW[side] + 'px');
    this._splitters();
    window.addEventListener('resize', () => this.apply());
    this.apply();
  }
  el(id) { return document.querySelector(`.panel[data-panel="${id}"]`); }
  isOpen(id) { return this.state[id].open; }
  _save() { settings.set('panels', this.state); }
  _defaultState(d) { return { dock: d.dock, open: d.open, x: null, y: 100, w: d.w || 320, h: d.h || 420 }; }

  _build(id) {
    const el = this.el(id), d = this.defs[id];
    const t = document.createElement('div');
    t.className = 'panel-title';
    t.title = d.tip || 'Drag here to move this window. Double-click to pop it out or dock it back.';
    t.innerHTML = `<b>${d.title}</b><span class="grow"></span>
      <button class="pop" title="Pop this panel out into its own window that you can move and resize — or put it back in its place.">⇱</button>
      <button class="x" title="Close this window. Bring it back from the Windows buttons in the toolbar.">×</button>`;
    el.prepend(t);
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = document.createElement('div');
      h.className = `resize ${dir}`; h.title = 'Drag to resize this window.';
      el.appendChild(h);
      h.addEventListener('pointerdown', e => this._resizeDrag(id, dir, e));
    }
    t.querySelector('.pop').addEventListener('click', () => this.toggleFloat(id));
    t.querySelector('.x').addEventListener('click', () => this.close(id));
    t.addEventListener('dblclick', e => { if (!e.target.closest('button')) this.toggleFloat(id); });
    t.addEventListener('pointerdown', e => this._moveDrag(id, e));
    el.addEventListener('pointerdown', () => { if (!this.state[id].dock) el.style.zIndex = ++this.z; }, true);
  }

  apply() {
    const vw = innerWidth, vh = innerHeight;
    let hasL = false, hasR = false;
    for (const id of Object.keys(this.defs)) {
      const s = this.state[id], el = this.el(id);
      el.hidden = !s.open;
      el.querySelector('.pop').textContent = s.dock ? '⇱' : '⇲';
      if (s.dock) { // (moved into its dock below, in the defined order)
        el.classList.remove('floating'); el.style.cssText = '';
        if (s.open) { if (s.dock === 'left') hasL = true; else hasR = true; }
      } else {
        if (el.parentElement !== document.body) document.body.appendChild(el);
        el.classList.add('floating');
        s.w = Math.min(Math.max(MIN_W, s.w), vw); s.h = Math.min(Math.max(MIN_H, s.h), vh);
        if (s.x == null) s.x = vw - s.w - 40;
        s.x = Math.min(Math.max(0, s.x), vw - s.w); s.y = Math.min(Math.max(0, s.y), vh - s.h);
        Object.assign(el.style, { left: s.x + 'px', top: s.y + 'px', width: s.w + 'px', height: s.h + 'px' });
      }
    }
    // keep docked panels in their defined order
    for (const id of Object.keys(this.defs)) { const s = this.state[id]; if (s.dock) $(s.dock === 'left' ? '#dockLeft' : '#dockRight').appendChild(this.el(id)); }
    $('#main').classList.toggle('noleft', !hasL);
    $('#main').classList.toggle('noright', !hasR);
    window.dispatchEvent(new Event('panels-changed'));
    this.onChange();
  }
  open(id) { this.state[id].open = true; if (!this.state[id].dock) this.el(id).style.zIndex = ++this.z; this.apply(); this._save(); }
  close(id) { this.state[id].open = false; this.apply(); this._save(); }
  toggle(id) { this.state[id].open ? this.close(id) : this.open(id); }
  toggleFloat(id) {
    const s = this.state[id];
    if (s.dock) { // pop out where it currently is
      const r = this.el(id).getBoundingClientRect();
      s.lastDock = s.dock; s.dock = null;
      s.x = r.left + 30; s.y = r.top + 30; s.w = Math.max(r.width, MIN_W + 60); s.h = Math.min(Math.max(r.height, 300), innerHeight - 80);
      this.el(id).style.zIndex = ++this.z;
    } else s.dock = s.lastDock || this.defs[id].dock || 'right';
    this.apply(); this._save();
  }
  dock(id, side) { const s = this.state[id]; s.dock = side; s.open = true; this.apply(); this._save(); }
  reset() {
    for (const [id, d] of Object.entries(this.defs)) this.state[id] = this._defaultState(d);
    for (const side of ['left', 'right']) document.documentElement.style.removeProperty(`--dock-${side}`);
    settings.set('dockWidths', {});
    this.apply(); this._save();
  }

  _moveDrag(id, e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault(); // no text selection while dragging
    const s = this.state[id], el = this.el(id);
    const start = { x: e.clientX, y: e.clientY };
    let off = null;
    const zl = $('#dockzoneL'), zr = $('#dockzoneR');
    const mv = ev => {
      if (s.dock) { // drag a docked panel's title to tear it off
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 12) return;
        const r = el.getBoundingClientRect();
        s.lastDock = s.dock; s.dock = null; s.w = Math.max(r.width, MIN_W + 60); s.h = Math.min(Math.max(r.height, 300), innerHeight - 80);
        off = { x: 40, y: 12 }; el.style.zIndex = ++this.z;
      }
      if (!off) off = { x: start.x - s.x, y: start.y - s.y };
      s.x = ev.clientX - off.x; s.y = ev.clientY - off.y;
      zl.hidden = ev.clientX > 30; zr.hidden = ev.clientX < innerWidth - 30;
      this.apply();
    };
    // window-level listeners (the panel may be re-parented mid-drag, which would drop pointer capture)
    const end = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', end); zl.hidden = zr.hidden = true; this._endDrag = null; };
    const up = ev => {
      end();
      if (!s.dock && off) { if (ev.clientX <= 30) s.dock = 'left'; else if (ev.clientX >= innerWidth - 30) s.dock = 'right'; this.apply(); }
      this._save();
    };
    this._endDrag?.(); this._endDrag = end; // never leave an older drag running
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', end);
  }
  _resizeDrag(id, dir, e) {
    const s = this.state[id]; if (s.dock) return;
    e.preventDefault(); e.stopPropagation();
    const h = e.currentTarget; h.setPointerCapture(e.pointerId);
    const st = { x: e.clientX, y: e.clientY, l: s.x, t: s.y, w: s.w, h: s.h };
    const mv = ev => {
      const dx = ev.clientX - st.x, dy = ev.clientY - st.y, right = st.l + st.w, bottom = st.t + st.h;
      if (dir.includes('e')) s.w = Math.min(Math.max(MIN_W, st.w + dx), innerWidth - st.l);
      if (dir.includes('s')) s.h = Math.min(Math.max(MIN_H, st.h + dy), innerHeight - st.t);
      if (dir.includes('w')) { s.w = Math.min(Math.max(MIN_W, st.w - dx), right); s.x = right - s.w; }
      if (dir.includes('n')) { s.h = Math.min(Math.max(MIN_H, st.h - dy), bottom); s.y = bottom - s.h; }
      this.apply();
    };
    const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); this._save(); };
    h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  }
  _splitters() {
    for (const sp of document.querySelectorAll('.splitter')) {
      sp.addEventListener('pointerdown', e => {
        e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
        const side = sp.dataset.side;
        const mv = ev => {
          const w = side === 'left' ? ev.clientX : innerWidth - ev.clientX;
          const px = Math.round(Math.min(Math.max(170, w), innerWidth * 0.45));
          document.documentElement.style.setProperty(`--dock-${side}`, px + 'px');
          window.dispatchEvent(new Event('panels-changed'));
        };
        const up = () => {
          sp.classList.remove('drag'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
          const cs = getComputedStyle(document.documentElement);
          settings.set('dockWidths', { left: parseInt(cs.getPropertyValue('--dock-left')), right: parseInt(cs.getPropertyValue('--dock-right')) });
        };
        sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
      });
    }
  }
}
