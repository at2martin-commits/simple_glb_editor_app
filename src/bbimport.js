// Import a Blockbench model (.bbmodel, "generic / free" format) as ONE light, rigid, animatable model.
//   - every group = one bone (its origin is the joint pivot) and one rigid part: each point follows exactly one bone,
//     so bending never stretches anything (action-figure style)
//   - faces hidden by parts of the SAME bone are dropped (faces between two bones stay: they show when a joint bends)
//   - flat, same-colour neighbouring faces are merged into bigger rectangles; colours go into one tiny palette texture
//   - animations are sampled at 24 fps like Blockbench's own glTF export (catmull-rom / linear / step)
//   - locators (e.g. attach_hand_right) become empty nodes under their bone
// Conventions (checked against Blockbench's own .glb export): 16 Blockbench units = 1 unit; same axes (the model
// faces -Z, its right is +X); rotations are XYZ degrees applied in Z, Y, X order (three.js Euler order 'ZYX').
import * as THREE from 'three';

const U = 1 / 16;
const FPS = 24;
const D2R = Math.PI / 180;
export const eulerQ = r => new THREE.Quaternion().setFromEuler(new THREE.Euler((+r?.[0] || 0) * D2R, (+r?.[1] || 0) * D2R, (+r?.[2] || 0) * D2R, 'ZYX'));
export const pivotM = (origin, rot) => { // rotate about a pivot: T(o) R T(-o)
  const o = new THREE.Vector3().fromArray(origin || [0, 0, 0]);
  return new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(eulerQ(rot))).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
};
const hasRot = r => !!r && r.some(v => Math.abs(+v || 0) > 1e-9);
export const round4 = v => Math.round(v * 1e4) / 1e4; // (unlike build.js r4, -0 stays -0)

async function loadImage(src) {
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error('A texture picture in the model could not be read')); img.src = src; if (img.complete && img.naturalWidth) ok(); }); // (img.decode() can stall in a background window)
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  return { canvas: c, data: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

// Corners of each cube face as [x-from/to, y, z] picks (0 = from, 1 = to), in the order
// top-left, top-right, bottom-right, bottom-left as seen from outside, matching the face's uv [u1,v1]..[u2,v2].
export const FACES = {
  north: { n: [0, 0, -1], c: [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]] },
  south: { n: [0, 0, 1], c: [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]] },
  east: { n: [1, 0, 0], c: [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]] },
  west: { n: [-1, 0, 0], c: [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]] },
  up: { n: [0, 1, 0], c: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] },
  down: { n: [0, -1, 0], c: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]] },
};

/**
 * One plane {axis, sign, plane, ua, va, rects: [[u0, u1, v0, v1, colour]]} cut into cells along every rect / blocker
 * edge (shared with build.js boxSurface). Boxes ({min, max}) right in front of the plane hide the cells they cover (-1).
 * Returns null when there are no cells, else {Us, Vs, nu, nv, cols, cell (0 = nothing, else colour index + 1), hidden}.
 */
export function planeCells(pl, boxes) {
  const R = round4;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const r of pl.rects) { u0 = Math.min(u0, r[0]); u1 = Math.max(u1, r[1]); v0 = Math.min(v0, r[2]); v1 = Math.max(v1, r[3]); }
  const front = pl.plane + pl.sign * 1e-3, blockers = [];
  for (const bx of boxes) {
    if (bx.min[pl.axis] > front || bx.max[pl.axis] < front) continue;
    const r = [Math.max(u0, R(bx.min[pl.ua])), Math.min(u1, R(bx.max[pl.ua])), Math.max(v0, R(bx.min[pl.va])), Math.min(v1, R(bx.max[pl.va]))];
    if (r[0] < r[1] && r[2] < r[3]) blockers.push(r);
  }
  const all = pl.rects.concat(blockers);
  const Us = [...new Set(all.flatMap(r => [r[0], r[1]]))].sort((a, b) => a - b);
  const Vs = [...new Set(all.flatMap(r => [r[2], r[3]]))].sort((a, b) => a - b);
  const ui = new Map(Us.map((v, i) => [v, i])), vi = new Map(Vs.map((v, i) => [v, i]));
  const nu = Us.length - 1, nv = Vs.length - 1; if (nu < 1 || nv < 1) return null;
  const cols = [], colIdx = new Map(), cell = new Int32Array(nu * nv);
  for (const r of pl.rects) {
    let c = colIdx.get(r[4]); if (c === undefined) { c = cols.length + 1; cols.push(r[4]); colIdx.set(r[4], c); }
    for (let j = vi.get(r[2]); j < vi.get(r[3]); j++) for (let i = ui.get(r[0]); i < ui.get(r[1]); i++) cell[j * nu + i] = c;
  }
  let hidden = 0;
  for (const r of blockers) for (let j = vi.get(r[2]); j < vi.get(r[3]); j++) for (let i = ui.get(r[0]); i < ui.get(r[1]); i++) { if (cell[j * nu + i] > 0) hidden++; cell[j * nu + i] = -1; }
  return { Us, Vs, nu, nv, cols, cell, hidden };
}

/**
 * Turn a parsed .bbmodel into { scene, animations, report } (a glTF-like result the editor can load).
 * opts: { name, layers (false = no clothing layers), cullBetweenBones (also hide faces pressed against another bone) }
 */
export async function importBlockbench(bb, opts = {}) {
  const report = { cubes: 0, meshes: 0, locators: 0, facesIn: 0, hidden: 0, culled: 0, merged: 0, trianglesOut: 0, bones: 0, animations: 0, notes: [] };
  // ---------------- textures
  const texs = await Promise.all((bb.textures || []).map(async t => {
    if (!t.source || !String(t.source).startsWith('data:')) { report.notes.push(`texture "${t.name}" has no embedded picture`); return null; }
    const im = await loadImage(t.source);
    return { ...im, uvW: t.uv_width || bb.resolution?.width || im.w, uvH: t.uv_height || bb.resolution?.height || im.h, name: t.name, uuid: t.uuid };
  }));
  const texOf = ref => (ref === null || ref === undefined || ref === false) ? null : (typeof ref === 'number' ? texs[ref] : texs.find(t => t && t.uuid === ref) || texs[+ref] || null);

  // ---------------- groups -> bones
  const groupData = Object.fromEntries((bb.groups || []).map(g => [g.uuid, g]));
  const elements = Object.fromEntries((bb.elements || []).map(e => [e.uuid, e]));
  const used = new Set(), uniq = n => { let b = THREE.PropertyBinding.sanitizeNodeName(n || 'bone') || 'bone', s = b, i = 2; while (used.has(s)) s = `${b}_${i++}`; used.add(s); return s; };
  const bones = [], boneOfGroup = new Map(), groupWorld = new Map(), elemOwner = new Map(), locators = [];
  let loose = false; // elements that sit outside every group
  const walk = (nodes, parentG, parentGM, parentBone) => {
    for (const n of nodes) {
      if (typeof n === 'string') { // an element
        const el = elements[n]; if (!el || (el.export === false && !el.glb_collider)) continue; // colliders are not exported by Blockbench but are ours
        elemOwner.set(n, { group: parentG, gm: parentGM });
        if (!parentG) loose = true;
        continue;
      }
      const g = { ...(groupData[n.uuid] || {}), ...(groupData[n.uuid] ? {} : n), children: n.children || [] };
      if (g.export === false) continue;
      const gm = parentGM.clone().multiply(pivotM(g.origin, g.rotation)); // what this group does to everything in it
      const bone = new THREE.Bone(); bone.name = uniq(g.name);
      const boneWorld = parentGM.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3().fromArray(g.origin || [0, 0, 0]), eulerQ(g.rotation), new THREE.Vector3(1, 1, 1)));
      bone.userData.world = boneWorld; bone.userData.uuid = n.uuid;
      if (g.glb_slide?.axis) bone.userData.slideBB = g.glb_slide; // slide joint (moves along a rail, no turning)
      if (parentBone) parentBone.add(bone);
      bones.push(bone); boneOfGroup.set(n.uuid, bone); groupWorld.set(n.uuid, gm);
      walk(g.children, n.uuid, gm, bone);
    }
  };
  walk(bb.outliner || [], null, new THREE.Matrix4(), null);
  if (loose && bones.length) { // parts outside every group follow a root bone
    const r = new THREE.Bone(); r.name = uniq('root_static'); r.userData.world = new THREE.Matrix4(); r.userData.uuid = null;
    bones.unshift(r); for (const [k, v] of elemOwner) if (!v.group) elemOwner.set(k, { group: null, gm: v.gm, bone: r });
  }
  // bone local transforms from their world rest matrices (in Blockbench units, scaled at the end)
  for (const b of bones) {
    const parentW = b.parent?.isBone ? b.parent.userData.world : new THREE.Matrix4();
    const local = new THREE.Matrix4().copy(parentW).invert().multiply(b.userData.world);
    local.decompose(b.position, b.quaternion, b.scale);
    b.position.multiplyScalar(U);
  }
  report.bones = bones.length;
  const boneIndex = new Map(bones.map((b, i) => [b, i]));
  const ownerBone = uuid => { const o = elemOwner.get(uuid); return o ? (o.bone || boneOfGroup.get(o.group) || null) : null; };

  // ---------------- faces
  // a face: { bone, P:[4 or 3 Vector3 world, BB units], uv:[[u,v] in source pixels]|null, tex, flat:colourKey|null, axis info }
  const colliders = []; // invisible shapes for the game (Build mode colliders)
  const faces = [];
  const cubeInfo = []; // for the "covered by the same bone" test
  // Clothing layers: a part named <slot>__<set>__<piece> (e.g. hat__cap__visor) belongs to the layer "hat__cap". Each layer
  // becomes its own mesh on the shared skeleton, and faces are only hidden / merged against parts of the SAME bone AND layer,
  // so the body stays whole under clothes that can be switched off. opts.layers === false merges everything as before.
  const layerOf = name => { if (opts.layers === false) return ''; const q = String(name || '').split('__'); return q.length >= 3 && q[0] && q[1] ? `${q[0]}__${q[1]}` : ''; };
  const grpCache = new Map(), gk = (bone, layer) => { const k = (boneIndex.get(bone) ?? -1) + '|' + layer; if (!grpCache.has(k)) grpCache.set(k, { bone, layer }); return grpCache.get(k); };
  for (const el of bb.elements || []) {
    if (el.glb_collider) { const owner = elemOwner.get(el.uuid); if (owner) colliders.push({ el, owner }); continue; }
    if (el.export === false) continue;
    const owner = elemOwner.get(el.uuid); if (!owner) continue;
    const bone = ownerBone(el.uuid), layer = layerOf(el.name), grp = gk(bone, layer);
    if (el.type === 'locator' || el.type === 'null_object') {
      locators.push({ el, owner }); report.locators++; continue;
    }
    if (el.type === 'mesh') {
      report.meshes++;
      const M = owner.gm.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3().fromArray(el.origin || [0, 0, 0]), eulerQ(el.rotation), new THREE.Vector3(1, 1, 1)));
      const V = Object.fromEntries(Object.entries(el.vertices || {}).map(([k, v]) => [k, new THREE.Vector3().fromArray(v).applyMatrix4(M)]));
      for (const f of Object.values(el.faces || {})) {
        report.facesIn++;
        const tex = texOf(f.texture); if (f.texture === null || f.texture === undefined || f.texture === false) { report.hidden++; continue; }
        let ids = f.vertices.filter(k => V[k]); if (ids.length < 3) continue;
        if (ids.length === 4) ids = sortQuad(ids, V); // Blockbench may store a quad's corners in any order
        faces.push({ bone, layer, grp, P: ids.map(k => V[k].clone()), uv: ids.map(k => f.uv?.[k] || [0, 0]), tex, mergeable: false });
      }
      continue;
    }
    // cube
    report.cubes++;
    const inf = +el.inflate || 0;
    const from = (el.from || [0, 0, 0]).map(v => +v - inf), to = (el.to || [0, 0, 0]).map(v => +v + inf);
    const M = owner.gm.clone().multiply(pivotM(el.origin, el.rotation));
    const rotated = hasRot(el.rotation) || !isAxisAligned(owner.gm);
    const inv = M.clone().invert();
    const box = rotated ? null : (() => { const a = new THREE.Vector3(...from).applyMatrix4(M), b = new THREE.Vector3(...to).applyMatrix4(M); return { min: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)], max: [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)] }; })();
    cubeInfo.push({ bone, layer, grp, from, to, inv, uuid: el.uuid, box });
    for (const [side, def] of Object.entries(FACES)) {
      const f = el.faces?.[side]; if (!f) continue;
      report.facesIn++;
      if (f.texture === null || f.texture === undefined || f.texture === false) { report.hidden++; continue; }
      const P = def.c.map(([ix, iy, iz]) => new THREE.Vector3(ix ? to[0] : from[0], iy ? to[1] : from[1], iz ? to[2] : from[2]).applyMatrix4(M));
      const [u1, v1, u2, v2] = f.uv || [0, 0, 0, 0];
      let uv = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
      const r = ((+f.rotation || 0) / 90) & 3; for (let k = 0; k < r; k++) uv = [uv[3], uv[0], uv[1], uv[2]]; // face uv rotation
      P.reverse(); uv.reverse(); // the table lists corners clockwise from outside; faces must wind counter-clockwise to face out
      const fr = el.glb_frames?.[side];
      if (fr?.frames) { // expression frames: this side becomes its own mesh so the game can swap its picture
        const nm = el.name + (Object.keys(el.glb_frames).length > 1 ? '_' + side : '');
        faces.push({ bone, layer: 'framed:' + nm, grp: gk(bone, 'framed:' + nm), P, uv, tex: texOf(f.texture), mergeable: false, cube: el.uuid, side, local: { from, to }, framed: { name: nm, info: fr, layer } });
        continue;
      }
      faces.push({ bone, layer, grp, P, uv, tex: texOf(f.texture), mergeable: !rotated, cube: el.uuid, side, local: { from, to } });
    }
  }

  // ---------------- drop faces covered by parts of the SAME bone
  const byBone = new Map(); for (const c of cubeInfo) { (byBone.get(c.grp) || byBone.set(c.grp, []).get(c.grp)).push(c); } // keyed by bone + layer
  const cellOf = v => `${Math.floor(v.x / 4)},${Math.floor(v.y / 4)},${Math.floor(v.z / 4)}`;
  const boneGrid = new Map();
  for (const [b, list] of byBone) {
    const grid = new Map();
    for (const c of list) { // bounding box of the cube in world space -> cells
      const corners = []; for (const ix of [0, 1]) for (const iy of [0, 1]) for (const iz of [0, 1]) corners.push(new THREE.Vector3(ix ? c.to[0] : c.from[0], iy ? c.to[1] : c.from[1], iz ? c.to[2] : c.from[2]).applyMatrix4(new THREE.Matrix4().copy(c.inv).invert()));
      const bx = new THREE.Box3().setFromPoints(corners);
      for (let x = Math.floor(bx.min.x / 4); x <= Math.floor(bx.max.x / 4); x++) for (let y = Math.floor(bx.min.y / 4); y <= Math.floor(bx.max.y / 4); y++) for (let z = Math.floor(bx.min.z / 4); z <= Math.floor(bx.max.z / 4); z++) {
        const k = `${x},${y},${z}`; (grid.get(k) || grid.set(k, []).get(k)).push(c);
      }
    }
    boneGrid.set(b, grid);
  }
  const insideOther = (p, bone, selfUuid) => {
    const list = boneGrid.get(bone)?.get(cellOf(p)); if (!list) return false;
    const q = new THREE.Vector3();
    for (const c of list) {
      if (c.uuid === selfUuid) continue;
      q.copy(p).applyMatrix4(c.inv);
      if (q.x >= c.from[0] - 1e-4 && q.x <= c.to[0] + 1e-4 && q.y >= c.from[1] - 1e-4 && q.y <= c.to[1] + 1e-4 && q.z >= c.from[2] - 1e-4 && q.z <= c.to[2] + 1e-4) return true;
    }
    return false;
  };
  // ---------------- colours: is a face one flat colour?
  const colourOf = f => {
    const t = f.tex; if (!t) return 'ffffffff';
    const xs = f.uv.map(u => u[0] / t.uvW * t.w), ys = f.uv.map(u => u[1] / t.uvH * t.h);
    let x0 = Math.floor(Math.min(...xs) + 1e-6), x1 = Math.ceil(Math.max(...xs) - 1e-6), y0 = Math.floor(Math.min(...ys) + 1e-6), y1 = Math.ceil(Math.max(...ys) - 1e-6);
    if (x1 <= x0) x1 = x0 + 1; if (y1 <= y0) y1 = y0 + 1;
    x0 = Math.max(0, Math.min(t.w - 1, x0)); y0 = Math.max(0, Math.min(t.h - 1, y0)); x1 = Math.max(x0 + 1, Math.min(t.w, x1)); y1 = Math.max(y0 + 1, Math.min(t.h, y1));
    let first = null;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * t.w + x) * 4, c = (t.data[o] << 24 | t.data[o + 1] << 16 | t.data[o + 2] << 8 | t.data[o + 3]) >>> 0;
      if (first === null) first = c; else if (c !== first) return null;
    }
    return first.toString(16).padStart(8, '0');
  };
  for (const f of faces) f.flat = f.framed ? null : colourOf(f); // a framed side always uses its picture (its uvs get swapped)

  const kept = [];
  for (const f of faces) {
    if (f.P.length !== 4 || !f.cube || (f.flat && f.mergeable)) { kept.push(f); continue; } // straight flat faces: hidden cell by cell below
    const n = new THREE.Vector3().subVectors(f.P[1], f.P[0]).cross(new THREE.Vector3().subVectors(f.P[3], f.P[0])).normalize();
    const eps = n.clone().multiplyScalar(0.01);
    let covered = true;
    for (const a of [0.08, 0.5, 0.92]) { // a 3x3 grid of spots just outside the face
      for (const b of [0.08, 0.5, 0.92]) {
        const top = f.P[0].clone().lerp(f.P[1], a), bot = f.P[3].clone().lerp(f.P[2], a), p = top.lerp(bot, b).add(eps);
        if (!insideOther(p, f.grp, f.cube)) { covered = false; break; }
      }
      if (!covered) break;
    }
    if (covered) report.culled++; else kept.push(f);
  }

  // ---------------- merge on the SURFACE: per bone + plane, across cube boundaries (greedy rectangles per colour)
  // Each plane is cut into cells along every face / neighbour edge; a cell shows the face's colour unless a cube of the
  // same bone sits right in front of it (then that part is hidden, even when the rest of the face shows).
  const out = [];
  const planes = new Map(), R = round4;
  for (const f of kept) {
    if (!f.flat || !f.mergeable || f.P.length !== 4) { out.push(f); continue; }
    const nrm = FACES[f.side].n, axis = nrm[0] ? 0 : nrm[1] ? 1 : 2, sign = nrm[axis];
    const plane = R(f.P[0].getComponent(axis));
    const key = `${boneIndex.get(f.bone)}|${f.layer}|${axis}|${sign}|${plane}`;
    const [ua, va] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
    const us = f.P.map(p => R(p.getComponent(ua))), vs = f.P.map(p => R(p.getComponent(va)));
    (planes.get(key) || planes.set(key, { bone: f.bone, layer: f.layer, grp: f.grp, axis, sign, plane, ua, va, rects: [] }).get(key)).rects.push([Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs), f.flat]);
  }
  const straightByBone = new Map(); for (const c of cubeInfo) if (c.box) (straightByBone.get(c.grp) || straightByBone.set(c.grp, []).get(c.grp)).push(c.box);
  const allStraight = new Map(); for (const c of cubeInfo) if (c.box) (allStraight.get(c.layer) || allStraight.set(c.layer, []).get(c.layer)).push(c.box); // per layer
  let facesToMerge = 0, quadsOut = 0, cellsHidden = 0;
  for (const pl of planes.values()) {
    facesToMerge += pl.rects.length;
    // same-bone cubes right in front of this plane (opts.cullBetweenBones: also faces pressed against another bone, which can open up when a joint bends)
    const pc = planeCells(pl, (opts.cullBetweenBones ? allStraight.get(pl.layer) : straightByBone.get(pl.grp)) || []); if (!pc) continue;
    const { Us, Vs, nu, nv, cols, cell } = pc; cellsHidden += pc.hidden;
    // cells with a same-bone cube right in front are hidden for good (-1): a quad may run across them (DC = "don't care")
    const DC = -1;
    const corner = (u, v) => { const p = new THREE.Vector3(); p.setComponent(pl.axis, pl.plane); p.setComponent(pl.ua, u); p.setComponent(pl.va, v); return p; };
    // greedy cover, tried along u first and along v first; keep whichever needs fewer quads
    const cover = vFirst => {
      const W = vFirst ? nv : nu, H = vFirst ? nu : nv, at = (x, y) => vFirst ? x * nu + y : y * nu + x;
      const done = new Uint8Array(nu * nv), quads = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k0 = at(x, y), c = cell[k0]; if (c <= 0 || done[k0]) continue;
        const ok = k => cell[k] === c || cell[k] === DC; // same colour (even if already covered: same colour on top is invisible) or hidden
        let x1 = x; while (x1 + 1 < W && ok(at(x1 + 1, y))) x1++;
        let y1 = y; grow: while (y1 + 1 < H) { for (let k = x; k <= x1; k++) if (!ok(at(k, y1 + 1))) break grow; y1++; }
        // trim edges that only run through hidden cells
        const real = (xa, xb, ya, yb) => { for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) if (cell[at(xx, yy)] === c) return true; return false; };
        let xa = x, ya = y;
        while (y1 > ya && !real(xa, x1, y1, y1)) y1--;
        while (x1 > xa && !real(x1, x1, ya, y1)) x1--;
        while (xa < x1 && !real(xa, xa, ya, y1)) xa++;
        for (let yy = ya; yy <= y1; yy++) for (let xx = xa; xx <= x1; xx++) { const k = at(xx, yy); if (cell[k] === c) done[k] = 1; }
        quads.push(vFirst ? [ya, y1, xa, x1, c] : [xa, x1, ya, y1, c]); // [i0, i1, j0, j1, colour]
      }
      return quads;
    };
    const qa = cover(false), qb = cover(true), best = qb.length < qa.length ? qb : qa;
    for (const [i0, i1, j0, j1, c] of best) {
      let P = [corner(Us[i0], Vs[j0]), corner(Us[i1 + 1], Vs[j0]), corner(Us[i1 + 1], Vs[j1 + 1]), corner(Us[i0], Vs[j1 + 1])];
      const nn = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0]));
      if (nn.getComponent(pl.axis) * pl.sign < 0) P = [P[0], P[3], P[2], P[1]]; // face outward
      out.push({ bone: pl.bone, layer: pl.layer, P, flat: cols[c - 1] }); quadsOut++;
    }
  }
  report.merged = facesToMerge - quadsOut; report.surfaceFaces = facesToMerge; report.surfaceQuads = quadsOut; report.partHiddenCells = cellsHidden;

  // ---------------- atlas: flat colours as 2x2 cells + any source texture a non-flat face needs
  const colours = [...new Set(out.filter(f => f.flat).map(f => f.flat))];
  const needTex = [...new Set(out.filter(f => !f.flat && f.tex).map(f => f.tex))];
  const cellsPerRow = Math.max(1, Math.ceil(Math.sqrt(colours.length)));
  const palW = cellsPerRow * 2, palH = Math.ceil(colours.length / cellsPerRow) * 2;
  let AW = Math.max(palW, ...needTex.map(t => t.w), 1), AH = palH;
  const place = new Map(); let x = 0, y = palH, rowH = 0; // simple shelf packing below the palette
  for (const t of [...needTex].sort((a, b) => b.h - a.h)) {
    if (x + t.w > AW) { x = 0; y += rowH; rowH = 0; }
    place.set(t, { x, y }); x += t.w; rowH = Math.max(rowH, t.h); AH = Math.max(AH, y + rowH);
  }
  AH = Math.max(AH, 1);
  const atlas = document.createElement('canvas'); atlas.width = AW; atlas.height = AH;
  const ax = atlas.getContext('2d');
  const colourUV = new Map();
  colours.forEach((c, i) => {
    const cx = (i % cellsPerRow) * 2, cy = Math.floor(i / cellsPerRow) * 2, n = parseInt(c, 16) >>> 0;
    ax.fillStyle = `rgba(${n >>> 24},${(n >>> 16) & 255},${(n >>> 8) & 255},${(n & 255) / 255})`; ax.fillRect(cx, cy, 2, 2);
    colourUV.set(c, [(cx + 1) / AW, (cy + 1) / AH]);
  });
  for (const [t, p] of place) ax.drawImage(t.canvas, p.x, p.y);
  const translucent = colours.some(c => (parseInt(c, 16) & 255) < 255) || needTex.length > 0;

  // ---------------- rigid, skinned meshes (corners with the same place, facing, colour and bone are shared):
  // one for the body, plus one per clothing layer, all on the same skeleton
  function buildGeometry(list) {
    const pos = [], nor = [], uvs = [], si = [], sw = [], idx = [], vmap = new Map();
    const b = new THREE.Vector3(), n = new THREE.Vector3();
    for (const f of list) {
      const bi = boneIndex.get(f.bone) ?? 0;
      n.subVectors(f.P[1], f.P[0]).cross(b.subVectors(f.P[2], f.P[0])); if (n.lengthSq() < 1e-14 && f.P[3]) n.subVectors(f.P[2], f.P[0]).cross(b.subVectors(f.P[3], f.P[0]));
      n.normalize();
      const ids = f.P.map((p, k) => {
        let tu = 0, tv = 0;
        if (f.flat) [tu, tv] = colourUV.get(f.flat);
        else if (f.tex) { const pl = place.get(f.tex), [u, v] = f.uv[k]; tu = (pl.x + u / f.tex.uvW * f.tex.w) / AW; tv = (pl.y + v / f.tex.uvH * f.tex.h) / AH; }
        const key = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}|${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}|${tu.toFixed(5)},${tv.toFixed(5)}|${bi}`;
        let id = vmap.get(key);
        if (id === undefined) { id = pos.length / 3; vmap.set(key, id); pos.push(p.x * U, p.y * U, p.z * U); nor.push(n.x, n.y, n.z); uvs.push(tu, tv); si.push(bi, 0, 0, 0); sw.push(1, 0, 0, 0); }
        return id;
      });
      if (ids.length === 3) idx.push(ids[0], ids[1], ids[2]); else idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(Uint16Array.from(uvs, v => Math.round(Math.min(1, Math.max(0, v)) * 65535)), 2, true)); // 16-bit texture coords (glTF core allows them)
    g.setIndex(idx);
    if (bones.length) {
      g.setAttribute('skinIndex', bones.length <= 256 ? new THREE.Uint8BufferAttribute(si, 4) : new THREE.Uint16BufferAttribute(si, 4)); // 8-bit joints when they fit
      g.setAttribute('skinWeight', new THREE.BufferAttribute(Uint8Array.from(sw, w => Math.round(w * 255)), 4, true)); // rigid 1/0 weights fit in a byte (glTF: unsigned byte, normalized)
    }
    return { g, verts: pos.length / 3, tris: idx.length / 3 };
  }
  const tex = new THREE.CanvasTexture(atlas);
  tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  tex.name = (opts.name || 'model') + '_atlas';
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, alphaTest: translucent ? 0.5 : 0, side: THREE.FrontSide });
  mat.name = (opts.name || 'model') + '_mat';
  const scene = new THREE.Group(); scene.name = 'Scene';
  const meshName = THREE.PropertyBinding.sanitizeNodeName(opts.name || 'model') || 'model';
  const layerNames = [...new Set(out.map(f => f.layer || ''))].sort((p, q) => (p === '' ? -1 : q === '' ? 1 : p.localeCompare(q)));
  const hasLayers = layerNames.some(l => l && !l.startsWith('framed:'));
  let skeleton = null;
  if (bones.length) {
    const roots = bones.filter(bn => !bn.parent?.isBone);
    const holder = new THREE.Object3D(); holder.name = 'Armature';
    roots.forEach(r => holder.add(r)); scene.add(holder); scene.updateMatrixWorld(true);
    skeleton = new THREE.Skeleton(bones);
  }
  report.vertices = 0; report.trianglesOut = 0; report.layers = [];
  for (const layer of layerNames.length ? layerNames : ['']) {
    const mine = out.filter(f => (f.layer || '') === layer), built = buildGeometry(mine), fr = mine.find(f => f.framed)?.framed, frFace = mine.find(f => f.framed);
    const m = skeleton ? new THREE.SkinnedMesh(built.g, mat) : new THREE.Mesh(built.g, mat);
    m.name = uniq(fr ? fr.name : layer || (hasLayers ? 'body' : meshName)); // unique among joints and attach points too (animation tracks bind by name)
    if (layer && !fr) m.userData.layer = layer; // a switchable clothing set (show / hide it by name)
    if (fr) { // expression frames: rectangles in the atlas (u, v, w, h in 0..1, v down from the top as the texture is stored)
      const t = frFace.tex, pl = place.get(t);
      m.userData.frames = Object.fromEntries(Object.entries(fr.info.frames).map(([k, [x, y, w, h]]) => [k, [(pl.x + x / t.uvW * t.w) / AW, (pl.y + y / t.uvH * t.h) / AH, (w / t.uvW * t.w) / AW, (h / t.uvH * t.h) / AH].map(v => Math.round(v * 1e6) / 1e6)]));
      m.userData.frame = m.userData.frameDefault = fr.info.current;
      if (fr.layer) m.userData.layer = fr.layer;
      (report.framed ||= []).push({ name: m.name, frames: Object.keys(fr.info.frames) });
    }
    scene.add(m);
    if (skeleton) { scene.updateMatrixWorld(true); m.bind(skeleton, new THREE.Matrix4()); m.frustumCulled = false; }
    report.vertices += built.verts; report.trianglesOut += built.tris;
    if (hasLayers) report.layers.push({ name: m.name, triangles: built.tris });
  }

  // ---------------- attach points (locators) as empty nodes under their bone
  for (const { el, owner } of locators) {
    const o = new THREE.Object3D(); o.name = uniq(el.name);
    const world = owner.gm.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3().fromArray(el.position || [0, 0, 0]), eulerQ(el.rotation), new THREE.Vector3(1, 1, 1)));
    const parent = (owner.bone || boneOfGroup.get(owner.group)) || null;
    const parentW = parent ? parent.userData.world : new THREE.Matrix4();
    new THREE.Matrix4().copy(parentW).invert().multiply(world).decompose(o.position, o.quaternion, o.scale);
    o.position.multiplyScalar(U);
    (parent || scene).add(o);
  }
  // ---------------- colliders: empty nodes under their joint, extras.collider = { shape, size (metres), radius?, height? }
  for (const { el, owner } of colliders) {
    const box = el.type === 'mesh' && el.glb_shape ? { from: el.glb_shape.from, to: el.glb_shape.to } : { from: el.from || [0, 0, 0], to: el.to || [0, 0, 0] };
    const lo = box.from.map((v, i) => Math.min(v, box.to[i])), hi = box.from.map((v, i) => Math.max(v, box.to[i])), size = hi.map((v, i) => v - lo[i]);
    const M = owner.gm.clone().multiply(pivotM(el.origin || [0, 0, 0], el.rotation || [0, 0, 0])).multiply(new THREE.Matrix4().makeTranslation(...lo.map((v, i) => v + size[i] / 2)));
    const o = new THREE.Object3D(); o.name = uniq(el.name || 'collider');
    const parent = (owner.bone || boneOfGroup.get(owner.group)) || null, parentW = parent ? parent.userData.world : new THREE.Matrix4();
    new THREE.Matrix4().copy(parentW).invert().multiply(M).decompose(o.position, o.quaternion, o.scale);
    o.position.multiplyScalar(U); o.scale.set(1, 1, 1);
    const sz = size.map(v => Math.round(v * U * 1e5) / 1e5), shape = el.glb_collider;
    o.userData.collider = { shape, size: sz, ...(shape === 'sphere' ? { radius: Math.max(...sz) / 2 } : {}), ...(shape === 'capsule' ? { radius: Math.max(sz[0], sz[2]) / 2, height: sz[1] } : {}) };
    (parent || scene).add(o); report.colliders = (report.colliders || 0) + 1;
  }
  for (const bn of bones) {
    delete bn.userData.world; delete bn.userData.uuid;
    const sl = bn.userData.slideBB; delete bn.userData.slideBB;
    if (sl) { bn.userData.slide = { axis: sl.axis.map(Number), min: +sl.min * U, max: +sl.max * U, rest: bn.position.toArray(), restQ: bn.quaternion.toArray() }; report.slides = (report.slides || 0) + 1; }
  }

  // ---------------- animations
  const animations = [];
  for (const anim of bb.animations || []) {
    const len = Math.max(+anim.length || 0, 1 / FPS), tracks = [];
    const frames = Math.round(len * FPS), times = [];
    for (let i = 0; i <= frames; i++) times.push(Math.min(len, i / FPS));
    for (const [uid, an] of Object.entries(anim.animators || {})) {
      const bone = boneOfGroup.get(uid); if (!bone || !an.keyframes?.length) continue;
      const restQ = bone.quaternion.clone(), restP = bone.position.clone(), restS = bone.scale.clone();
      const byCh = { rotation: [], position: [], scale: [] };
      for (const k of an.keyframes) if (byCh[k.channel]) byCh[k.channel].push(k);
      for (const [ch, keys] of Object.entries(byCh)) {
        if (!keys.length) continue;
        keys.sort((p, q) => p.time - q.time);
        const vals = [];
        for (const t of times) {
          const v = sampleChannel(keys, t, report, anim.loop === 'loop' ? len : 0);
          if (ch === 'rotation') vals.push(...restQ.clone().multiply(eulerQ(v)).toArray());
          else if (ch === 'position') vals.push(restP.x + v[0] * U, restP.y + v[1] * U, restP.z + v[2] * U);
          else vals.push(restS.x * v[0], restS.y * v[1], restS.z * v[2]);
        }
        if (ch === 'rotation') tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, vals));
        else tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.${ch === 'position' ? 'position' : 'scale'}`, times, vals));
      }
    }
    const clip = new THREE.AnimationClip(THREE.PropertyBinding.sanitizeNodeName(anim.name || 'animation'), len, tracks);
    clip.userData = { loop: anim.loop || 'once' };
    animations.push(clip);
  }
  report.animations = animations.length;
  report.atlas = `${AW}x${AH}`;
  report.colours = colours.length;
  return { scene, animations, report };
}

// one channel's value [x,y,z] at time t (Blockbench: catmull-rom, linear, step; values may be strings)
// looping clips: the curve wraps round, so the first and last keys see their neighbours across the loop (as Blockbench does)
function sampleChannel(keys, t, report, loopLen = 0) {
  const val = (k, i = 0) => { const d = k.data_points?.[Math.min(i, (k.data_points?.length || 1) - 1)] || {}; return ['x', 'y', 'z'].map(a => { const n = parseFloat(d[a]); if (isNaN(n) && d[a] !== undefined && d[a] !== '') { if (!report._expr) { report._expr = 1; report.notes.push('some keyframes use formulas (Molang); those values were read as 0'); } } return isNaN(n) ? 0 : n; }); };
  if (t <= keys[0].time) return val(keys[0]);
  const last = keys[keys.length - 1]; if (t >= last.time) return val(last, 1);
  let i = 0; while (i < keys.length - 2 && keys[i + 1].time <= t) i++;
  const k1 = keys[i], k2 = keys[i + 1], f = (t - k1.time) / Math.max(k2.time - k1.time, 1e-9);
  const p1 = val(k1, 1), p2 = val(k2, 0);
  if (k1.interpolation === 'step') return p1;
  if (k1.interpolation === 'catmullrom' || k2.interpolation === 'catmullrom') {
    const n = keys.length, eps = 1e-4;
    const wrapPrev = () => { if (!loopLen || n < 2) return null; const k = keys[n - 1].time < loopLen - eps ? keys[n - 1] : keys[n - 2]; return keys[0].time < eps && k !== k1 ? val(k, 1) : null; };
    const wrapNext = () => { if (!loopLen || n < 2) return null; const k = keys[0].time > eps ? keys[0] : keys[1]; return last.time > loopLen - eps && k !== k2 ? val(k, 0) : null; };
    const p0 = i > 0 ? val(keys[i - 1], 1) : (wrapPrev() || p1), p3 = i + 2 < n ? val(keys[i + 2], 0) : (wrapNext() || p2);
    return p1.map((_, a) => 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * f + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * f * f + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * f * f * f));
  }
  return p1.map((v, a) => v + (p2[a] - v) * f);
}

// put a quad's 4 corners in order around the face (keeping the face pointing the way its first corners do)
function sortQuad(ids, V) {
  const P = ids.map(k => V[k]), c = P.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(4);
  const n = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0]));
  if (n.lengthSq() < 1e-14) n.subVectors(P[2], P[0]).cross(new THREE.Vector3().subVectors(P[3], P[0]));
  n.normalize();
  const ax = new THREE.Vector3().subVectors(P[0], c).normalize(), ay = new THREE.Vector3().crossVectors(n, ax);
  return ids.map((k, i) => [k, Math.atan2(new THREE.Vector3().subVectors(P[i], c).dot(ay), new THREE.Vector3().subVectors(P[i], c).dot(ax))]).sort((p, q) => p[1] - q[1]).map(p => p[0]);
}
function isAxisAligned(m) { // a matrix with no rotation (only translation)
  const e = m.elements; return Math.abs(e[1]) < 1e-9 && Math.abs(e[2]) < 1e-9 && Math.abs(e[4]) < 1e-9 && Math.abs(e[6]) < 1e-9 && Math.abs(e[8]) < 1e-9 && Math.abs(e[9]) < 1e-9;
}
