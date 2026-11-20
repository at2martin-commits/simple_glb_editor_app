// Model library window (same behaviour as Claudio Editor's sound library):
// a folder on disk, organised into folders, shown as a tree. Double-click or drag a model into
// the viewport to open it; drag files from Explorer in to import them; right-click for more.
import { settings } from './settings.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const stem = n => n.replace(/\.[^.]+$/, '');
const parentOf = rel => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const api = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
export const MIME_LIB = 'application/x-glb-library';

export function initLibrary({ editor: ed, panels, status, run, openTab }) {
  const ui = { target: '', expanded: [''], ...settings.get('library', {}) };
  const expanded = new Set(ui.expanded);
  const saveUi = () => { ui.expanded = [...expanded]; settings.set('library', { target: ui.target, expanded: ui.expanded }); };
  let tree = null, info = { root: '', desktop: false }, selFiles = new Set(), renaming = null, lastClick = null, lastClickTime = 0;
  const body = $('#libBody'), ctx = $('#libCtx'), menu = $('#libMenu');

  async function refresh() {
    try { [tree, info] = await Promise.all([api('/api/lib/list'), api('/api/lib/info')]); }
    catch (err) { status('Library problem: ' + err.message); return; }
    if (!findFolder(ui.target)) ui.target = '';
    for (const r of [...selFiles]) if (!findFile(r)) selFiles.delete(r);
    render();
  }
  function findFolder(rel, n = tree) { if (!n) return null; if (n.rel === rel) return n; for (const d of n.dirs) { const f = findFolder(rel, d); if (f) return f; } return null; }
  function findFile(rel) { const f = findFolder(parentOf(rel)); return f && f.files.find(x => x.rel === rel); }
  function filesUnder(n, out = []) { for (const f of n.files) out.push(f.rel); n.dirs.forEach(d => filesUnder(d, out)); return out; }
  const folderLabel = rel => (rel ? `Library / ${rel.split('/').join(' / ')}` : 'Library');

  function render() {
    if (!tree) return;
    const q = ($('#libSearch').value || '').trim().toLowerCase();
    let html;
    if (q) {
      const hits = []; (function walk(n) { n.files.forEach(f => { if (f.name.toLowerCase().includes(q)) hits.push(f); }); n.dirs.forEach(walk); })(tree);
      html = hits.length ? hits.map(f => fileRow(f, 0, true)).join('') : '<div class="lib-empty">No models match your search.</div>';
    } else {
      html = folderRows(tree, 0);
      if (!filesUnder(tree).length && !tree.dirs.length) html += '<div class="lib-empty">Your library is empty.<br>Click <b>Import…</b> above, drag .glb files from Explorer into this window, or press <b>Save</b> to put the model you are working on here. Use <b>+ Folder</b> to make a folder for each project.</div>';
    }
    body.innerHTML = html;
    $('#libFoot').innerHTML = `Saves and imports go into: <b>${esc(folderLabel(ui.target))}</b>`;
    $('#libRootNote').textContent = info.root ? `Library location: ${info.root}` : '';
    $('#libRootNote').title = info.root;
    if (renaming) { const inp = body.querySelector('.lib-rename'); if (inp) { inp.focus(); inp.select(); } }
  }
  const nameHtml = (rel, name) => renaming === rel ? `<input type="text" class="lib-rename" value="${esc(name)}" data-rel="${esc(rel)}">` : `<span class="lib-name">${esc(name)}</span>`;
  function folderRows(n, depth) {
    const open = expanded.has(n.rel), name = n.rel ? n.name : 'Library';
    let h = `<div class="lib-row folder${n.rel === ui.target ? ' target' : ''}" draggable="${n.rel ? 'true' : 'false'}" data-rel="${esc(n.rel)}" data-kind="dir" style="padding-left:${6 + depth * 16}px"
      title="${n.rel ? 'Folder. Click to open it and make it the place where saves and imports go. Drag models or folders onto it to move them in. Right-click for more.' : 'Your whole model library. Right-click for more options.'}">
      <span class="caret">${n.dirs.length || n.files.length ? (open ? '▾' : '▸') : ''}</span><span class="icon">${open ? '📂' : '📁'}</span>${nameHtml(n.rel, name)}<span class="lib-meta">${filesUnder(n).length || ''}</span></div>`;
    if (open) { n.dirs.forEach(d => { h += folderRows(d, depth + 1); }); n.files.forEach(f => { h += fileRow(f, depth + 1, false); }); }
    return h;
  }
  function fileRow(f, depth, showPath) {
    const where = showPath && parentOf(f.rel) ? `<span class="lib-path">${esc(parentOf(f.rel))}</span>` : '';
    const cls = (selFiles.has(f.rel) ? ' sel' : '') + (ed.libRel === f.rel ? ' open' : '');
    return `<div class="lib-row file${cls}" draggable="true" data-rel="${esc(f.rel)}" data-kind="file" style="padding-left:${6 + depth * 16 + 12}px"
      title="${esc(f.name)}${ed.libRel === f.rel ? ' (open now)' : ''}\nDouble-click (or drag it into the 3D view) to open it. Right-click for more.">
      <span class="icon">${/\.bbmodel$/i.test(f.name) ? '🧱' : '🧍'}</span>${nameHtml(f.rel, stem(f.name))}${where}<span class="lib-meta">${fmtSize(f.size)}</span></div>`;
  }

  // ---------------- actions ----------------
  async function openModel(rel) { // always in its own tab (the empty start tab is reused); a file already open in a tab just switches to it
    const tabs = window.tabs, isBB = /\.bbmodel$/i.test(rel);
    const there = tabs?.list.find(t => (isBB ? t.ed.mode === 'build' && t.ed.build?.libRel === rel : t.ed.mode !== 'build' && t.ed.libRel === rel));
    ui.target = parentOf(rel); saveUi();
    if (there) { tabs.select(there); render(); return; }
    await run(() => openTab(async e => { if (isBB) { e.setMode('build'); return e.build.open(rel); } return e.load(rel); }));
    render();
  }
  async function importFiles(files, dest = ui.target) {
    const list = [...files].filter(f => /\.(glb|gltf|bbmodel)$/i.test(f.name));
    if (!list.length) { status('Only .glb / .gltf / .bbmodel files can go in the library'); return []; }
    status(`Copying ${list.length} model${list.length > 1 ? 's' : ''} into ${folderLabel(dest)}…`);
    const rels = [];
    for (const f of list) rels.push((await api(`/api/lib/file?dir=${encodeURIComponent(dest)}&name=${encodeURIComponent(f.name)}`, { method: 'PUT', body: await f.arrayBuffer() })).rel);
    let p = dest; expanded.add(p); while (p) { p = parentOf(p); expanded.add(p); }
    saveUi(); await refresh();
    status(`Copied ${rels.length} model${rels.length === 1 ? '' : 's'} into ${folderLabel(dest)}`);
    return rels;
  }
  function importDialog(dest = ui.target) {
    const inp = $('#libFile');
    inp.onchange = () => { const fs = [...inp.files]; inp.value = ''; if (fs.length) importFiles(fs, dest).then(() => panels.open('library')); };
    inp.click();
  }
  async function newFolder(parent = ui.target) {
    const { rel } = await api(`/api/lib/mkdir?parent=${encodeURIComponent(parent)}&name=New%20folder`, { method: 'POST' });
    expanded.add(parent); ui.target = rel; saveUi(); renaming = rel;
    panels.open('library'); await refresh();
  }
  async function commitRename(rel, value) {
    renaming = null;
    const v = value.trim(), node = findFolder(rel) || findFile(rel);
    const cur = node ? (findFile(rel) ? stem(node.name) : node.name) : '';
    if (v && v !== cur) {
      try {
        const { rel: nrel } = await api(`/api/lib/rename?rel=${encodeURIComponent(rel)}&name=${encodeURIComponent(v)}`, { method: 'POST' });
        if (ui.target === rel) ui.target = nrel;
        if (expanded.delete(rel)) expanded.add(nrel);
        if (selFiles.delete(rel)) selFiles.add(nrel);
        if (ed.libRel === rel) { ed.libRel = nrel; ed.fileName = nrel.split('/').pop(); ed.changed(); }
        saveUi();
      } catch (err) { status('Rename failed: ' + err.message); }
    }
    await refresh();
  }
  async function trash(rels) {
    if (!rels.length) return;
    const names = rels.map(r => r.split('/').pop() || 'Library');
    const msg = rels.length === 1 ? `Move “${names[0]}” to the Recycle Bin?` : `Move these ${rels.length} items to the Recycle Bin?`;
    if (!confirm(`${msg}\n\nThe model you have open stays open. You can get files back from the Recycle Bin.`)) return;
    await api('/api/lib/delete', { method: 'POST', body: JSON.stringify(rels) });
    rels.forEach(r => selFiles.delete(r));
    await refresh();
    status(`Moved ${rels.length} item${rels.length > 1 ? 's' : ''} to the Recycle Bin`);
  }
  async function move(rels, dest) {
    const { moved } = await api(`/api/lib/move?dest=${encodeURIComponent(dest)}`, { method: 'POST', body: JSON.stringify(rels) });
    expanded.add(dest); saveUi(); selFiles.clear(); await refresh();
    if (moved.length) status(`Moved ${moved.length} item${moved.length > 1 ? 's' : ''} to ${folderLabel(dest)}`);
  }
  const reveal = rel => (info.desktop ? api(`/api/lib/reveal?rel=${encodeURIComponent(rel)}`, { method: 'POST' }) : status('Showing folders in Explorer works in the desktop app'));

  // ---------------- tree interaction ----------------
  body.addEventListener('click', e => {
    if (e.target.closest('.lib-rename')) return;
    const row = e.target.closest('.lib-row'); if (!row) return;
    const rel = row.dataset.rel;
    if (row.dataset.kind === 'dir') {
      if (ui.target === rel || e.target.closest('.caret')) { if (!expanded.delete(rel)) expanded.add(rel); } else expanded.add(rel);
      ui.target = rel; selFiles.clear();
    } else {
      // double-click (detected by timing, because the first click redraws the list)
      const now = performance.now();
      if (!e.ctrlKey && !e.shiftKey && lastClick === rel && now - lastClickTime < 450) { lastClickTime = 0; openModel(rel); return; }
      lastClickTime = now;
      if (e.ctrlKey || e.metaKey) { if (!selFiles.delete(rel)) selFiles.add(rel); }
      else if (e.shiftKey && lastClick) {
        const rows = [...body.querySelectorAll('.lib-row.file')].map(r => r.dataset.rel), a = rows.indexOf(lastClick), b = rows.indexOf(rel);
        if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selFiles.add(rows[i]);
      } else selFiles = new Set([rel]);
      lastClick = rel; ui.target = parentOf(rel);
    }
    saveUi(); render();
  });
  body.addEventListener('keydown', e => {
    const inp = e.target.closest('.lib-rename'); if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); commitRename(inp.dataset.rel, inp.value); }
    if (e.key === 'Escape') { e.preventDefault(); renaming = null; render(); }
  });
  body.addEventListener('focusout', e => { const inp = e.target.closest?.('.lib-rename'); if (inp && renaming === inp.dataset.rel) commitRename(inp.dataset.rel, inp.value); });
  const panelEl = document.querySelector('[data-panel="library"]');
  panelEl.tabIndex = -1;
  panelEl.addEventListener('keydown', e => {
    if (e.target.closest('input')) return;
    const rels = [...selFiles];
    if (e.key === 'Delete') { e.preventDefault(); trash(rels.length ? rels : (ui.target ? [ui.target] : [])); }
    else if (e.key === 'F2') { e.preventDefault(); renaming = rels.length === 1 ? rels[0] : ui.target || null; render(); }
    else if (e.key === 'Enter' && rels.length === 1) { e.preventDefault(); openModel(rels[0]); }
    else if (e.key === 'Escape') { e.preventDefault(); panels.close('library'); }
  });

  // drag out (into the viewport to open, or onto another folder to move)
  body.addEventListener('dragstart', e => {
    const row = e.target.closest('.lib-row'); if (!row) return;
    const rel = row.dataset.rel;
    let items;
    if (row.dataset.kind === 'file') { if (!selFiles.has(rel)) { selFiles = new Set([rel]); } items = [...selFiles]; }
    else items = [rel];
    e.dataTransfer.setData(MIME_LIB, JSON.stringify(items));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  const dropFolderFor = e => { const row = e.target.closest('.lib-row'); if (!row) return ui.target; return row.dataset.kind === 'dir' ? row.dataset.rel : parentOf(row.dataset.rel); };
  let hoverOpen = { rel: null, timer: 0 };
  body.addEventListener('dragover', e => {
    const types = [...e.dataTransfer.types];
    if (!types.includes(MIME_LIB) && !types.includes('Files')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes(MIME_LIB) ? 'move' : 'copy';
    const dest = dropFolderFor(e);
    body.querySelectorAll('.lib-row.drop').forEach(r => r.classList.remove('drop'));
    [...body.querySelectorAll('.lib-row.folder')].find(r => r.dataset.rel === dest)?.classList.add('drop');
    const over = e.target.closest('.lib-row.folder'), overRel = over ? over.dataset.rel : null;
    if (overRel !== hoverOpen.rel) {
      clearTimeout(hoverOpen.timer); hoverOpen = { rel: overRel, timer: 0 };
      if (overRel !== null && !expanded.has(overRel)) hoverOpen.timer = setTimeout(() => { expanded.add(overRel); saveUi(); render(); }, 650);
    }
  });
  body.addEventListener('dragleave', e => { if (!body.contains(e.relatedTarget)) body.querySelectorAll('.lib-row.drop').forEach(r => r.classList.remove('drop')); });
  body.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    clearTimeout(hoverOpen.timer); hoverOpen = { rel: null, timer: 0 };
    const dest = dropFolderFor(e);
    const items = e.dataTransfer.getData(MIME_LIB);
    if (items) { await move(JSON.parse(items), dest); return; }
    if (e.dataTransfer.files.length) await importFiles(e.dataTransfer.files, dest);
  });

  // ---------------- context menu ----------------
  function showCtx(x, y, items) {
    ctx.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" title="${esc(it.tip || '')}">${esc(it.label)}</button>`)).join('');
    ctx.hidden = false;
    ctx.style.left = `${Math.min(x, innerWidth - 230)}px`;
    ctx.style.top = `${Math.min(y, innerHeight - ctx.offsetHeight - 8)}px`;
    ctx.onclick = ev => { const b = ev.target.closest('button[data-i]'); if (!b) return; ctx.hidden = true; items[+b.dataset.i].run(); };
  }
  const allFolders = (n = tree, out = []) => { out.push(n.rel); n.dirs.forEach(d => allFolders(d, out)); return out; };
  function showMoveMenu(x, y, rels) {
    const blocked = f => rels.some(r => f === r || f.startsWith(r + '/') || f === parentOf(r));
    const items = allFolders().filter(f => !blocked(f)).map(f => ({ label: `${'  '.repeat(f ? f.split('/').length : 0)}📁 ${f ? f.split('/').pop() : 'Library (top level)'}`, run: () => move(rels, f), tip: folderLabel(f) }));
    if (!items.length) { status('There is no other folder to move to yet — make one with + Folder'); return; }
    showCtx(x, y, items);
  }
  body.addEventListener('contextmenu', e => {
    e.preventDefault();
    const row = e.target.closest('.lib-row'), rel = row ? row.dataset.rel : '';
    if (!row || row.dataset.kind === 'dir') {
      const items = [
        { label: 'New folder inside', run: () => newFolder(rel), tip: 'Make a folder inside this one.' },
        { label: 'Import models into here…', run: () => importDialog(rel) },
        { label: 'Save the open model into here', run: () => { ui.target = rel; saveUi(); render(); run(() => ed.save(ed.fileName, rel)); }, tip: 'Save what you are working on into this folder.' },
        '-', { label: 'Show in Explorer', run: () => reveal(rel) },
      ];
      if (rel) items.push({ label: 'Move to folder…', run: () => showMoveMenu(e.clientX, e.clientY, [rel]) }, { label: 'Rename', run: () => { renaming = rel; render(); } }, { label: 'Delete folder', run: () => trash([rel]) });
      showCtx(e.clientX, e.clientY, items);
    } else {
      if (!selFiles.has(rel)) { selFiles = new Set([rel]); render(); }
      const rels = [...selFiles];
      const items = [{ label: 'Open', run: () => openModel(rel), tip: 'Open this model in the editor.' }, '-', { label: 'Show in Explorer', run: () => reveal(rel) },
        { label: 'Move to folder…', run: () => showMoveMenu(e.clientX, e.clientY, rels), tip: 'Pick a folder to move the selected model(s) into.' }];
      if (rels.length === 1) items.push({ label: 'Rename', run: () => { renaming = rel; render(); } });
      items.push({ label: rels.length > 1 ? `Delete ${rels.length} models` : 'Delete', run: () => trash(rels) });
      showCtx(e.clientX, e.clientY, items);
    }
  });
  document.addEventListener('pointerdown', e => {
    if (!ctx.hidden && !ctx.contains(e.target)) ctx.hidden = true;
    if (!menu.hidden && !e.target.closest('#libDropdown')) menu.hidden = true;
  });

  // ---------------- toolbar dropdown + window buttons ----------------
  menu.addEventListener('click', async e => {
    const b = e.target.closest('button[data-lib]'); if (!b) return;
    menu.hidden = true;
    const a = b.dataset.lib;
    if (a === 'open') panels.toggle('library');
    else if (a === 'import') importDialog();
    else if (a === 'newFolder') newFolder();
    else if (a === 'reveal') reveal('');
    else if (a === 'chooseRoot') {
      if (!info.desktop) { status('Changing the library location works in the desktop app'); return; }
      const { root } = await api('/api/lib/chooseRoot', { method: 'POST' });
      if (root) { ui.target = ''; saveUi(); await refresh(); panels.open('library'); status('Library is now at ' + root); }
    }
  });
  $('#libNewFolder').addEventListener('click', () => newFolder());
  $('#libImport').addEventListener('click', () => importDialog());
  $('#libSearch').addEventListener('input', render);
  ed.addEventListener('library', () => { // after a save: show where it went
    if (ed.libRel) { ui.target = parentOf(ed.libRel); let p = ui.target; expanded.add(p); while (p) { p = parentOf(p); expanded.add(p); } saveUi(); }
    refresh();
  });
  ed.addEventListener('change', () => { if (tree) { const open = body.querySelector('.lib-row.open'); if ((open?.dataset.rel || null) !== (ed.libRel || null)) render(); } });
  refresh();

  return {
    target: () => ui.target, refresh, importFiles, importDialog, newFolder,
    toggleMenu() { menu.hidden = !menu.hidden; if (!menu.hidden) refresh(); },
  };
}
