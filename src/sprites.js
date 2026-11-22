// Sprite sheets: render a rigged, animated model's clips from several directions into one PNG + a JSON a 2D engine reads
// (TexturePacker "hash" frames — Phaser, PixiJS … — plus `animations` lists and Aseprite-style `frameTags`).
// Orthographic camera, ONE scale and ONE ground anchor for every frame of every direction, so nothing jitters or changes size.
import * as THREE from 'three';

/** Directions = which way the character faces ON SCREEN. Camera azimuth around the model (0 = in front of its +Z face). */
const DIRS8 = ['down', 'down_right', 'right', 'up_right', 'up', 'up_left', 'left', 'down_left'];
const DIR_AZ = Object.fromEntries(DIRS8.map((d, k) => [d, -45 * k]));
const DIR_SETS = { 1: ['down'], 2: ['right', 'left'], 4: ['down', 'right', 'up', 'left'], 8: DIRS8 };
const VIEWS = { side: 0, rpg: 30, iso: 26.565, top: 89 }; // camera elevation in degrees (iso = 2:1 pixel slopes)
export const SPRITE_DEFAULTS = { front: 'auto', clips: null, directions: 4, view: 'rpg', elevation: null, size: 64, fps: 12, style: 'smooth', outline: false, outlineColor: '#000000', background: null, padding: 2, folder: null, name: null, save: true, maxSheet: 8192 };

/** Which way a model faces: its feet stick out forward from the ankles (Blockbench models usually face -Z, ours +Z). */
export function detectFront(ed) {
  const wasAnim = ed.animMode; if (wasAnim) ed.setAnimMode(false);
  try {
    let sum = 0, n = 0; const v = new THREE.Vector3(), bp = new THREE.Vector3();
    for (const m of ed.meshes()) {
      if (!m.isSkinnedMesh) continue;
      const feet = new Map(m.skeleton.bones.map((b, i) => [i, b]).filter(([, b]) => /foot|toe/i.test(b.name)));
      if (!feet.size) continue;
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let best = -1, bw = 0; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        const b = feet.get(best); if (!b) continue;
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld); b.getWorldPosition(bp);
        sum += v.z - bp.z; n++;
      }
    }
    return n && sum / n < -1e-4 ? '-z' : '+z';
  } finally { if (wasAnim) ed.setAnimMode(true); }
}

const sleep0 = () => new Promise(r => setTimeout(r, 0));

/**
 * Render sprite sheets. opts: clips (names, default all), directions (1|2|4|8 or a list of names / azimuth degrees),
 * view ('side'|'rpg'|'iso'|'top') or elevation (deg), size (px or [w,h]), fps, style ('smooth'|'pixel'), outline (pixel style:
 * 1-px outline), outlineColor, background (null = transparent, or '#hex'), padding (px), folder / name (Library output,
 * default Sprites/<model>/<model>), save (false = only return data URLs), onProgress(done, total).
 * Returns {png, json, sheets:[{png, json, w, h}], frames, frameSize, directions, clips, ms} (+ dataURLs when save is false).
 */
export async function renderSprites(ed, options = {}) {
  const o = { ...SPRITE_DEFAULTS, ...options }, t0 = performance.now();
  if (ed.mode === 'build') throw new Error('Sprite sheets are made from a finished model: Make model first (Ctrl+Enter), or open a .glb');
  const meshes = ed.meshes(); if (!meshes.length) throw new Error('Nothing to render: open a model first');
  const allClips = ed.clips.map(c => c.name);
  const clipNames = [...new Set(o.clips ? [].concat(o.clips) : allClips.length ? allClips : [null])]; // no clips = one still frame of the rest pose
  for (const c of clipNames) if (c !== null && !allClips.includes(c)) throw new Error('No animation called ' + c + ' (have: ' + allClips.join(', ') + ')');
  const dirs = (Array.isArray(o.directions) ? o.directions : DIR_SETS[o.directions] || DIR_SETS[4]).map(d => (typeof d === 'number' ? { name: 'a' + d, az: d } : DIR_AZ[d] !== undefined ? { name: d, az: DIR_AZ[d] } : (() => { throw new Error('Unknown direction ' + d + ' (use ' + DIRS8.join(', ') + ' or degrees)'); })()));
  const elev = THREE.MathUtils.degToRad(o.elevation ?? VIEWS[o.view] ?? 30);
  const front = o.front === '+z' || o.front === '-z' ? o.front : detectFront(ed); // which way the model's face points
  if (front === '-z') dirs.forEach(d => { d.az += 180; });
  const [W, H] = Array.isArray(o.size) ? o.size.map(v => Math.max(8, Math.round(v))) : [Math.max(8, Math.round(o.size)), Math.max(8, Math.round(o.size))];
  const fps = Math.max(1, +o.fps || 12), pixel = o.style === 'pixel';
  const model = (ed.fileName || 'model').replace(/\.(glb|gltf)$/i, ''), name = o.name || model, folder = o.folder ?? `Sprites/${model}`;

  // ---- remember the editor's state, hide everything but the model
  const keep = { anim: ed.animMode, clip: ed.clipIndex, time: ed.time, playing: ed.playing, bg: ed.scene.background, clear: ed.renderer.getClearColor(new THREE.Color()), alpha: ed.renderer.getClearAlpha(), target: ed.renderer.getRenderTarget() };
  const hidden = []; for (const c of ed.scene.children) if (c !== ed.root && !c.isLight && c.visible) { c.visible = false; hidden.push(c); }
  ed.pause?.(); ed.playing = false;
  const restore = () => {
    hidden.forEach(c => { c.visible = true; });
    ed.scene.background = keep.bg; ed.renderer.setClearColor(keep.clear, keep.alpha); ed.renderer.setRenderTarget(keep.target);
    if (ed.clips.length) ed.setClip(keep.clip >= 0 ? keep.clip : 0);
    ed.setAnimMode(keep.anim); ed.setTime(keep.time); ed.changed();
  };
  try {
    // ---- the frames to draw: per clip, times at fps (a looping clip's last key = its first, so it is left out)
    const plan = clipNames.map(c => {
      if (c === null) return { clip: null, times: [0] };
      const clip = ed.clips.find(x => x.name === c), n = Math.max(1, Math.round(clip.duration * fps));
      return { clip: c, times: Array.from({ length: n }, (_, i) => i / fps) };
    });
    const pose = (c, t) => { if (c === null) { ed.setAnimMode(false); } else { if (!ed.animMode) ed.setAnimMode(true); if (ed.clip?.name !== c) ed.setClip(c); ed.setTime(t); } ed.root.updateMatrixWorld(true); };

    // ---- one fit for everything: sample skinned points over every frame, measure them in every direction's screen axes
    const pts = [], v = new THREE.Vector3(); // flat x,y,z list
    for (const p of plan) for (const t of p.times) {
      pose(p.clip, t);
      for (const m of meshes) {
        if (!m.visible) continue;
        const pos = m.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 6000)); // low-poly corners matter (a hat brim), so nearly every point
        for (let i = 0; i < pos.count; i += step) { m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld); pts.push(v.x, v.y, v.z); }
      }
    }
    const box = new THREE.Box3(); for (let i = 0; i < pts.length; i += 3) box.expandByPoint(v.set(pts[i], pts[i + 1], pts[i + 2]));
    const anchor = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2); // the ground point under the model
    const axes = dirs.map(d => {
      const az = THREE.MathUtils.degToRad(d.az), back = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));
      const right = new THREE.Vector3(0, 1, 0).cross(back).normalize(), up = back.clone().cross(right).normalize();
      return { ...d, back, right, up };
    });
    let maxX = 1e-6, maxUp = 1e-6, maxDown = 0; // (+2 % below, so anti-aliased edges are not cut)
    for (const a of axes) for (let i = 0; i < pts.length; i += 3) { const d = v.set(pts[i], pts[i + 1], pts[i + 2]).sub(anchor); maxX = Math.max(maxX, Math.abs(d.dot(a.right))); const y = d.dot(a.up); maxUp = Math.max(maxUp, y); maxDown = Math.max(maxDown, -y); }
    maxX *= 1.02; maxUp *= 1.02; maxDown *= 1.02;
    const pad = Math.max(0, o.padding | 0) + (pixel && o.outline ? 1 : 0);
    const scale = Math.min((W / 2 - pad) / maxX, (H - 2 * pad) / (maxUp + maxDown)); // pixels per metre
    const ax = W / 2, ay = pad + maxUp * scale; // the anchor's pixel in every frame (feet centre)
    const dist = box.getSize(new THREE.Vector3()).length() * 2 + 10;
    const cam = new THREE.OrthographicCamera(-ax / scale, (W - ax) / scale, ay / scale, -(H - ay) / scale, 0.01, dist * 2);

    // ---- render
    const rt = new THREE.WebGLRenderTarget(W, H, { samples: pixel ? 0 : 4, colorSpace: THREE.SRGBColorSpace });
    ed.scene.background = null; ed.renderer.setClearColor(0x000000, 0);
    const buf = new Uint8Array(W * H * 4), rows = plan.flatMap(p => axes.map(a => ({ ...p, dir: a })));
    const cols = Math.max(...plan.map(p => p.times.length)), total = rows.reduce((s, r) => s + r.times.length, 0);
    const frameImgs = []; let done = 0;
    const outline = pixel && o.outline ? new THREE.Color(o.outlineColor) : null;
    for (const r of rows) {
      const imgs = [];
      cam.position.copy(anchor).addScaledVector(r.dir.back, dist); cam.up.copy(r.dir.up); cam.lookAt(anchor); cam.updateMatrixWorld();
      for (const t of r.times) {
        pose(r.clip, t);
        ed.renderer.setRenderTarget(rt); ed.renderer.clear(); ed.renderer.render(ed.scene, cam);
        ed.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
        const img = new ImageData(W, H);
        for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4); // GL rows are bottom-up
        if (pixel) pixelize(img, outline); else unpremultiply(img);
        imgs.push(img);
        if (++done % 24 === 0) { o.onProgress?.(done, total); await sleep0(); }
      }
      frameImgs.push(imgs);
    }
    ed.renderer.setRenderTarget(keep.target); rt.dispose();

    // ---- pack: each animation x direction starts a new line (wrapped when longer than the sheet is wide);
    // everything on one sheet if it fits in maxSheet x maxSheet, else one sheet per animation
    const perLine = Math.max(1, Math.min(cols, Math.floor(o.maxSheet / W))), linesOf = ri => Math.ceil(frameImgs[ri].length / perLine);
    const height = g => g.reduce((s, ri) => s + linesOf(ri), 0) * H;
    const groups = height(rows.map((_, i) => i)) <= o.maxSheet ? [rows.map((_, i) => i)] : plan.map((p, ci) => axes.map((_, di) => ci * axes.length + di));
    if (groups.some(g => height(g) > o.maxSheet)) throw new Error(`One animation would need a sheet taller than ${o.maxSheet} px: use a smaller frame size or fewer frames per second`);
    const sheets = [];
    for (const [gi, g] of groups.entries()) {
      const cv = document.createElement('canvas'); cv.width = perLine * W; cv.height = height(g);
      const cx = cv.getContext('2d');
      if (o.background) { cx.fillStyle = o.background; cx.fillRect(0, 0, cv.width, cv.height); }
      const base = groups.length > 1 ? `${name}_${(plan[Math.floor(g[0] / axes.length)].clip || 'pose').replace(/[^\w-]+/g, '_')}` : name;
      const frames = {}, animations = {}, frameTags = []; let idx = 0, line = 0;
      for (const rowIdx of g) {
        const r = rows[rowIdx], list = []; let tag = `${String(r.clip || 'pose').replace(/\s+/g, '_')}_${r.dir.name}`; while (animations[tag]) tag += '_2'; // names stay unique
        frameImgs[rowIdx].forEach((img, fi) => {
          const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(img, 0, 0);
          const fx = (fi % perLine) * W, fy = (line + Math.floor(fi / perLine)) * H;
          cx.drawImage(tmp, fx, fy);
          const key = `${tag}_${fi}`;
          frames[key] = { frame: { x: fx, y: fy, w: W, h: H }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: W, h: H }, sourceSize: { w: W, h: H }, pivot: { x: +(ax / W).toFixed(4), y: +(ay / H).toFixed(4) }, duration: Math.round(1000 / fps) };
          list.push(key);
        });
        animations[tag] = list; frameTags.push({ name: tag, from: idx, to: idx + list.length - 1, direction: 'forward', clip: r.clip, facing: r.dir.name }); idx += list.length; line += linesOf(rowIdx);
      }
      const json = { frames, animations, meta: { app: 'Simple GLB Editor', version: '1', image: base + '.png', format: 'RGBA8888', size: { w: cv.width, h: cv.height }, scale: '1', fps, frameSize: { w: W, h: H }, pivot: { x: ax, y: ay }, pixelsPerMetre: +scale.toFixed(3), view: o.elevation ?? o.view, modelFront: front, directions: axes.map(a => a.name), frameTags } };
      const sheet = { name: base, w: cv.width, h: cv.height, json };
      if (o.save) {
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        const put = async (fname, body) => { const res = await fetch(`/api/lib/file?dir=${encodeURIComponent(folder)}&name=${encodeURIComponent(fname)}&overwrite=1`, { method: 'PUT', body }); const j = await res.json(); if (!res.ok || j.error) throw new Error('Save failed: ' + (j.error || res.status)); return j.rel; };
        sheet.png = await put(base + '.png', blob); sheet.json = await put(base + '.json', JSON.stringify(json, null, 1));
      } else sheet.dataURL = cv.toDataURL('image/png');
      if (!o.save || options.keepCanvas) sheet.canvas = cv;
      sheets.push(sheet);
    }
    o.onProgress?.(total, total);
    if (o.save) ed.dispatchEvent(new Event('library'));
    const out = { front, png: sheets[0].png, json: sheets[0].json, sheets: sheets.map(({ canvas, ...s }) => s), frames: total, frameSize: [W, H], directions: axes.map(a => a.name), clips: clipNames, fps, ms: Math.round(performance.now() - t0) };
    if (!o.save || options.keepCanvas) { out.sheetCanvases = sheets.map(s => s.canvas); out.sheetJsons = sheets.map(s => s.json); } // (the Sprite sheet window's preview)
    ed.msg(o.save ? `Sprite sheet: ${total} frames (${clipNames.length} animations × ${axes.length} directions) → Library/${sheets.map(s => s.png).join(', ')}` : `Sprite preview: ${total} frames`);
    return out;
  } finally { restore(); }
}

/** Anti-aliased edges come out of the GPU premultiplied (colour already faded by coverage); a PNG wants straight alpha. */
function unpremultiply(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a && a < 255) { const k = 255 / a; d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k); } }
}
/** Pixel-art look: hard alpha edges, optional 1-px outline around the figure. */
function pixelize(img, outline) {
  const d = img.data, W = img.width, H = img.height;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  if (!outline) return;
  const solid = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) solid[i] = d[i * 4 + 3] ? 1 : 0;
  const r = Math.round(outline.r * 255), g = Math.round(outline.g * 255), b = Math.round(outline.b * 255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (solid[i]) continue;
    if ((x > 0 && solid[i - 1]) || (x < W - 1 && solid[i + 1]) || (y > 0 && solid[i - W]) || (y < H - 1 && solid[i + W])) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
  }
}
