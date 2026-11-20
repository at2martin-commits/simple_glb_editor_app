// Arrange the buttons: an editing mode (View > Arrange the buttons…) where the toolbar buttons can be dragged to new
// places — within a group, to another group, to the other toolbar — and dropped onto another button to make a parent
// button (a dropdown holding both). Parent buttons are renamed with a double-click; an empty one disappears.
// The layout is saved in settings.toolbarLayout = { groups: {gid: [unit keys]}, menus: {mid: {name, items: [unit keys]}} }
// and applied at start. Unit keys: 'act:<data-act>' (a plain button), 'id:<element id>' (dropdowns like the Library or
// Claude ones), 'menu:<mid>' (a parent button made here). Groups are the toolbars' .group boxes, numbered g0, g1, …
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initArrange({ settings, status, askText, onChange }) {
  const groups = () => [...document.querySelectorAll('header.toolbar .group')];
  groups().forEach((g, i) => { g.dataset.gid = 'g' + i; });
  const keyOf = el => (el.dataset.um ? 'menu:' + el.dataset.um : el.id && el.classList.contains('dropdown') ? 'id:' + el.id : el.dataset.act ? 'act:' + el.dataset.act : null);
  const unitsIn = c => [...c.children].filter(el => keyOf(el)); // the movable things directly inside a group or a parent button's menu
  const capture = () => {
    const out = { groups: {}, menus: {} };
    for (const g of groups()) out.groups[g.dataset.gid] = unitsIn(g).map(keyOf);
    for (const m of document.querySelectorAll('.usermenu')) out.menus[m.dataset.um] = { name: m.dataset.name, items: unitsIn(m.querySelector('.menu')).map(keyOf) };
    return out;
  };
  const defaults = capture(); // as built: what Reset goes back to

  // ---- parent buttons (dropdowns made here)
  function makeMenu(mid, name) {
    const d = document.createElement('div');
    d.className = 'dropdown usermenu'; d.dataset.um = mid; d.dataset.name = name;
    d.innerHTML = `<button class="um-btn" title="${esc(name)}: click to open.">${esc(name)} ▾</button><div class="menu" hidden></div>`;
    return d;
  }
  const findUnit = key => {
    if (key.startsWith('act:')) return document.querySelector(`header.toolbar [data-act="${CSS.escape(key.slice(4))}"]`);
    if (key.startsWith('id:')) return document.getElementById(key.slice(3));
    if (key.startsWith('menu:')) return document.querySelector(`.usermenu[data-um="${CSS.escape(key.slice(5))}"]`);
    return null;
  };
  /** Put everything where a saved layout says (things it does not mention stay where they are). */
  function apply(layout) {
    if (!layout) return;
    const menus = {};
    for (const [mid, m] of Object.entries(layout.menus || {})) menus[mid] = document.querySelector(`.usermenu[data-um="${CSS.escape(mid)}"]`) || makeMenu(mid, m.name || 'Menu');
    for (const [gid, keys] of Object.entries(layout.groups || {})) {
      const g = document.querySelector(`header.toolbar .group[data-gid="${gid}"]`); if (!g) continue;
      for (const k of keys) { const el = k.startsWith('menu:') ? menus[k.slice(5)] : findUnit(k); if (el) g.appendChild(el); }
    }
    for (const [mid, m] of Object.entries(layout.menus || {})) {
      const list = menus[mid].querySelector('.menu');
      for (const k of m.items || []) { const el = findUnit(k); if (el && el !== menus[mid]) list.appendChild(el); }
    }
    tidy();
  }
  /** Empty parent buttons go away; the others show their name. */
  function tidy() {
    for (const m of [...document.querySelectorAll('.usermenu')]) {
      if (!unitsIn(m.querySelector('.menu')).length) m.remove();
      else m.querySelector('.um-btn').textContent = m.dataset.name + ' ▾';
    }
  }
  const save = () => { settings.set('toolbarLayout', capture()); onChange?.(); };
  apply(settings.get('toolbarLayout', null));

  // parent buttons open / close (also outside arrange mode); a click on something inside runs it and closes the menu
  document.addEventListener('click', e => {
    const b = e.target.closest('.um-btn');
    for (const m of document.querySelectorAll('.usermenu .menu')) if (!b || !m.parentElement.contains(b)) m.hidden = true;
    if (b) { const list = b.parentElement.querySelector('.menu'); list.hidden = !list.hidden; return; }
  });

  // ---- arrange mode
  let on = false, drag = null;
  const bar = document.createElement('div'); bar.id = 'arrangeBar'; bar.hidden = true;
  bar.innerHTML = `<b>Arranging buttons</b><span>Drag a button to move it · drop it on the middle of another button to make a menu · double-click a menu to rename it</span><button id="arrReset" title="Put every button back where it was.">Reset to default</button><button id="arrDone" class="primary">Done</button>`;
  document.body.appendChild(bar);
  const mark = document.createElement('div'); mark.id = 'arrangeMark'; mark.hidden = true; document.body.appendChild(mark);
  function setOn(v) {
    on = v; document.body.classList.toggle('arranging', on); bar.hidden = !on;
    status(on ? 'Arranging the buttons: drag them where you like (View > Arrange the buttons… or Done to finish)' : 'Button layout saved');
    if (!on) { save(); for (const m of document.querySelectorAll('.usermenu .menu')) m.hidden = true; }
  }
  bar.addEventListener('click', e => {
    if (e.target.id === 'arrDone') setOn(false);
    if (e.target.id === 'arrReset' && confirm('Put every button back where it was? Your menus are removed.')) {
      for (const m of [...document.querySelectorAll('.usermenu')]) { const list = m.querySelector('.menu'); for (const el of unitsIn(list)) m.parentElement.insertBefore(el, m); }
      apply(defaults); tidy(); settings.set('toolbarLayout', null); onChange?.(); status('Buttons are back where they were');
    }
  });

  const unitAt = (x, y) => {
    mark.hidden = true; const ghost = drag?.ghost; if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y); if (ghost) ghost.style.display = '';
    if (!el) return {};
    const unit = el.closest('header.toolbar .group > *, .usermenu .menu > *'), list = el.closest('header.toolbar .group, .usermenu .menu');
    return { unit: unit && keyOf(unit) ? unit : null, list };
  };
  // in arrange mode a press on a button never runs it
  document.addEventListener('click', e => { if (on && e.target.closest('header.toolbar') && !e.target.closest('.um-btn')) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('dblclick', async e => {
    const b = on && e.target.closest('.um-btn'); if (!b) return;
    const m = b.parentElement, n = await askText('Name of this menu button:', m.dataset.name); if (!n) return;
    m.dataset.name = n; tidy(); save();
  }, true);
  document.addEventListener('pointerdown', e => {
    if (!on || e.button !== 0) return;
    const unit = e.target.closest('header.toolbar .group > *, .usermenu .menu > *');
    if (!unit || !keyOf(unit) || e.target.closest('#arrangeBar')) return;
    e.preventDefault();
    drag = { unit, x0: e.clientX, y0: e.clientY, started: false, ghost: null, timer: setTimeout(() => start(e.clientX, e.clientY), 300) }; // click and hold (or just start moving)
  }, true);
  function start(x, y) {
    if (!drag || drag.started) return;
    drag.started = true; clearTimeout(drag.timer);
    const r = drag.unit.getBoundingClientRect(), g = drag.unit.cloneNode(true);
    g.id = ''; g.className += ' arrange-ghost'; Object.assign(g.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
    document.body.appendChild(g); drag.ghost = g; drag.dx = x - r.left; drag.dy = y - r.top;
    drag.unit.classList.add('arrange-src');
  }
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.started) { if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) start(e.clientX, e.clientY); else return; }
    drag.ghost.style.left = e.clientX - drag.dx + 'px'; drag.ghost.style.top = e.clientY - drag.dy + 'px';
    const { unit, list } = unitAt(e.clientX, e.clientY); drag.target = null;
    for (const el of document.querySelectorAll('.arrange-into')) el.classList.remove('arrange-into');
    if (unit && unit !== drag.unit && !unit.contains(drag.unit)) {
      const r = unit.getBoundingClientRect(), rel = (e.clientX - r.left) / r.width, vertical = !!unit.closest('.usermenu .menu');
      const into = !vertical && rel > 0.3 && rel < 0.7 && !drag.unit.classList.contains('usermenu'); // the middle of a button: make / fill a menu
      if (into) { unit.classList.add('arrange-into'); drag.target = { into: unit }; return; }
      const after = vertical ? (e.clientY - r.top) / r.height > 0.5 : rel >= 0.5;
      drag.target = { before: after ? unit.nextSibling : unit, list: unit.parentElement };
      Object.assign(mark.style, vertical ? { left: r.left + 'px', top: (after ? r.bottom : r.top) - 1 + 'px', width: r.width + 'px', height: '3px' } : { left: (after ? r.right : r.left) + 1 + 'px', top: r.top + 'px', width: '3px', height: r.height + 'px' });
      mark.hidden = false;
    } else if (list && !unit) { // empty space in a group / an open menu: the end of it
      drag.target = { before: null, list };
      const r = list.getBoundingClientRect(); Object.assign(mark.style, { left: r.right - 2 + 'px', top: r.top + 'px', width: '3px', height: r.height + 'px' }); mark.hidden = false;
    }
  }, true);
  document.addEventListener('pointerup', async () => {
    if (!drag) return;
    const d = drag; drag = null; clearTimeout(d.timer); mark.hidden = true;
    d.ghost?.remove(); d.unit.classList.remove('arrange-src');
    for (const el of document.querySelectorAll('.arrange-into')) el.classList.remove('arrange-into');
    if (!d.started || !d.target) return;
    if (d.target.into) {
      const t = d.target.into;
      if (t.classList.contains('usermenu')) t.querySelector('.menu').appendChild(d.unit); // onto a menu button: into it
      else { // onto a plain button: a new menu holding both
        const name = (await askText('Name for the new menu button (it holds both buttons):', 'Menu')) || null; if (!name) return;
        const mid = 'm' + Date.now().toString(36), m = makeMenu(mid, name);
        t.parentElement.insertBefore(m, t); m.querySelector('.menu').append(t, d.unit);
      }
    } else d.target.list.insertBefore(d.unit, d.target.before);
    tidy(); save();
  }, true);

  return { setOn, toggle: () => setOn(!on), get on() { return on; }, capture, apply, defaults };
}
