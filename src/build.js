// Build mode: make models the Blockbench way — parts (cube, cylinder, cone, sphere, pyramid, wedge) placed on a
// grid, grouped into folders with a pivot each (a group = a joint that can bend), coloured face by face.
// Tools: Move, Stretch (pull a side), Rotate, Pivot (where it turns), Paint (colour a side; Shift = whole part).
// Copy / paste / duplicate, mirror copy (left <-> right), flip, group / ungroup.
// The project is a real Blockbench file (.bbmodel): save it, open it in Blockbench, or "Make model" to get a light,
// rigged model in the editor (through src/bbimport.js: each group becomes a bone, parts are rigid).
// Units are Blockbench units (16 = 1 metre / 1 block). Coordinates of everything inside groups are absolute,
// exactly like Blockbench: a group only adds its rotation around its pivot.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { eulerQ, pivotM, FACES, round4, planeCells } from './bbimport.js';

const U = 1 / 16, D2R = Math.PI / 180, R2D = 180 / Math.PI;
const SIDES = ['north', 'south', 'east', 'west', 'up', 'down'];
/** Plain names for the sides, as seen on a model that faces +Z: front = +Z (south), back = -Z (north), left = +X (east, the model's own left), right = -X (west), top, bottom. */
export const SIDE_ALIAS = { front: 'south', back: 'north', left: 'east', right: 'west', top: 'up', bottom: 'down' };
const NICE_SIDE = Object.fromEntries(Object.entries(SIDE_ALIAS).map(([k, v]) => [v, k]));
export const sideName = s => (typeof s === 'string' && SIDE_ALIAS[s.toLowerCase()]) || s;
const DIR = Object.fromEntries(Object.entries(FACES).map(([s, f]) => [s, f.n])); // outward normal of each side
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
export const SHAPES = {
  cube: { label: 'Cube', icon: '◼', help: 'A box. Stretch any side to make planks, walls, limbs.' },
  cylinder: { label: 'Cylinder', icon: '⬮', help: 'A round post or wheel (round around the up axis).' },
  cone: { label: 'Cone', icon: '▲', help: 'A round cone: hats, spikes, roofs.' },
  sphere: { label: 'Sphere', icon: '●', help: 'A ball. Stretch it into an egg or a blob.' },
  pyramid: { label: 'Pyramid', icon: '◭', help: 'A square-based point: roofs, tips, studs.' },
  wedge: { label: 'Wedge', icon: '◢', help: 'A ramp: high at the back, sloping down to the front. Flip it to turn it round.' },
  hexagon: { label: 'Hexagon', icon: '⬢', help: 'A six-sided post (hex prism): nuts, pillars, honeycomb, gems.' },
  pentagon: { label: 'Pentagon', icon: '⬟', help: 'A five-sided post (pentagon prism): pillars, shields, crystals.' },
};
const r4 = v => Math.round(v * 1e4) / 1e4 + 0; // (+0 turns -0 into 0)
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const qEuler = q => { const e = new THREE.Euler().setFromQuaternion(q, 'ZYX'); return [e.x, e.y, e.z].map(a => Math.round(a * R2D * 1000) / 1000 + 0); };
const sideOf = n => { const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)], i = a.indexOf(Math.max(...a)); return i === 0 ? (n.x > 0 ? 'east' : 'west') : i === 1 ? (n.y > 0 ? 'up' : 'down') : (n.z > 0 ? 'south' : 'north'); };
const clone = o => JSON.parse(JSON.stringify(o));
const hex = c => '#' + c.getHexString();

// ---------------------------------------------------------------- shape geometry (in a unit box 0..1)
const unitCache = new Map();
const NATURAL = {}; // shape -> [x, y, z] proportions of the regular shape (prisms), so new ones start out regular
function polyGeo(pts, faces) { // convex solid from points + faces (any winding; fixed to face outward)
  const c = pts.reduce((s, p) => s.add(v3(p)), new THREE.Vector3()).divideScalar(pts.length), out = [];
  for (const f of faces) {
    const P = f.map(i => v3(pts[i])), n = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0]));
    const fc = P.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(P.length);
    if (n.dot(fc.sub(c)) < 0) P.reverse();
    for (let k = 1; k + 1 < P.length; k++) out.push(...P[0].toArray(), ...P[k].toArray(), ...P[k + 1].toArray());
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
}
function unitGeo(shape, sides = 12) {
  const key = shape + '|' + sides;
  if (unitCache.has(key)) return unitCache.get(key);
  let g;
  const s = Math.max(3, Math.min(48, Math.round(sides) || 12));
  if (shape === 'cylinder') g = new THREE.CylinderGeometry(0.5, 0.5, 1, s);
  else if (shape === 'cone') g = new THREE.ConeGeometry(0.5, 1, s);
  else if (shape === 'sphere') g = new THREE.SphereGeometry(0.5, s, Math.max(3, Math.round(s / 2)));
  else if (shape === 'pyramid') g = polyGeo([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0.5, 1, 0.5]], [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]);
  else if (shape === 'hexagon' || shape === 'pentagon') { // regular prisms, squeezed to fill the box (natural shape kept in NATURAL)
    g = new THREE.CylinderGeometry(0.5, 0.5, 1, shape === 'hexagon' ? 6 : 5); g.computeBoundingBox();
    const bb = g.boundingBox, sz = bb.getSize(new THREE.Vector3()); NATURAL[shape] = [sz.x / sz.y, 1, sz.z / sz.y];
    g.translate(-bb.min.x, -bb.min.y, -bb.min.z); g.scale(1 / sz.x, 1 / sz.y, 1 / sz.z);
  }
  else if (shape === 'wedge') g = polyGeo([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0]], [[0, 1, 2, 3], [0, 1, 5, 4], [4, 5, 2, 3], [0, 4, 3], [1, 5, 2]]);
  else g = new THREE.BoxGeometry(1, 1, 1);
  if (!['pyramid', 'wedge', 'hexagon', 'pentagon'].includes(shape)) g.translate(0.5, 0.5, 0.5);
  g = g.index ? g.toNonIndexed() : g;
  unitCache.set(key, g);
  return g;
}
/** Triangles of a part in its unit box (flips applied, hidden faces dropped), each with its colour key. */
function partTris(p, keepHidden = false) {
  const tris = []; // { P:[3 Vector3], side|face, color }
  if (p.shape === 'mesh') {
    for (let f = 0; f < p.mesh.tris.length; f++) { const t = p.mesh.tris[f]; tris.push({ P: t.v.map(i => v3(p.mesh.verts[i])), face: f, color: t.color }); }
  } else {
    const pos = unitGeo(p.shape, p.sides).attributes.position;
    for (let i = 0; i < pos.count; i += 3) tris.push({ P: [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i + k)) });
  }
  const f = p.flip || [0, 0, 0], odd = (f[0] ^ f[1] ^ f[2]) & 1;
  for (const t of tris) {
    for (const v of t.P) { if (f[0]) v.x = 1 - v.x; if (f[1]) v.y = 1 - v.y; if (f[2]) v.z = 1 - v.z; }
    if (odd) t.P = [t.P[0], t.P[2], t.P[1]];
    if (t.face === undefined) {
      const n = new THREE.Vector3().subVectors(t.P[1], t.P[0]).cross(new THREE.Vector3().subVectors(t.P[2], t.P[0]));
      t.side = sideOf(n); t.color = p.colors[t.side];
    }
  }
  if (keepHidden) { const fill = tris.find(t => t.color)?.color || '#cccccc'; tris.forEach(t => { t.color ||= fill; }); return tris; }
  return tris.filter(t => t.color);
}
function partGeometry(p) {
  const tris = partTris(p), pos = [], col = [], c = new THREE.Color();
  for (const t of tris) { c.set(t.color); for (const v of t.P) { pos.push(v.x, v.y, v.z); col.push(c.r, c.g, c.b); } }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.userData.tris = tris.map(t => (t.face !== undefined ? { face: t.face } : { side: t.side }));
  return g;
}
// ---------------------------------------------------------------- pixel paint on cube sides
// part.pix = { north: { w, h, rgba: base64 of w*h*4 bytes }, ... }  — a side's own pixel grid. u, v = pixels from the
// side's top-left as seen from outside (Blockbench's face orientation). Unpainted sides keep their flat colour.
const FACE = Object.fromEntries(Object.entries(FACES).map(([s, f]) => [s, [f.c[0], f.c[1], f.c[3]]])); // unit-box corners TL, TR, BL of each side, seen from outside (bbimport's TL, TR, BR, BL)
const faceAxes = side => { const [tl, tr, bl] = FACE[side].map(v3); return { tl, du: tr.clone().sub(tl), dv: bl.clone().sub(tl) }; };
const faceDims = (p, side) => { const { du, dv } = faceAxes(side), size = p.to.map((t, i) => Math.abs(t - p.from[i])); const len = d => Math.abs(d.x) * size[0] + Math.abs(d.y) * size[1] + Math.abs(d.z) * size[2]; return [len(du), len(dv)]; };
const b64 = u8 => { let s2 = ''; for (let i = 0; i < u8.length; i += 0x8000) s2 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s2); };
const unb64 = str => { const s2 = atob(str), u8 = new Uint8Array(s2.length); for (let i = 0; i < s2.length; i++) u8[i] = s2.charCodeAt(i); return u8; };
const hashStr = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + str.length; };
/** Split a triangle {P:[3 Vector3], color} by the plane coord[a] = c into 1-3 triangles. */
function splitTri(t, a, c) {
  const d = t.P.map(v => v.getComponent(a) - c);
  if (d.every(x => x >= -1e-9) || d.every(x => x <= 1e-9)) return [t];
  const sideA = [], sideB = [];
  for (let i = 0; i < 3; i++) {
    const P = t.P[i], Q = t.P[(i + 1) % 3], dp = d[i], dq = d[(i + 1) % 3];
    (dp >= 0 ? sideA : sideB).push(P);
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) { const X = P.clone().lerp(Q, dp / (dp - dq)); sideA.push(X); sideB.push(X.clone()); }
  }
  const fan = poly => { const out = []; for (let i = 1; i + 1 < poly.length; i++) out.push({ P: [poly[0].clone(), poly[i].clone(), poly[i + 1].clone()], color: t.color }); return out; };
  return [...fan(sideA), ...fan(sideB)];
}
const hasPix = p => p.kind === 'part' && p.shape === 'cube' && p.pix && Object.keys(p.pix).length > 0;
const hexRGB = h => { const c = new THREE.Color(h); const t = c.clone().convertLinearToSRGB(); return [Math.round(t.r * 255), Math.round(t.g * 255), Math.round(t.b * 255)]; };
const rgbHex = (r, g, b2) => '#' + [r, g, b2].map(v => v.toString(16).padStart(2, '0')).join('');
/** Cube geometry with a uv per side (TL = top-left of the side's pixel grid) and one material group per side. */
function pixGeometry(p) {
  const pos = [], uv = [], col = [], tris = [], c = new THREE.Color(), groups = [];
  let tri = 0;
  for (const side of SIDES) {
    const painted = !!p.pix?.[side];
    if (!painted && !p.colors[side]) continue;
    const { tl, du, dv } = faceAxes(side), P = [tl, tl.clone().add(du), tl.clone().add(du).add(dv), tl.clone().add(dv)], U2 = [[0, 1], [1, 1], [1, 0], [0, 0]];
    c.set(p.colors[side] || '#cccccc');
    const start = pos.length / 3;
    for (const k of [0, 3, 2, 0, 2, 1]) { pos.push(P[k].x, P[k].y, P[k].z); uv.push(...U2[k]); col.push(c.r, c.g, c.b); }
    groups.push({ start, count: 6, side: painted ? side : null });
    tris.push({ side }, { side }); tri += 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.userData.tris = tris; g.userData.faceGroups = groups;
  return g;
}
/** Text as pixels: {w, h, mask} for a font size in pixels (height of capitals + descenders), crisp (no anti-aliasing). */
function textMask(text, { size = 7, font = 'sans', bold = false } = {}) {
  const fam = { sans: 'Arial, Helvetica, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'Consolas, "Courier New", monospace' }[font] || font;
  const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true }), f = `${bold ? 'bold ' : ''}${Math.max(3, Math.round(size))}px ${fam}`;
  x.font = f; const lines = String(text).split('\n'), lh = Math.max(3, Math.round(size)) + 1;
  const w = Math.max(1, Math.ceil(Math.max(...lines.map(l => x.measureText(l).width)))) + 1, h = lh * lines.length + 1;
  c.width = w; c.height = h; x.font = f; x.textBaseline = 'top'; x.fillStyle = '#fff';
  lines.forEach((l, i) => x.fillText(l, 0, i * lh));
  const d = x.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return { w, h, mask };
}
const geoKey = p => [p.collider || '', p.shape, p.sides, (p.flip || []).join(''), p.shape === 'mesh' ? p.mesh.tris.map(t => t.color).join() : SIDES.map(s => p.colors[s]).join(), hasPix(p) ? 'pix:' + SIDES.map(sd => (p.pix[sd] ? `${p.pix[sd].w}x${p.pix[sd].h}:${hashStr(p.pix[sd].rgba)}` : '')).join(',') : ''].join('|');

// ---------------------------------------------------------------- combine helpers
/**
 * Outside surface of a set of axis-aligned boxes [{min, max, colors}] (same frame): every side is cut into cells along
 * all nearby edges, a cell is dropped when another box sits right in front of it, and what is left is merged into
 * rectangles per colour (only over visible cells, so nothing ends up inside). Returns [{P:[4 Vector3], color}].
 */
function boxSurface(boxes) {
  const R = round4, planes = new Map(), out = [];
  for (const bx of boxes) for (const side of SIDES) {
    const color = bx.colors[side]; if (!color) continue;
    const d = DIR[side], axis = d[0] ? 0 : d[1] ? 1 : 2, sign = d[axis], plane = R(sign > 0 ? bx.max[axis] : bx.min[axis]);
    const [ua, va] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1], key = `${axis}|${sign}|${plane}`;
    (planes.get(key) || planes.set(key, { axis, sign, plane, ua, va, rects: [] }).get(key)).rects.push([R(bx.min[ua]), R(bx.max[ua]), R(bx.min[va]), R(bx.max[va]), color]);
  }
  for (const pl of planes.values()) {
    const pc = planeCells(pl, boxes); if (!pc) continue;
    const { Us, Vs, nu, nv, cols, cell } = pc;
    const done = new Uint8Array(nu * nv);
    const corner = (u, v) => { const p = new THREE.Vector3(); p.setComponent(pl.axis, pl.plane); p.setComponent(pl.ua, u); p.setComponent(pl.va, v); return p; };
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const c = cell[j * nu + i]; if (c <= 0 || done[j * nu + i]) continue;
      const ok = k => cell[k] === c && !done[k]; // only visible cells: nothing may end up inside the solid
      let i1 = i; while (i1 + 1 < nu && ok(j * nu + i1 + 1)) i1++;
      let j1 = j; grow: while (j1 + 1 < nv) { for (let k = i; k <= i1; k++) if (!ok((j1 + 1) * nu + k)) break grow; j1++; }
      const ia = i;
      for (let y = j; y <= j1; y++) for (let x = ia; x <= i1; x++) if (cell[y * nu + x] === c) done[y * nu + x] = 1;
      let P = [corner(Us[ia], Vs[j]), corner(Us[i1 + 1], Vs[j]), corner(Us[i1 + 1], Vs[j1 + 1]), corner(Us[ia], Vs[j1 + 1])];
      const nn = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0]));
      if (nn.getComponent(pl.axis) * pl.sign < 0) P = [P[0], P[3], P[2], P[1]];
      out.push({ P, color: cols[c - 1] });
    }
  }
  return out;
}

/** Triangles from boxSurface quads with no T-junctions (each quad fanned from its middle through every corner that
 * lies on its edges), so the result is a closed solid that a solid union can work with. */
function watertight(quads) {
  const R = round4, lines = [new Map(), new Map(), new Map()]; // axis -> "other two coords" -> sorted positions
  const add = p => { for (let a = 0; a < 3; a++) { const k = [0, 1, 2].filter(i => i !== a).map(i => R(p.getComponent(i))).join(','); const l = lines[a].get(k) || lines[a].set(k, new Set()).get(k); l.add(R(p.getComponent(a))); } };
  quads.forEach(q => q.P.forEach(add));
  for (const m of lines) for (const [k, set] of m) m.set(k, [...set].sort((x, y) => x - y));
  const tris = [];
  for (const q of quads) {
    const ring = [];
    for (let e = 0; e < 4; e++) {
      const A = q.P[e], B = q.P[(e + 1) % 4]; ring.push(A);
      const a = [0, 1, 2].find(i => Math.abs(A.getComponent(i) - B.getComponent(i)) > 1e-6); if (a === undefined) continue;
      const k = [0, 1, 2].filter(i => i !== a).map(i => R(A.getComponent(i))).join(','), lo = Math.min(A.getComponent(a), B.getComponent(a)) + 1e-5, hi = Math.max(A.getComponent(a), B.getComponent(a)) - 1e-5;
      let mid = (lines[a].get(k) || []).filter(v => v > lo && v < hi); if (A.getComponent(a) > B.getComponent(a)) mid = mid.reverse();
      for (const v of mid) { const p = A.clone(); p.setComponent(a, v); ring.push(p); }
    }
    if (ring.length === 4) { tris.push({ P: [ring[0], ring[1], ring[2]], color: q.color }, { P: [ring[0], ring[2], ring[3]], color: q.color }); continue; }
    const c = q.P.reduce((s2, p) => s2.add(p), new THREE.Vector3()).divideScalar(4);
    for (let i = 0; i < ring.length; i++) tris.push({ P: [c, ring[i], ring[(i + 1) % ring.length]], color: q.color });
  }
  return tris;
}

// ---------------------------------------------------------------- solid geometry (three-bvh-csg), shared by Combine and Push / Pull
async function csgKit() { const m = await import('three-bvh-csg'); const ev = new m.Evaluator(); ev.attributes = ['position', 'normal', 'color']; ev.useGroups = false; return { ...m, ev }; }
/** A brush from triangles [{P:[3 Vector3], color}], optionally moved by matrix M (winding fixed for mirrored matrices). */
function csgBrush(Brush, tris, M = null) {
  const pos = [], nor = [], col = [], c = new THREE.Color(), n = new THREE.Vector3(), e = new THREE.Vector3(), flipW = M && M.determinant() < 0;
  for (const t of tris) {
    const P = M ? t.P.map(v => v.clone().applyMatrix4(M)) : t.P; if (flipW) P.reverse();
    n.subVectors(P[1], P[0]).cross(e.subVectors(P[2], P[0])).normalize(); c.set(t.color);
    for (const v of P) { pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z); col.push(c.r, c.g, c.b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const br = new Brush(g); br.updateMatrixWorld(); return br;
}
/** Triangles of a CSG result, each snapped to the nearest of the original colours (#hex list). */
function csgTris(geo, colours) {
  const pal = [...new Set(colours)].map(h => [h, new THREE.Color(h)]), P = geo.attributes.position, C = geo.attributes.color, idx = geo.index, count = idx ? idx.count : P.count, out = [];
  const nearest = (r, g, bl) => { let best = pal[0][0], bd = Infinity; for (const [h, c] of pal) { const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - bl) ** 2; if (d < bd) { bd = d; best = h; } } return best; };
  for (let i = 0; i < count; i += 3) { const k = [0, 1, 2].map(o => (idx ? idx.getX(i + o) : i + o)); out.push({ P: k.map(v => new THREE.Vector3().fromBufferAttribute(P, v)), color: nearest(C.getX(k[0]), C.getY(k[0]), C.getZ(k[0])) }); }
  return out;
}
/** Weld triangles into a 'mesh' part's data: slivers dropped, points shared, normalised to the bounding box. Null if nothing is left. */
function meshPartData(tris) {
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  tris = tris.filter(t => e1.subVectors(t.P[1], t.P[0]).cross(e2.subVectors(t.P[2], t.P[0])).lengthSq() > 1e-10);
  if (!tris.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t.P) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v.getComponent(a)); hi[a] = Math.max(hi[a], v.getComponent(a)); }
  const size = hi.map((h, a) => Math.max(1e-4, h - lo[a])), vmap = new Map(), verts = [], mtris = [];
  const vid = v => { const u = [0, 1, 2].map(a => (v.getComponent(a) - lo[a]) / size[a]), k = u.map(x => Math.round(x * 1e5)).join(','); if (!vmap.has(k)) { vmap.set(k, verts.length); verts.push(u.map(x => Math.round(x * 1e6) / 1e6)); } return vmap.get(k); };
  for (const t of tris) { const v = t.P.map(vid); if (v[0] !== v[1] && v[1] !== v[2] && v[0] !== v[2]) mtris.push({ v, color: t.color }); }
  return { lo, hi, size, verts, tris: mtris };
}

// ---------------------------------------------------------------- the Build tool
export function initBuild(ed, hooks = {}) {
  const b = {
    doc: null, sel: [], tool: 'move', gridStep: 1, rotStep: 22.5, color: '#c8a46e', active: false, dirty: false, clipboard: null, libRel: null,
    snapMode: 'all', // moving parts click onto: 'all' = snap points + corners + middles of sides, 'points' = snap points only, 'off'
    pixelDensity: 2, // pixels per Blockbench unit for a side painted for the first time (1, 2, 4 or 8)
    pixelBrush: { mode: 'pencil', size: 1, mirror: false, text: 'Text', textSize: 8, font: 'sans', bold: false }, // pencil | fill | erase | text
    showColliders: true,
  };
  const root = new THREE.Group(); root.name = '__build'; root.scale.setScalar(U); root.visible = false; ed.scene.add(root);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
  const meshes = new Map(); // id -> Mesh
  // grid: 1 unit lines over 3 blocks, brighter block lines, a 1-block square in the middle
  const gridG = new THREE.Group(); gridG.visible = false; ed.scene.add(gridG);
  const gridLines = [];
  b.setTheme = light => { // light / dark grid
    for (const g of gridLines) { gridG.remove(g); g.geometry.dispose(); g.material.dispose(); }
    const fine = new THREE.GridHelper(48 * U, 48, light ? 0xb3b8c2 : 0x3d4046, light ? 0xc4c8d0 : 0x33363b); fine.position.y = -0.0005;
    const blocks = new THREE.GridHelper(48 * U, 3, light ? 0x8f96a3 : 0x5a5d63, light ? 0x8f96a3 : 0x5a5d63);
    gridLines.splice(0, gridLines.length, fine, blocks); gridG.add(fine, blocks);
  };
  { b.setTheme(false);
    const ax = (a, c) => { const g = new THREE.BufferGeometry().setFromPoints(a.map(p => v3(p).multiplyScalar(U))); return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c })); };
    gridG.add(ax([[-24, 0, 0], [24, 0, 0]], 0xb0453f), ax([[0, 0, -24], [0, 0, 24]], 0x3f6fb0)); }
  // selection overlay
  const selG = new THREE.Group(); ed.scene.add(selG);
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5));
  const selMat = new THREE.LineBasicMaterial({ color: 0xff8c1a, depthTest: false, transparent: true });
  const grpMat = new THREE.LineBasicMaterial({ color: 0x4fc3f7, depthTest: false, transparent: true, opacity: 0.6 });
  const pivotMark = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, depthTest: false }));
  pivotMark.renderOrder = 41; pivotMark.visible = false; ed.scene.add(pivotMark);
  const locGeo = new THREE.OctahedronGeometry(0.6), locMat = new THREE.MeshBasicMaterial({ color: 0x9be37b, wireframe: true });
  const arrowGeo = new THREE.ConeGeometry(0.35, 1.2, 10).rotateX(Math.PI / 2).translate(0, 0, 1.3), arrowMat = new THREE.MeshBasicMaterial({ color: 0x9be37b });
  const upGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6).translate(0, 0.5, 0);
  // snap points: small cyan dots; the yellow ring shows where a moving part will click on
  const snapG = new THREE.Group(); ed.scene.add(snapG);
  const snapDot = new THREE.SphereGeometry(1, 10, 6), snapMat = new THREE.MeshBasicMaterial({ color: 0x35e0ff, depthTest: false }), snapSelMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a, depthTest: false });
  const snapRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.22, 8, 24), new THREE.MeshBasicMaterial({ color: 0xffe14d, depthTest: false }));
  snapRing.renderOrder = 44; snapRing.visible = false; ed.scene.add(snapRing);
  let altHeld = false;
  addEventListener('keydown', e => { if (e.key === 'Alt') altHeld = true; }, true);
  addEventListener('keyup', e => { if (e.key === 'Alt') altHeld = false; }, true);
  addEventListener('blur', () => { altHeld = false; });
  // stretch knobs
  const knobs = SIDES.map(s => { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb347, depthTest: false })); m.renderOrder = 42; m.visible = false; m.userData.side = s; ed.scene.add(m); return m; });
  // gizmo
  const proxy = new THREE.Object3D(); ed.scene.add(proxy);
  const tc = new TransformControls(ed.camera, ed.dom); tc.setSize(0.8); ed.scene.add(tc);
  let drag = null;

  // ---------------------------------------------------------------- document
  const N = id => b.doc.nodes[id];
  const kids = pid => (pid ? N(pid).children : b.doc.roots);
  function newDoc(name = 'new_model') {
    b.doc = { name, nodes: {}, roots: [], extra: {} }; b.sel = []; b.dirty = false; b.libRel = null;
    refresh(); return b.msg(`New model “${name}”. Add a shape to start.`);
  }
  const ancestors = id => { const a = []; for (let p = N(id).parent; p; p = N(p).parent) a.push(p); return a; };
  const descendants = id => { const out = []; const walk = x => { for (const c of N(x).children || []) { out.push(c); walk(c); } }; walk(id); return out; };
  /** Selected nodes without the ones whose group is also selected. */
  const topSel = () => b.sel.filter(id => N(id) && !ancestors(id).some(a => b.sel.includes(a)));
  function groupWorld(pid) { // Blockbench units
    const m = new THREE.Matrix4(); const chain = []; for (let p = pid; p; p = N(p).parent) chain.unshift(N(p));
    for (const g of chain) m.multiply(pivotM(g.origin, g.rotation));
    return m;
  }
  const groupQ = pid => { const q = new THREE.Quaternion(); const chain = []; for (let p = pid; p; p = N(p).parent) chain.unshift(N(p)); for (const g of chain) q.multiply(eulerQ(g.rotation)); return q; };
  const locM = n => new THREE.Matrix4().makeTranslation(...n.position).multiply(new THREE.Matrix4().makeRotationFromQuaternion(eulerQ(n.rotation || [0, 0, 0])));
  function nodeLocal(n) { return n.kind === 'locator' ? locM(n) : pivotM(n.origin, n.rotation); }
  /** Where a snap point sits (Blockbench units, world): u is 0..1 inside the part's box, flips applied like the shape. */
  const flipU = (p, u) => u.map((v, i) => ((p.flip || [])[i] ? 1 - v : v));
  const snapWorld = (p, u, M = partMatrix(p)) => v3(flipU(p, u)).applyMatrix4(M);
  const AUTO_U = [...[[0.5, 0.5, 0], [0.5, 0.5, 1], [0, 0.5, 0.5], [1, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5]], ...[0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [x, y, z])))];
  function partMatrix(p, W = groupWorld(p.parent)) {
    const size = p.to.map((t, i) => Math.max(1e-3, t - p.from[i]));
    return W.clone().multiply(pivotM(p.origin, p.rotation)).multiply(new THREE.Matrix4().makeTranslation(...p.from)).multiply(new THREE.Matrix4().makeScale(...size));
  }
  /** Shift a node's own coordinates (part box, locator) or everything inside a group, by s (BB units, its frame). */
  function shift(id, s) {
    const n = N(id);
    if (n.kind === 'part') { n.from = n.from.map((v, i) => r4(v + s[i])); n.to = n.to.map((v, i) => r4(v + s[i])); }
    else if (n.kind === 'locator') n.position = n.position.map((v, i) => r4(v + s[i]));
    else for (const d of descendants(id)) {
      const m = N(d);
      if (m.kind === 'part') { m.from = m.from.map((v, i) => r4(v + s[i])); m.to = m.to.map((v, i) => r4(v + s[i])); m.origin = m.origin.map((v, i) => r4(v + s[i])); }
      else if (m.kind === 'locator') m.position = m.position.map((v, i) => r4(v + s[i]));
      else m.origin = m.origin.map((v, i) => r4(v + s[i]));
    }
  }
  /** Move a whole node (and what is inside it) by d in its parent's frame. */
  function translate(id, d) {
    const n = N(id);
    if (n.kind === 'locator') { n.position = n.position.map((v, i) => r4(v + d[i])); return; }
    n.origin = n.origin.map((v, i) => r4(v + d[i]));
    shift(id, d); // a part's box, or everything inside a group
  }
  /**
   * Give node a new local placement M (rotation + translation, in its parent's frame) while keeping its shape:
   * the pivot becomes `newOrigin` (default: where M takes the old pivot) and the contents shift to match.
   */
  function setLocal(id, M, newOrigin = null) {
    const n = N(id);
    if (n.kind === 'locator') { const p = new THREE.Vector3(), q = new THREE.Quaternion(); M.decompose(p, q, new THREE.Vector3()); n.position = p.toArray().map(r4); n.rotation = qEuler(q); return; }
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M));
    const t = new THREE.Vector3().setFromMatrixPosition(M);
    const o = newOrigin ? v3(newOrigin) : v3(n.origin).applyMatrix4(M);
    const s = t.clone().add(o.clone().applyQuaternion(q)).sub(o).applyQuaternion(q.clone().invert());
    shift(id, s.toArray());
    if (n.slide) { const qFrame = q.clone().multiply(eulerQ(n.rotation).invert()); n.slide = { ...n.slide, axis: v3(n.slide.axis).applyQuaternion(qFrame).normalize().toArray().map(r4) }; }
    n.origin = o.toArray().map(r4); n.rotation = qEuler(q);
  }
  /** Move node to another parent group (null = top level) without changing how it looks. */
  function reparent(id, pid, index = -1) {
    const n = N(id); if (!n) throw new Error(`No part or group called “${id}”`);
    if (pid && !N(pid)) throw new Error(`No group called “${pid}”`);
    if (pid && N(pid).kind !== 'group') throw new Error(`“${N(pid).name}” is not a group`); if (n.parent === pid) { const list = kids(pid); if (index >= 0) { list.splice(list.indexOf(id), 1); list.splice(Math.min(index, list.length), 0, id); } return; }
    if (pid && (pid === id || ancestors(pid).includes(id))) throw new Error('A group cannot go inside itself');
    const M = new THREE.Matrix4().copy(groupWorld(pid)).invert().multiply(groupWorld(n.parent)).multiply(nodeLocal(n));
    const list = kids(n.parent); list.splice(list.indexOf(id), 1);
    n.parent = pid; const to = kids(pid); if (index < 0 || index > to.length) to.push(id); else to.splice(index, 0, id);
    setLocal(id, M);
  }
  function insertNode(n, pid, after = null) {
    b.doc.nodes[n.id] = n; n.parent = pid;
    const list = kids(pid), i = after ? list.indexOf(after) : -1;
    if (i >= 0) list.splice(i + 1, 0, n.id); else list.push(n.id);
  }
  function removeNode(id) {
    const n = N(id); if (!n) return;
    for (const c of [...(n.children || [])]) removeNode(c);
    const list = kids(n.parent); const i = list.indexOf(id); if (i >= 0) list.splice(i, 1);
    delete b.doc.nodes[id];
  }
  const uniqueName = (base, kind) => { const names = new Set(Object.values(b.doc.nodes).filter(n => kind === 'group' ? n.kind === 'group' : true).map(n => n.name)); if (!names.has(base)) return base; let i = 2; while (names.has(`${base}${i}`)) i++; return `${base}${i}`; };

  // ---------------------------------------------------------------- undo
  const pushUndo = (label, u, r) => { if (b.isolate && N(b.isolate.group)) label = `[${N(b.isolate.group).name}] ${label}`; ed._pushUndo(label, u, r); ed.undoStack[ed.undoStack.length - 1].build = true; }; // Build steps only touch the build, so they survive Make model
  const snapshot = () => JSON.stringify({ nodes: b.doc.nodes, roots: b.doc.roots, name: b.doc.name });
  function restore(s, sel) { const d = JSON.parse(s); b.doc.nodes = d.nodes; b.doc.roots = d.roots; b.doc.name = d.name; b.sel = (sel || []).filter(id => d.nodes[id]); b.dirty = true; refresh(); }
  function op(label, fn) {
    if (!b.doc) newDoc();
    const before = snapshot(), selBefore = [...b.sel];
    let out;
    try { out = fn(); } catch (e) { restore(before, selBefore); throw e; }
    const after = snapshot(), selAfter = [...b.sel];
    if (after !== before) { pushUndo(label, () => restore(before, selBefore), () => restore(after, selAfter)); b.dirty = true; }
    refresh();
    return out;
  }

  // ---------------------------------------------------------------- pixel faces: canvases, textures, materials
  const faceCache = new Map(); // `${id}|${side}` -> { sig, canvas, ctx, tex, mat, w, h }
  function faceCanvas(n, side) {
    const rec = n.pix[side], key = n.id + '|' + side, sig = `${rec.w}x${rec.h}:${hashStr(rec.rgba)}`;
    let f = faceCache.get(key);
    if (f && f.sig === sig) return f;
    if (!f || f.w !== rec.w || f.h !== rec.h) {
      f?.tex.dispose(); f?.mat.dispose();
      const canvas = document.createElement('canvas'); canvas.width = rec.w; canvas.height = rec.h;
      const tex = new THREE.CanvasTexture(canvas); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
      f = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), tex, mat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0, flatShading: true }), w: rec.w, h: rec.h };
      faceCache.set(key, f);
    }
    const data = unb64(rec.rgba); f.ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer, 0, rec.w * rec.h * 4), rec.w, rec.h), 0, 0);
    f.tex.needsUpdate = true; f.sig = sig;
    return f;
  }
  const colliderMat = new THREE.MeshBasicMaterial({ color: 0x35e0ff, wireframe: true, transparent: true, opacity: 0.7 });
  function setPartLook(m, n) {
    m.geometry?.dispose?.();
    if (n.collider) { m.geometry = partGeometry({ ...n, colors: Object.fromEntries(SIDES.map(sd => [sd, '#35e0ff'])) }); m.material = colliderMat; m.renderOrder = 38; return; } // a collider: wireframe, never part of the visible model
    if (hasPix(n)) {
      const g = pixGeometry(n), mats = [mat];
      g.clearGroups();
      for (const gr of g.userData.faceGroups) { let mi = 0; if (gr.side) { mats.push(faceCanvas(n, gr.side).mat); mi = mats.length - 1; } g.addGroup(gr.start, gr.count, mi); }
      m.geometry = g; m.material = mats;
    } else { m.geometry = partGeometry(n); m.material = mat; }
  }

  // ---------------------------------------------------------------- drawing
  // ---------------- isolate (sub-tabs): only one group is shown / clickable; {group, mode: 'alone' | 'context'}
  b.isolate = null;
  let isoIds = null;
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x8a8f99, transparent: true, opacity: 0.18, depthWrite: false });
  function isoSet() { const g = b.isolate && b.doc && N(b.isolate.group); return g ? new Set([g.id, ...descendants(g.id)]) : null; }
  const inIso = id => !isoIds || isoIds.has(id);
  /** Show / work on one group only (null = everything). mode 'alone' hides the rest, 'context' greys it (not clickable). */
  b.setIsolate = (group, mode = 'context') => {
    const g = group == null ? null : N(group) || N(b.find(group));
    if (group != null && (!g || g.kind !== 'group')) throw new Error('No group: ' + group);
    b.isolate = g ? { group: g.id, mode: mode === 'alone' ? 'alone' : 'context' } : null;
    refresh(); if (g) b.sel = b.sel.filter(inIso); drawSelection(); syncGizmo(); changed();
    return b.isolate;
  };
  function refresh() {
    if (!b.doc) { root.clear(); meshes.clear(); return changed(); }
    const seen = new Set(), gw = groupWorldMemo();
    for (const n of Object.values(b.doc.nodes)) {
      if (n.kind === 'group') continue;
      seen.add(n.id);
      let m = meshes.get(n.id);
      if (n.kind === 'locator') {
        if (!m) { m = new THREE.Mesh(locGeo, locMat); m.add(new THREE.Mesh(arrowGeo, arrowMat), new THREE.Mesh(upGeo, arrowMat)); m.matrixAutoUpdate = false; m.userData.id = n.id; meshes.set(n.id, m); root.add(m); }
        m.matrix.copy(gw(n.parent)).multiply(locM(n));
        continue;
      }
      const key = geoKey(n);
      if (!m) { m = new THREE.Mesh(); m.matrixAutoUpdate = false; m.userData = { id: n.id }; meshes.set(n.id, m); root.add(m); }
      if (m.userData.key !== key) { setPartLook(m, n); m.userData.key = key; }
      m.matrix.copy(partMatrix(n, gw(n.parent)));
    }
    for (const [id, m] of meshes) if (!seen.has(id)) { if (m.geometry !== locGeo) m.geometry.dispose(); root.remove(m); meshes.delete(id); }
    for (const [k, f] of faceCache) { const [id, side] = k.split('|'); if (!N(id)?.pix?.[side]) { f.tex.dispose(); f.mat.dispose(); faceCache.delete(k); } } // paint removed / part deleted
    isoIds = isoSet();
    for (const [id, m] of meshes) {
      const inside = !isoIds || isoIds.has(id);
      m.visible = !hiddenLayer(N(id)) && (!N(id)?.collider || b.showColliders) && (inside || b.isolate.mode === 'context'); // switched-off clothing layers / hidden colliders / a sub-tab's other parts
      if (!inside && m.visible && m.material !== ghostMat) { m.userData.ownMat = m.material; m.material = ghostMat; } // "In context": the rest greyed
      else if ((inside || !m.visible) && m.material === ghostMat) { m.material = m.userData.ownMat; delete m.userData.ownMat; }
    }
    root.updateMatrixWorld(true);
    b.sel = b.sel.filter(id => N(id));
    drawSelection(); syncGizmo(); changed();
  }
  /** Slide joints: a line from the start to the end of each rail (through the group's pivot), bright when picked. */
  const railMat = new THREE.LineBasicMaterial({ color: 0xc58cff, depthTest: false, transparent: true, opacity: 0.55 }), railSelMat = new THREE.LineBasicMaterial({ color: 0xe6c8ff, depthTest: false });
  function drawRails() {
    for (const n of Object.values(b.doc?.nodes || {})) {
      if (n.kind !== 'group' || !n.slide) continue;
      const W = groupWorld(n.parent), o = v3(n.origin), ax = v3(n.slide.axis), at = s2 => o.clone().addScaledVector(ax, s2).applyMatrix4(W).multiplyScalar(U);
      const side = new THREE.Vector3(1, 0, 0); if (Math.abs(ax.x) > 0.9) side.set(0, 1, 0); side.cross(ax).normalize().multiplyScalar(0.35);
      const tick = s2 => [o.clone().addScaledVector(ax, s2).add(side), o.clone().addScaledVector(ax, s2).sub(side)].map(p => p.applyMatrix4(W).multiplyScalar(U));
      const g = new THREE.BufferGeometry().setFromPoints([at(n.slide.min), at(n.slide.max), ...tick(n.slide.min), ...tick(n.slide.max)]);
      const l = new THREE.LineSegments(g, b.sel.includes(n.id) ? railSelMat : railMat); l.renderOrder = 40; selG.add(l);
    }
  }
  function drawSnaps() {
    snapG.clear();
    if (!b.active) return;
    const picked = new Set(b.sel.flatMap(id => [id, ...descendants(id)]));
    for (const n of Object.values(b.doc.nodes)) {
      if (n.kind !== 'part' || !n.snaps?.length || !meshes.get(n.id)) continue;
      const M = meshes.get(n.id).matrixWorld;
      for (const sp of n.snaps) {
        const d = new THREE.Mesh(snapDot, picked.has(n.id) ? snapSelMat : snapMat); d.renderOrder = 43;
        d.position.copy(v3(flipU(n, sp.u)).applyMatrix4(M)); d.userData = { part: n.id, snap: sp.id }; snapG.add(d);
      }
    }
  }
  function drawSelection() {
    drawSnaps();
    for (const o of selG.children) if (o.geometry !== boxEdges) o.geometry.dispose(); // rail lines are made per redraw
    selG.clear();
    drawRails();
    const parts = new Set(), inGroups = new Set();
    for (const id of b.sel) { const n = N(id); if (n.kind === 'group') descendants(id).forEach(d => inGroups.add(d)); else parts.add(id); }
    const add = (id, m) => { const n = N(id); if (!n || n.kind !== 'part') return; const l = new THREE.LineSegments(boxEdges, m); l.matrixAutoUpdate = false; l.matrix.copy(meshes.get(id).matrixWorld); l.renderOrder = 39; selG.add(l); };
    inGroups.forEach(id => { if (!parts.has(id)) add(id, grpMat); });
    parts.forEach(id => add(id, selMat));
    selG.updateMatrixWorld(true);
  }
  const changed = () => { ed.changed(); };
  b.msg = t => ed.msg(t);

  // ---------------------------------------------------------------- picking / clicks
  function hitAt(x, y) {
    const hits = ed._ray(x, y).intersectObjects([...meshes.values()].filter(m => m.visible && inIso(m.userData.id)), false);
    return hits[0] || null;
  }
  let lastClick = { id: null, t: 0 };
  b.click = (x, y, { shift = false, button = 0, alt = false } = {}) => {
    if (button !== 0) return;
    const h = hitAt(x, y), id = h?.object.userData.id;
    if (b.tool === 'paint' && h && N(id).collider) return b.msg('Colliders have no colour: they are invisible in the game');
    if (b.tool === 'paint' && h && N(id).kind === 'part') {
      if (alt) { const info = h.object.geometry.userData.tris[h.faceIndex], p = N(id); b.color = info.face !== undefined ? p.mesh.tris[info.face].color : p.colors[info.side]; b.msg('Picked colour ' + b.color); return changed(); }
      return paint(id, shift ? null : h.object.geometry.userData.tris[h.faceIndex]);
    }
    if (b.tool === 'push') return ppClick(h);
    if (b.tool === 'pixel') return;
    if (b.tool === 'snap') { // click a dot to remove it, click a part to add one there
      const dot = snapDotAt(x, y);
      if (dot) return b.removeSnap(dot.part, dot.snap);
      if (h && N(id).kind === 'part') {
        const p = N(id), inv = partMatrix(p).invert(), u = flipU(p, h.point.clone().divideScalar(U).applyMatrix4(inv).toArray());
        const nice = u.map(v => { for (const t of [0, 0.25, 0.5, 0.75, 1]) if (Math.abs(v - t) < 0.08) return t; return Math.round(v * 1000) / 1000; });
        return b.addSnap(id, nice);
      }
      return;
    }
    if (!h) { if (!shift) { b.sel = []; drawSelection(); syncGizmo(); changed(); } return; }
    const now = performance.now();
    let pick = id;
    if (lastClick.id === id && now - lastClick.t < 380 && N(id).parent) pick = N(id).parent; // double-click = its group
    lastClick = { id, t: now };
    if (shift) b.sel = b.sel.includes(pick) ? b.sel.filter(s => s !== pick) : [...b.sel, pick];
    else b.sel = [pick];
    drawSelection(); syncGizmo(); changed();
  };
  function snapDotAt(x, y) {
    let best = null;
    for (const d of snapG.children) { const sp = d.position.clone().project(ed.camera); if (sp.z > 1) continue; const dd = Math.hypot((sp.x + 1) / 2 * ed.dom.clientWidth - x, (1 - sp.y) / 2 * ed.dom.clientHeight - y); if (dd < 14 && (!best || dd < best.dd)) best = { ...d.userData, dd }; }
    return best;
  }
  b.select = (ids, add = false) => { ids = [].concat(ids).map(x => (N(x) ? x : b.find(x))).filter(Boolean).filter(inIso); b.sel = add ? [...new Set([...b.sel, ...ids])] : ids; drawSelection(); syncGizmo(); changed(); return b.sel; };
  /** Pick every part whose middle is inside a screen rectangle (canvas pixels). */
  b.boxSelect = (x0, y0, x1, y1, add = false) => {
    const W = ed.dom.clientWidth, H = ed.dom.clientHeight, ids = [], c = new THREE.Vector3();
    for (const [id, m] of meshes) {
      if (!m.visible || !inIso(id)) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      m.geometry.boundingBox.getCenter(c).applyMatrix4(m.matrixWorld).project(ed.camera);
      const x = (c.x + 1) / 2 * W, y = (1 - c.y) / 2 * H;
      if (c.z < 1 && x >= x0 && x <= x1 && y >= y0 && y <= y1) ids.push(id);
    }
    return b.select(ids, add);
  };
  b.selectAll = () => b.select(Object.values(b.doc?.nodes || {}).filter(n => n.kind !== 'group' && inIso(n.id)).map(n => n.id));
  b.clear = () => { ppReset(); return b.select([]); };

  // ---------------------------------------------------------------- gizmo (move / rotate / pivot)
  function selCentre() { // world (metres)
    const box = new THREE.Box3();
    for (const id of b.sel) { const n = N(id); if (n.kind === 'group') { descendants(id).forEach(d => meshes.get(d) && box.expandByObject(meshes.get(d))); if (!descendants(id).length) box.expandByPoint(v3(n.origin).applyMatrix4(groupWorld(n.parent)).multiplyScalar(U)); } else if (meshes.get(id)) box.expandByObject(meshes.get(id)); }
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  }
  const primary = () => (b.sel.length ? N(b.sel[b.sel.length - 1]) : null);
  const pivotWorld = n => (n.kind === 'locator' ? v3(n.position) : v3(n.origin)).applyMatrix4(groupWorld(n.parent)).multiplyScalar(U);
  function syncGizmo() {
    const on = b.active && b.sel.length && ['move', 'rotate', 'pivot'].includes(b.tool) && !drag;
    knobs.forEach(k => { k.visible = false; });
    pivotMark.visible = false;
    if (!b.active) { tc.detach(); return; }
    const p = primary();
    if (p && (p.kind === 'group' || (p.kind === 'part' && (b.tool === 'rotate' || b.tool === 'pivot')))) { pivotMark.position.copy(pivotWorld(p)); pivotMark.visible = true; }
    if (b.tool === 'stretch') { tc.detach(); placeKnobs(); return; }
    if (!on) { if (!tc.dragging) tc.detach(); return; }
    if (tc.dragging) return;
    const single = topSel().length === 1;
    if (b.tool === 'move') { const c = selCentre(); if (!c) return tc.detach(); proxy.position.copy(c); proxy.quaternion.identity(); tc.setMode('translate'); tc.setSpace('world'); }
    else if (b.tool === 'pivot') { if (p.kind === 'locator') return tc.detach(); proxy.position.copy(pivotWorld(p)); proxy.quaternion.identity(); tc.setMode('translate'); tc.setSpace('world'); }
    else { // rotate
      if (single) { proxy.position.copy(pivotWorld(p)); proxy.quaternion.copy(groupQ(p.parent).multiply(eulerQ(p.rotation || [0, 0, 0]))); tc.setSpace('local'); }
      else { const c = selCentre(); if (!c) return tc.detach(); proxy.position.copy(c); proxy.quaternion.identity(); tc.setSpace('world'); }
      tc.setMode('rotate');
    }
    tc.setRotationSnap(b.rotStep > 0 ? b.rotStep * D2R : null);
    proxy.updateMatrixWorld(true);
    if (tc.object !== proxy) tc.attach(proxy);
  }
  tc.addEventListener('mouseDown', () => {
    ed.orbit.enabled = false;
    const ids = b.tool === 'pivot' ? [b.sel[b.sel.length - 1]] : topSel();
    const keep = new Set(ids); ids.forEach(id => descendants(id).forEach(d => keep.add(d)));
    drag = { before: snapshot(), selBefore: [...b.sel], ids, base: new Map([...keep].map(id => [id, clone(N(id))])), p0: proxy.position.clone(), q0: proxy.quaternion.clone(), single: ids.length === 1 };
    if (b.tool === 'move' && b.snapMode !== 'off') { // points that can click together: the moving parts' and everyone else's
      const pts = (p, M) => [...(p.snaps || []).map(sp => snapWorld(p, sp.u, M)), ...(b.snapMode === 'all' ? AUTO_U.map(u => v3(u).applyMatrix4(M)) : [])];
      const moving = [], targets = new Map(), W = ed.dom.clientWidth, H = ed.dom.clientHeight, cell = 24;
      for (const n of Object.values(b.doc.nodes)) {
        if (n.kind !== 'part' || !meshes.get(n.id)) continue;
        const M = meshes.get(n.id).matrixWorld.clone().premultiply(new THREE.Matrix4().makeScale(1 / U, 1 / U, 1 / U)); // Blockbench units
        if (keep.has(n.id)) { moving.push(...pts(n, M)); continue; }
        for (const w of pts(n, M)) {
          const sp = w.clone().multiplyScalar(U).project(ed.camera); if (sp.z > 1 || sp.z < -1) continue;
          const sx = (sp.x + 1) / 2 * W, sy = (1 - sp.y) / 2 * H, k = Math.floor(sx / cell) + ',' + Math.floor(sy / cell);
          (targets.get(k) || targets.set(k, []).get(k)).push({ w, sx, sy });
        }
      }
      drag.snap = { moving, targets, cell };
    }
  });
  tc.addEventListener('objectChange', () => {
    if (!drag) return;
    for (const [id, n] of drag.base) Object.assign(N(id), clone(n)); // start from the state at mouse-down
    if (b.tool === 'move' || b.tool === 'pivot') {
      let d = proxy.position.clone().sub(drag.p0).divideScalar(U);
      if (b.gridStep > 0) d = new THREE.Vector3(...d.toArray().map(v => Math.round(v / b.gridStep) * b.gridStep));
      snapRing.visible = false;
      if (b.tool === 'move' && drag.snap && !altHeld) { // click onto the nearest point on another part (hold Alt to stop it)
        const raw = proxy.position.clone().sub(drag.p0).divideScalar(U), W = ed.dom.clientWidth, H = ed.dom.clientHeight, { cell, targets } = drag.snap;
        let best = null;
        for (const m of drag.snap.moving) {
          const mw = m.clone().add(raw), sp = mw.clone().multiplyScalar(U).project(ed.camera), sx = (sp.x + 1) / 2 * W, sy = (1 - sp.y) / 2 * H;
          const cx = Math.floor(sx / cell), cy = Math.floor(sy / cell);
          for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const t of targets.get((cx + i) + ',' + (cy + j)) || []) {
            const dd = Math.hypot(t.sx - sx, t.sy - sy); if (dd < 16 && (!best || dd < best.dd)) best = { dd, d: t.w.clone().sub(m), at: t.w };
          }
        }
        if (best) { d = best.d; snapRing.position.copy(best.at).multiplyScalar(U); snapRing.visible = true; }
      }
      proxy.position.copy(drag.p0).addScaledVector(d, U);
      for (const id of drag.ids) {
        const n = N(id), dl = d.clone().applyQuaternion(groupQ(n.parent).invert()).toArray().map(r4);
        if (b.tool === 'move') translate(id, dl);
        else setLocal(id, nodeLocal(n), n.origin.map((v, i) => r4(v + dl[i])));
      }
    } else if (b.tool === 'rotate') {
      if (drag.single) { const n = N(drag.ids[0]); n.rotation = qEuler(groupQ(n.parent).invert().multiply(proxy.quaternion)); }
      else {
        const qd = proxy.quaternion.clone().multiply(drag.q0.clone().invert());
        for (const id of drag.ids) { const n = N(id); const gp = groupQ(n.parent); n.rotation = qEuler(gp.clone().invert().multiply(qd).multiply(gp).multiply(eulerQ(n.rotation || [0, 0, 0]))); }
      }
    }
    refreshQuick();
  });
  tc.addEventListener('mouseUp', () => {
    ed.orbit.enabled = true; snapRing.visible = false;
    if (!drag) return;
    const d = drag; drag = null;
    const after = snapshot();
    if (after !== d.before) { const sel = [...b.sel]; pushUndo({ move: 'Move', rotate: 'Rotate', pivot: 'Move pivot' }[b.tool] || 'Change', () => restore(d.before, d.selBefore), () => restore(after, sel)); b.dirty = true; }
    refresh();
  });
  /** Group world matrices, each worked out once per pass (Blockbench units). */
  function groupWorldMemo() { const W = new Map(); const gw = pid => { if (!pid) return new THREE.Matrix4(); if (!W.has(pid)) W.set(pid, gw(N(pid).parent).clone().multiply(pivotM(N(pid).origin, N(pid).rotation))); return W.get(pid); }; return gw; }
  function refreshQuick() { // during a drag: update matrices without rebuilding the gizmo
    const gw = groupWorldMemo(); // a drag only moves / turns / sizes things: matrices only, no look rebuild, no panel redraw (done on mouse-up)
    for (const [id, m] of meshes) { const n = N(id); if (!n) continue; m.matrix.copy(n.kind === 'locator' ? gw(n.parent).clone().multiply(locM(n)) : partMatrix(n, gw(n.parent))); }
    root.updateMatrixWorld(true); drawSelection();
    const p = primary(); if (p && pivotMark.visible) pivotMark.position.copy(pivotWorld(p));
    if (b.tool === 'stretch') placeKnobs();
  }
  b.gizmoActive = () => tc.dragging || (tc.axis !== null && !!tc.object) || !!stretchDrag;

  // ---------------------------------------------------------------- stretch (pull a side)
  function placeKnobs() {
    const p = primary();
    if (!b.active || b.tool !== 'stretch' || !p || p.kind !== 'part') { knobs.forEach(k => { k.visible = false; }); return; }
    const M = meshes.get(p.id)?.matrixWorld; if (!M) return;
    for (const k of knobs) { const d = DIR[k.userData.side]; k.position.set(0.5 + d[0] * 0.5, 0.5 + d[1] * 0.5, 0.5 + d[2] * 0.5).applyMatrix4(M); k.visible = true; }
  }
  // ---------------------------------------------------------------- push / pull (cut holes, add blocks)
  // Points are picked on one flat side of one part, in that part's own frame (Blockbench units, before its turn), so
  // turned parts work too. The pane = the rectangle the points span. Dragging along the side's outward direction:
  // in = cut (a pocket, or a hole once it goes past the far side), out = add a block.
  const ppG = new THREE.Group(); root.add(ppG); // drawn in Blockbench units
  const ppDots = new THREE.Group(); ed.scene.add(ppDots); // world units (kept the same size on screen)
  const ppHover = new THREE.Mesh(snapDot, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })); ppHover.renderOrder = 45; ppHover.visible = false; ed.scene.add(ppHover);
  const paneMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: false });
  const cutMat = new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.35, depthWrite: false });
  const addMat = new THREE.MeshBasicMaterial({ color: 0x40e070, transparent: true, opacity: 0.35, depthWrite: false });
  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  let pp = null; // { id, side, a, sign, plane, points:[[x,y,z]], rect:{min,max}|null, drag }
  const frameOf = p => groupWorld(p.parent).multiply(pivotM(p.origin, p.rotation)); // part frame -> Blockbench world
  function ppReset() { pp = null; ppG.clear(); ppDots.clear(); ppHover.visible = false; }
  /** Where on a flat side a mouse hit lands: {id, side, a, sign, plane, pt:[x,y,z] snapped} or null. */
  function ppSpot(h) {
    if (!h || N(h.object.userData.id)?.kind !== 'part') return null;
    const p = N(h.object.userData.id), inv = frameOf(p).invert(), q = h.point.clone().divideScalar(U).applyMatrix4(inv);
    const n = h.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize().applyQuaternion(groupQ(p.parent).multiply(eulerQ(p.rotation)).invert());
    const a = [0, 1, 2].reduce((best, i) => (Math.abs(n.getComponent(i)) > Math.abs(n.getComponent(best)) ? i : best), 0), sign = Math.sign(n.getComponent(a));
    if (Math.abs(n.getComponent(a)) < 0.999) return { slanted: true };
    const lo = p.from.map((v, i) => Math.min(v, p.to[i])), hi = p.from.map((v, i) => Math.max(v, p.to[i])), plane = sign > 0 ? hi[a] : lo[a];
    if (Math.abs(q.getComponent(a) - plane) > 0.02) return { slanted: true }; // a flat face that is not on the box side (e.g. inside a wedge)
    const st = b.gridStep > 0 ? b.gridStep : 0, pt = q.toArray();
    for (let i = 0; i < 3; i++) {
      if (i === a) { pt[i] = plane; continue; }
      let v = st ? Math.round(pt[i] / st) * st : pt[i];
      for (const edge of [lo[i], hi[i]]) if (Math.abs(pt[i] - edge) < Math.max(st, 0.25) * 0.45) v = edge; // edges win
      pt[i] = r4(Math.max(lo[i], Math.min(hi[i], v)));
    }
    return { id: p.id, side: SIDES.find(s2 => DIR[s2][a] === sign), a, sign, plane, pt, lo, hi };
  }
  function ppDraw() {
    ppG.clear(); ppDots.clear();
    if (!pp) return;
    const p = N(pp.id); if (!p) return ppReset();
    const F = frameOf(p);
    for (const q of pp.points) { const d = new THREE.Mesh(snapDot, new THREE.MeshBasicMaterial({ color: 0xff8c1a, depthTest: false })); d.renderOrder = 45; d.position.copy(v3(q).applyMatrix4(F).multiplyScalar(U)); ppDots.add(d); }
    if (!pp.rect) return;
    const { min, max } = pp.rect, a = pp.a, [ua, va] = [0, 1, 2].filter(i => i !== a);
    const c = (u, v) => { const r = [0, 0, 0]; r[a] = pp.plane; r[ua] = u; r[va] = v; return v3(r).applyMatrix4(F); };
    const g = new THREE.BufferGeometry().setFromPoints([c(min[ua], min[va]), c(max[ua], min[va]), c(max[ua], max[va]), c(min[ua], min[va]), c(max[ua], max[va]), c(min[ua], max[va])]);
    const pane = new THREE.Mesh(g, paneMat); pane.renderOrder = 44; pane.userData.pane = true; ppG.add(pane);
    if (pp.depth) { // preview of what will be cut (red) or added (green)
      const bx = ppBox(p, pp.depth), m = new THREE.Mesh(unitBox, pp.depth < 0 ? cutMat : addMat); m.matrixAutoUpdate = false; m.renderOrder = 43;
      m.matrix.copy(F).multiply(new THREE.Matrix4().makeTranslation(...bx.min)).multiply(new THREE.Matrix4().makeScale(...bx.max.map((v, i) => Math.max(1e-3, v - bx.min[i])))); ppG.add(m);
    }
    ppG.updateMatrixWorld(true);
  }
  /** The block that a depth (negative = in) sweeps out from the pane, in the part's frame. Cuts stop at the far side. */
  function ppBox(p, depth) {
    const min = [...pp.rect.min], max = [...pp.rect.max], a = pp.a, out = pp.plane + pp.sign * depth;
    min[a] = Math.min(pp.plane, out); max[a] = Math.max(pp.plane, out);
    if (depth < 0) { const lo = Math.min(p.from[a], p.to[a]), hi = Math.max(p.from[a], p.to[a]); min[a] = Math.max(lo, min[a]); max[a] = Math.min(hi, max[a]); }
    return { min, max };
  }
  function ppClick(h) {
    const sp = ppSpot(h);
    if (!sp) return b.msg('Push / Pull: click on a part');
    if (sp.slanted) return b.msg('Push / Pull works on flat sides that face straight out (not slopes or curves)');
    if (!pp || pp.id !== sp.id || pp.side !== sp.side || pp.points.length >= 4) pp = { id: sp.id, side: sp.side, a: sp.a, sign: sp.sign, plane: sp.plane, points: [], rect: null, depth: 0 };
    pp.points.push(sp.pt);
    const min = [0, 1, 2].map(i => Math.min(...pp.points.map(q => q[i]))), max = [0, 1, 2].map(i => Math.max(...pp.points.map(q => q[i])));
    const flat = [0, 1, 2].filter(i => i !== pp.a).some(i => max[i] - min[i] < 1e-6);
    pp.rect = flat ? null : { min, max };
    b.sel = [sp.id]; drawSelection(); ppDraw(); changed();
    const [ua, va] = [0, 1, 2].filter(i => i !== pp.a);
    return b.msg(pp.rect ? `Pane ${r4(max[ua] - min[ua])} × ${r4(max[va] - min[va])} on the ${pp.side} side of “${N(sp.id).name}” — drag it in to cut, out to add${pp.points.length < 4 ? ' (or click more points)' : ''}` : `Point ${pp.points.length} on the ${pp.side} side — click another corner`);
  }
  // ---------------------------------------------------------------- pixel paint (Build mode, cube sides)
  const partOf = x => { const id = N(x) ? x : b.find(x); const n = id && N(id); if (!n || n.kind !== 'part') throw new Error(`No part called “${x}”`); if (n.shape !== 'cube') throw new Error(`“${n.name}” is a ${n.shape}: pixel paint works on cubes. For stripes on round or cut parts use paintBand (glb_build band), or paint(part, side, colour) for a whole side`); return n; };
  const sideOk = side => { if (!DIR[side]) throw new Error('Side must be front, back, left, right, top, bottom (or north, south, east, west, up, down)'); return side; };
  /** The side's pixel grid (made from its flat colour the first time). */
  function ensureFace(n, side) {
    n.pix ||= {};
    if (!n.pix[side]) {
      const [fw, fh] = faceDims(n, side), w = Math.max(1, Math.round(fw * b.pixelDensity)), h = Math.max(1, Math.round(fh * b.pixelDensity)), [r, g, bl] = hexRGB(n.colors[side] || b.color), d = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) d.set([r, g, bl, 255], i * 4);
      n.pix[side] = { w, h, rgba: b64(d) };
    }
    return n.pix[side];
  }
  /** After painting: a side that is one colour again goes back to a plain coloured side (so it merges in Make model). */
  function tidyFace(n, side) {
    const rec = n.pix?.[side]; if (!rec || rec.frames) return; // a side with frames keeps its grid
    const d = unb64(rec.rgba); let same = true; for (let i = 4; i < d.length && same; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) same = false;
    if (same) { n.colors[side] = rgbHex(d[0], d[1], d[2]); delete n.pix[side]; }
    if (n.pix && !Object.keys(n.pix).length) delete n.pix;
  }
  function editFace(n, side, fn) { const rec = ensureFace(n, side), d = unb64(rec.rgba); fn(d, rec.w, rec.h); rec.rgba = b64(d); tidyFace(n, side); }
  const put = (d, w, h, u, v, rgb) => { u = Math.round(u); v = Math.round(v); if (u < 0 || v < 0 || u >= w || v >= h) return; d.set([rgb[0], rgb[1], rgb[2], 255], (v * w + u) * 4); };
  const lineCells = (u0, v0, u1, v1) => { const out = []; let x = Math.round(u0), y = Math.round(v0); const x1 = Math.round(u1), y1 = Math.round(v1), dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1; let err = dx + dy; for (;;) { out.push([x, y]); if (x === x1 && y === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x += sx; } if (e2 <= dx) { err += dx; y += sy; } } return out; };
  const square = (u, v, size) => { const out = [], o = Math.floor((size - 1) / 2); for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) out.push([u - o + i, v - o + j]); return out; };
  /** Paint pixels on a side: list of [u, v, '#hex'] (u, v = pixels from the side's top-left, seen from outside). */
  b.paintPixels = (part, side, list) => op('Paint pixels', () => { const n = partOf(part); editFace(n, sideOk(side), (d, w, h) => { for (const [u, v, c] of list) put(d, w, h, u, v, hexRGB(c || b.color)); }); return b.msg(`Painted ${list.length} pixel${list.length === 1 ? '' : 's'} on the ${side} side of “${n.name}”`); });
  b.paintRect = (part, side, { u = 0, v = 0, w: rw = 1, h: rh = 1, color } = {}) => op('Paint rectangle', () => { const n = partOf(part), rgb = hexRGB(color || b.color); editFace(n, sideOk(side), (d, w, h) => { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) put(d, w, h, u + i, v + j, rgb); }); return b.msg(`Painted a ${rw} × ${rh} rectangle on “${n.name}”`); });
  b.paintLine = (part, side, from, to, color, width = 1) => op('Paint line', () => { const n = partOf(part), rgb = hexRGB(color || b.color); editFace(n, sideOk(side), (d, w, h) => { for (const [x, y] of lineCells(from[0], from[1], to[0], to[1])) for (const [i, j] of square(x, y, Math.max(1, Math.round(width)))) put(d, w, h, i, j, rgb); }); return b.msg(`Painted a line on “${n.name}”`); });
  /** Write text in pixels on a side. opts: { u, v (top-left, or the middle with align:'center'), color, size (px, default 7), font: 'sans'|'serif'|'mono'|css family, bold, align }. Returns {w, h} used. */
  b.paintText = (part, side, text, { u = 0, v = 0, color, size = 7, font = 'sans', bold = false, align = 'left' } = {}) => op('Paint text', () => {
    const n = partOf(part), t = textMask(text, { size, font, bold }), rgb = hexRGB(color || b.color), u0 = align === 'center' ? Math.round(u - t.w / 2) : u, v0 = align === 'center' ? Math.round(v - t.h / 2) : v;
    editFace(n, sideOk(side), (d, w, h) => { for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.mask[y * t.w + x]) put(d, w, h, u0 + x, v0 + y, rgb); });
    b.msg(`Wrote “${text}” (${t.w} × ${t.h} px) on the ${side} side of “${n.name}”`); return { w: t.w, h: t.h };
  });
  b.clearPaint = (part = null, side = null) => op('Clear paint', () => {
    const ns = part ? [partOf(part)] : b.sel.flatMap(id => [id, ...descendants(id)]).map(N).filter(n => n?.kind === 'part'); let c = 0;
    for (const n of ns) { if (!n.pix) continue; for (const sd of side ? [sideOk(side)] : SIDES) if (n.pix[sd]) { delete n.pix[sd]; c++; } if (!Object.keys(n.pix).length) delete n.pix; }
    return b.msg(`Cleared the paint from ${c} side${c === 1 ? '' : 's'}`);
  });
  /** Size of a side's pixel grid (what it is, or what it would be with the current pixel density). */
  b.faceSize = (part, side) => { const n = partOf(part); sideOk(side); if (n.pix?.[side]) return { w: n.pix[side].w, h: n.pix[side].h, painted: true }; const [fw, fh] = faceDims(n, side); return { w: Math.max(1, Math.round(fw * b.pixelDensity)), h: Math.max(1, Math.round(fh * b.pixelDensity)), painted: false }; };
  b.pixelAt = (part, side, u, v) => { const n = partOf(part); const rec = n.pix?.[sideOk(side)]; if (!rec) return n.colors[side]; const d = unb64(rec.rgba), o = (Math.floor(v) * rec.w + Math.floor(u)) * 4; return rgbHex(d[o], d[o + 1], d[o + 2]); };
  // ---- frames: a painted side can hold several named pictures (expressions: neutral, happy, blink...)
  // rec.rgba is always the picture showing now; rec.frames[name] keeps every picture (synced when switching / saving).
  const syncFrame = rec => { if (rec?.frames) rec.frames[rec.frame] = rec.rgba; };
  const framedRec = (part, side) => { const n = partOf(part), rec = n.pix?.[sideOk(side)]; if (!rec?.frames) throw new Error(`The ${side} side of “${n.name}” has no frames yet (add one with addFrame)`); return { n, rec }; };
  /** Add a named frame to a painted side. The first one names the picture already there; later ones copy the current picture and switch to it. */
  b.addFrame = (part, side, name) => op('Add frame', () => {
    const n = partOf(part), rec = ensureFace(n, sideOk(side)); name = String(name || '').trim() || `frame${Object.keys(rec.frames || {}).length + 1}`;
    if (!rec.frames) { rec.frames = { [name]: rec.rgba }; rec.frame = name; return b.msg(`The ${side} side of “${n.name}” now has frames; this picture is “${name}”. Add more frames for other expressions.`); }
    if (rec.frames[name]) throw new Error(`There is already a frame called “${name}”`);
    syncFrame(rec); rec.frames[name] = rec.rgba; rec.frame = name;
    return b.msg(`Added frame “${name}” (a copy of the last picture) — paint it now`);
  });
  /** Show a frame (painting then draws into it). */
  b.setFrame = (part, side, name) => op('Show frame', () => { const { n, rec } = framedRec(part, side); if (!rec.frames[name]) throw new Error(`No frame “${name}” (frames: ${Object.keys(rec.frames).join(', ')})`); syncFrame(rec); rec.rgba = rec.frames[name]; rec.frame = name; return b.msg(`Showing “${name}” on “${n.name}”`); });
  b.frames = (part, side) => { const n = partOf(part), rec = n.pix?.[sideOk(side)]; return rec?.frames ? { frames: Object.keys(rec.frames), current: rec.frame } : { frames: [], current: null }; };
  b.removeFrame = (part, side, name) => op('Delete frame', () => {
    const { n, rec } = framedRec(part, side); if (!rec.frames[name]) throw new Error(`No frame “${name}”`);
    syncFrame(rec); delete rec.frames[name];
    const left = Object.keys(rec.frames);
    if (!left.length) { delete rec.frames; delete rec.frame; return b.msg('Removed the last frame; the side keeps its picture'); }
    if (rec.frame === name) { rec.frame = left[0]; rec.rgba = rec.frames[left[0]]; }
    return b.msg(`Deleted frame “${name}” from “${n.name}”`);
  });
  b.renameFrame = (part, side, from, to) => op('Rename frame', () => { const { rec } = framedRec(part, side); to = String(to || '').trim(); if (!rec.frames[from]) throw new Error(`No frame “${from}”`); if (!to || rec.frames[to]) throw new Error('Pick a new, unused name'); syncFrame(rec); rec.frames = Object.fromEntries(Object.entries(rec.frames).map(([k, v]) => [k === from ? to : k, v])); if (rec.frame === from) rec.frame = to; });
  b.setPixelDensity = v => { if (![1, 2, 4, 8].includes(+v)) throw new Error('Pixel density must be 1, 2, 4 or 8 pixels per unit'); b.pixelDensity = +v; changed(); return b.msg(`New painted sides get ${v} pixel${+v === 1 ? '' : 's'} per unit (sides already painted keep their grid)`); };

  // brush strokes in the view
  let stroke = null;
  /** Where on a cube side a mouse hit is: { n, side, u, v } (u, v 0..1 from the side's top-left). */
  function faceSpot(h) {
    if (!h) return null; const n = N(h.object.userData.id); if (!n || n.kind !== 'part' || n.shape !== 'cube' || n.collider) return null;
    const q = h.point.clone().divideScalar(U).applyMatrix4(partMatrix(n).invert());
    const nrm = h.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize().applyQuaternion(groupQ(n.parent).multiply(eulerQ(n.rotation)).invert());
    const side = sideOf(nrm), { tl, du, dv } = faceAxes(side), d = q.sub(tl);
    return { n, side, u: Math.max(0, Math.min(0.9999, d.dot(du))), v: Math.max(0, Math.min(0.9999, d.dot(dv))) };
  }
  /** The same spot mirrored across the middle line (x = 0) on whichever cube side is there. */
  function mirrorSpot(sp) {
    const { tl, du, dv } = faceAxes(sp.side), unit = tl.clone().addScaledVector(du, sp.u).addScaledVector(dv, sp.v), P = unit.applyMatrix4(partMatrix(sp.n)); P.x = -P.x;
    const nW = v3(DIR[sp.side]).applyQuaternion(groupQ(sp.n.parent).multiply(eulerQ(sp.n.rotation))); nW.x = -nW.x;
    for (const q of Object.values(b.doc.nodes)) {
      if (q.kind !== 'part' || q.shape !== 'cube') continue;
      const u = P.clone().applyMatrix4(partMatrix(q).invert()); if ([0, 1, 2].some(i => u.getComponent(i) < -0.02 || u.getComponent(i) > 1.02)) continue;
      const nl = nW.clone().applyQuaternion(groupQ(q.parent).multiply(eulerQ(q.rotation)).invert()), side = sideOf(nl), a = DIR[side].findIndex(x => x);
      if (Math.abs(nl.getComponent(a)) < 0.99 || Math.abs(u.getComponent(a) - (DIR[side][a] > 0 ? 1 : 0)) > 0.02) continue;
      const F = faceAxes(side), d = u.sub(F.tl);
      return { n: q, side, u: Math.max(0, Math.min(0.9999, d.dot(F.du))), v: Math.max(0, Math.min(0.9999, d.dot(F.dv))) };
    }
    return null;
  }
  function strokeFace(sp) { // the live canvas of a side (made on first touch; the data is written back when the stroke ends)
    const fresh = !sp.n.pix?.[sp.side];
    ensureFace(sp.n, sp.side);
    stroke.touched.set(sp.n.id + '|' + sp.side, { n: sp.n, side: sp.side });
    if (fresh) { const m = meshes.get(sp.n.id); setPartLook(m, sp.n); m.userData.key = geoKey(sp.n); }
    return faceCanvas(sp.n, sp.side);
  }
  function dab(sp, from) {
    const f = strokeFace(sp), i = Math.floor(sp.u * f.w), j = Math.floor(sp.v * f.h), B = b.pixelBrush;
    const colour = B.mode === 'erase' ? (sp.n.colors[sp.side] || b.color) : b.color;
    if (B.mode === 'text') { // stamp the text with its top-left on the clicked pixel
      const t = textMask(B.text || 'Text', { size: B.textSize, font: B.font, bold: B.bold }); f.ctx.fillStyle = b.color;
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.mask[y * t.w + x]) f.ctx.fillRect(i + x, j + y, 1, 1);
      f.tex.needsUpdate = true; return;
    }
    if (B.mode === 'fill') { // flood-fill the touching pixels of the same colour
      const img = f.ctx.getImageData(0, 0, f.w, f.h), d = img.data, o0 = (j * f.w + i) * 4, target = [d[o0], d[o0 + 1], d[o0 + 2]], rgb = hexRGB(colour);
      if (target.every((v, k) => v === rgb[k])) return;
      const stack = [[i, j]], seen = new Uint8Array(f.w * f.h);
      while (stack.length) { const [x, y] = stack.pop(); if (x < 0 || y < 0 || x >= f.w || y >= f.h || seen[y * f.w + x]) continue; seen[y * f.w + x] = 1; const o = (y * f.w + x) * 4; if (d[o] !== target[0] || d[o + 1] !== target[1] || d[o + 2] !== target[2]) continue; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255; stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]); }
      f.ctx.putImageData(img, 0, 0);
    } else {
      f.ctx.fillStyle = colour;
      const cells = from && from.n === sp.n && from.side === sp.side ? lineCells(Math.floor(from.u * f.w), Math.floor(from.v * f.h), i, j) : [[i, j]];
      for (const [x, y] of cells) for (const [a2, c2] of square(x, y, B.size)) f.ctx.fillRect(a2, c2, 1, 1);
    }
    f.tex.needsUpdate = true;
  }
  function dabAll(sp) {
    dab(sp, stroke.last); const last = sp;
    if (b.pixelBrush.mirror && b.pixelBrush.mode !== 'text') { const m = mirrorSpot(sp); if (m && !(m.n === sp.n && m.side === sp.side && Math.abs(m.u - sp.u) < 1e-6)) dab(m, stroke.lastM); stroke.lastM = m; }
    stroke.last = last;
  }
  function endStroke() {
    if (!stroke) return; const st = stroke; stroke = null; ed.orbit.enabled = true;
    for (const { n, side } of st.touched.values()) { const f = faceCanvas(n, side), img = f.ctx.getImageData(0, 0, f.w, f.h); n.pix[side].rgba = b64(new Uint8Array(img.data.buffer)); tidyFace(n, side); }
    const after = snapshot();
    if (after !== st.before) { const sel = [...b.sel]; pushUndo({ pencil: 'Draw pixels', fill: 'Fill pixels', erase: 'Erase pixels' }[b.pixelBrush.mode], () => restore(st.before, st.selBefore), () => restore(after, sel)); b.dirty = true; }
    refresh();
  }
  ed.dom.addEventListener('pointerdown', e => {
    if (!b.active || b.tool !== 'pixel' || e.button !== 0 || ed.viewOnly) return;
    const pt = local(e), h = hitAt(pt.x, pt.y);
    if (!h) return; // empty space: turn the view as usual
    e.stopImmediatePropagation(); e.preventDefault();
    const sp = faceSpot(h);
    if (!sp) return b.msg('Pixel paint works on cubes (round shapes take one colour per side)');
    if (e.altKey) { b.color = b.pixelAt(sp.n.id, sp.side, Math.floor(sp.u * (sp.n.pix?.[sp.side]?.w || 1)), Math.floor(sp.v * (sp.n.pix?.[sp.side]?.h || 1))) || b.color; b.msg('Picked colour ' + b.color); return changed(); }
    stroke = { before: snapshot(), selBefore: [...b.sel], touched: new Map(), last: null, lastM: null };
    ed.orbit.enabled = false; try { ed.dom.setPointerCapture(e.pointerId); } catch {}
    dabAll(sp);
  }, true);
  ed.dom.addEventListener('pointermove', e => {
    if (!stroke || b.pixelBrush.mode === 'fill' || b.pixelBrush.mode === 'text') return;
    const pt = local(e), sp = faceSpot(hitAt(pt.x, pt.y)); if (sp) dabAll(sp);
  }, true);
  ed.dom.addEventListener('pointerup', e => { if (stroke) { e.stopImmediatePropagation(); endStroke(); } }, true);
  ed.dom.addEventListener('pointercancel', () => endStroke(), true);

  let stretchDrag = null;
  const closestOnAxis = (A, u, ray) => { // parameter t along line A + t·u closest to the mouse ray
    const w = new THREE.Vector3().subVectors(A, ray.origin), a = u.dot(u), bb = u.dot(ray.direction), c = ray.direction.dot(ray.direction), d = u.dot(w), e = ray.direction.dot(w);
    const den = a * c - bb * bb; return Math.abs(den) < 1e-9 ? 0 : (bb * e - c * d) / den;
  };
  const local = e => { const r = ed.dom.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  ed.dom.addEventListener('pointerdown', e => {
    if (!b.active || e.button !== 0 || ed.viewOnly) return;
    const pt = local(e);
    if (b.tool === 'push' && pp?.rect) { // grab the pane and drag it in or out
      const pane = ppG.children.find(o => o.userData.pane), hit = pane && ed._ray(pt.x, pt.y).intersectObject(pane, false)[0];
      if (hit) {
        e.stopImmediatePropagation(); e.preventDefault();
        const p = N(pp.id), u = v3(DIR[pp.side]).applyQuaternion(groupQ(p.parent).multiply(eulerQ(p.rotation))).normalize();
        pp.drag = { u, A: hit.point.clone(), t0: closestOnAxis(hit.point, u, ed._ray(pt.x, pt.y).ray) };
        ed.orbit.enabled = false; try { ed.dom.setPointerCapture(e.pointerId); } catch {}
        return;
      }
    }
    // let the gizmo find its arrow / ring first, so the editor doesn't start a box-select instead
    if (tc.object && tc.enabled) tc.pointerHover({ x: pt.x / ed.dom.clientWidth * 2 - 1, y: -(pt.y / ed.dom.clientHeight) * 2 + 1, button: e.button });
    if (b.tool === 'paint' && e.altKey) { b.click(pt.x, pt.y, { alt: true }); e.stopImmediatePropagation(); return; }
    if (b.tool !== 'stretch') return;
    const vis = knobs.filter(k => k.visible); if (!vis.length) return;
    const ray = ed._ray(pt.x, pt.y).ray;
    let best = null;
    for (const k of vis) { const s = k.position.clone().project(ed.camera), sx = (s.x + 1) / 2 * ed.dom.clientWidth, sy = (1 - s.y) / 2 * ed.dom.clientHeight, dd = Math.hypot(sx - pt.x, sy - pt.y); if (dd < 20 && (!best || dd < best.dd)) best = { k, dd }; }
    if (!best) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const p = primary(), side = best.k.userData.side, M = meshes.get(p.id).matrixWorld;
    const u = v3(DIR[side]).transformDirection(M); // world direction of the side (normalised)
    const ids = topSel().filter(id => N(id).kind === 'part');
    stretchDrag = { side, u, A: best.k.position.clone(), t0: 0, before: snapshot(), selBefore: [...b.sel], base: new Map(ids.map(id => [id, clone(N(id))])), both: e.shiftKey };
    stretchDrag.t0 = closestOnAxis(stretchDrag.A, u, ray);
    ed.orbit.enabled = false;
    try { ed.dom.setPointerCapture(e.pointerId); } catch {}
  }, true);
  ed.dom.addEventListener('pointermove', e => {
    if (b.active && b.tool === 'push') {
      const pt = local(e);
      if (pp?.drag) {
        let d = (closestOnAxis(pp.drag.A, pp.drag.u, ed._ray(pt.x, pt.y).ray) - pp.drag.t0) / U;
        if (b.gridStep > 0) d = Math.round(d / b.gridStep) * b.gridStep;
        pp.depth = r4(d); ppDraw();
        const p = N(pp.id), thick = Math.abs(p.to[pp.a] - p.from[pp.a]);
        b.msg(d < 0 ? (-d >= thick - 1e-6 ? `Hole straight through (${r4(thick)} deep) — let go to cut` : `Cut ${r4(-d)} deep — let go to cut`) : d > 0 ? `Add a block ${r4(d)} out — let go to add` : 'Drag in to cut, out to add');
        return;
      }
      const sp = ppSpot(hitAt(pt.x, pt.y)); // show where a click would land
      if (sp && !sp.slanted) { ppHover.position.copy(v3(sp.pt).applyMatrix4(frameOf(N(sp.id))).multiplyScalar(U)); ppHover.visible = true; } else ppHover.visible = false;
    }
    if (!stretchDrag) return;
    const pt = local(e), sd = stretchDrag, ray = ed._ray(pt.x, pt.y).ray;
    let d = (closestOnAxis(sd.A, sd.u, ray) - sd.t0) / U; // Blockbench units, outward from this side
    if (b.gridStep > 0) d = Math.round(d / b.gridStep) * b.gridStep;
    const ax = { east: 0, west: 0, up: 1, down: 1, south: 2, north: 2 }[sd.side], plus = ['east', 'up', 'south'].includes(sd.side);
    for (const [id, base] of sd.base) {
      const n = N(id); n.from = [...base.from]; n.to = [...base.to];
      if (plus || sd.both) n.to[ax] = r4(Math.max(n.from[ax], base.to[ax] + d));
      if (!plus || sd.both) n.from[ax] = r4(Math.min(n.to[ax], base.from[ax] - d));
      if (n.from[ax] > n.to[ax]) n.from[ax] = n.to[ax];
    }
    refreshQuick();
    const p = primary(); if (p) b.msg(`Size ${p.to.map((t, i) => r4(t - p.from[i])).join(' × ')}`);
  }, true);
  const endStretch = () => {
    if (!stretchDrag) return;
    const sd = stretchDrag; stretchDrag = null; ed.orbit.enabled = true;
    const after = snapshot();
    if (after !== sd.before) { const sel = [...b.sel]; pushUndo('Stretch', () => restore(sd.before, sd.selBefore), () => restore(after, sel)); b.dirty = true; }
    refresh();
  };
  ed.dom.addEventListener('pointerup', e => {
    if (stretchDrag) { e.stopImmediatePropagation(); endStretch(); return; }
    if (pp?.drag) {
      e.stopImmediatePropagation(); ed.orbit.enabled = true;
      const { id, side, rect, depth } = pp; pp.drag = null;
      if (!depth) { pp.depth = 0; ppDraw(); return; }
      b.pushPull(id, side, rect, depth).catch(err => b.msg(err.message || String(err)));
    }
  }, true);
  ed.dom.addEventListener('pointercancel', endStretch, true);

  b.tick = () => { // keep handles the same size on screen
    if (!b.active) return;
    const s = o => { o.scale.setScalar(ed.camera.position.distanceTo(o.position) * 0.016); };
    knobs.forEach(k => k.visible && s(k)); if (pivotMark.visible) s(pivotMark);
    snapG.children.forEach(o => { o.scale.setScalar(ed.camera.position.distanceTo(o.position) * 0.0075); });
    for (const o of [...ppDots.children, ppHover]) o.scale.setScalar(ed.camera.position.distanceTo(o.position) * 0.0065);
    if (snapRing.visible) { snapRing.scale.setScalar(ed.camera.position.distanceTo(snapRing.position) * 0.018); snapRing.quaternion.copy(ed.camera.quaternion); }
  };

  // ---------------------------------------------------------------- commands
  function defaultParent() { const p = primary(); return p ? (p.kind === 'group' ? p.id : p.parent) : (b.isolate && N(b.isolate.group) ? b.isolate.group : null); } // in a sub-tab new shapes land in its group
  /** Add a shape. opts: { from, to, size, color, name, parent } (Blockbench units). New shapes sit on top of what is picked. */
  b.add = (shape = 'cube', opts = {}) => op('Add ' + (SHAPES[shape]?.label || shape), () => {
    if (!SHAPES[shape]) throw new Error('Shape must be one of ' + Object.keys(SHAPES).join(', '));
    unitGeo(shape); const nat = NATURAL[shape] || [1, 1, 1];
    const size = opts.size || [4 * nat[0] / Math.max(nat[0], nat[2]), 4, 4 * nat[2] / Math.max(nat[0], nat[2])].map(v => Math.round(v * 1000) / 1000);
    let from = opts.from, to = opts.to;
    if (!from) {
      const p = primary();
      if (p && p.kind === 'part' && !opts.parent) { const cx = (p.from[0] + p.to[0]) / 2, cz = (p.from[2] + p.to[2]) / 2; from = [cx - size[0] / 2, p.to[1], cz - size[2] / 2]; }
      else from = [-size[0] / 2, 0, -size[2] / 2];
      if (b.gridStep > 0) from = from.map(v => Math.round(v / b.gridStep) * b.gridStep);
    }
    to = to || from.map((v, i) => v + size[i]);
    const col = opts.color || b.color, n = {
      id: uid(), kind: 'part', name: opts.name || uniqueName(shape, 'part'), shape, from: from.map(r4), to: to.map(r4),
      origin: opts.origin || from.map((v, i) => r4((v + to[i]) / 2)), rotation: opts.rotation || [0, 0, 0],
      colors: Object.fromEntries(SIDES.map(s => [s, col])), flip: [0, 0, 0], sides: opts.sides || 12,
    };
    insertNode(n, opts.parent !== undefined ? opts.parent : defaultParent(), null);
    b.sel = [n.id];
    return n.id;
  });
  /**
   * A collider: an invisible shape for the game's physics / hits, moving with its group (joint). shape: 'box' | 'sphere' | 'capsule'.
   * opts: { from, to (Blockbench units), name, parent }. Without from/to it wraps what is picked (or a 8-unit box at the middle).
   * Edit it like a part (move, stretch, rotate, copy, mirror). Make model turns it into an empty node under its joint with
   * extras.collider = {shape, size:[x,y,z] metres, radius?, height?}.
   */
  b.addCollider = (shape = 'box', opts = {}) => op('Add collider', () => {
    const map = { box: 'cube', sphere: 'sphere', capsule: 'cylinder' }; if (!map[shape]) throw new Error("Collider shape must be 'box', 'sphere' or 'capsule'");
    let from = opts.from, to = opts.to;
    if (!from || !to) {
      const ps = b.sel.flatMap(id => [id, ...descendants(id)]).map(N).filter(n => n?.kind === 'part' && !n.collider);
      if (ps.length) { from = [0, 1, 2].map(i => Math.min(...ps.map(p => Math.min(p.from[i], p.to[i])))); to = [0, 1, 2].map(i => Math.max(...ps.map(p => Math.max(p.from[i], p.to[i])))); }
      else { from = [-4, 0, -4]; to = [4, 8, 4]; }
    }
    const pid = opts.parent !== undefined ? opts.parent : (primary()?.kind === 'group' ? primary().id : primary()?.parent ?? null);
    const n = { id: uid(), kind: 'part', collider: shape, name: uniqueName(opts.name || `collider_${pid ? N(pid).name : 'body'}`), shape: map[shape], from: from.map(r4), to: to.map(r4), origin: from.map((v, i) => r4((v + to[i]) / 2)), rotation: [0, 0, 0], colors: Object.fromEntries(SIDES.map(sd => [sd, '#35e0ff'])), flip: [0, 0, 0], sides: 16 };
    insertNode(n, pid); b.sel = [n.id];
    return b.msg(`Added a ${shape} collider “${n.name}”${pid ? ` on “${N(pid).name}”` : ''}. Stretch and move it like a part.`);
  });
  b.colliders = () => Object.values(b.doc?.nodes || {}).filter(n => n.collider).map(n => ({ id: n.id, name: n.name, shape: n.collider, joint: n.parent ? N(n.parent).name : null, from: n.from, to: n.to, rotation: n.rotation }));
  b.setCollidersVisible = on => { b.showColliders = !!on; refresh(); return b.msg(on ? 'Showing colliders' : 'Colliders hidden (they are still saved)'); };
  b.addLocator = (name = 'attach_point', opts = {}) => op('Add attach point', () => {
    const p = primary(), pos = opts.position || (p && p.kind === 'part' ? p.from.map((v, i) => r4((v + p.to[i]) / 2)) : [0, 0, 0]);
    const n = { id: uid(), kind: 'locator', name: uniqueName(name), position: pos, rotation: [0, 0, 0] };
    insertNode(n, opts.parent !== undefined ? opts.parent : defaultParent()); b.sel = [n.id]; return n.id;
  });
  b.remove = () => op('Delete', () => { const ids = topSel(); if (!ids.length) throw new Error('Pick something to delete'); ids.forEach(removeNode); b.sel = []; return b.msg(`Deleted ${ids.length}`); });
  function copyOf(id) { const out = []; const walk = x => { const n = clone(N(x)); out.push(n); (n.children || []).forEach(walk); }; walk(id); return out; }
  b.copy = () => { const ids = topSel(); if (!ids.length) return b.msg('Pick something to copy'); b.clipboard = ids.map(copyOf); return b.msg(`Copied ${ids.length}`); };
  function pasteTrees(trees, pid, after = null) {
    const newIds = [];
    for (const tree of trees) {
      const map = new Map(tree.map(n => [n.id, uid()]));
      for (const n of tree) {
        const m = clone(n); m.id = map.get(n.id);
        if (m.children) m.children = m.children.map(c => map.get(c));
        if (n === tree[0]) { b.doc.nodes[m.id] = m; m.parent = pid; const list = kids(pid), i = after ? list.indexOf(after) : -1; if (i >= 0) list.splice(i + 1 + newIds.length, 0, m.id); else list.push(m.id); newIds.push(m.id); }
        else { m.parent = map.get(n.parent); b.doc.nodes[m.id] = m; }
        if (m.kind === 'group' && n !== tree[0]) m.name = m.name; // names inside a pasted group stay
      }
      const top = b.doc.nodes[map.get(tree[0].id)]; top.name = uniqueName(top.name.replace(/\d+$/, '') || top.name, top.kind);
    }
    return newIds;
  }
  b.paste = () => op('Paste', () => { if (!b.clipboard) throw new Error('Copy something first'); b.sel = pasteTrees(b.clipboard, defaultParent()); return b.msg(`Pasted ${b.sel.length}`); });
  b.duplicate = () => op('Duplicate', () => {
    const ids = topSel(); if (!ids.length) throw new Error('Pick something to duplicate');
    const out = []; for (const id of ids) out.push(...pasteTrees([copyOf(id)], N(id).parent, id));
    b.sel = out; return b.msg(`Duplicated ${out.length} — it sits on top of the original; move it away`);
  });
  b.group = (name = 'group') => op('Group', () => {
    const ids = topSel(); if (!ids.length) throw new Error('Pick the parts to put in a group');
    const pid = N(ids[0]).parent, c = selCentre(), W = groupWorld(pid);
    const o = c ? c.divideScalar(U).applyMatrix4(W.clone().invert()).toArray().map(v => b.gridStep > 0 ? Math.round(v / b.gridStep) * b.gridStep : r4(v)) : [0, 0, 0];
    const g = { id: uid(), kind: 'group', name: uniqueName(name, 'group'), origin: o, rotation: [0, 0, 0], children: [] };
    insertNode(g, pid, ids[0]);
    for (const id of ids) reparent(id, g.id);
    b.sel = [g.id]; return b.msg(`Grouped ${ids.length} into “${g.name}”. Use the Pivot tool to set where it bends.`);
  });
  b.ungroup = () => op('Ungroup', () => {
    const gs = b.sel.filter(id => N(id)?.kind === 'group'); if (!gs.length) throw new Error('Pick a group to ungroup');
    const out = [];
    for (const g of gs) { const pid = N(g).parent; let at = kids(pid).indexOf(g); for (const c of [...N(g).children]) { reparent(c, pid, ++at); out.push(c); } removeNode(g); }
    b.sel = out; return b.msg('Ungrouped');
  });
  /**
   * Combine: fuse parts into ONE part and throw away every face and point that ends up inside.
   * Picked group -> the parts directly in it (groups inside it stay separate, they bend); or 2+ picked parts in one group.
   * Straight cubes use an exact surface method (big same-colour rectangles); other shapes use a solid union (three-bvh-csg).
   */
  /**
   * Push / pull a rectangle on one side of a part. area = {min:[x,y,z], max:[x,y,z]} in the part's own frame (Blockbench
   * units; the coordinate across the side is ignored), side = 'up' | 'north' | ..., depth: < 0 cuts in (a hole once it
   * passes the far side), > 0 adds a block. Cubes are split into cubes; other shapes get a solid cut.
   */
  b.pushPull = async (id, side, area, depth) => {
    const p = N(id) || N(b.find(id)); if (!p || p.kind !== 'part') throw new Error('Name a part to push or pull');
    const d0 = DIR[side]; if (!d0) throw new Error('Side must be north, south, east, west, up or down');
    if (!depth) throw new Error('Depth 0 does nothing (negative = cut in, positive = add)');
    const a = d0.findIndex(v => v), sign = d0[a], lo = p.from.map((v, i) => Math.min(v, p.to[i])), hi = p.from.map((v, i) => Math.max(v, p.to[i]));
    const rect = { min: area.min.map((v, i) => (i === a ? 0 : Math.max(lo[i], Math.min(v, area.max[i])))), max: area.max.map((v, i) => (i === a ? 0 : Math.min(hi[i], Math.max(v, area.min[i])))) };
    if ([0, 1, 2].some(i => i !== a && rect.max[i] - rect.min[i] < 1e-6)) throw new Error('The pane has no size: pick corners that are apart');
    const save = pp; pp = { a, sign, plane: sign > 0 ? hi[a] : lo[a], rect }; const box = ppBox(p, depth); pp = save;
    const colorOf = p.shape === 'mesh' ? (p.mesh.tris[0]?.color || b.color) : (p.colors[side] || Object.values(p.colors).find(Boolean) || b.color);
    if (depth > 0) return op('Add block', () => { // pull out: a new block on that side
      const n = { id: uid(), kind: 'part', name: uniqueName(p.name + '_add'), shape: 'cube', from: box.min.map(r4), to: box.max.map(r4), origin: [...p.origin], rotation: [...p.rotation],
        colors: Object.fromEntries(SIDES.map(s2 => [s2, p.shape === 'cube' ? (p.colors[s2] || colorOf) : colorOf])), flip: [0, 0, 0], sides: 12 };
      insertNode(n, p.parent, p.id); b.sel = [n.id]; ppReset();
      return b.msg(`Added a ${box.max.map((v, i) => r4(v - box.min[i])).join(' × ')} block to “${p.name}”`);
    });
    const thick = hi[a] - lo[a], through = box.max[a] - box.min[a] >= thick - 1e-6;
    if (p.collider) throw new Error('Push / Pull works on parts, not colliders: stretch the collider instead');
    if (hasPix(p)) throw new Error(`“${p.name}” has pixel paint, which a cut would lose. Clear its paint first.`);
    if (p.shape === 'cube' && !(p.flip || []).some(Boolean)) return op(through ? 'Cut hole' : 'Cut', () => { // a cube splits into cubes around the hole
      const pieces = [], cur = { min: [...lo], max: [...hi] };
      for (const ax of [a, ...[0, 1, 2].filter(i => i !== a)]) {
        if (box.min[ax] > cur.min[ax] + 1e-6) { const q = { min: [...cur.min], max: [...cur.max] }; q.max[ax] = box.min[ax]; pieces.push(q); cur.min[ax] = box.min[ax]; }
        if (box.max[ax] < cur.max[ax] - 1e-6) { const q = { min: [...cur.min], max: [...cur.max] }; q.min[ax] = box.max[ax]; pieces.push(q); cur.max[ax] = box.max[ax]; }
      }
      const ids = [];
      pieces.forEach((q, i) => {
        const colors = {}; // sides facing into the cut get the colour of the side you cut into (the inside of the material)
        for (const s2 of SIDES) { const dd = DIR[s2], k = dd.findIndex(v => v), facesCut = dd[k] > 0 ? Math.abs(q.max[k] - box.min[k]) < 1e-6 : Math.abs(q.min[k] - box.max[k]) < 1e-6; colors[s2] = facesCut ? colorOf : p.colors[s2]; }
        const n = { id: uid(), kind: 'part', name: uniqueName(`${p.name}_${i + 1}`), shape: 'cube', from: q.min.map(r4), to: q.max.map(r4), origin: [...p.origin], rotation: [...p.rotation], colors, flip: [0, 0, 0], sides: 12 };
        const inside = (p.snaps || []).filter(sp => { const w = flipU(p, sp.u).map((u, j) => lo[j] + u * (hi[j] - lo[j])); return w.every((v, j) => v >= q.min[j] - 1e-6 && v <= q.max[j] + 1e-6); });
        if (inside.length) n.snaps = inside.map(sp => ({ ...sp, u: flipU(p, sp.u).map((u, j) => lo[j] + u * (hi[j] - lo[j])).map((v, j) => r4((v - q.min[j]) / Math.max(1e-6, q.max[j] - q.min[j]))) }));
        insertNode(n, p.parent, ids.length ? ids[ids.length - 1] : p.id); ids.push(n.id);
      });
      removeNode(p.id); b.sel = ids; ppReset();
      return b.msg(`${through ? 'Cut a hole through' : `Cut ${r4(box.max[a] - box.min[a])} deep into`} “${p.name}”: it is now ${ids.length} cube${ids.length === 1 ? '' : 's'} (picked together — Combine makes them one part)`);
    });
    // other shapes: solid cut (three-bvh-csg), result is one triangle-mesh part
    const { Brush, SUBTRACTION, ev } = await csgKit();
    const PM = pivotM(p.origin, p.rotation), BM = PM.clone().multiply(new THREE.Matrix4().makeTranslation(...p.from)).multiply(new THREE.Matrix4().makeScale(...p.to.map((t, i) => Math.max(1e-4, t - p.from[i]))));
    const grow = [...box.min], grow2 = [...box.max]; if (through) { grow[a] -= 0.01; grow2[a] += 0.01; } else if (sign > 0) grow2[a] += 0.01; else grow[a] -= 0.01; // poke out of the surface so the cut is clean
    const cutTris = unitGeo('cube').attributes.position, ct = []; for (let i = 0; i < cutTris.count; i += 3) ct.push({ P: [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(cutTris, i + k)), color: colorOf });
    const cutM = PM.clone().multiply(new THREE.Matrix4().makeTranslation(...grow)).multiply(new THREE.Matrix4().makeScale(...grow2.map((v, i) => v - grow[i])));
    const own = partTris(p, true), res = ev.evaluate(csgBrush(Brush, own, BM), csgBrush(Brush, ct, cutM), SUBTRACTION);
    const data = meshPartData(csgTris(res.geometry, [...own.map(t => t.color), colorOf]));
    if (!data) throw new Error('Nothing would be left of that part');
    const { lo: mn, hi: mx, size, verts, tris: mt } = data;
    return op(through ? 'Cut hole' : 'Cut', () => {
      const n = { id: uid(), kind: 'part', name: p.name, shape: 'mesh', from: mn.map(r4), to: mx.map(r4), origin: mn.map((v, j) => r4(v + size[j] / 2)), rotation: [0, 0, 0], colors: {}, flip: [0, 0, 0], sides: 12, mesh: { verts, tris: mt } };
      insertNode(n, p.parent, p.id); removeNode(p.id); b.sel = [n.id]; ppReset();
      return b.msg(`${through ? 'Cut a hole through' : 'Cut into'} “${n.name}” (solid cut): ${mt.length} triangles`);
    });
  };
  /**
   * Hollow a part out (mug, bucket, pot, box): the inside is removed following the part's OWN shape (round for a cylinder /
   * cone / sphere), leaving walls `wall` thick and a bottom; open on `side` (default top), `depth` deep (default: all but a
   * bottom as thick as the walls). Units = Blockbench units, measured in the part's own box. Result: one 'mesh' part.
   */
  b.hollow = async (id, { side = 'up', wall = 1, depth = null } = {}) => {
    const p = N(id) || N(b.find(id)); if (!p || p.kind !== 'part') throw new Error('Name a part to hollow');
    side = sideName(side); const d0 = DIR[side]; if (!d0) throw new Error('Side must be front, back, left, right, top or bottom');
    if (p.collider) throw new Error('Colliders can not be hollowed');
    if (hasPix(p)) throw new Error(`“${p.name}” has pixel paint, which hollowing would lose. Clear its paint first (paint stripes afterwards with paintBand).`);
    const a = d0.findIndex(v => v), sign = d0[a], lo = p.from.map((v, i) => Math.min(v, p.to[i])), hi = p.from.map((v, i) => Math.max(v, p.to[i])), size = hi.map((h, i) => h - lo[i]);
    wall = Math.max(0.05, +wall || 1);
    if ([0, 1, 2].some(i => i !== a && size[i] <= wall * 2 + 0.05)) throw new Error(`“${p.name}” is too thin for walls ${wall} thick (it is ${size.map(r4).join(' × ')})`);
    depth = depth == null ? size[a] - wall : Math.min(+depth, size[a] - 0.05);
    if (!(depth > 0)) throw new Error('Depth must be more than 0');
    const iMin = lo.map((v, i) => (i === a ? (sign > 0 ? hi[a] - depth : lo[a] - 0.01 - wall) : v + wall)), iMax = hi.map((v, i) => (i === a ? (sign > 0 ? hi[a] + 0.01 + wall : lo[a] + depth) : v - wall));
    const { Brush, SUBTRACTION, ev } = await csgKit();
    const PM = pivotM(p.origin, p.rotation), box = (mn, mx) => PM.clone().multiply(new THREE.Matrix4().makeTranslation(...mn)).multiply(new THREE.Matrix4().makeScale(...mx.map((t, i) => Math.max(1e-4, t - mn[i]))));
    const own = partTris(p, true), insideColour = p.shape === 'mesh' ? (p.mesh.tris[0]?.color || b.color) : (p.colors[side] || Object.values(p.colors).find(Boolean) || b.color);
    const inner = own.map(t => ({ P: t.P.map(v => v.clone()), color: insideColour }));
    const res = ev.evaluate(csgBrush(Brush, own, box(lo, hi)), csgBrush(Brush, inner, box(iMin, iMax)), SUBTRACTION);
    const data = meshPartData(csgTris(res.geometry, [...own.map(t => t.color), insideColour]));
    if (!data) throw new Error('Nothing would be left of that part');
    const { lo: mn, hi: mx, size: sz, verts, tris: mt } = data;
    return op('Hollow', () => {
      const n = { id: uid(), kind: 'part', name: p.name, shape: 'mesh', from: mn.map(r4), to: mx.map(r4), origin: mn.map((v, j) => r4(v + sz[j] / 2)), rotation: [0, 0, 0], colors: {}, flip: [0, 0, 0], sides: 12, mesh: { verts, tris: mt } };
      if (p.snaps) n.snaps = p.snaps;
      insertNode(n, p.parent, p.id); removeNode(p.id); b.sel = [n.id];
      return b.msg(`Hollowed “${n.name}”: walls ${wall}, ${r4(depth)} deep, open at the ${NICE_SIDE[side]} (${mt.length} triangles)`);
    });
  };
  /**
   * Paint a stripe / band round ANY part (round, cut, combined — not only cubes): everything between `from` and `to` along
   * `side` (fractions 0..1 of the part's height that way: 0 = the opposite side, 1 = that side) gets `color`. The part
   * becomes a triangle-mesh part (cut exactly at the band edges). Cubes with pixel paint: use paintRect instead.
   */
  b.paintBand = (id, { side = 'up', from = 0.4, to = 0.6, color } = {}) => {
    const p = N(id) || N(b.find(id)); if (!p || p.kind !== 'part') throw new Error('Name a part to paint');
    side = sideName(side); const d0 = DIR[side]; if (!d0) throw new Error('Side must be front, back, left, right, top or bottom');
    if (p.collider) throw new Error('Colliders have no colour');
    if (hasPix(p)) throw new Error(`“${p.name}” has pixel paint: paint its sides with paintRect / paintLine instead`);
    const a = d0.findIndex(v => v), f0 = Math.max(0, Math.min(1, Math.min(from, to))), f1 = Math.max(0, Math.min(1, Math.max(from, to)));
    const u0 = d0[a] > 0 ? f0 : 1 - f1, u1 = d0[a] > 0 ? f1 : 1 - f0, col = color || b.color;
    let tris = partTris(p, true).map(t => ({ P: t.P.map(v => v.clone()), color: t.color }));
    for (const cut of [u0, u1]) tris = tris.flatMap(t => splitTri(t, a, cut));
    for (const t of tris) { const c = (t.P[0].getComponent(a) + t.P[1].getComponent(a) + t.P[2].getComponent(a)) / 3; if (c > u0 + 1e-6 && c < u1 - 1e-6) t.color = col; }
    const data = meshPartData(tris); if (!data) throw new Error('Nothing to paint');
    return op('Paint band', () => {
      const n = N(p.id); // back into the part's unit box
      const lo = n.from.map((v, i) => Math.min(v, n.to[i])), hi = n.from.map((v, i) => Math.max(v, n.to[i])), S = hi.map((h, i) => h - lo[i]);
      n.from = lo.map((v, i) => r4(v + data.lo[i] * S[i])); n.to = lo.map((v, i) => r4(v + data.hi[i] * S[i]));
      n.shape = 'mesh'; n.flip = [0, 0, 0]; n.mesh = { verts: data.verts, tris: data.tris }; n.colors = {}; 
      return b.msg(`Painted a ${col} band round “${n.name}” (${Math.round(f0 * 100)}–${Math.round(f1 * 100)} % of the way to the ${NICE_SIDE[side]})`);
    });
  };
  b.combine = async (name) => {
    if (!b.doc) throw new Error('Nothing to combine');
    let ids = b.sel.filter(id => N(id));
    if (ids.length === 1 && N(ids[0]).kind === 'group') ids = N(ids[0]).children.filter(c => N(c).kind === 'part');
    else ids = ids.filter(id => N(id).kind === 'part');
    if (ids.length < 2) throw new Error('Pick a group (or 2 or more parts) to combine');
    if (ids.some(id => N(id).collider)) throw new Error('Colliders can not be combined with parts (they are invisible shapes for the game)');
    if (ids.some(id => hasPix(N(id)))) throw new Error('Some of these parts have pixel paint, which Combine would lose. Clear their paint first (or keep them as separate parts).');
    const pid = N(ids[0]).parent;
    if (ids.some(id => N(id).parent !== pid)) throw new Error('The parts must be in the same group to combine them');
    const parts = ids.map(id => N(id));
    const localM = p => pivotM(p.origin, p.rotation).multiply(new THREE.Matrix4().makeTranslation(...p.from)).multiply(new THREE.Matrix4().makeScale(...p.to.map((t, i) => Math.max(1e-4, t - p.from[i]))));
    const t0 = performance.now();
    let tris = []; // { P:[3 Vector3] (parent frame), color }
    const straight = p => p.shape === 'cube' && !p.rotation.some(v => Math.abs(v) > 1e-6);
    const asBox = p => ({ min: p.from.map((v, i) => Math.min(v, p.to[i])), max: p.from.map((v, i) => Math.max(v, p.to[i])), colors: (p.flip || []).some(Boolean) ? { ...p.colors, ...(p.flip[0] ? { east: p.colors.west, west: p.colors.east } : {}), ...(p.flip[1] ? { up: p.colors.down, down: p.colors.up } : {}), ...(p.flip[2] ? { north: p.colors.south, south: p.colors.north } : {}) } : p.colors });
    const cubes = parts.filter(straight), others = parts.filter(p => !straight(p));
    let method;
    if (!others.length) { // all straight cubes: exact outside surface, big rectangles
      method = 'exact';
      for (const q of boxSurface(cubes.map(asBox))) tris.push({ P: [q.P[0], q.P[1], q.P[2]], color: q.color }, { P: [q.P[0], q.P[2], q.P[3]], color: q.color });
    } else { // solid union: the straight cubes go in as one closed shell, the others one by one
      method = cubes.length ? 'exact + solid union' : 'solid union';
      const { Brush, ADDITION, ev } = await csgKit();
      const colours = [...others.flatMap(p => partTris(p, true).map(t => t.color)), ...cubes.flatMap(p => Object.values(p.colors).filter(Boolean))];
      let brushes = others.map(p => csgBrush(Brush, partTris(p, true), localM(p)));
      while (brushes.length > 1) { const next = []; for (let i = 0; i < brushes.length; i += 2) next.push(i + 1 < brushes.length ? ev.evaluate(brushes[i], brushes[i + 1], ADDITION) : brushes[i]); brushes = next; }
      let result = brushes[0];
      if (cubes.length) {
        const fill = cubes.map(asBox).map(bx => ({ ...bx, colors: Object.fromEntries(SIDES.map(sd => [sd, bx.colors[sd] || Object.values(bx.colors).find(Boolean) || '#cccccc'])) })); // closed shell
        result = ev.evaluate(csgBrush(Brush, watertight(boxSurface(fill))), result, ADDITION);
      }
      tris = csgTris(result.geometry, colours);
    }
    // weld points, drop slivers, normalise into the new part's box
    const data = meshPartData(tris);
    if (!data) throw new Error('Nothing is left on the outside');
    const { lo, hi, size, verts, tris: mtris } = data;
    const before = parts.reduce((s, p) => s + partTris(p).length, 0);
    const snaps = parts.flatMap(p => (p.snaps || []).map(sp => ({ ...sp, u: v3(flipU(p, sp.u)).applyMatrix4(localM(p)).toArray().map((v, a) => r4((v - lo[a]) / size[a])) })));
    return op('Combine', () => {
      const first = ids[0], list = kids(pid), at = list.indexOf(first);
      const n = { id: uid(), kind: 'part', name: uniqueName(name || (pid ? N(pid).name + '_combined' : 'combined')), shape: 'mesh', from: lo.map(r4), to: hi.map(r4),
        origin: lo.map((v, a) => r4(v + size[a] / 2)), rotation: [0, 0, 0], colors: {}, flip: [0, 0, 0], sides: 12, mesh: { verts, tris: mtris }, ...(snaps.length ? { snaps } : {}) };
      ids.forEach(removeNode);
      b.doc.nodes[n.id] = n; n.parent = pid; list.splice(Math.max(0, Math.min(at, list.length)), 0, n.id);
      b.sel = [n.id];
      return b.msg(`Combined ${parts.length} parts into “${n.name}” (${method}): ${before} → ${mtris.length} triangles, ${verts.length} points, nothing left inside. ${Math.round(performance.now() - t0)} ms`);
    });
  };
  b.moveTo = (ids, pid) => op('Move into group', () => { const g = pid ? (N(pid) ? pid : b.find(pid) || pid) : null; [].concat(ids).forEach(id => reparent(N(id) ? id : b.find(id) || id, g)); });
  b.rename = (id, name) => op('Rename', () => { const n = N(id); if (!n) throw new Error('Nothing to rename'); const v = String(name).trim().replace(/[.\s]+/g, '_'); if (!v) return; n.name = v; });
  const swapName = s => s.replace(/(right|left|Right|Left|RIGHT|LEFT|_R\b|_L\b|\.R\b|\.L\b)/g, m => ({ right: 'left', left: 'right', Right: 'Left', Left: 'Right', RIGHT: 'LEFT', LEFT: 'RIGHT', _R: '_L', _L: '_R', '.R': '.L', '.L': '.R' }[m]));
  /** Mirror the given nodes (and everything inside) across the plane axis = c, in their parent's frame. */
  function mirrorNodes(ids, axis, c) {
    const a = 'xyz'.indexOf(axis), swap = [['east', 'west'], ['up', 'down'], ['north', 'south']][a];
    const all = new Set(); ids.forEach(id => { all.add(id); descendants(id).forEach(d => all.add(d)); });
    for (const id of all) {
      const n = N(id);
      const m = v => { const r = [...v]; r[a] = r4(2 * c - r[a]); return r; };
      if (n.kind === 'locator') { n.position = m(n.position); n.rotation = (n.rotation || [0, 0, 0]).map((r, i) => (i === a ? r : r4(-r))); continue; }
      n.origin = m(n.origin);
      if (n.slide) n.slide = { ...n.slide, axis: n.slide.axis.map((v, i) => (i === a ? r4(-v) : v)) };
      n.rotation = n.rotation.map((r, i) => (i === a ? r : r4(-r)));
      if (n.kind === 'part') {
        const f = m(n.from), t = m(n.to); n.from = f.map((v, i) => Math.min(v, t[i])); n.to = f.map((v, i) => Math.max(v, t[i]));
        if (n.shape === 'cube') { // a mirrored box is still a box: remap its paint and snap points instead of flipping it
          if (n.pix) n.pix = mirrorPix(n.pix, a);
          if (n.snaps) n.snaps = n.snaps.map(sp => ({ ...sp, u: sp.u.map((v, i) => (i === a && !(n.flip || [])[i] ? r4(1 - v) : v)) }));
        } else { n.flip = [...(n.flip || [0, 0, 0])]; n.flip[a] ^= 1; }
        [n.colors[swap[0]], n.colors[swap[1]]] = [n.colors[swap[1]], n.colors[swap[0]]];
      }
    }
  }
  /** Pixel grids of a box mirrored along axis a: each new side's pixel reads the mirror-image point of the old box. */
  function mirrorPix(pix, a) {
    const out = {};
    for (const side of SIDES) {
      const srcSide = DIR[side][a] ? OPP[side] : side, src = pix[srcSide]; if (!src) continue;
      const { tl, du, dv } = faceAxes(side), S = faceAxes(srcSide), map = [];
      for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) {
        const q = tl.clone().addScaledVector(du, (i + 0.5) / src.w).addScaledVector(dv, (j + 0.5) / src.h); q.setComponent(a, 1 - q.getComponent(a));
        const d = q.sub(S.tl), si = Math.min(src.w - 1, Math.floor(d.dot(S.du) * src.w)), sj = Math.min(src.h - 1, Math.floor(d.dot(S.dv) * src.h));
        map.push((sj * src.w + si) * 4);
      }
      const remap = str => { const from = unb64(str), to = new Uint8Array(from.length); map.forEach((o, k) => to.set(from.subarray(o, o + 4), k * 4)); return b64(to); };
      if (src.frames) src.frames[src.frame] = src.rgba;
      out[side] = { w: src.w, h: src.h, rgba: remap(src.rgba), ...(src.frames ? { frame: src.frame, frames: Object.fromEntries(Object.entries(src.frames).map(([k, v]) => [k, remap(v)])) } : {}) };
    }
    return out;
  }
  /** Mirror copy: a mirrored twin across the middle line (x = 0), names swapped left <-> right. */
  b.mirrorCopy = (axis = 'x') => op('Mirror copy', () => {
    const ids = topSel(); if (!ids.length) throw new Error('Pick what to mirror');
    const out = [];
    for (const id of ids) {
      const [nid] = pasteTrees([copyOf(id)], N(id).parent, id);
      const twin = N(nid); twin.name = swapName(N(id).name) !== N(id).name ? swapName(N(id).name) : uniqueName(N(id).name + '_mirror');
      descendants(nid).forEach(d => { N(d).name = swapName(N(d).name); });
      mirrorNodes([nid], axis, 0); out.push(nid);
    }
    b.sel = out; return b.msg(`Mirrored ${out.length} to the other side`);
  });
  /** Flip in place (mirror around the selection's own centre). */
  b.flip = (axis = 'x') => op('Flip ' + axis.toUpperCase(), () => {
    const ids = topSel(); if (!ids.length) throw new Error('Pick what to flip');
    const c = selCentre(), pid = N(ids[0]).parent, lc = c.divideScalar(U).applyMatrix4(groupWorld(pid).invert());
    mirrorNodes(ids, axis, r4(lc.getComponent('xyz'.indexOf(axis)))); return b.msg('Flipped ' + axis.toUpperCase());
  });
  /** Colour one side (info from a click), or the whole part (info null). */
  function paint(id, info, color = b.color) {
    return op('Paint', () => {
      const p = N(id);
      if (!info) { if (p.shape === 'mesh') p.mesh.tris.forEach(t => { t.color = color; }); else SIDES.forEach(s => { p.colors[s] = color; }); }
      else if (info.face !== undefined) p.mesh.tris[info.face].color = color;
      else p.colors[info.side] = color;
    });
  }
  b.paint = (id, side = null, color = b.color) => paint(N(id) ? id : b.select(id)[0], side ? { side } : null, color);
  b.paintSelected = (color = b.color) => op('Paint', () => { for (const id of b.sel) { const ps = N(id).kind === 'group' ? descendants(id) : [id]; for (const q of ps) { const p = N(q); if (p.kind !== 'part') continue; if (p.shape === 'mesh') p.mesh.tris.forEach(t => { t.color = color; }); else SIDES.forEach(s => { p.colors[s] = color; }); } } });
  /** Change properties of a node: { name, shape, from, to, size, position, origin, rotation, sides, color } (Blockbench units, degrees). */
  b.set = (id, props) => op('Change', () => {
    const n = N(id) || N(b.select(id)[0]); if (!n) throw new Error('Nothing picked');
    if (props.name !== undefined) n.name = String(props.name).trim().replace(/[.\s]+/g, '_') || n.name;
    if (n.kind === 'locator') { if (props.position) n.position = props.position.map(r4); if (props.rotation) n.rotation = props.rotation.map(v => r4(+v || 0)); return; }
    if (props.rotation) n.rotation = props.rotation.map(v => r4(+v || 0));
    if (props.origin) n.origin = props.origin.map(r4);
    if (n.kind !== 'part') return;
    if (props.shape && SHAPES[props.shape]) n.shape = props.shape;
    if (props.sides) n.sides = Math.max(3, Math.min(48, Math.round(props.sides)));
    if (props.from) { const size = n.to.map((t, i) => t - n.from[i]); n.from = props.from.map(r4); n.to = n.from.map((v, i) => r4(v + size[i])); }
    if (props.to) n.to = props.to.map(r4);
    if (props.size) n.to = n.from.map((v, i) => r4(v + Math.max(0, props.size[i])));
    if (props.color) SIDES.forEach(s => { n.colors[s] = props.color; });
  });
  /**
   * Slide joint: the group moves along a straight rail and never turns (jaw, eyelid, visor, drawer, piston).
   * opts: { axis: 'up'|'down'|'north'|'south'|'east'|'west' | [x,y,z], min, max }  (Blockbench units along the axis, from where it
   * is now: 0 = this pose)  or  { from:[x,y,z], to:[x,y,z] } (two points on the rail)  or null to make it a normal joint again.
   * Animate it after Make model with editor.slide(name, 0..1, t).
   */
  b.setSlide = (id, opts) => op(opts ? 'Make slide joint' : 'Remove slide joint', () => {
    const g = N(id) || N(b.find(id)); if (!g || g.kind !== 'group') throw new Error('Pick a group to make a slide joint (groups are the joints)');
    if (!opts) { delete g.slide; return b.msg(`“${g.name}” is a normal joint again`); }
    let axis, min, max;
    if (opts.from && opts.to) {
      const d = v3(opts.to).sub(v3(opts.from)); if (d.lengthSq() < 1e-10) throw new Error('The two rail points are the same');
      axis = d.normalize(); min = v3(opts.from).sub(v3(g.origin)).dot(axis); max = v3(opts.to).sub(v3(g.origin)).dot(axis);
    } else {
      axis = typeof opts.axis === 'string' ? v3(DIR[opts.axis] || (() => { throw new Error('Axis must be up, down, north, south, east, west or [x,y,z]'); })()) : v3(opts.axis || [0, 1, 0]);
      if (axis.lengthSq() < 1e-10) throw new Error('The axis has no direction'); axis.normalize();
      min = +(opts.min ?? 0); max = +(opts.max ?? 1);
    }
    if (min > max) { [min, max] = [max, min]; }
    if (max - min < 1e-6) throw new Error('Start and end of the rail are the same');
    g.slide = { axis: axis.toArray().map(r4), min: r4(min), max: r4(max) };
    return b.msg(`“${g.name}” slides ${r4(max - min)} units along its rail (from ${r4(min)} to ${r4(max)}) and does not turn. After Make model, animate it with the Slide slider.`);
  });
  // ---------------------------------------------------------------- clothing layers (parts named slot__set__piece)
  b.hiddenLayers = new Set();
  const layerOfName = name => { const q = String(name || '').split('__'); return q.length >= 3 && q[0] && q[1] ? `${q[0]}__${q[1]}` : null; };
  function hiddenLayer(n) { if (!n || !b.hiddenLayers.size) return false; const l = layerOfName(n.name); if (!l) return false; return b.hiddenLayers.has(l) || b.hiddenLayers.has(l.split('__')[0]); }
  /** Clothing layers in the build: [{layer, slot, set, parts, visible}]. Name parts slot__set__piece (hat__cap__visor); no "__" = the body. */
  b.layers = () => {
    const m = new Map();
    for (const n of Object.values(b.doc?.nodes || {})) { if (n.kind !== 'part') continue; const l = layerOfName(n.name); if (!l) continue; const e = m.get(l) || m.set(l, { layer: l, slot: l.split('__')[0], set: l.split('__')[1], parts: 0, visible: !hiddenLayer(n) }).get(l); e.parts++; }
    return [...m.values()].sort((p, q) => p.layer.localeCompare(q.layer));
  };
  /** Show / hide a layer ('hat__cap') or a whole slot ('hat') in the view (only a view setting: Make model always includes every layer). */
  b.setLayerVisible = (layerOrSlot, visible = true) => {
    if (!b.layers().some(l => l.layer === layerOrSlot || l.slot === layerOrSlot)) throw new Error(`No layer or slot called “${layerOrSlot}” (layers: ${b.layers().map(l => l.layer).join(', ') || 'none — name parts slot__set__piece'})`);
    if (visible) { b.hiddenLayers.delete(layerOrSlot); if (!layerOrSlot.includes('__')) for (const l of [...b.hiddenLayers]) if (l.startsWith(layerOrSlot + '__')) b.hiddenLayers.delete(l); }
    else b.hiddenLayers.add(layerOrSlot);
    b.sel = b.sel.filter(id => !hiddenLayer(N(id))); refresh();
    return b.msg(`${visible ? 'Showing' : 'Hiding'} ${layerOrSlot}`);
  };
  /** Add a snap point to a part. u = where in its box, 0..1 each way ([0.5,1,0.5] = middle of the top), or a side name ('up', 'north', ...). */
  b.addSnap = (id, u = [0.5, 1, 0.5], name) => op('Add snap point', () => {
    const p = N(id) || N(b.find(id)); if (!p || p.kind !== 'part') throw new Error('Pick a part for the snap point');
    if (typeof u === 'string') { const d = DIR[u]; if (!d) throw new Error('Side must be north, south, east, west, up or down'); u = d.map(v => 0.5 + v / 2); }
    p.snaps = [...(p.snaps || []), { id: uid(), name: name || `snap${(p.snaps || []).length + 1}`, u: u.map(v => Math.max(0, Math.min(1, +v))) }];
    return b.msg(`Snap point added to “${p.name}” (${p.snaps.length} on it). Moving parts now click onto it.`);
  });
  b.removeSnap = (id, snapId) => op('Remove snap point', () => { const p = N(id) || N(b.find(id)); if (!p?.snaps) return; p.snaps = p.snaps.filter(sp => sp.id !== snapId); return b.msg(`Snap point removed from “${p.name}”`); });
  b.clearSnaps = () => op('Remove snap points', () => { let n = 0; for (const id of b.sel.flatMap(x => [x, ...descendants(x)])) { const p = N(id); if (p?.snaps?.length) { n += p.snaps.length; p.snaps = []; } } return b.msg(`Removed ${n} snap point${n === 1 ? '' : 's'}`); });
  /** Move part (or group) `a` so one of its snap points sits exactly on the nearest snap point of part `b2` (corners/side middles if a part has none). */
  b.join = (a, b2) => op('Join', () => {
    const ida = N(a) ? a : b.find(a), idb = N(b2) ? b2 : b.find(b2); if (!ida || !idb) throw new Error('Name two parts to join');
    const partsOf = id => (N(id).kind === 'group' ? descendants(id) : [id]).map(N).filter(n => n.kind === 'part');
    const pts = p => { const M = partMatrix(p), list = (p.snaps || []).map(sp => snapWorld(p, sp.u, M)); return list.length ? list : AUTO_U.map(u => v3(u).applyMatrix4(M)); }; // its snap points, else corners + side middles
    const A = partsOf(ida).flatMap(pts), Bp = partsOf(idb).flatMap(pts);
    if (!A.length || !Bp.length) throw new Error('Nothing to join');
    let best = null; for (const x of A) for (const y of Bp) { const d = x.distanceTo(y); if (!best || d < best.d) best = { d, v: y.clone().sub(x) }; }
    const n = N(ida); translate(ida, best.v.applyQuaternion(groupQ(n.parent).invert()).toArray().map(r4));
    b.sel = [ida]; return b.msg(`Joined “${n.name}” onto “${N(idb).name}”`);
  });
  b.setSnapMode = m => { if (!['all', 'points', 'off'].includes(m)) throw new Error("Snap mode must be 'all', 'points' or 'off'"); b.snapMode = m; changed(); return b.msg({ all: 'Moving parts click onto snap points, corners and the middles of sides (hold Alt to stop it)', points: 'Moving parts click onto snap points only (hold Alt to stop it)', off: 'Snapping parts together is off' }[m]); };
  b.setTool = t => { if (!['move', 'stretch', 'rotate', 'pivot', 'paint', 'snap', 'push', 'pixel'].includes(t)) throw new Error('Tool must be move, stretch, rotate, pivot, paint, snap, push or pixel'); b.tool = t; ppReset(); syncGizmo(); changed(); return b.msg({ pixel: 'Pixel paint: drag on a side of a cube to draw pixels (Fill / Eraser in the Tools window, Alt+click picks a colour). Each stroke is one Undo.', push: 'Push / Pull: click 2 to 4 points on a flat side to mark a pane, then drag the pane in (cut a hole) or out (add a block). Esc starts again.', snap: 'Snap point: click a part to put a snap point there (it lands on middles and edges), click a dot to remove it', move: 'Move: drag the arrows', stretch: 'Stretch: drag a round handle to pull that side (Shift = both sides)', rotate: 'Rotate: drag the rings', pivot: 'Pivot: drag to set where the part or group turns', paint: 'Paint: click a side to colour it, Shift+click colours the whole part, Alt+click picks a colour' }[t]); };
  b.frame = () => {
    const box = new THREE.Box3();
    const ids = b.sel.length ? b.sel.flatMap(id => [id, ...descendants(id)]) : [...meshes.keys()].filter(inIso);
    ids.forEach(id => meshes.get(id) && box.expandByObject(meshes.get(id)));
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.15);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(ed.camera.fov / 2)) * 1.1, dir = ed.camera.position.clone().sub(ed.orbit.target).normalize();
    ed.orbit.target.copy(c); ed.camera.position.copy(c).addScaledVector(dir, dist); ed.camera.near = dist / 1000; ed.camera.far = dist * 100; ed.camera.updateProjectionMatrix(); ed.orbit.update();
  };

  // ---------------------------------------------------------------- mode on / off
  let saved = null;
  b.setActive = on => {
    if (on === b.active) return;
    b.active = on;
    if (on) {
      if (!b.doc) newDoc();
      saved = { root: ed.root.visible, grid: ed.grid.visible, overlay: ed.overlay.visible };
      ed.root.visible = false; ed.grid.visible = false; ed.overlay.visible = false;
      root.visible = gridG.visible = selG.visible = true;
      ed.mixer?.stopAllAction?.();
    } else {
      if (saved) { ed.root.visible = saved.root; ed.grid.visible = saved.grid; ed.overlay.visible = saved.overlay; }
      root.visible = gridG.visible = selG.visible = false; snapG.clear(); snapRing.visible = false; ppReset(); tc.detach(); knobs.forEach(k => { k.visible = false; }); pivotMark.visible = false;
    }
    refresh();
  };

  // ---------------------------------------------------------------- Blockbench file in / out
  /** The project as a Blockbench .bbmodel (JSON object). Flat colours become a small palette texture. */
  b.toBBModel = () => {
    const doc = b.doc, colours = [];
    const ci = c => { let i = colours.indexOf(c); if (i < 0) { i = colours.length; colours.push(c); } return i; };
    const parts = Object.values(doc.nodes).filter(n => n.kind === 'part');
    parts.forEach(p => (p.shape === 'mesh' ? p.mesh.tris.map(t => t.color) : SIDES.map(s => p.colors[s])).forEach(c => c && ci(c)));
    if (!colours.length) colours.push('#ffffff');
    // painted sides: shelf-pack every pixel grid into paint.png (texture 1)
    const painted = []; for (const p of parts) if (hasPix(p)) for (const side of SIDES) { const rec = p.pix[side]; if (!rec) continue; syncFrame(rec); if (rec.frames) for (const [fr, rgba] of Object.entries(rec.frames)) painted.push({ p, side, frame: fr, rec: { w: rec.w, h: rec.h, rgba } }); else painted.push({ p, side, rec }); }
    let PW = 16, PH = 0; const place = new Map();
    if (painted.length) {
      PW = Math.max(16, ...painted.map(x => x.rec.w)); let px = 0, py = 0, rowH = 0;
      for (const x of [...painted].sort((q, r) => r.rec.h - q.rec.h)) { if (px + x.rec.w > PW) { px = 0; py += rowH; rowH = 0; } place.set(x, [px, py]); px += x.rec.w; rowH = Math.max(rowH, x.rec.h); PH = Math.max(PH, py + rowH); }
    }
    const pcv = document.createElement('canvas'); pcv.width = PW; pcv.height = Math.max(PH, 1);
    for (const [x, [px, py]] of place) pcv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(unb64(x.rec.rgba).buffer), x.rec.w, x.rec.h), px, py);
    const paintAt = (p, side) => { const cur = p.pix[side]?.frame; for (const [x, at] of place) if (x.p === p && x.side === side && (!x.frame || x.frame === cur)) return [at, x.rec]; return null; };
    const framesOf = p => { const o = {}; for (const [x, [fx, fy]] of place) if (x.p === p && x.frame) { (o[x.side] ||= { current: p.pix[x.side].frame, frames: {} }).frames[x.frame] = [fx, fy, x.rec.w, x.rec.h]; } return Object.keys(o).length ? o : null; };
    const W = 16, H = Math.max(16, Math.ceil(colours.length / W));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d');
    colours.forEach((c, i) => { cx.fillStyle = c; cx.fillRect(i % W, Math.floor(i / W), 1, 1); });
    const sw = c => { const i = ci(c); return [i % W, Math.floor(i / W)]; };
    const elements = [];
    for (const p of parts) {
      const common = { name: p.name, uuid: p.id, export: true, visibility: true, locked: false, render_order: 'default', allow_mirror_modeling: true, color: 0, origin: [...p.origin], rotation: [...p.rotation] };
      if (p.shape === 'cube') { // (a flipped box looks the same as an unflipped one)
        const fr = hasPix(p) && framesOf(p);
        elements.push({ ...common, ...(p.snaps?.length ? { glb_snaps: p.snaps } : {}), ...(fr ? { glb_frames: fr } : {}), ...(p.collider ? { glb_collider: p.collider, export: false } : {}), type: 'cube', box_uv: false, rescale: false, autouv: 0, from: [...p.from], to: [...p.to],
          faces: Object.fromEntries(SIDES.map(s => { const pa = hasPix(p) && paintAt(p, s); if (pa) { const [[x, y], rec] = pa; return [s, { uv: [x, y, x + rec.w, y + rec.h], texture: 1 }]; /* paint.png uses its own pixel size as uv size */ } if (!p.colors[s]) return [s, { uv: [0, 0, 0, 0], texture: null }]; const [x, y] = sw(p.colors[s]); return [s, { uv: [x, y, x + 1, y + 1], texture: 0 }]; })) });
        continue;
      }
      // other shapes: a Blockbench mesh (vertices relative to the pivot); our settings ride along so it opens editable here
      const tris = partTris(p), size = p.to.map((t, i) => t - p.from[i]), vkeys = new Map(), vertices = {}, faces = {};
      const key = v => { const w = [0, 1, 2].map(i => r4(p.from[i] + v.getComponent(i) * size[i] - p.origin[i])), k0 = w.join(','); if (!vkeys.has(k0)) { const k = 'v' + vkeys.size.toString(36); vkeys.set(k0, k); vertices[k] = w; } return vkeys.get(k0); };
      tris.forEach((t, i) => { const ks = t.P.map(key), [x, y] = sw(t.color); faces['f' + i.toString(36)] = { uv: Object.fromEntries(ks.map(k => [k, [x + 0.5, y + 0.5]])), vertices: ks, texture: 0 }; });
      elements.push({ ...common, ...(p.snaps?.length ? { glb_snaps: p.snaps } : {}), ...(p.collider ? { glb_collider: p.collider, export: false } : {}), type: 'mesh', vertices, faces, glb_shape: { shape: p.shape, from: p.from, to: p.to, sides: p.sides, flip: p.flip, colors: p.colors, mesh: p.mesh } });
    }
    for (const l of Object.values(doc.nodes).filter(n => n.kind === 'locator')) elements.push({ name: l.name, uuid: l.id, type: 'locator', position: [...l.position], rotation: [...(l.rotation || [0, 0, 0])], export: true, visibility: true, locked: false, ignore_inherited_scale: false });
    const outl = ids => ids.map(id => { const n = N(id); if (n.kind !== 'group') return id; return { name: n.name, origin: [...n.origin], rotation: [...n.rotation], color: 0, uuid: n.id, export: true, mirror_uv: false, isOpen: true, locked: false, visibility: true, autouv: 0, ...(n.slide ? { glb_slide: n.slide } : {}), children: outl(n.children) }; });
    return {
      meta: { format_version: '4.10', model_format: 'free', box_uv: false }, name: doc.name, model_identifier: '', visible_box: [1, 1, 0],
      variable_placeholders: '', variable_placeholder_buttons: [], timeline_setups: [], unhandled_root_fields: {}, resolution: { width: W, height: H },
      elements, outliner: outl(doc.roots),
      textures: [...[{ path: '', name: 'palette.png', folder: '', namespace: '', id: '0', width: W, height: H, uv_width: W, uv_height: H, particle: false, use_as_default: false, layers_enabled: false, sync_to_project: '', render_mode: 'default', render_sides: 'auto', frame_time: 1, frame_order_type: 'loop', frame_order: '', frame_interpolate: false, visible: true, internal: true, saved: false, uuid: uid(), relative_path: '', source: cv.toDataURL('image/png') }], ...(painted.length ? [{ path: '', name: 'paint.png', folder: '', namespace: '', id: '1', width: PW, height: PH, uv_width: PW, uv_height: PH, particle: false, use_as_default: false, layers_enabled: false, sync_to_project: '', render_mode: 'default', render_sides: 'auto', frame_time: 1, frame_order_type: 'loop', frame_order: '', frame_interpolate: false, visible: true, internal: true, saved: false, uuid: uid(), relative_path: '', source: pcv.toDataURL('image/png') }] : [])],
      animations: doc.extra.animations || [],
    };
  };
  /** Open a Blockbench model for building: a parsed .bbmodel, a library path, or a File. */
  b.open = async (src, name) => {
    let bb = src;
    if (typeof src === 'string') { const url = /^(\/|https?:|blob:|data:)/.test(src) ? src : '/api/lib/file?rel=' + encodeURIComponent(src); const r = await fetch(url); if (!r.ok) throw new Error('Could not read ' + src); bb = await r.json(); if (!/^(\/|https?:|blob:|data:)/.test(src)) b.libRel = src; name ||= src.split(/[\\/]/).pop(); }
    else if (src instanceof Blob) { name ||= src.name; bb = JSON.parse(await src.text()); }
    const texs = await Promise.all((bb.textures || []).map(async t => {
      if (!String(t.source || '').startsWith('data:')) return null;
      const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = t.source; });
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
      return { d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height, uvW: t.uv_width || bb.resolution?.width || c.width, uvH: t.uv_height || bb.resolution?.height || c.height, uuid: t.uuid };
    }));
    const texOf = r => (r === null || r === undefined || r === false ? null : typeof r === 'number' ? texs[r] : texs.find(t => t && t.uuid === r) || texs[+r] || null);
    let mixed = 0, paintedSides = 0; const notes = new Set();
    const colourIn = (t, us, vs) => { // the main colour inside a uv area
      if (!t) return '#cccccc';
      let x0 = Math.floor(Math.min(...us) / t.uvW * t.w + 1e-6), x1 = Math.ceil(Math.max(...us) / t.uvW * t.w - 1e-6), y0 = Math.floor(Math.min(...vs) / t.uvH * t.h + 1e-6), y1 = Math.ceil(Math.max(...vs) / t.uvH * t.h - 1e-6);
      if (x1 <= x0) x1 = x0 + 1; if (y1 <= y0) y1 = y0 + 1;
      x0 = Math.max(0, Math.min(t.w - 1, x0)); y0 = Math.max(0, Math.min(t.h - 1, y0)); x1 = Math.max(x0 + 1, Math.min(t.w, x1)); y1 = Math.max(y0 + 1, Math.min(t.h, y1));
      const count = new Map();
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * t.w + x) * 4; if (t.d[o + 3] < 8) continue; const k = (t.d[o] << 16 | t.d[o + 1] << 8 | t.d[o + 2]) >>> 0; count.set(k, (count.get(k) || 0) + 1); }
      if (!count.size) return null;
      if (count.size > 1) mixed++;
      const best = [...count].sort((a, c) => c[1] - a[1])[0][0];
      return '#' + best.toString(16).padStart(6, '0');
    };
    const doc = { name: (name || bb.name || 'model').replace(/\.bbmodel$/i, ''), nodes: {}, roots: [], extra: { animations: bb.animations || [] } };
    const groupData = Object.fromEntries((bb.groups || []).map(g => [g.uuid, g]));
    const elements = Object.fromEntries((bb.elements || []).map(e => [e.uuid, e]));
    const used = new Set();
    const addEl = (e, pid) => {
      used.add(e.uuid);
      const base = { id: e.uuid, name: e.name || e.type || 'cube', parent: pid };
      let n;
      if (e.type === 'locator' || e.type === 'null_object') n = { ...base, kind: 'locator', position: (e.position || [0, 0, 0]).map(Number), rotation: (e.rotation || [0, 0, 0]).map(Number) };
      else if (e.type === 'mesh' && e.glb_shape) n = { ...base, kind: 'part', ...clone(e.glb_shape), origin: (e.origin || [0, 0, 0]).map(Number), rotation: (e.rotation || [0, 0, 0]).map(Number) };
      else if (e.type === 'mesh') {
        const keys = Object.keys(e.vertices || {}), P = keys.map(k => e.vertices[k].map((v, i) => +v + (+e.origin?.[i] || 0)));
        if (!P.length) return;
        const lo = [0, 1, 2].map(i => Math.min(...P.map(p => p[i]))), hi = [0, 1, 2].map(i => Math.max(...P.map(p => p[i])));
        const idx = new Map(keys.map((k, i) => [k, i])), verts = P.map(p => p.map((v, i) => (hi[i] - lo[i] > 1e-9 ? (v - lo[i]) / (hi[i] - lo[i]) : 0)));
        const tris = [];
        for (const f of Object.values(e.faces || {})) {
          const t = texOf(f.texture); if (f.texture === null || f.texture === undefined) continue;
          let vk = (f.vertices || []).filter(k => idx.has(k)); if (vk.length < 3) continue;
          if (vk.length === 4) { const c = vk.map(k => v3(P[idx.get(k)])), m = c.reduce((s, p) => s.add(p.clone()), new THREE.Vector3()).divideScalar(4), nn = new THREE.Vector3().subVectors(c[1], c[0]).cross(new THREE.Vector3().subVectors(c[2], c[0])).normalize(), ax = c[0].clone().sub(m).normalize(), ay = new THREE.Vector3().crossVectors(nn, ax); vk = vk.map((k, i) => [k, Math.atan2(c[i].clone().sub(m).dot(ay), c[i].clone().sub(m).dot(ax))]).sort((a, c2) => a[1] - c2[1]).map(a => a[0]); }
          const color = colourIn(t, vk.map(k => +(f.uv?.[k]?.[0] || 0)), vk.map(k => +(f.uv?.[k]?.[1] || 0))) || '#cccccc';
          for (let k = 1; k + 1 < vk.length; k++) tris.push({ v: [idx.get(vk[0]), idx.get(vk[k]), idx.get(vk[k + 1])], color });
        }
        n = { ...base, kind: 'part', shape: 'mesh', from: lo.map(r4), to: hi.map(r4), origin: (e.origin || [0, 0, 0]).map(Number), rotation: (e.rotation || [0, 0, 0]).map(Number), colors: {}, flip: [0, 0, 0], sides: 12, mesh: { verts, tris } };
      } else { // cube
        const inf = +e.inflate || 0, colors = {};
        const pix = {};
        for (const s of SIDES) {
          const f = e.faces?.[s]; if (!f || f.texture === null || f.texture === undefined) { colors[s] = null; continue; }
          const [u1, v1, u2, v2] = f.uv || [0, 0, 0, 0], t = texOf(f.texture), before = mixed;
          colors[s] = colourIn(t, [u1, u2], [v1, v2]);
          if (t && mixed > before) { mixed = before; // keep the side's pixels (flipped uvs read mirrored)
            const X0 = Math.floor(Math.min(u1, u2) / t.uvW * t.w + 1e-6), X1 = Math.ceil(Math.max(u1, u2) / t.uvW * t.w - 1e-6), Y0 = Math.floor(Math.min(v1, v2) / t.uvH * t.h + 1e-6), Y1 = Math.ceil(Math.max(v1, v2) / t.uvH * t.h - 1e-6);
            const w = Math.max(1, X1 - X0), h = Math.max(1, Y1 - Y0), out = new Uint8Array(w * h * 4), rot = ((+f.rotation || 0) / 90) & 3;
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const sx = Math.min(t.w - 1, X0 + (u1 > u2 ? w - 1 - i : i)), sy = Math.min(t.h - 1, Y0 + (v1 > v2 ? h - 1 - j : j)), o = (sy * t.w + sx) * 4; out.set([t.d[o], t.d[o + 1], t.d[o + 2], 255], (j * w + i) * 4); }
            if (rot) notes.add('Some painted sides were turned in Blockbench; they were kept unturned');
            pix[s] = { w, h, rgba: b64(out) }; paintedSides++;
          }
        }
        if (e.glb_frames) for (const [sd, fi] of Object.entries(e.glb_frames)) { // expression frames: every picture lives in the paint texture
          const t = texOf(e.faces?.[sd]?.texture); if (!t || !fi?.frames) continue;
          const read = ([x, y, w, h]) => { const X0 = Math.round(x / t.uvW * t.w), Y0 = Math.round(y / t.uvH * t.h), W2 = Math.max(1, Math.round(w / t.uvW * t.w)), H2 = Math.max(1, Math.round(h / t.uvH * t.h)), o2 = new Uint8Array(W2 * H2 * 4); for (let j = 0; j < H2; j++) for (let i = 0; i < W2; i++) { const o = (Math.min(t.h - 1, Y0 + j) * t.w + Math.min(t.w - 1, X0 + i)) * 4; o2.set([t.d[o], t.d[o + 1], t.d[o + 2], 255], (j * W2 + i) * 4); } return { w: W2, h: H2, rgba: b64(o2) }; };
          const frames = Object.fromEntries(Object.entries(fi.frames).map(([k, r]) => [k, read(r)])), cur = frames[fi.current] ? fi.current : Object.keys(frames)[0]; if (!cur) continue;
          if (!pix[sd]) paintedSides++; pix[sd] = { w: frames[cur].w, h: frames[cur].h, rgba: frames[cur].rgba, frame: cur, frames: Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, v.rgba])) };
        }
        n = { ...base, kind: 'part', shape: 'cube', from: (e.from || [0, 0, 0]).map(v => r4(+v - inf)), to: (e.to || [0, 0, 0]).map(v => r4(+v + inf)), origin: (e.origin || [0, 0, 0]).map(Number), rotation: (e.rotation || [0, 0, 0]).map(Number), colors, flip: [0, 0, 0], sides: 12, ...(Object.keys(pix).length ? { pix } : {}) };
      }
      if (n.kind === 'part' && Array.isArray(e.glb_snaps)) n.snaps = clone(e.glb_snaps);
      if (n.kind === 'part' && e.glb_collider) n.collider = e.glb_collider;
      doc.nodes[n.id] = n; (pid ? doc.nodes[pid].children : doc.roots).push(n.id);
    };
    const walk = (list, pid) => {
      for (const it of list) {
        if (typeof it === 'string') { if (elements[it]) addEl(elements[it], pid); continue; }
        const g = { ...(groupData[it.uuid] || {}), ...(groupData[it.uuid] ? {} : it) };
        const n = { id: it.uuid || uid(), kind: 'group', name: g.name || 'group', parent: pid, origin: (g.origin || [0, 0, 0]).map(Number), rotation: (g.rotation || [0, 0, 0]).map(Number), children: [], ...(g.glb_slide ? { slide: clone(g.glb_slide) } : {}) };
        doc.nodes[n.id] = n; (pid ? doc.nodes[pid].children : doc.roots).push(n.id);
        walk(it.children || [], n.id);
      }
    };
    walk(bb.outliner || [], null);
    for (const e of bb.elements || []) if (!used.has(e.uuid)) addEl(e, null);
    const keepRel = b.libRel;
    b.doc = doc; b.sel = []; b.dirty = false; b.libRel = typeof src === 'string' && !/^(\/|https?:|blob:|data:)/.test(src) ? src : (src === keepRel ? keepRel : null);
    ed.undoStack.length = 0; ed.redoStack.length = 0;
    refresh(); b.frame();
    const parts = Object.values(doc.nodes).filter(n => n.kind === 'part').length, groups = Object.values(doc.nodes).filter(n => n.kind === 'group').length;
    return b.msg(`Opened “${doc.name}” for building: ${parts} parts, ${groups} groups${doc.extra.animations.length ? `, ${doc.extra.animations.length} animations kept` : ''}${paintedSides ? `, ${paintedSides} painted sides kept as pixels` : ''}${mixed ? `. ${mixed} faces had more than one colour; each got its main colour` : ''}${notes.size ? '. ' + [...notes].join('. ') : ''}.`);
  };
  /** Save the project into the library as <folder>/<name>.bbmodel (opens in Blockbench too). */
  b.save = async (name = b.doc?.name, folder = '') => {
    if (!b.doc) throw new Error('Nothing to save');
    name = String(name || 'model').replace(/\.bbmodel$/i, ''); b.doc.name = name;
    const body = JSON.stringify(b.toBBModel());
    const r = await fetch(`/api/lib/file?dir=${encodeURIComponent(folder || '')}&name=${encodeURIComponent(name + '.bbmodel')}&overwrite=1`, { method: 'PUT', body });
    const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || 'Save failed');
    b.libRel = j.rel; b.dirty = false; hooks.saved?.(j.rel);
    changed(); return b.msg(`Saved to Library/${j.rel} (${(j.bytes / 1024).toFixed(1)} KB) — opens in Blockbench too`);
  };
  /** Turn the project into a real model in the editor: groups become joints, every part is solid and follows its joint. */
  b.makeModel = async (opts = {}) => {
    if (!b.doc || !Object.values(b.doc.nodes).some(n => n.kind === 'part')) throw new Error('Add some shapes first');
    const file = new File([JSON.stringify(b.toBBModel())], b.doc.name + '.bbmodel', { type: 'application/json' });
    const keep = ed.undoStack.filter(e => e.build), keepRedo = ed.redoStack.filter(e => e.build);
    // keep the animations of the model that is open now (a rebuild must not drop them): copied by joint name below
    const keepClips = opts.keepClips === false ? [] : ed.clips.map(c => ({ name: c.name, duration: c.duration, tracks: JSON.parse(JSON.stringify(c.tracks)), raw: [], frames: JSON.parse(JSON.stringify(c.frames || {})) }));
    await ed.load(file);
    ed.undoStack.push(...keep); ed.redoStack.push(...keepRedo); // Build steps stay undoable after making the model
    ed.setMode('object');
    const r = ed.importReport;
    let kept = null; if (keepClips.length) { kept = ed._mergeClips(keepClips, { replace: true, label: 'Keep animations' }); if (!kept.copied.length) kept = null; }
    return b.msg(`Made “${b.doc.name}”: ${r.trianglesOut} triangles, ${r.bones} joints${r.animations ? `, ${r.animations} animations` : ''}. ${kept ? `Kept ${kept.copied.length} animation${kept.copied.length === 1 ? '' : 's'} from the model that was open${kept.skippedTracks.length ? ` (${kept.skippedTracks.length} tracks for joints that are gone were dropped)` : ''}. ` : ''}Save it to keep the .glb (your build is still there in Build mode).`);
  };

  b.info = () => {
    if (!b.doc) return { doc: null };
    const nodes = Object.values(b.doc.nodes), desc = id => { const n = N(id); const o = { id, kind: n.kind, name: n.name, ...(n.collider ? { collider: n.collider } : {}) }; if (n.kind === 'part') Object.assign(o, { shape: n.shape, from: n.from, to: n.to, origin: n.origin, rotation: n.rotation, colors: n.shape === 'mesh' ? '(per face)' : n.colors }); else if (n.kind === 'group') Object.assign(o, { origin: n.origin, rotation: n.rotation, children: n.children.length, ...(n.slide ? { slide: n.slide } : {}) }); else { o.position = n.position; o.rotation = n.rotation; } if (n.snaps?.length) o.snaps = n.snaps; if (n.pix) o.painted = Object.fromEntries(Object.entries(n.pix).map(([k, r]) => [k, `${r.w}x${r.h}${r.frames ? ` frames: ${Object.keys(r.frames).join('/')} (showing ${r.frame})` : ''}`])); return o; };
    const tree = ids => ids.map(id => { const n = N(id); return n.kind === 'group' ? { group: n.name, children: tree(n.children) } : n.name; });
    return { name: b.doc.name, parts: nodes.filter(n => n.kind === 'part').length, groups: nodes.filter(n => n.kind === 'group').length, locators: nodes.filter(n => n.kind === 'locator').length, snapPoints: nodes.reduce((t, n) => t + (n.snaps?.length || 0), 0), colliders: nodes.filter(n => n.collider).length, layers: b.layers(), paintedSides: nodes.reduce((t, n) => t + (n.pix ? Object.keys(n.pix).length : 0), 0), pixelDensity: b.pixelDensity, snapMode: b.snapMode, tool: b.tool, gridStep: b.gridStep, rotStep: b.rotStep, color: b.color, selection: b.sel.map(desc), outline: nodes.length <= 200 ? tree(b.doc.roots) : '(large: ' + nodes.length + ' nodes)', saved: !b.dirty, libRel: b.libRel };
  };
  b.node = id => {
    const n = N(id) || N(b.find(id)); if (!n) return null;
    const out = clone(n);
    if (n.kind === 'part' && n.shape === 'cube' && !n.collider) out.sidePixels = Object.fromEntries(Object.entries(SIDE_ALIAS).map(([nice, s2]) => { const f = b.faceSize(n.id, s2); return [nice, [f.w, f.h]]; })); // [w, h] pixels per side at the current density (painted sides: their grid)
    return out;
  };
  // plain side names (front/back/left/right/top/bottom) everywhere a side is given
  for (const k of ['paintPixels', 'paintRect', 'paintLine', 'paintText', 'clearPaint', 'faceSize', 'pixelAt', 'addFrame', 'setFrame', 'frames', 'removeFrame', 'renameFrame', 'pushPull', 'paint']) { const f = b[k]; b[k] = (x, side, ...rest) => f(x, sideName(side), ...rest); }
  { const f = b.addSnap; b.addSnap = (id, u, ...rest) => f(id, sideName(u), ...rest); }
  { const f = b.setSlide; b.setSlide = (id, o, ...rest) => f(id, o && typeof o.axis === 'string' ? { ...o, axis: sideName(o.axis) } : o, ...rest); }
  // paint that would land outside a side says how big the side is
  const sizeNote = (x, side) => { try { const f = b.faceSize(x, side); return `the ${side} side is ${f.w} × ${f.h} pixels (u 0..${f.w - 1}, v 0..${f.h - 1})`; } catch { return ''; } };
  { const f = b.paintPixels; b.paintPixels = (x, side, list = [], ...r) => { const fs = b.faceSize(x, side); if (list.length && !list.some(([u, v]) => u >= 0 && v >= 0 && u < fs.w && v < fs.h)) throw new Error('No pixel landed on the side: ' + sizeNote(x, side)); return f(x, side, list, ...r) + ` (${fs.w} × ${fs.h} px side)`; }; }
  { const f = b.paintRect; b.paintRect = (x, side, o = {}, ...r) => { const fs = b.faceSize(x, side), { u = 0, v = 0, w = 1, h = 1 } = o; if (u >= fs.w || v >= fs.h || u + w <= 0 || v + h <= 0) throw new Error('The rectangle is outside the side: ' + sizeNote(x, side)); return f(x, side, o, ...r) + ` (${fs.w} × ${fs.h} px side)`; }; }
  { const f = b.paintLine; b.paintLine = (x, side, from, to, ...r) => { const fs = b.faceSize(x, side), out = q => q[0] < 0 || q[1] < 0 || q[0] >= fs.w || q[1] >= fs.h; if (out(from) && out(to) && ((from[0] < 0 && to[0] < 0) || (from[1] < 0 && to[1] < 0) || (from[0] >= fs.w && to[0] >= fs.w) || (from[1] >= fs.h && to[1] >= fs.h))) throw new Error('The line is outside the side: ' + sizeNote(x, side)); return f(x, side, from, to, ...r) + ` (${fs.w} × ${fs.h} px side)`; }; }
  b.find = name => { const all = Object.values(b.doc?.nodes || {}).filter(n => n.name === name); return (all.find(n => n.kind === 'group') || all[0])?.id || null; }; // groups win (they are the joints)
  b.newDoc = name => { newDoc(name); ed.undoStack.length = 0; ed.redoStack.length = 0; return b.msg(`New model “${b.doc.name}”`); };
  b.refresh = refresh;
  b._internals = { N, groupWorld, descendants, topSel, setLocal, tc, proxy };
  newDoc();
  return b;
}
