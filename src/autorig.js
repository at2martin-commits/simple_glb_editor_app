// Auto-rig helpers for the Simple GLB Editor:
//   fitSkeleton(ed)        humanoid joints read off the model's shape (cross-sections of its surface)
//   surfaceWeights(...)    skin weights measured along the surface, so touching limbs don't pull each other
//   makeWalk(ed, opts)     looping in-place walk: planted feet (leg IK), knee/elbow bends, arm swing, head bob
// Conventions: Y up, character faces +Z, its left side is +X (bones *_L).
import * as THREE from 'three';
import { TriGrid } from './trigrid.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ surface samples
/** Evenly spread points over the model's surface (world space), so low-poly models can be measured too. */
function sampleSurface(ed, count = 40000) {
  const tris = [];
  let total = 0;
  for (const mesh of ed.meshes()) {
    const t = ed._refreshWorld(mesh), w = t.world;
    for (let f = 0; f < t.triCount; f++) {
      const a = t.pointOf[t.corner(f * 3)], b = t.pointOf[t.corner(f * 3 + 1)], c = t.pointOf[t.corner(f * 3 + 2)];
      const A = V(w[a * 3], w[a * 3 + 1], w[a * 3 + 2]), B = V(w[b * 3], w[b * 3 + 1], w[b * 3 + 2]), C = V(w[c * 3], w[c * 3 + 1], w[c * 3 + 2]);
      const area = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).length() / 2;
      if (area > 0) { tris.push({ A, B, C, area }); total += area; }
      }
  }
  const out = [];
  let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const withCorners = tris.length <= 20000; // low-poly models: also use the corners themselves (big ones have plenty)
  let carry = 0;
  for (const tr of tris) {
    carry += count * tr.area / total; const n = Math.floor(carry); carry -= n;   // ~count points in total
    for (let i = 0; i < n; i++) {
      let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      out.push(tr.A.clone().addScaledVector(V().subVectors(tr.B, tr.A), u).addScaledVector(V().subVectors(tr.C, tr.A), v));
    }
    if (withCorners) out.push(tr.A, tr.B, tr.C);
  }
  return out;
}
function segments(xs, gap) {
  if (!xs.length) return [];
  xs.sort((a, b) => a - b);
  const segs = []; let a = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { segs.push([a, xs[i - 1]]); a = xs[i]; }
  segs.push([a, xs[xs.length - 1]]);
  return segs;
}
// min/max over any number of values (Math.max(...bigArray) blows the call stack on big, detailed models)
const minOf = (arr, f = x => x) => { let m = Infinity; for (const x of arr) { const v = f(x); if (v < m) m = v; } return m; };
const maxOf = (arr, f = x => x) => { let m = -Infinity; for (const x of arr) { const v = f(x); if (v > m) m = v; } return m; };
const mid = (arr, k) => (minOf(arr, p => p[k]) + maxOf(arr, p => p[k])) / 2;

// ------------------------------------------------------------------ landmarks
export function landmarks(ed) {
  const raw = sampleSurface(ed);
  if (raw.length < 50) throw new Error('Load a model first');
  const box = new THREE.Box3().setFromPoints(raw);
  const H = box.max.y - box.min.y, cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const P = raw.map(p => ({ x: p.x - cx, y: p.y - box.min.y, z: p.z - cz })); // feet at y=0, centred
  const toWorld = p => V(p.x + cx, p.y + box.min.y, p.z + cz);
  P.sort((a, b) => a.y - b.y);
  const firstAt = y => { let lo = 0, hi = P.length; while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].y < y) lo = m + 1; else hi = m; } return lo; };
  const sl = (y0, y1) => P.slice(firstAt(y0), firstAt(y1)); // the points with y0 <= y < y1
  const L = { H, toWorld };

  // feet: toes are the front (+z) of the lowest slice
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    let low = P.filter(p => p.y < 0.04 * H && p.x * sg > 0);
    if (!low.length) low = P.filter(p => p.y < 0.1 * H && p.x * sg > 0);
    const toe = maxOf(low, p => p.z), heel = minOf(low, p => p.z), flen = Math.max(toe - heel, 0.02 * H);
    const fx = mid(low, 'x');
    let ay = 0.05 * H;
    for (let k = 6; k < 60; k++) { // ankle: where the leg above the foot becomes short front-to-back
      const s2 = sl(k * 0.004 * H, (k + 1) * 0.004 * H).filter(p => p.x * sg > 0 && Math.abs(p.x - fx) < 0.1 * H);
      if (s2.length > 3 && maxOf(s2, p => p.z) - minOf(s2, p => p.z) < 0.6 * flen) { ay = (k + 0.5) * 0.004 * H; break; }
    }
    const as = sl(ay, ay + 0.01 * H).filter(p => p.x * sg > 0);
    L['foot' + s] = { x: fx, toe, heel, len: flen, width: maxOf(low, p => p.x) - minOf(low, p => p.x),
      ankle: { x: as.length ? mid(as, 'x') : fx, y: ay, z: as.length ? mid(as, 'z') : heel + 0.3 * flen } };
  }
  // crotch: lowest height where the middle column is filled
  let crotch = 0.45 * H;
  for (let k = 10; k < 200; k++) {
    const y = k * 0.004 * H;
    if (sl(y, y + 0.004 * H).some(p => Math.abs(p.x) < 0.012 * H)) { crotch = y; break; }
  }
  L.crotch = crotch;
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    const hs = sl(crotch - 0.04 * H, crotch - 0.005 * H).filter(p => p.x * sg > 0.005 * H);
    const hip = { x: hs.length ? mid(hs, 'x') : sg * 0.06 * H, y: crotch + 0.035 * H, z: hs.length ? mid(hs, 'z') : 0 };
    const ank = L['foot' + s].ankle, ky = ank.y + 0.5 * (hip.y - ank.y);
    const ks = sl(ky - 0.01 * H, ky + 0.01 * H).filter(p => p.x * sg > 0.003 * H && Math.abs(p.x - hip.x) < 0.12 * H);
    L['hip' + s] = hip;
    L['knee' + s] = { x: ks.length ? mid(ks, 'x') : (hip.x + ank.x) / 2, y: ky, z: (ks.length ? mid(ks, 'z') : 0) + 0.012 * H }; // knees bend forward
  }
  // torso and arms from cross-sections
  const gap = 0.012 * H;
  const segsAt = y => segments(sl(y, y + 0.006 * H).map(p => p.x), gap);
  const torsoAt = y => segsAt(y).find(([a, b]) => a <= 0 && 0 <= b) || null;
  let armpit = null;
  const armsBeside = y => { // something separate on BOTH sides of the torso at this height
    const sg = segsAt(y), t = sg.find(([a, b]) => a <= 0 && 0 <= b);
    return !!(t && sg.some(([a]) => a > t[1]) && sg.some(([, b]) => b < t[0]));
  };
  for (let y = crotch + 0.04 * H; y < 0.9 * H; y += 0.004 * H) {
    // a real armpit has arm hanging below it for a while (hair beside the face does not)
    if (armsBeside(y) && armsBeside(y - 0.04 * H) && armsBeside(y - 0.08 * H)) armpit = y;
  }
  // arms held out to the sides (T-pose): the model is much wider than a body; the arms are the widest band
  const width = maxOf(P, p => p.x) - minOf(P, p => p.x);
  const tpose = width > 0.75 * H || !armpit;
  let armBandTop = null;
  if (width > 0.75 * H) {
    let lo = null, hi = null;
    for (let y = crotch; y < 0.95 * H; y += 0.004 * H) {
      const s2 = sl(y, y + 0.006 * H); if (!s2.length) continue;
      if (maxOf(s2, p => Math.abs(p.x)) > 0.3 * width) { if (lo === null) lo = y; hi = y; }
    }
    if (lo !== null) { armpit = lo; armBandTop = hi; }
  }
  if (!armpit) armpit = crotch + 0.55 * (0.85 * H - crotch);
  let ts = null; // torso width just under the arms (where the arms aren't joined on)
  for (let y = armpit; y > armpit - 0.12 * H && !ts; y -= 0.004 * H) { const t = torsoAt(y); if (t && t[1] - t[0] < 0.5 * width) ts = t; }
  ts ||= [-0.1 * H, 0.1 * H];
  let best = 9, neck = armpit + 0.06 * H;
  for (let y = (armBandTop ?? armpit) + 0.02 * H; y < 0.9 * H; y += 0.004 * H) {
    const t = torsoAt(y); if (!t) continue;
    if (t[1] - t[0] < best) { best = t[1] - t[0]; neck = y; }
    if (t[1] - t[0] > best * 1.8 && y > neck + 0.05 * H) break;
  }
  L.neck = neck; L.shoulderY = Math.min(armpit + 0.045 * H, neck - 0.02 * H); L.headTop = H;
  const ns = sl(neck, neck + 0.01 * H); L.spineZ = ns.length ? mid(ns, 'z') : 0;
  // arms: follow each arm down (or out) from the shoulder to the hand
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    let sh = { x: sg * Math.max(Math.min(Math.abs(ts[0]), Math.abs(ts[1])) - 0.03 * H, 0.06 * H), y: L.shoulderY, z: L.spineZ };
    let tip = null, armPts = null;
    if (!tpose) {
      // Arms hanging down: at every height the arm is the OUTERMOST part of that side, even where it touches
      // the body. Follow it down; it ends where the outermost point suddenly jumps inward (hand -> hip/legs).
      const armW = 0.075 * H, pts = [], rows = [];
      let prev = null;
      for (let y = L.shoulderY - 0.01 * H; y > 0.04 * H; y -= 0.004 * H) {
        const side = sl(y - 0.004 * H, y + 0.004 * H).filter(p => p.x * sg > 0.02 * H);
        if (side.length < 2) break;
        const outer = maxOf(side, p => p.x * sg);
        if (prev !== null && outer < prev - 0.04 * H) break;   // fell off the hand onto the hip / trousers
        const arm = side.filter(p => p.x * sg > outer - armW);
        rows.push({ y, x: arm.reduce((a, p) => a + p.x, 0) / arm.length, z: arm.reduce((a, p) => a + p.z, 0) / arm.length });
        for (const q of arm) pts.push(q); prev = outer;
      }
      if (rows.length > 5) {
        const lowY = minOf(pts, p => p.y), last = rows[rows.length - 1];
        tip = { x: last.x, y: lowY, z: last.z };
        const top = rows.slice(0, 4); // shoulder joint: inside the top of the upper arm
        sh = { x: top.reduce((a, r) => a + r.x, 0) / top.length - sg * 0.02 * H, y: L.shoulderY, z: top.reduce((a, r) => a + r.z, 0) / top.length };
        armPts = pts;
      }
    }
    if (!tip || sh.y - tip.y < 0.15 * H) { // arms held out (T/A pose): the hand is the farthest point outward
      sh = { x: sg * Math.max(Math.min(Math.abs(ts[0]), Math.abs(ts[1])) - 0.03 * H, 0.06 * H), y: L.shoulderY, z: L.spineZ };
      const cand = P.filter(p => p.y > crotch - 0.15 * H && p.y < L.shoulderY + 0.05 * H && p.x * sg > 0);
      const far = cand.reduce((m, p) => (p.x * sg > m.x * sg ? p : m), cand[0]);
      tip = { x: far.x, y: far.y, z: far.z }; armPts = null;
    }
    const shV = V(sh.x, sh.y, sh.z), tipV = V(tip.x, tip.y, tip.z), ax = tipV.clone().sub(shV), alen = ax.length(); ax.normalize();
    const cand = armPts || P.filter(p => p.x * sg > Math.abs(sh.x) * 0.5 && p.y > Math.min(tip.y, sh.y) - 0.05 * H && p.y < sh.y + 0.05 * H);
    // wrist: the thinnest place in the outer part of the arm
    let wt = 0.75, thin = 9;
    for (let k = 60; k <= 88; k += 2) {
      const c = shV.clone().addScaledVector(ax, alen * k / 100);
      const r = cand.map(p => { const d = V(p.x, p.y, p.z).sub(c), along = d.dot(ax); return Math.abs(along) < 0.012 * H ? d.addScaledVector(ax, -along).length() : null; })
        .filter(x => x !== null && x < 0.1 * H);
      const th = r.length ? maxOf(r) : 9;
      if (th < thin) { thin = th; wt = k / 100; }
    }
    const wrist = shV.clone().addScaledVector(ax, alen * wt);
    const elbow = shV.clone().lerp(wrist, 0.5).add(V(0, 0, -0.012 * H)); // a little back: elbows bend forward
    L['arm' + s] = { shoulder: shV, elbow, wrist, tip: tipV };
  }
  return L;
}

/** Build the humanoid skeleton (same joint names as the stick figure) fitted to the model. */
export function fitSkeleton(ed) {
  const L = landmarks(ed), H = L.H, w = p => L.toWorld(p);
  const hipC = { x: 0, y: (L.hipL.y + L.hipR.y) / 2, z: (L.hipL.z + L.hipR.z) / 2 };
  const neckBase = (L.shoulderY + L.neck) / 2, sz = L.spineZ;
  const up = t => ({ x: 0, y: hipC.y + t * (neckBase - hipC.y), z: hipC.z + t * (sz - hipC.z) });
  const defs = [
    ['Hips', null, hipC], ['Spine', 'Hips', up(0.35)], ['Chest', 'Spine', up(0.72)], ['Neck', 'Chest', { x: 0, y: neckBase, z: sz }],
    ['Head', 'Neck', { x: 0, y: L.neck + 0.02 * H, z: sz }], ['HeadEnd', 'Head', { x: 0, y: H, z: sz }],
  ];
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    const a = L['arm' + s], f = L['foot' + s];
    const local = v => ({ x: v.x, y: v.y, z: v.z });
    defs.push(
      [`Shoulder_${s}`, 'Chest', { x: sg * 0.03 * H, y: L.shoulderY - 0.01 * H, z: sz }],
      [`UpperArm_${s}`, `Shoulder_${s}`, local(a.shoulder)], [`LowerArm_${s}`, `UpperArm_${s}`, local(a.elbow)],
      [`Hand_${s}`, `LowerArm_${s}`, local(a.wrist)], [`HandEnd_${s}`, `Hand_${s}`, local(a.tip)],
      [`UpperLeg_${s}`, 'Hips', L['hip' + s]], [`LowerLeg_${s}`, `UpperLeg_${s}`, L['knee' + s]],
      [`Foot_${s}`, `LowerLeg_${s}`, f.ankle], [`Toe_${s}`, `Foot_${s}`, { x: f.x, y: 0.01 * H, z: f.toe }],
    );
  }
  return defs.map(([n, p, pos]) => [n, p, w(pos).toArray()]);
}

// ------------------------------------------------------------------ weights along the surface
/**
 * Per-point skin weights from distances measured along the mesh (Dijkstra over its edges), seeded from the
 * points that clearly belong to each bone. A hand resting against a hip stays on the hand.
 * Returns { idx: Uint16Array(P*4), w: Float32Array(P*4) } for the mesh's points.
 */
export function surfaceWeights(t, bones, segs, H) {
  const P = t.points.length, W = t.world;
  const pos = i => V(W[i * 3], W[i * 3 + 1], W[i * 3 + 2]);
  const seg = new THREE.Line3(), tmp = new THREE.Vector3();
  const eu = new Float64Array(P * bones.length);
  const near = new Int32Array(P);
  // line of sight: a bone only "sees" skin it can reach through the inside of the body. Skin bulging out behind
  // (a backpack, a belly) is not given to a limb just because the limb happens to be closer through the air.
  const tris = [];
  for (let f = 0; f < t.triCount; f++) {
    const a = t.pointOf[t.corner(f * 3)], b = t.pointOf[t.corner(f * 3 + 1)], c = t.pointOf[t.corner(f * 3 + 2)];
    if (a !== b && b !== c && a !== c) tris.push({ a, b, c, A: pos(a), B: pos(b), C: pos(c) });
  }
  // faces sorted into a grid, so each look only tests the faces along its own path (fast on big models)
  const grid = new TriGrid(tris, Math.min(96, Math.max(16, Math.round(Math.cbrt(tris.length) * 2))));
  const dir = new THREE.Vector3();
  const sees = (i, p, q) => { // does the straight line from skin point p (id i) to bone point q stay inside?
    const len = dir.subVectors(q, p).length(); if (len < 1e-9) return true;
    dir.divideScalar(len);
    return !grid.hits(p, dir, len - 1e-6, k => { const T = tris[k]; return T.a !== i && T.b !== i && T.c !== i; }, 1e-6);
  };
  for (let i = 0; i < P; i++) {
    const p = pos(i); const order = [];
    for (let j = 0; j < bones.length; j++) {
      let d = Infinity, cq = null;
      for (const e of segs[j].ends) { seg.set(segs[j].a, e); seg.closestPointToPoint(p, true, tmp); const dd = tmp.distanceTo(p); if (dd < d) { d = dd; cq = tmp.clone(); } }
      eu[i * bones.length + j] = d; order.push([d, j, cq]);
    }
    order.sort((x, y) => x[0] - y[0]);
    near[i] = order[0][1];
    for (const [d, j, cq] of order.slice(0, 6)) { // nearest bone it can see (looking at the closest few)
      if (d > order[0][0] * 2.5 + 0.02 * H) break;
      if (sees(i, p, cq)) { near[i] = j; break; }
    }
  }
  // adjacency
  const adj = Array.from({ length: P }, () => []);
  for (let k = 0; k < t.edges.length; k += 2) {
    const a = t.edges[k], b = t.edges[k + 1], d = pos(a).distanceTo(pos(b));
    adj[a].push(b, d); adj[b].push(a, d);
  }
  // seeds: for each bone, the connected patch of its nearest points that is closest to the bone itself
  const seeds = bones.map(() => []);
  const seen = new Uint8Array(P);
  for (let j = 0; j < bones.length; j++) {
    const mine = []; for (let i = 0; i < P; i++) if (near[i] === j) mine.push(i);
    if (!mine.length) continue;
    let bestComp = null, bestD = Infinity;
    for (const s of mine) {
      if (seen[s]) continue;
      const comp = [], stack = [s]; seen[s] = 1;
      while (stack.length) { const v = stack.pop(); comp.push(v); const a = adj[v]; for (let k = 0; k < a.length; k += 2) { const u = a[k]; if (!seen[u] && near[u] === j) { seen[u] = 1; stack.push(u); } } }
      const d = minOf(comp, v => eu[v * bones.length + j]);
      if (d < bestD) { bestD = d; bestComp = comp; }
    }
    seeds[j] = bestComp || [];
  }
  // geodesic distance per bone
  const geo = new Float64Array(P * bones.length).fill(Infinity);
  for (let j = 0; j < bones.length; j++) {
    const dist = new Float64Array(P).fill(Infinity), heap = [];
    const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (const s of seeds[j]) { dist[s] = eu[s * bones.length + j]; push(dist[s], s); }
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v]) continue;
      const a = adj[v];
      for (let k = 0; k < a.length; k += 2) { const u = a[k], nd = d + a[k + 1]; if (nd < dist[u]) { dist[u] = nd; push(nd, u); } }
    }
    for (let i = 0; i < P; i++) geo[i * bones.length + j] = dist[i];
  }
  // weights: closest bone (along the surface) plus its parent/children, blended smoothly at the joints
  const parentOf = bones.map(b => bones.indexOf(b.parent));
  const sigma = 0.03 * H;
  const idx = new Uint16Array(P * 4), wts = new Float32Array(P * 4);
  for (let i = 0; i < P; i++) {
    const g = j => (isFinite(geo[i * bones.length + j]) ? geo[i * bones.length + j] : eu[i * bones.length + j] * 3);
    let b0 = 0; for (let j = 1; j < bones.length; j++) if (g(j) < g(b0)) b0 = j;
    // closest along the surface, but it must also be able to see the point through the body (else try the next ones)
    const byG = bones.map((_, j) => j).sort((x, y) => g(x) - g(y)).slice(0, 5), p = pos(i);
    const closestOn = j => { let d = Infinity, best = null; for (const e of segs[j].ends) { seg.set(segs[j].a, e); seg.closestPointToPoint(p, true, tmp); const dd = tmp.distanceTo(p); if (dd < d) { d = dd; best = tmp.clone(); } } return best; };
    for (const j of byG) { if (g(j) > g(byG[0]) + 0.15 * H) break; if (sees(i, p, closestOn(j))) { b0 = j; break; } }
    const fam = new Set([b0]); if (parentOf[b0] >= 0) fam.add(parentOf[b0]);
    bones.forEach((b, j) => { if (parentOf[j] === b0) fam.add(j); });
    const cand = [...fam].map(j => [j, Math.exp(-(g(j) - g(b0)) / sigma)]).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = cand.reduce((s, c) => s + c[1], 0);
    cand.forEach(([j, w], k) => { idx[i * 4 + k] = j; wts[i * 4 + k] = w / sum; });
  }
  return { idx, w: wts };
}

// ------------------------------------------------------------------ walk cycle
const smooth = u => u * u * (3 - 2 * u);
/** Angle (radians) of a direction in the side view, measured from straight down toward the front (+Z). */
const sideAngle = (y, z) => Math.atan2(z, -y);

/**
 * Walk styles: named sets of makeWalk options. 'normal' is the original walk.
 * 'tough': heavy, confident swagger — slower and weightier, wider planted stance, chest out and shoulders back
 * rolling with each step, bigger chest-against-hips twist, fists held out from the body swinging with attitude,
 * head a little forward with the chin down and a small firm bob.
 */
export const WALK_STYLES = {
  normal: { label: 'Normal', help: 'An everyday walk.' },
  tough: {
    label: 'Tough guy', help: 'Heavy, confident swagger: slow wide stomping steps on bent knees, chest out, shoulders rolling, fists out from the body, chin down.',
    frames: 32, step: 1.0, lift: 0.26, stance: 0.62, bob: 1.6, sway: 0.022, crouch: 0.16, footRoll: 40, heelStrike: 25,
    pelvisTurn: 9, pelvisDrop: 4.5, chestTurn: 11,
    armSwing: 20, armOut: 24, armsOut: true, elbow: 30, elbowSwing: 8, fist: 12,
    headNod: 1.6, stanceWidth: 0.07, chestOut: 7, shoulderBack: 7, shoulderRoll: 7, headForward: 9,
  },
};

/**
 * Make a looping in-place walk on a humanoid skeleton (stick-figure / fitted joint names).
 * opts: { style='normal'|'tough', name, frames=24, step=0.62, lift=0.11, stance=0.6, bob=1, armSwing=14, elbow=14,
 *   elbowSwing=12, headNod=2.5, pelvisTurn=5, pelvisDrop=3, chestTurn=4, sway=0.012, armOut=8,
 *   stanceWidth=0 (extra foot spacing per side, share of leg length), chestOut=0, shoulderBack=0, shoulderRoll=0,
 *   headForward=0 (degrees), fist=0 (wrist curl, degrees), footRoll=22 (toe push-off, degrees), heelStrike=10 (toes up as the heel lands), crouch=0 (hips lower, share of leg length: more knee bend) }
 * Feet: planted feet stay flat on the floor and don't twist; when the foot rolls onto its toe or heel the ankle
 * rises just enough that nothing goes through the floor.
 */
export function makeWalk(ed, opts = {}) {
  const st = WALK_STYLES[opts.style || 'normal'];
  if (!st) throw new Error('Unknown walk style: ' + opts.style + ' (try: ' + Object.keys(WALK_STYLES).join(', ') + ')');
  const { label, help, ...preset } = st;
  const o = { name: 'Walk', frames: 24, step: 0.62, lift: 0.11, stance: 0.6, bob: 1, armSwing: 14, elbow: 14, elbowSwing: 12,
    headNod: 2.5, pelvisTurn: 5, pelvisDrop: 3, chestTurn: 4, sway: 0.012, armOut: 8,
    stanceWidth: 0, chestOut: 0, shoulderBack: 0, shoulderRoll: 0, headForward: 0, fist: 0, footRoll: 22, heelStrike: 10, crouch: 0, ...preset, ...opts };
  const fps = ed.fps || 30, F = o.frames, dur = F / fps, D = THREE.MathUtils.degToRad;
  const b = n => ed.root.getObjectByName(n);
  const need = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'UpperLeg_L', 'LowerLeg_L', 'Foot_L', 'UpperLeg_R', 'LowerLeg_R', 'Foot_R', 'UpperArm_L', 'LowerArm_L', 'UpperArm_R', 'LowerArm_R'];
  const miss = need.filter(n => !b(n)); if (miss.length) throw new Error('Walk needs a humanoid skeleton (Fit skeleton or Stick figure). Missing: ' + miss.join(', '));
  const wasAnim = ed.animMode;
  if (wasAnim) ed.setAnimMode(false); // read the rest pose
  ed.root.updateMatrixWorld(true);
  const rest = {}; for (const n of [...need, 'Toe_L', 'Toe_R', 'Hand_L', 'Hand_R', 'Shoulder_L', 'Shoulder_R']) { const x = b(n); if (x) rest[n] = { p: x.position.clone(), q: x.quaternion.clone() }; }
  const hips = b('Hips');
  // legs in the hips' space (rest rotations are identity for fitted / drawn skeletons)
  const leg = s => {
    const hipJ = b('UpperLeg_' + s).position.clone(), knee = hipJ.clone().add(b('LowerLeg_' + s).position), ank = knee.clone().add(b('Foot_' + s).position);
    const a = Math.hypot(knee.y - hipJ.y, knee.z - hipJ.z), c = Math.hypot(ank.y - knee.y, ank.z - knee.z);
    return { hipJ, ank, a, c, r1: sideAngle(knee.y - hipJ.y, knee.z - hipJ.z), r2: sideAngle(ank.y - knee.y, ank.z - knee.z) };
  };
  const legs = { L: leg('L'), R: leg('R') };
  const legLen = (legs.L.a + legs.L.c + legs.R.a + legs.R.c) / 2, S = o.step * legLen;
  // the soles: the lowest skin points under each ankle (rest pose, relative to the ankle), and the floor height
  const sole = { L: [], R: [] }; let floor = Infinity;
  const ankW = {}; for (const s of ['L', 'R']) ankW[s] = b('Foot_' + s).getWorldPosition(new THREE.Vector3());
  const vp = new THREE.Vector3();
  for (const m of ed.meshes()) { const pos = m.geometry.attributes.position; for (let i = 0; i < pos.count; i++) { m.getVertexPosition(i, vp).applyMatrix4(m.matrixWorld); floor = Math.min(floor, vp.y); } }
  for (const m of ed.meshes()) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      m.getVertexPosition(i, vp).applyMatrix4(m.matrixWorld);
      const s = vp.distanceToSquared(ankW.L) < vp.distanceToSquared(ankW.R) ? 'L' : 'R';
      if (vp.y < floor + 0.35 * (ankW[s].y - floor)) sole[s].push([vp.y - ankW[s].y, vp.z - ankW[s].z]);
    }
  }
  /** How far the ankle must rise so the foot, pitched by th (radians, + = heel up / toes down), stays on the floor. */
  const toeJ = {}; for (const s of ['L', 'R']) { const tb = b('Toe_' + s); toeJ[s] = tb ? tb.getWorldPosition(new THREE.Vector3()).sub(ankW[s]) : null; }
  const footClear = (s, th) => {
    if (!sole[s].length) return 0;
    const c = Math.cos(th), sn = Math.sin(th), g = floor - ankW[s].y, tj = toeJ[s];
    const tb = -Math.max(0, th) * 0.9, tc = Math.cos(tb), ts = Math.sin(tb); // the toes bend back as the heel lifts
    let low = Infinity;
    for (let [y, z] of sole[s]) {
      if (tj && z > tj.z) { const dy = y - tj.y, dz = z - tj.z; y = tj.y + dy * tc - dz * ts; z = tj.z + dy * ts + dz * tc; }
      low = Math.min(low, y * c - z * sn);
    }
    return Math.max(0, g - low);
  };
  // arms relax down to hang armOut degrees from the body (models are often made in an A- or T-pose)
  const armDown = {};
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    const d = b('LowerArm_' + s).position; // elbow relative to the shoulder joint
    const out = Math.atan2(Math.abs(d.x), -d.y); // 0 = hanging straight down
    armDown[s] = -sg * Math.max(0, out - D(o.armOut));
    if (o.armsOut) armDown[s] = -sg * (out - D(o.armOut)); // style wants the arms held out: lift them away from the body too
  }
  const q = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
  const qx = a => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
  const qz = a => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
  const keys = {}; // name -> { quaternion: [], position: [] }
  const put = (n, prop, t, v) => { ((keys[n] ||= {})[prop] ||= []).push({ t, v }); };
  const wide = o.stanceWidth * legLen;
  /** Pose one leg for one frame: planted / swinging ankle target -> thigh, shin, foot, toe rotations. */
  const solveLeg = (s, fr, extraLift) => {
    const sg = s === 'L' ? 1 : -1, off = s === 'L' ? 0 : 0.5;
    const L = legs[s], u0 = (fr.p + off) % 1; // 0 = this heel strikes
    let z, lift = 0, pitch = 0;
    if (u0 < o.stance) { const u = u0 / o.stance; z = S * (0.55 - u); if (u > 0.8) pitch = D(o.footRoll) * smooth((u - 0.8) / 0.2); }
    else { const u = (u0 - o.stance) / (1 - o.stance); z = S * (-0.45 + smooth(u)); lift = o.lift * legLen * Math.sin(Math.PI * u); pitch = D(o.footRoll) * (1 - smooth(Math.min(1, u * 2))) - D(o.heelStrike) * Math.sin(Math.PI * Math.max(0, u - 0.5) * 2) * 0.5; }
    lift = Math.max(lift, footClear(s, pitch)) + extraLift; // toes / heel never dip through the floor
    // ankle target in the world (relative to rest), then into hips space
    const restAnkW = rest.Hips.p.clone().add(L.ank);
    const targetW = V(restAnkW.x + sg * wide, restAnkW.y + lift, restAnkW.z + z);
    const T = targetW.sub(fr.hipsWorld).applyQuaternion(fr.hipInv).sub(L.hipJ); // relative to the hip joint
    // the leg leans sideways (in the hips' frame) to reach the target's x; the knee bends in that leaning plane
    const rest_dx = L.ank.x - L.hipJ.x;
    const rho = Math.atan2(T.x - rest_dx, -T.y);
    const Ty = -Math.hypot(T.x - rest_dx, T.y);
    let d = Math.hypot(Ty, T.z); d = Math.min(d, (L.a + L.c) * 0.999);
    const phiT = sideAngle(Ty, T.z);
    const alpha = Math.acos(THREE.MathUtils.clamp((L.a * L.a + d * d - L.c * L.c) / (2 * L.a * d), -1, 1));
    const t1 = phiT + alpha; // knee in front of the hip-ankle line
    const kneeY = -Math.cos(t1) * L.a, kneeZ = Math.sin(t1) * L.a;
    const t2 = sideAngle(Ty - kneeY, T.z - kneeZ);
    const th = -(t1 - L.r1), sh = -(t2 - L.r2), ft = pitch; // pitch of thigh, shin (leg plane) and foot (world)
    const out = {
      thigh: rest['UpperLeg_' + s].q.clone().multiply(qz(rho).multiply(qx(th))),
      shin: rest['LowerLeg_' + s].q.clone().multiply(qx(sh - th)),
      // foot: flat on the floor in the WORLD (undo the hips' turn/tilt and the leg's lean), pitched by ft only
      foot: rest['Foot_' + s].q.clone().multiply(qx(-sh).multiply(qz(-rho)).multiply(fr.hipInv.clone()).multiply(qx(ft))),
    };
    if (rest['Toe_' + s]) out.toe = rest['Toe_' + s].q.clone().multiply(q(-Math.max(0, ft) * 0.9, 0, 0));
    return out;
  };
  const frames = [];

  for (let f = 0; f <= F; f++) {
    const p = (f % F) / F, t = f / fps, ph = 2 * Math.PI * p;
    // hips: lowest just after each heel strike, highest at passing; sway toward the standing leg
    const dy = (-0.035 - 0.018 * Math.cos(2 * ph - 0.6)) * legLen * o.bob - o.crouch * legLen; // crouch: knees stay bent
    const sway = o.sway * legLen * 2 * Math.sin(ph);
    const yaw = -D(o.pelvisTurn) * Math.cos(ph), roll = D(o.pelvisDrop) * Math.sin(ph) * 0.5;
    const hq = q(0, yaw, roll);
    put('Hips', 'position', t, rest.Hips.p.clone().add(V(sway, dy, 0)).toArray());
    put('Hips', 'quaternion', t, rest.Hips.q.clone().multiply(hq).toArray());
    const hipInv = hq.clone().invert();
    const hipsWorld = rest.Hips.p.clone().add(V(sway, dy, 0));
    const fr = { t, p, hipsWorld, hipsQ: rest.Hips.q.clone().multiply(hq), hipInv, leg: {}, extra: { L: 0, R: 0 } };
    for (const s of ['L', 'R']) fr.leg[s] = solveLeg(s, fr, 0);
    frames.push(fr);
    // spine and head: chest turns against the pelvis, head keeps looking ahead and nods a little late
    const chestYaw = D(o.chestTurn) * Math.cos(ph);
    put('Spine', 'quaternion', t, rest.Spine.q.clone().multiply(q(-D(o.chestOut) * 0.4, -yaw * 0.5, -roll * 0.5)).toArray());
    put('Chest', 'quaternion', t, rest.Chest.q.clone().multiply(q(-D(o.chestOut) * 0.6, chestYaw - yaw * 0.5, -roll * 0.5)).toArray());
    put('Neck', 'quaternion', t, rest.Neck.q.clone().multiply(q(D(o.chestOut) + D(o.headForward) * 0.7, -chestYaw * 0.5, 0)).toArray());
    const nod = D(o.headNod) * Math.cos(2 * ph - 1.2);
    put('Head', 'quaternion', t, rest.Head.q.clone().multiply(q(nod + D(o.headForward) * 0.3, -chestYaw * 0.5, 0)).toArray());
    // arms swing against the legs, a little late; elbows soft and bend more when the arm swings forward
    for (const [s, sg] of [['L', 1], ['R', -1]]) {
      const fwd = -Math.cos(ph - 0.35) * sg; // +1 = arm forward
      if (rest['Shoulder_' + s] && (o.shoulderBack || o.shoulderRoll)) // shoulders held back, rolling forward with the arm
        put('Shoulder_' + s, 'quaternion', t, rest['Shoulder_' + s].q.clone().multiply(q(0, sg * D(o.shoulderBack - o.shoulderRoll * fwd), -sg * D(o.shoulderRoll) * 0.4 * Math.max(0, fwd))).toArray());
      const up = -D(o.armSwing) * fwd;
      const el = -(D(o.elbow) + D(o.elbowSwing) * Math.max(0, fwd));
      put('UpperArm_' + s, 'quaternion', t, rest['UpperArm_' + s].q.clone().multiply(q(up, 0, armDown[s])).toArray());
      put('LowerArm_' + s, 'quaternion', t, rest['LowerArm_' + s].q.clone().multiply(q(el, 0, 0)).toArray());
      if (rest['Hand_' + s]) put('Hand_' + s, 'quaternion', t, rest['Hand_' + s].q.clone().multiply(q(el * 0.25 - D(o.fist), 0, 0)).toArray());
    }
  }
  // skin check: pose each frame's hips + legs, measure the real (skinned) soles and lift a foot that dips below
  // the floor (heel/toe skin often follows the shin a little, so the rigid-foot estimate alone is not enough)
  const skinned = ed.meshes().filter(m => m.isSkinnedMesh);
  const clearance = 0.0012 * (b('HeadEnd') ? b('HeadEnd').getWorldPosition(new THREE.Vector3()).y - floor : 10 * legLen);
  if (skinned.length) {
    const soleV = { L: [], R: [] };
    for (const m of skinned) {
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        m.getVertexPosition(i, vp).applyMatrix4(m.matrixWorld);
        const s = vp.distanceToSquared(ankW.L) < vp.distanceToSquared(ankW.R) ? 'L' : 'R';
        if (vp.y < floor + 0.5 * (ankW[s].y - floor)) soleV[s].push([m, i]);
      }
    }
    const legBones = ['L', 'R'].flatMap(s => ['UpperLeg_', 'LowerLeg_', 'Foot_', 'Toe_'].map(n => n + s)).filter(n => rest[n]);
    const pose = fr => {
      hips.position.copy(fr.hipsWorld); hips.quaternion.copy(fr.hipsQ);
      for (const s of ['L', 'R']) { const l = fr.leg[s]; b('UpperLeg_' + s).quaternion.copy(l.thigh); b('LowerLeg_' + s).quaternion.copy(l.shin); b('Foot_' + s).quaternion.copy(l.foot); if (l.toe) b('Toe_' + s).quaternion.copy(l.toe); }
      ed.root.updateMatrixWorld(true); skinned.forEach(m => m.skeleton.update());
    };
    for (const fr of frames) for (let it = 0; it < 4; it++) {
      pose(fr); let again = false;
      for (const s of ['L', 'R']) {
        let low = Infinity; for (const [m, i] of soleV[s]) low = Math.min(low, m.getVertexPosition(i, vp).applyMatrix4(m.matrixWorld).y);
        const dip = floor + clearance - low; // keep a hair of clearance: blending between keyframes can dip a little
        if (dip > 1e-6) { fr.extra[s] += dip; fr.leg[s] = solveLeg(s, fr, fr.extra[s]); again = true; }
      }
      if (!again) break;
    }
    hips.position.copy(rest.Hips.p); hips.quaternion.copy(rest.Hips.q); // back to the rest pose
    for (const n of legBones) b(n).quaternion.copy(rest[n].q);
    ed.root.updateMatrixWorld(true); skinned.forEach(m => m.skeleton.update());
  }
  for (const fr of frames) for (const s of ['L', 'R']) {
    const l = fr.leg[s];
    put('UpperLeg_' + s, 'quaternion', fr.t, l.thigh.toArray()); put('LowerLeg_' + s, 'quaternion', fr.t, l.shin.toArray());
    put('Foot_' + s, 'quaternion', fr.t, l.foot.toArray()); if (l.toe) put('Toe_' + s, 'quaternion', fr.t, l.toe.toArray());
  }
  return { name: o.name, duration: dur, keys };
}
