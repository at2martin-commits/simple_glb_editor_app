// Fast "does this ray hit the model?" for big models: triangles are sorted into a 3D grid of boxes, and a ray only
// tests the triangles in the boxes it actually passes through (3D grid walk), instead of every triangle.
import * as THREE from 'three';

export class TriGrid {
  /**
   * tris: array of { A, B, C } (THREE.Vector3) plus any extra fields (e.g. a piece id); cells: boxes along the
   * longest side (more = finer).
   */
  constructor(tris, cells = 48) {
    this.tris = tris;
    const box = new THREE.Box3();
    for (const t of tris) box.expandByPoint(t.A).expandByPoint(t.B).expandByPoint(t.C);
    const size = box.getSize(new THREE.Vector3());
    this.cell = Math.max(size.x, size.y, size.z, 1e-9) / cells;
    this.min = box.min.clone().subScalar(this.cell * 0.5);
    this.n = [0, 1, 2].map(k => Math.max(1, Math.ceil((size.getComponent(k) + this.cell) / this.cell)));
    this.map = new Map();
    this.stamp = new Uint32Array(tris.length); this.tick = 0;
    tris.forEach((t, i) => {
      const lo = [0, 1, 2].map(k => this._c(Math.min(t.A.getComponent(k), t.B.getComponent(k), t.C.getComponent(k)), k));
      const hi = [0, 1, 2].map(k => this._c(Math.max(t.A.getComponent(k), t.B.getComponent(k), t.C.getComponent(k)), k));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const key = this._key(x, y, z); let l = this.map.get(key); if (!l) this.map.set(key, l = []); l.push(i);
      }
    });
  }
  _c(v, k) { return Math.min(this.n[k] - 1, Math.max(0, Math.floor((v - this.min.getComponent(k)) / this.cell))); }
  _key(x, y, z) { return (x * this.n[1] + y) * this.n[2] + z; }

  /**
   * Walk the boxes along a ray (origin, unit dir) up to maxDist and call test(triIndex) for each triangle once;
   * stops early when test returns true. Returns whether it stopped early.
   */
  walk(origin, dir, maxDist, test) {
    if (++this.tick === 0xffffffff) { this.stamp.fill(0); this.tick = 1; }
    const o = [origin.x - this.min.x, origin.y - this.min.y, origin.z - this.min.z], d = [dir.x, dir.y, dir.z], c = this.cell;
    // clip the ray to the grid
    let t0 = 0, t1 = maxDist;
    for (let k = 0; k < 3; k++) {
      const lo = 0, hi = this.n[k] * c;
      if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo || o[k] > hi) return false; continue; }
      let a = (lo - o[k]) / d[k], b = (hi - o[k]) / d[k]; if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    if (t0 > t1) return false;
    const p = o.map((v, k) => v + d[k] * (t0 + 1e-9));
    const cellIdx = p.map((v, k) => Math.min(this.n[k] - 1, Math.max(0, Math.floor(v / c))));
    const step = d.map(v => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tMax = d.map((v, k) => (v === 0 ? Infinity : (((cellIdx[k] + (v > 0 ? 1 : 0)) * c) - o[k]) / v));
    const tDelta = d.map(v => (v === 0 ? Infinity : c / Math.abs(v)));
    for (;;) {
      const list = this.map.get(this._key(cellIdx[0], cellIdx[1], cellIdx[2]));
      if (list) for (const i of list) { if (this.stamp[i] === this.tick) continue; this.stamp[i] = this.tick; if (test(i)) return true; }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (tMax[k] > t1) return false;
      cellIdx[k] += step[k]; if (cellIdx[k] < 0 || cellIdx[k] >= this.n[k]) return false;
      tMax[k] += tDelta[k];
    }
  }
  /** Does the ray hit any triangle (that keep(triIndex) allows) closer than maxDist? (minDist skips the start) */
  hits(origin, dir, maxDist = Infinity, keep = null, minDist = 0) {
    const ray = new THREE.Ray(origin, dir), hit = new THREE.Vector3();
    return this.walk(origin, dir, maxDist, i => {
      if (keep && !keep(i)) return false;
      const t = this.tris[i];
      if (!ray.intersectTriangle(t.A, t.B, t.C, false, hit)) return false;
      const dd = hit.distanceTo(origin);
      return dd < maxDist && dd > minDist;
    });
  }
}
