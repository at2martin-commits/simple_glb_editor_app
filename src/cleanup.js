// Clean up AI-made models (ComfyUI and similar): one strength slider, gentle..aggressive.
//   planCleanup(ed, strength 0..1) -> a plan (nothing changes; used for the preview and the counts)
//   applyCleanup(ed, plan)         -> does it, as ONE undo step
// What it looks for, per part of the model:
//   1. points almost on top of each other           -> weld them into one
//   2. paper-thin sliver faces                      -> fold them away (weld their shortest side)
//   3. back-to-back duplicate faces (zero-thick fins) -> remove
//   4. loose pieces hidden inside the body, and tiny floating bits outside -> remove
//   5. folds: the surface tucked under itself (neighbouring faces facing opposite ways) -> ease the point back out
//   6. pass-throughs: an edge poking through another part of the surface -> ease the point back, or snap it
//      onto a neighbour if that doesn't do it (aggressive settings)
//   7. top end of the slider only: a light overall smoothing (keeps the low-poly look at gentler settings)
import * as THREE from 'three';
import { PREVIEW } from './editor.js';
import { TriGrid } from './trigrid.js';

const V = () => new THREE.Vector3();

/** How far each step goes for a strength 0 (gentle) .. 1 (aggressive). Distances are x model height. */
export function cleanupSettings(s) {
  s = THREE.MathUtils.clamp(s, 0, 1);
  const L = (a, b) => a + (b - a) * s;
  return {
    weld: L(0.03, 0.45),        // x the model's typical edge length: points (not joined by an edge) closer than this become one
    shortEdge: s < 0.6 ? 0 : (s - 0.6) / 0.4 * 0.15, // x typical edge length: tiny edges collapse - aggressive half only
                                // (tight rings at the tip of a rounded part are real detail, not damage)
    sliver: L(0.004, 0.05),     // faces thinner than this (height / longest side) are folded away
    foldDot: L(-0.9, -0.6),     // neighbouring faces facing more opposite than this = a fold (natural creases like knuckles sit near -0.6)
    junk: L(0.01, 0.25),        // pieces hidden inside the body smaller than this are removed
    stray: L(0, 0.03),          // loose bits outside the body smaller than this are removed
    smooth: s > 0.7 ? (s - 0.7) / 0.3 * 0.35 : 0,
    snap: s > 0.45,             // stubborn folds / pass-throughs may snap onto a neighbouring point
  };
}

// ------------------------------------------------------------------ small geometry helpers
function unionFind(n) {
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  return { find, union: (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; } };
}
const triNormal = (W, a, b, c, out) => {
  out.set(W[b * 3] - W[a * 3], W[b * 3 + 1] - W[a * 3 + 1], W[b * 3 + 2] - W[a * 3 + 2]);
  const ex = W[c * 3] - W[a * 3], ey = W[c * 3 + 1] - W[a * 3 + 1], ez = W[c * 3 + 2] - W[a * 3 + 2];
  const x = out.y * ez - out.z * ey, y = out.z * ex - out.x * ez, z = out.x * ey - out.y * ex;
  return out.set(x, y, z);
};
/** Edge (p0->p1) against triangle (a,b,c): true if the segment passes through the triangle's inside. */
function segHitsTri(W, p0, p1, a, b, c) {
  const o = new THREE.Vector3(W[p0 * 3], W[p0 * 3 + 1], W[p0 * 3 + 2]), e = new THREE.Vector3(W[p1 * 3], W[p1 * 3 + 1], W[p1 * 3 + 2]);
  const d = e.clone().sub(o), len = d.length(); if (len < 1e-12) return false;
  const A = new THREE.Vector3(W[a * 3], W[a * 3 + 1], W[a * 3 + 2]), B = new THREE.Vector3(W[b * 3], W[b * 3 + 1], W[b * 3 + 2]), Cc = new THREE.Vector3(W[c * 3], W[c * 3 + 1], W[c * 3 + 2]);
  const hit = new THREE.Ray(o, d.divideScalar(len)).intersectTriangle(A, B, Cc, false, new THREE.Vector3());
  return !!hit && hit.distanceTo(o) < len * 0.999 && hit.distanceTo(o) > len * 0.001;
}

// ------------------------------------------------------------------ planning
/**
 * Work out what Clean up would do at this strength, without changing anything.
 * Returns { strength, meshes: [{ mesh, moves: Map(pid->Vector3), weldPids:Set, killFaces:Set, preview:Map(pid->Color),
 *           counts }], totals, notes }.
 */
export function planCleanup(ed, strength) {
  const S = cleanupSettings(strength), plans = [], notes = [];
  for (const mesh of ed.meshes()) {
    const t = ed._refreshWorld(mesh), P = t.points.length, F = t.triCount;
    if (!P || !F) continue;
    const W = Float64Array.from(t.world);
    let H = 0; { let lo = Infinity, hi = -Infinity; for (let i = 0; i < P; i++) { lo = Math.min(lo, W[i * 3 + 1]); hi = Math.max(hi, W[i * 3 + 1]); } H = Math.max(hi - lo, 1e-6); }
    const counts = { welded: 0, slivers: 0, fins: 0, junkPieces: 0, junkFaces: 0, strayPieces: 0, folds: 0, foldsFixed: 0, passThroughs: 0, passFixed: 0, smoothed: 0 };
    const preview = new Map(), moved = new Set();
    const faceP = new Int32Array(F * 3);
    for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) faceP[f * 3 + k] = t.pointOf[t.corner(f * 3 + k)];

    // typical edge length of this model (its own scale, so detailed models aren't over-welded)
    const elen = []; for (let k = 0; k < t.edges.length; k += 2) { const a = t.edges[k], b = t.edges[k + 1]; elen.push(Math.hypot(W[a * 3] - W[b * 3], W[a * 3 + 1] - W[b * 3 + 1], W[a * 3 + 2] - W[b * 3 + 2])); }
    elen.sort((x, y) => x - y); const typical = elen[elen.length >> 1] || H * 0.01;
    const joined = new Set(); for (let k = 0; k < t.edges.length; k += 2) joined.add(t.edges[k] * P + t.edges[k + 1]);
    const isJoined = (a, b) => joined.has(Math.min(a, b) * P + Math.max(a, b));
    const edgeUse = new Map(); for (let f = 0; f < F; f++) for (const [x, y] of [[0, 1], [1, 2], [2, 0]]) { const a = faceP[f * 3 + x], b = faceP[f * 3 + y], k = Math.min(a, b) * P + Math.max(a, b); edgeUse.set(k, (edgeUse.get(k) || 0) + 1); }
    const onCrack = new Uint8Array(P); for (const [k, n] of edgeUse) if (n === 1) { onCrack[Math.floor(k / P)] = 1; onCrack[k % P] = 1; }
    const dupe = 1e-4 * typical; // exact duplicates are always welded
    // 1. weld points almost on top of each other that are NOT joined by an edge (cracks, doubled-up points) - grid hash
    const uf = unionFind(P), th = Math.max(Math.min(S.weld * typical, 0.01 * H), 1e-9), th2 = th * th, cell = new Map(), key = (a, b, c) => a + ',' + b + ',' + c;
    for (let p = 0; p < P; p++) {
      const cx = Math.floor(W[p * 3] / th), cy = Math.floor(W[p * 3 + 1] / th), cz = Math.floor(W[p * 3 + 2] / th);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = cell.get(key(cx + dx, cy + dy, cz + dz)); if (!l) continue;
        for (const q of l) { const ex = W[p * 3] - W[q * 3], ey = W[p * 3 + 1] - W[q * 3 + 1], ez = W[p * 3 + 2] - W[q * 3 + 2]; const d2 = ex * ex + ey * ey + ez * ez; if (d2 <= th2 && !isJoined(p, q) && ((onCrack[p] && onCrack[q]) || d2 <= dupe * dupe)) uf.union(p, q); }
      }
      const k = key(cx, cy, cz); (cell.get(k) || cell.set(k, []).get(k)).push(p);
    }
    // 1b. edges far shorter than the model's typical edge collapse to a point
    for (let k = 0; k < t.edges.length; k += 2) { const a = t.edges[k], b = t.edges[k + 1]; if (Math.hypot(W[a * 3] - W[b * 3], W[a * 3 + 1] - W[b * 3 + 1], W[a * 3 + 2] - W[b * 3 + 2]) < S.shortEdge * typical) uf.union(a, b); }
    // 2. sliver faces: weld their shortest side
    const nrm = V();
    for (let f = 0; f < F; f++) {
      const [a, b, c] = [uf.find(faceP[f * 3]), uf.find(faceP[f * 3 + 1]), uf.find(faceP[f * 3 + 2])];
      if (a === b || b === c || a === c) continue;
      const L2 = (p, q) => (W[p * 3] - W[q * 3]) ** 2 + (W[p * 3 + 1] - W[q * 3 + 1]) ** 2 + (W[p * 3 + 2] - W[q * 3 + 2]) ** 2;
      const sides = [[a, b, L2(a, b)], [b, c, L2(b, c)], [c, a, L2(c, a)]].sort((x, y) => x[2] - y[2]);
      const longest = Math.sqrt(sides[2][2]); if (longest < 1e-12) continue;
      const area2 = triNormal(W, a, b, c, nrm).length(); // = 2 * area
      if (area2 / longest / longest < S.sliver) { uf.union(sides[0][0], sides[0][1]); counts.slivers++; }
    }
    const groups = new Map();
    for (let p = 0; p < P; p++) { const r = uf.find(p); (groups.get(r) || groups.set(r, []).get(r)).push(p); }
    const rep = new Int32Array(P);
    for (const [r, g] of groups) {
      for (const p of g) rep[p] = r;
      if (g.length < 2) continue;
      const c = V(); g.forEach(p => c.add(V().fromArray(W, p * 3))); c.divideScalar(g.length);
      g.forEach(p => { W[p * 3] = c.x; W[p * 3 + 1] = c.y; W[p * 3 + 2] = c.z; moved.add(p); preview.set(p, PREVIEW.weld); });
      counts.welded += g.length - 1;
    }
    // faces in terms of welded points; drop the ones that collapsed
    const kill = new Set(), live = [];
    for (let f = 0; f < F; f++) {
      const a = rep[faceP[f * 3]], b = rep[faceP[f * 3 + 1]], c = rep[faceP[f * 3 + 2]];
      if (a === b || b === c || a === c) kill.add(f); else live.push(f);
    }
    const R = f => [rep[faceP[f * 3]], rep[faceP[f * 3 + 1]], rep[faceP[f * 3 + 2]]];
    // 3. back-to-back duplicate faces (zero-thickness fins)
    const seen = new Map();
    for (const f of live) {
      const k = R(f).slice().sort((x, y) => x - y).join(',');
      if (seen.has(k)) { kill.add(f); kill.add(seen.get(k)); counts.fins++; } else seen.set(k, f);
    }
    // 4. loose pieces: inside the body (hidden junk) or tiny floating bits outside
    const alive = live.filter(f => !kill.has(f));
    const cuf = unionFind(P);
    for (const f of alive) { const [a, b, c] = R(f); cuf.union(a, b); cuf.union(b, c); }
    const comps = new Map();
    for (const f of alive) { const r = cuf.find(R(f)[0]); (comps.get(r) || comps.set(r, []).get(r)).push(f); }
    if (comps.size > 1) {
      const sorted = [...comps.values()].sort((x, y) => y.length - x.length);
      const triOf = new Map(); sorted.forEach((comp, ci) => comp.forEach(f => triOf.set(f, ci)));
      const allTris = alive.map(f => { const [A, B, C] = R(f).map(p => V().fromArray(W, p * 3)); return { ci: triOf.get(f), A, B, C }; });
      const tgrid = new TriGrid(allTris, Math.min(96, Math.max(16, Math.round(Math.cbrt(allTris.length) * 2))));
      const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(d => V().fromArray(d));
      for (const [ci, comp] of sorted.entries()) {
        if (ci === 0) continue;
        const box = new THREE.Box3(); comp.forEach(f => R(f).forEach(p => box.expandByPoint(V().fromArray(W, p * 3))));
        const size = box.getSize(V()).length() / H, c = box.getCenter(V());
        if (size >= Math.max(S.junk, S.stray)) continue; // too big to be junk at this setting
        // hidden only if ALL of it is enclosed: its centre and its outermost points must each be boxed in by other pieces
        const pts = new Set(); comp.forEach(f => R(f).forEach(p => pts.add(p)));
        const samples = [c];
        for (let k = 0; k < 3; k++) for (const sgn of [1, -1]) {
          let best = null, bv = -Infinity; for (const p of pts) { const v = sgn * W[p * 3 + k]; if (v > bv) { bv = v; best = p; } }
          if (best !== null) samples.push(V().fromArray(W, best * 3).lerp(c, 0.02)); // a hair inside its own surface
        }
        const enclosed = q => dirs.every(d => tgrid.hits(q, d, Infinity, k => allTris[k].ci !== ci));
        const inside = samples.every(enclosed);
        if ((inside && size < S.junk) || (!inside && size < S.stray)) {
          comp.forEach(f => kill.add(f));
          if (inside) { counts.junkPieces++; counts.junkFaces += comp.length; } else counts.strayPieces++;
          comp.forEach(f => R(f).forEach(p => preview.set(p, PREVIEW.junk)));
        }
      }
    }
    const faces = live.filter(f => !kill.has(f));
    const piece = new Int32Array(P); for (let p = 0; p < P; p++) piece[p] = cuf.find(p); // which connected piece each point is on
    // neighbours and faces around each point (welded)
    const nb = new Map(), around = new Map(), add = (m, k, v) => (m.get(k) || m.set(k, new Set()).get(k)).add(v);
    for (const f of faces) { const [a, b, c] = R(f); add(nb, a, b); add(nb, a, c); add(nb, b, a); add(nb, b, c); add(nb, c, a); add(nb, c, b); add(around, a, f); add(around, b, f); add(around, c, f); }
    // edge -> its two faces
    const edgeFaces = new Map();
    for (const f of faces) { const [a, b, c] = R(f); for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? p + ',' + q : q + ',' + p; (edgeFaces.get(k) || edgeFaces.set(k, []).get(k)).push(f); } }
    const fn = new Map(), n1 = V(), n2 = V();
    const faceNormal = f => { const [a, b, c] = R(f); return triNormal(W, a, b, c, V()).normalize(); };
    const foldsAt = (p, dot = S.foldDot) => { // folds among the faces around point p
      let n = 0; const fs = [...(around.get(p) || [])];
      for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
        const A = R(fs[i]), B = R(fs[j]), shared = A.filter(x => B.includes(x));
        if (shared.length === 2 && faceNormal(fs[i]).dot(faceNormal(fs[j])) < dot) n++;
      }
      return n;
    };
    // 5. folds
    const foldPts = new Set();
    for (const [, fs] of edgeFaces) {
      if (fs.length !== 2) continue;
      if (n1.copy(faceNormal(fs[0])).dot(n2.copy(faceNormal(fs[1]))) < S.foldDot) {
        counts.folds++;
        const A = R(fs[0]), B = R(fs[1]);
        A.forEach(p => { if (!B.includes(p)) foldPts.add(p); }); B.forEach(p => { if (!A.includes(p)) foldPts.add(p); });
      }
    }
    // 6. pass-throughs (edges poking through other faces): spatial grid of faces
    const big = faces.length > 60000;
    if (big) notes.push(`${mesh.name}: large model, skipped the pass-through check`);
    const gridSize = H / 24, fgrid = new Map(), gk = (x, y, z) => x + ',' + y + ',' + z;
    const cellsOf = (pts, fnc) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], W[p * 3 + k]); hi[k] = Math.max(hi[k], W[p * 3 + k]); }
      for (let x = Math.floor(lo[0] / gridSize); x <= Math.floor(hi[0] / gridSize); x++)
        for (let y = Math.floor(lo[1] / gridSize); y <= Math.floor(hi[1] / gridSize); y++)
          for (let z = Math.floor(lo[2] / gridSize); z <= Math.floor(hi[2] / gridSize); z++) fnc(gk(x, y, z));
    };
    const buildGrid = () => { fgrid.clear(); for (const f of faces) cellsOf(R(f), k => (fgrid.get(k) || fgrid.set(k, []).get(k)).push(f)); };
    const passOfEdge = (p, q, hitPts) => {
      if (big) return 0; const near = new Set(); cellsOf([p, q], k => (fgrid.get(k) || []).forEach(f => near.add(f)));
      let n = 0;
      for (const f of near) {
        const [a, b, c] = R(f); if (a === p || b === p || c === p || a === q || b === q || c === q) continue;
        if (piece[a] !== piece[p]) continue; // a different piece overlapping on purpose (e.g. clothing): not damage
        if (segHitsTri(W, p, q, a, b, c)) { n++; if (hitPts) hitPts.push(a, b, c); }
      }
      return n;
    };
    const passAt = p => { // poke-throughs involving p: its own edges through other faces, and other edges through its faces
      let n = 0; for (const q of nb.get(p) || []) n += passOfEdge(p, q);
      if (!big) for (const f of around.get(p) || []) {
        const [a, b, c] = R(f), near = new Set(); cellsOf([a, b, c], k => (fgrid.get(k) || []).forEach(g => near.add(g)));
        const seen2 = new Set();
        for (const g of near) { const T = R(g); for (const [x, y] of [[T[0], T[1]], [T[1], T[2]], [T[2], T[0]]]) {
          const k2 = x < y ? x + ',' + y : y + ',' + x; if (seen2.has(k2) || x === a || x === b || x === c || y === a || y === b || y === c) continue;
          seen2.add(k2); if (piece[x] === piece[a] && segHitsTri(W, x, y, a, b, c)) n++; } }
      }
      return n;
    };
    if (!big) buildGrid();
    const passPts = new Set();
    if (!big) for (const k of edgeFaces.keys()) {
      const [p, q] = k.split(',').map(Number), hit = [], n = passOfEdge(p, q, hit);
      if (n) { counts.passThroughs += n; passPts.add(p); passPts.add(q); hit.forEach(x => passPts.add(x)); } // the poked face may be the one out of place
    }
    // fix poke-throughs first (judged only against real flips, so ordinary creases never block them), then folds
    // (never making poke-throughs worse). One point at a time; a move is kept only if it makes things better.
    const runFix = (troubled, cost) => {
      const tryMove = (p, to) => {
        const old = [W[p * 3], W[p * 3 + 1], W[p * 3 + 2]], before = cost(p);
        W[p * 3] = to.x; W[p * 3 + 1] = to.y; W[p * 3 + 2] = to.z;
        if (cost(p) + 15 * to.distanceTo(V().fromArray(old)) / H < before) return true;
        W[p * 3] = old[0]; W[p * 3 + 1] = old[1]; W[p * 3 + 2] = old[2]; return false;
      };
      for (let pass = 0; pass < 5; pass++) {
        for (const p of troubled) {
          if (!cost(p)) continue;
          const ns = [...(nb.get(p) || [])]; if (!ns.length) continue;
          const avg = V(); ns.forEach(q => avg.add(V().fromArray(W, q * 3))); avg.divideScalar(ns.length);
          const cur = V().fromArray(W, p * 3);
          let ok = false;
          for (const f of [0.5, 0.8, 1]) if (tryMove(p, cur.clone().lerp(avg, f))) { ok = true; break; }
          if (!ok && S.snap) { // snap onto the neighbour that helps most
            let best = null, bc = cost(p);
            for (const q of ns) { const to = V().fromArray(W, q * 3), old = V().fromArray(W, p * 3); W.set([to.x, to.y, to.z], p * 3); const c = cost(p) + 15 * to.distanceTo(old) / H; W.set([old.x, old.y, old.z], p * 3); if (c < bc) { bc = c; best = to; } }
            if (best) { W.set([best.x, best.y, best.z], p * 3); ok = true; }
          }
          if (ok) { moved.add(p); preview.set(p, PREVIEW.fix); }
        }
        if (!big) buildGrid();
      }
    };
    runFix([...passPts], p => 3 * passAt(p) + foldsAt(p, -0.9));
    runFix([...foldPts], p => foldsAt(p) + 3 * passAt(p));
    if (!big) { let leftP = 0; for (const k of edgeFaces.keys()) { const [p, q] = k.split(',').map(Number); leftP += passOfEdge(p, q); } counts.passFixed = Math.max(0, counts.passThroughs - leftP); }
    { let leftF = 0; for (const [, fs] of edgeFaces) if (fs.length === 2 && faceNormal(fs[0]).dot(faceNormal(fs[1])) < S.foldDot) leftF++; counts.foldsFixed = Math.max(0, counts.folds - leftF); }
    // 7. light smoothing at the top end (shrink-free: one in, one out)
    if (S.smooth > 0) {
      const pts = [...nb.keys()], lam = S.smooth, mu = -(lam + 0.02);
      const step = f => { const out = Float64Array.from(W); for (const p of pts) { const ns = [...nb.get(p)]; const a = V(); ns.forEach(q => a.add(V().fromArray(W, q * 3))); a.divideScalar(ns.length); for (let k = 0; k < 3; k++) out[p * 3 + k] = W[p * 3 + k] + f * (a.getComponent(k) - W[p * 3 + k]); } W.set(out); };
      const before = Float64Array.from(W); step(lam); step(mu);
      for (const p of pts) { const d = Math.hypot(W[p * 3] - before[p * 3], W[p * 3 + 1] - before[p * 3 + 1], W[p * 3 + 2] - before[p * 3 + 2]); if (d > 0.002 * H) { moved.add(p); if (!preview.has(p)) preview.set(p, PREVIEW.smooth); counts.smoothed++; } }
    }
    // final positions for every point that moves (welded members all get their group's spot)
    const moves = new Map();
    for (const p of moved) { const g = groups.get(rep[p]) || [p]; for (const m of g) moves.set(m, V().fromArray(W, rep[p] * 3)); }
    for (const [r, g] of groups) if (g.length > 1) for (const m of g) moves.set(m, V().fromArray(W, r * 3));
    plans.push({ mesh, moves, killFaces: kill, preview, counts, H });
  }
  const totals = {};
  for (const pl of plans) for (const [k, v] of Object.entries(pl.counts)) totals[k] = (totals[k] || 0) + v;
  return { strength, settings: S, meshes: plans, totals, notes };
}

/** Show (or hide, with null) a plan's changes as coloured points on the model. */
export function showPlan(ed, plan) {
  ed.preview = plan ? new Map(plan.meshes.map(m => [m.mesh, m.preview])) : null;
  ed._updateMeshOverlays();
}

/** Do the clean-up as ONE undo step. Returns a plain-English summary. */
export function applyCleanup(ed, plan) {
  const meshes = plan.meshes.map(m => m.mesh);
  return ed._op('Clean up', { geo: meshes }, () => {
    let faces = 0;
    for (const pl of plan.meshes) {
      const { mesh } = pl;
      const t = ed.topo(mesh), det = ed._det(mesh.geometry);
      if (pl.moves.size) {
        ed._setPointsWorld(mesh, [...pl.moves]);
        for (const p of pl.moves.keys()) for (const v of t.points[p] || []) det.delete(v);
      }
      // face indices are unchanged by moving points; welded points now share a spot -> their slivers collapse
      ed._invalidateTopo(mesh);
      const t2 = ed.topo(mesh);
      faces += ed._removeFaces(mesh, (f, a, b, c) => pl.killFaces.has(f) || t2.pointOf[a] === t2.pointOf[b] || t2.pointOf[b] === t2.pointOf[c] || t2.pointOf[a] === t2.pointOf[c]);
      ed._finishGeometry(mesh, null);
    }
    ed.preview = null; ed._clearPointSel(); ed._syncGizmo(); ed._updateMeshOverlays();
    const T = plan.totals;
    return ed.msg(`Cleaned up: welded ${T.welded} point(s), fixed ${T.foldsFixed} fold(s) and ${T.passFixed} poke-through(s), removed ${T.junkPieces + T.strayPieces} loose piece(s) and ${faces} face(s)` + (T.smoothed ? `, smoothed ${T.smoothed} point(s)` : ''));
  });
}
