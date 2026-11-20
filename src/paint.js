// Paint mode: a brush that paints straight onto the model's texture.
//   Paint  - lay down colour       Smudge - drag colour along like a finger       Blur - soften what's under the brush
// Size is in screen pixels. Each dab is drawn into every nearby face that faces you, at that face's own spot in
// the texture, so strokes carry across texture seams without leaking onto unrelated parts packed next to them.
// One Undo per stroke. Alt+click = eyedropper (picks the colour under the brush).
import * as THREE from 'three';

const canvases = new WeakMap(); // mesh -> { canvas, ctx, tex, W, H, flipY }

export function initPaint(ed) {
  const brush = { tool: 'paint', color: '#7b4f33', size: 30, strength: 0.5, softness: 0.5 };
  ed.brush = brush;
  const cursor = document.createElement('div');
  cursor.className = 'brushcursor';
  ed.container.appendChild(cursor);

  /** A paintable canvas copy of the mesh's colour texture (made once per mesh). */
  function paintable(mesh) {
    let c = canvases.get(mesh);
    const mat = [].concat(mesh.material)[0];
    if (c && mat.map === c.tex) return c;
    const old = mat.map;
    if (!old || !old.image) return null;
    const img = old.image, W = img.width || img.videoWidth, H = img.height || img.videoHeight;
    if (!W || !H) return null;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, W, H);
    const tex = new THREE.CanvasTexture(canvas); // a NEW source, so undo of other tools keeps the old picture
    for (const k of ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'channel']) if (k in old) tex[k] = old[k];
    tex.offset.copy(old.offset); tex.repeat.copy(old.repeat); tex.rotation = old.rotation; tex.center.copy(old.center);
    tex.name = old.name; tex.needsUpdate = true;
    for (const m of [].concat(mesh.material)) if (m.map === old) { m.map = tex; m.needsUpdate = true; }
    c = { canvas, ctx, tex, W, H, flipY: tex.flipY };
    canvases.set(mesh, c);
    return c;
  }
  const toPx = (c, u, v) => [u * c.W, (c.flipY ? 1 - v : v) * c.H];

  // ---- the faces around a point, each with its texture triangle and the brush centre mapped into it
  function nearFaces(mesh, hitPoint, worldR) {
    const g = mesh.geometry, uv = g.attributes.uv; if (!uv) return [];
    const idx = g.index, n = idx ? idx.count / 3 : g.attributes.position.count / 3;
    const W = stroke.world.get(mesh), out = [], camPos = ed.camera.position;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3(), cen = new THREE.Vector3();
    const r2 = (worldR * 1.6) ** 2;
    for (let f = 0; f < n; f++) {
      const ia = idx ? idx.getX(f * 3) : f * 3, ib = idx ? idx.getX(f * 3 + 1) : f * 3 + 1, ic = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      a.fromArray(W, ia * 3); b.fromArray(W, ib * 3); c.fromArray(W, ic * 3);
      cen.copy(a).add(b).add(c).divideScalar(3);
      const rad = Math.max(cen.distanceTo(a), cen.distanceTo(b), cen.distanceTo(c));
      if (cen.distanceToSquared(hitPoint) > r2 + rad * rad * 2 + 2 * Math.sqrt(r2) * rad) continue;
      nrm.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = nrm.length() / 2; if (area < 1e-14) continue;
      if (nrm.dot(new THREE.Vector3().subVectors(camPos, cen)) <= 0) continue; // only surfaces facing you
      out.push({ ia, ib, ic, A: a.clone(), B: b.clone(), C: c.clone(), area,
        ua: [uv.getX(ia), uv.getY(ia)], ub: [uv.getX(ib), uv.getY(ib)], uc: [uv.getX(ic), uv.getY(ic)] });
    }
    return out;
  }
  /** World point -> texture pixel within a face (barycentric on the face's plane; may fall outside it). */
  function uvIn(face, cv, p) {
    const v0 = face.B.clone().sub(face.A), v1 = face.C.clone().sub(face.A), v2 = p.clone().sub(face.A);
    const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1), d20 = v2.dot(v0), d21 = v2.dot(v1), den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-20) return null;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
    return toPx(cv, u * face.ua[0] + v * face.ub[0] + w * face.uc[0], u * face.ua[1] + v * face.ub[1] + w * face.uc[1]);
  }
  function texScale(face, cv) { // texture pixels per world unit, for this face
    const [ax, ay] = toPx(cv, ...face.ua), [bx, by] = toPx(cv, ...face.ub), [cx, cy] = toPx(cv, ...face.uc);
    const tArea = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    return Math.sqrt(tArea / face.area);
  }
  function clipTri(ctx, cv, face) {
    const pts = [face.ua, face.ub, face.uc].map(t => toPx(cv, ...t));
    // grow the triangle by ~1px so neighbouring faces meet without hairline gaps
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    ctx.beginPath();
    pts.forEach(([x, y], i) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; const X = x + dx / l * 1.2, Y = y + dy / l * 1.2; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.closePath(); ctx.clip();
  }

  // ---- one dab of the brush at a hit on the surface
  const tmp = document.createElement('canvas'), tctx = tmp.getContext('2d', { willReadFrequently: true });
  function dab(hit, prevPoint) {
    const mesh = hit.object, cv = paintable(mesh); if (!cv) return false;
    if (!stroke.before.has(mesh)) stroke.before.set(mesh, cv.ctx.getImageData(0, 0, cv.W, cv.H));
    const dist = hit.point.distanceTo(ed.camera.position);
    const worldPerPx = 2 * dist * Math.tan(THREE.MathUtils.degToRad(ed.camera.fov / 2)) / ed.dom.clientHeight;
    const worldR = brush.size / 2 * worldPerPx;
    const ctx = cv.ctx;
    for (const face of nearFaces(mesh, hit.point, worldR)) {
      const c = uvIn(face, cv, hit.point); if (!c) continue;
      const r = Math.max(1, worldR * texScale(face, cv));
      ctx.save(); clipTri(ctx, cv, face);
      ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.clip();
      if (brush.tool === 'paint') {
        const g = ctx.createRadialGradient(c[0], c[1], r * (1 - brush.softness) * 0.98, c[0], c[1], r);
        const col = new THREE.Color(brush.color), rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
        g.addColorStop(0, `rgba(${rgb},${brush.strength})`); g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g; ctx.fillRect(c[0] - r, c[1] - r, r * 2, r * 2);
      } else if (brush.tool === 'blur') {
        const s = Math.ceil(r * 2 + 8), x0 = Math.floor(c[0] - s / 2), y0 = Math.floor(c[1] - s / 2);
        tmp.width = s; tmp.height = s; tctx.clearRect(0, 0, s, s); tctx.drawImage(cv.canvas, x0, y0, s, s, 0, 0, s, s);
        ctx.globalAlpha = brush.strength; ctx.filter = `blur(${Math.max(0.6, r * 0.18)}px)`;
        ctx.drawImage(tmp, x0, y0); ctx.filter = 'none';
      } else if (brush.tool === 'smudge' && prevPoint) {
        const p = uvIn(face, cv, prevPoint); if (!p) { ctx.restore(); continue; }
        const s = Math.ceil(r * 2), sx = Math.round(p[0] - r), sy = Math.round(p[1] - r);
        tmp.width = s; tmp.height = s; tctx.clearRect(0, 0, s, s); tctx.drawImage(stroke.snap.get(mesh), sx, sy, s, s, 0, 0, s, s);
        ctx.globalAlpha = brush.strength; ctx.drawImage(tmp, Math.round(c[0] - r), Math.round(c[1] - r));
      }
      ctx.restore();
    }
    cv.tex.needsUpdate = true;
    if (brush.tool === 'smudge') { const sn = stroke.snap.get(mesh); sn.getContext('2d').drawImage(cv.canvas, 0, 0); } // smudge carries the latest colour
    return true;
  }

  // ---- strokes
  const stroke = { on: false, before: new Map(), world: new Map(), snap: new Map(), last: null, lastXY: null };
  function worldPositions(mesh) { // every vertex where it is drawn right now (also for posed, skinned models)
    ed.root.updateMatrixWorld(true); if (mesh.isSkinnedMesh) mesh.skeleton.update();
    const n = mesh.geometry.attributes.position.count, out = new Float64Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
    return out;
  }
  function begin(x, y) {
    stroke.on = true; stroke.before = new Map(); stroke.snap = new Map(); stroke.last = null; stroke.lastXY = null;
    stroke.world = new Map(ed.meshes().map(m => [m, worldPositions(m)]));
    for (const m of ed.meshes()) { const cv = paintable(m); if (cv && brush.tool === 'smudge') { const s = document.createElement('canvas'); s.width = cv.W; s.height = cv.H; s.getContext('2d').drawImage(cv.canvas, 0, 0); stroke.snap.set(m, s); } }
    move(x, y);
  }
  function move(x, y) {
    const from = stroke.lastXY || { x, y }, d = Math.hypot(x - from.x, y - from.y), step = Math.max(1.5, brush.size * 0.2);
    const n = stroke.lastXY ? Math.floor(d / step) : 0;
    for (let i = stroke.lastXY ? 1 : 0; i <= n; i++) {
      const px = stroke.lastXY ? from.x + (x - from.x) * i / Math.max(n, 1) : x, py = stroke.lastXY ? from.y + (y - from.y) * i / Math.max(n, 1) : y;
      const hit = ed._hit(px, py);
      if (hit && hit.uv) { dab(hit, stroke.last); stroke.last = hit.point.clone(); }
      stroke.lastXY = { x: px, y: py };
    }
    if (!stroke.lastXY) stroke.lastXY = { x, y };
  }
  function end() {
    if (!stroke.on) return; stroke.on = false;
    const entries = [...stroke.before].map(([mesh, before]) => { const cv = canvases.get(mesh); return { cv, before, after: cv.ctx.getImageData(0, 0, cv.W, cv.H) }; });
    if (!entries.length) return;
    const put = which => () => entries.forEach(e => { e.cv.ctx.putImageData(e[which], 0, 0); e.cv.tex.needsUpdate = true; });
    ed._pushUndo({ paint: 'Paint stroke', smudge: 'Smudge', blur: 'Blur' }[brush.tool], put('before'), put('after'));
    ed.changed();
  }
  function eyedropper(x, y) {
    const hit = ed._hit(x, y); if (!hit || !hit.uv) return;
    const cv = paintable(hit.object); if (!cv) return;
    const [px, py] = toPx(cv, hit.uv.x, hit.uv.y), d = cv.ctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
    brush.color = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    ed.msg(`Picked colour ${brush.color}`); ed.changed();
  }

  // ---- pointer + brush outline
  const el = ed.dom;
  const local = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  el.addEventListener('pointerdown', e => {
    if (ed.mode !== 'paint' || e.button !== 0 || ed.viewOnly) return;
    const p = local(e);
    if (e.altKey) { eyedropper(p.x, p.y); return; }
    if (!ed._hit(p.x, p.y)) return; // started off the model: let the view turn as usual
    ed.orbit.enabled = false;
    try { el.setPointerCapture(e.pointerId); } catch { /* not a real pointer (e.g. scripted): painting still works */ }
    begin(p.x, p.y);
  });
  el.addEventListener('pointermove', e => {
    const p = local(e);
    if (ed.mode === 'paint') {
      Object.assign(cursor.style, { display: 'block', left: p.x - brush.size / 2 + 'px', top: p.y - brush.size / 2 + 'px', width: brush.size + 'px', height: brush.size + 'px' });
      cursor.classList.toggle('off', !ed._hit(p.x, p.y));
    } else cursor.style.display = 'none';
    if (stroke.on) move(p.x, p.y);
  });
  const stop = () => { if (stroke.on) { end(); ed.orbit.enabled = true; } };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', () => { cursor.style.display = 'none'; });
  window.addEventListener('wheel', e => { // Ctrl+wheel = brush size (plain wheel still zooms); caught before the camera sees it
    if (e.target !== el || ed.mode !== 'paint' || !e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    brush.size = THREE.MathUtils.clamp(Math.round(brush.size * (e.deltaY < 0 ? 1.12 : 0.89)), 2, 300); ed.changed();
  }, { capture: true, passive: false });

  return { brush, paintable, eyedropper };
}
