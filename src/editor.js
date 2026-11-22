// Simple GLB Editor — core (no DOM panels here; see ui.js).
// Everything the UI does goes through public methods on Editor, so the same
// methods can be driven from the console / automation via `window.editor`.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fitSkeleton as fitDefs, surfaceWeights, makeWalk as walkKeys } from './autorig.js';

export const MODES = ['object', 'vertex', 'edge', 'bone', 'draw', 'paint', 'build'];
const PROPS = ['position', 'quaternion', 'scale'];
const C = {
  point: new THREE.Color(0x15181c), pointSel: new THREE.Color(0xff8c1a), pointActive: new THREE.Color(0xffe14d),
  joint: new THREE.Color(0x4fc3f7), jointSel: new THREE.Color(0xff8c1a), jointActive: new THREE.Color(0xffe14d),
  pointHidden: new THREE.Color(0x6a7080), hover: new THREE.Color(0x4fc3f7),
};
export const PREVIEW = { weld: new THREE.Color(0xff5fd2), fix: new THREE.Color(0xffe14d), junk: new THREE.Color(0xff5252), smooth: new THREE.Color(0x7ee787) };
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const m1 = new THREE.Matrix4();
const r3 = n => Math.round(n * 1000) / 1000;
const arr3 = v => [r3(v.x), r3(v.y), r3(v.z)];

function circleTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 6; g.strokeStyle = '#000'; g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- geometry helpers ----------
const editableGeoms = new WeakSet();
function makeEditable(g) {
  if (editableGeoms.has(g)) return;
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    const toFloat = name === 'position' && !(a.array instanceof Float32Array);
    if (!a.isInterleavedBufferAttribute && !toFloat) continue;
    const n = a.count, s = a.itemSize;
    let arr;
    if (toFloat) {
      arr = new Float32Array(n * s);
      for (let i = 0; i < n; i++) for (let k = 0; k < s; k++) arr[i * s + k] = a[GETS[k]](i);
      g.setAttribute(name, new THREE.BufferAttribute(arr, s, false));
    } else {
      const src = a.data.array, stride = a.data.stride;
      arr = new src.constructor(n * s);
      for (let i = 0; i < n; i++) for (let k = 0; k < s; k++) arr[i * s + k] = src[i * stride + a.offset + k];
      g.setAttribute(name, new THREE.BufferAttribute(arr, s, a.normalized));
    }
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  editableGeoms.add(g);
}
function appendVertices(g, src) {
  const n = g.attributes.position.count, k = src.length;
  const grow = a => {
    const s = a.itemSize, arr = new a.array.constructor((n + k) * s);
    arr.set(a.array);
    for (let j = 0; j < k; j++) for (let c = 0; c < s; c++) arr[(n + j) * s + c] = a.array[src[j] * s + c];
    return new THREE.BufferAttribute(arr, s, a.normalized);
  };
  for (const name of Object.keys(g.attributes)) g.setAttribute(name, grow(g.attributes[name]));
  for (const name of Object.keys(g.morphAttributes)) g.morphAttributes[name] = g.morphAttributes[name].map(grow);
  return n;
}
/** Drop vertices no face uses (keeps vertex order). Returns old->new index map, or null if nothing changed. */
function compactGeometry(g) {
  const idx = g.index; if (!idx) return null;
  const n = g.attributes.position.count, ia = idx.array, mark = new Uint8Array(n);
  for (let i = 0; i < ia.length; i++) mark[ia[i]] = 1;
  const remap = new Int32Array(n).fill(-1); let k = 0;
  for (let i = 0; i < n; i++) if (mark[i]) remap[i] = k++;
  if (k === n) return null;
  const shrink = a => {
    const s = a.itemSize, arr = new a.array.constructor(k * s);
    for (let i = 0; i < n; i++) if (remap[i] >= 0) for (let c = 0; c < s; c++) arr[remap[i] * s + c] = a.array[i * s + c];
    return new THREE.BufferAttribute(arr, s, a.normalized);
  };
  for (const name of Object.keys(g.attributes)) g.setAttribute(name, shrink(g.attributes[name]));
  for (const name of Object.keys(g.morphAttributes)) g.morphAttributes[name] = g.morphAttributes[name].map(shrink);
  const out = new Uint32Array(ia.length); for (let i = 0; i < ia.length; i++) out[i] = remap[ia[i]];
  g.setIndex(new THREE.BufferAttribute(out, 1));
  return remap;
}
function ensureIndex(g, extra = 0) {
  const n = g.attributes.position.count;
  if (!g.index) {
    const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = i;
    g.setIndex(new THREE.BufferAttribute(a, 1));
  } else if (!(g.index.array instanceof Uint32Array) && n + extra > 65535) {
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(g.index.array), 1));
  }
  return g.index;
}

// ---------- animation data <-> three clips ----------
function fromThreeClip(clip) {
  const c = { name: clip.name || 'Action', duration: clip.duration || 1, tracks: {}, raw: [], frames: {} }; // frames: meshName -> [{t, frame}] (expression switches)
  for (const tr of clip.tracks) {
    const pb = THREE.PropertyBinding.parseTrackName(tr.name);
    const stride = { position: 3, scale: 3, quaternion: 4 }[pb.propertyName];
    if (!stride || pb.objectName || pb.propertyIndex) { c.raw.push(tr); continue; }
    const n = tr.times.length, cubic = tr.values.length === n * stride * 3;
    const keys = [];
    for (let i = 0; i < n; i++) {
      const o = cubic ? i * stride * 3 + stride : i * stride;
      keys.push({ t: tr.times[i], v: Array.from(tr.values.slice(o, o + stride)) });
    }
    (c.tracks[pb.nodeName] ||= {})[pb.propertyName] = keys;
  }
  return c;
}
function toThreeClip(c) {
  const tracks = [];
  for (const [node, props] of Object.entries(c.tracks)) {
    for (const [p, keys] of Object.entries(props)) {
      if (!keys.length) continue;
      keys.sort((a, b) => a.t - b.t);
      const times = keys.map(k => k.t), values = keys.flatMap(k => k.v);
      const T = p === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      tracks.push(new T(`${node}.${p}`, times, values));
    }
  }
  for (const r of c.raw) tracks.push(r.clone());
  return new THREE.AnimationClip(c.name, c.duration, tracks);
}
/** extras.frameKeys {clip: [[t, frame], ...]} on the meshes under root -> clip.frames; a .glb clip is as long as its last joint key: frame keys may run longer. */
function readFrameKeys(root, clips) {
  root.traverse(o => { const fk = o.isMesh && o.userData.frameKeys; if (!fk) return; for (const [cn, keys] of Object.entries(fk)) { const c = clips.find(x => x.name === cn); if (c) { c.frames[o.name] = keys.map(([t, frame]) => ({ t, frame })); c.duration = Math.max(c.duration, ...keys.map(k => +k[0] || 0)); } } });
}
const cloneClip = c => ({ name: c.name, duration: c.duration, tracks: JSON.parse(JSON.stringify(c.tracks)), raw: c.raw.slice(), frames: JSON.parse(JSON.stringify(c.frames || {})) });

const _invScratch = new Float32Array(16), GETS = ['getX', 'getY', 'getZ', 'getW']; // scratch for _vertexInv (called per point while dragging); GETS also used by makeEditable
/** Release the GPU memory of everything under o (geometries, materials, textures, skeleton textures). */
function disposeTree(o) {
  o.traverse(x => {
    x.geometry?.dispose?.(); x.skeleton?.dispose?.();
    for (const m of [].concat(x.material || [])) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) m[k]?.dispose?.(); m.dispose?.(); }
  });
}

/** Camera directions for view() / snapshot(): where the camera sits, seen from the model (it faces +Z). */
const VIEW_DIRS = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], persp: [0.55, 0.38, 0.75] };

export class Editor extends EventTarget {
  constructor(container) {
    super();
    this.THREE = THREE;
    this.container = container;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(r.domElement);
    this.dom = r.domElement;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2b2d31);
    this.scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(3, 5, 4); this.scene.add(sun);
    this.grid = new THREE.GridHelper(10, 20, 0x5a5d63, 0x3a3d42); this.scene.add(this.grid);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
    this.camera.position.set(2.6, 1.8, 3.6);
    this.orbit = new OrbitControls(this.camera, this.dom);
    this.orbit.target.set(0, 0.9, 0); this.orbit.update();
    this.setMouseButtons('middle', 'right');

    // The model lives in its own Scene so the exporter writes its children as glTF root nodes.
    this.root = new THREE.Scene(); this.root.name = 'Scene';
    this.scene.add(this.root);
    this.overlay = new THREE.Group(); this.overlay.name = '__overlay'; this.scene.add(this.overlay);

    this.pivot = new THREE.Object3D(); this.scene.add(this.pivot);
    this.gizmo = new TransformControls(this.camera, this.dom);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('mouseDown', () => { this.orbit.enabled = false; this._dragStart(); });
    this.gizmo.addEventListener('mouseUp', () => { this.orbit.enabled = true; this._dragEnd(); });
    this.gizmo.addEventListener('objectChange', () => this._dragChange());
    this.scene.add(this.gizmo);

    const draco = new DRACOLoader().setDecoderPath('/vendor/three/jsm/libs/draco/gltf/');
    this.loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    this.raycaster = new THREE.Raycaster();

    // state
    this.mode = 'object';
    this.animMode = false;
    this.gizmoMode = 'translate';
    this.childrenFollow = true;
    this.xray = false;
    this.snapMerge = false; // toggle: dragged points snap onto other points and merge on release
    this.snapHeld = false;  // same, while the snap key is held
    this.showBones = true;
    this.pointSize = 11;   // how big the points are drawn (pixels); the click area grows with it
    this.preview = null;   // Map(mesh -> Map(pid -> Color)): points a tool is about to change (e.g. Clean up)
    this._geoVer = 0;      // bumps whenever points move (for the visibility cache)
    this.fileName = 'model.glb';
    this.sceneSize = 2;
    this.sel = { meshes: [], bones: [], pts: new Map(), edges: new Map(), activePt: null, activeEdge: null };
    this.clips = []; this.clipIndex = -1;
    this.time = 0; this.playing = false; this.loop = true; this.fps = 30; this.speed = 1; this.autoKey = true;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.undoStack = []; this.redoStack = [];
    this._topo = new WeakMap(); this._ovl = new Map(); this._detached = new WeakMap(); this._rest = null;

    this._ptTex = circleTexture();
    this._ptMat = new THREE.PointsMaterial({ size: this.pointSize, sizeAttenuation: false, vertexColors: true, map: this._ptTex, alphaTest: 0.5 });
    this._depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    // hover highlight: the point / line a click would pick right now
    this._hoverPt = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
      new THREE.PointsMaterial({ size: this.pointSize + 7, sizeAttenuation: false, color: C.hover, map: this._ptTex, alphaTest: 0.5, depthTest: false }));
    this._hoverLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3)),
      new THREE.LineBasicMaterial({ color: C.hover, depthTest: false }));
    for (const o of [this._hoverPt, this._hoverLine]) { o.visible = false; o.frustumCulled = false; o.renderOrder = 30; this.overlay.add(o); }
    this._wireMat = new THREE.LineBasicMaterial({ color: 0x0c0e10, transparent: true, opacity: 0.55 });
    this._selWireMat = new THREE.LineBasicMaterial({ color: 0xff8c1a });
    this._selWire = new THREE.LineSegments(new THREE.BufferGeometry(), this._selWireMat);
    this._selWire.frustumCulled = false; this._selWire.renderOrder = 5; this.overlay.add(this._selWire);
    this._snapMarker = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 24), new THREE.MeshBasicMaterial({ color: 0xffe14d, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    this._snapMarker.renderOrder = 20; this._snapMarker.visible = false; this.overlay.add(this._snapMarker);
    this._boxHelpers = [];
    this._initBoneOverlay();
    this._initPointer();

    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  // ================= events / util =================
  changed() { this.dispatchEvent(new Event('change')); }
  msg(text) { this.lastMessage = text; this.dispatchEvent(new CustomEvent('message', { detail: text })); return text; }
  obj(x) { return typeof x === 'string' ? this.root.getObjectByName(x) : x; }
  bone(x) { const b = this.obj(x); if (!b || !b.isBone) throw new Error('No bone: ' + x); return b; }
  mesh(x) { const m = this.obj(x); if (!m || !m.isMesh) throw new Error('No mesh: ' + x); return m; }
  meshes() { const a = []; this.root.traverseVisible(o => { if (o.isMesh) a.push(o); }); return a; }
  allBones() { const a = []; this.root.traverse(o => { if (o.isBone) a.push(o); }); return a; }
  skeletons() { const s = new Set(); this.root.traverse(o => { if (o.isSkinnedMesh && o.skeleton) s.add(o.skeleton); }); return [...s]; }
  get activeBone() { return this.sel.bones[this.sel.bones.length - 1] || null; }
  get clip() { return this.clips[this.clipIndex] || null; }
  uniqueName(base) {
    base = THREE.PropertyBinding.sanitizeNodeName(base || 'Object') || 'Object';
    if (!this.root.getObjectByName(base)) return base;
    let i = 2; while (this.root.getObjectByName(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }
  _resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  /** Light / dark 3D view (background + grid). */
  setTheme(light) {
    this.light = !!light;
    this.scene.background = new THREE.Color(light ? 0xd9dce1 : 0x2b2d31);
    const vis = this.grid.visible; this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose();
    this.grid = new THREE.GridHelper(10, 20, light ? 0x8f96a3 : 0x5a5d63, light ? 0xb7bcc6 : 0x3a3d42); this.grid.visible = vis; this.scene.add(this.grid);
    this.build.setTheme(light); this.changed();
  }
  /** Tabs: only the tab you look at draws itself every frame. */
  setActive(on) {
    if (this.disposed) return;
    this.active = on;
    this.renderer.setAnimationLoop(on ? () => this._tick() : null);
    if (on) { this.clock.getDelta(); this._resize(); }
  }
  /** Closing a tab: free the GPU memory and stop everything this editor runs. */
  dispose() {
    this.setActive(false); this.disposed = true; this.pause();
    try { this.gizmo.detach(); this.gizmo.dispose?.(); this.orbit.dispose(); } catch {}
    for (const c of [...this.root.children]) { c.removeFromParent(); disposeTree(c); }
    this.build?.dispose?.();
    disposeTree(this.scene);
    this.renderer.dispose(); this.renderer.forceContextLoss();
    this.undoStack = []; this.redoStack = [];
  }
  /** Changed since it was last saved or opened (undoing back to that point counts as saved). */
  get dirty() { return this._lastModelStep() !== (this._savedStep ?? null); } // Build-mode steps have their own flag (build.dirty)
  _lastModelStep() { for (let i = this.undoStack.length - 1; i >= 0; i--) if (!this.undoStack[i].build) return this.undoStack[i]; return null; }
  _markSaved() { this._savedStep = this._lastModelStep(); }
  toScreen(p) {
    v3.copy(p).project(this.camera);
    return { x: (v3.x + 1) / 2 * this.dom.clientWidth, y: (1 - v3.y) / 2 * this.dom.clientHeight, behind: v3.z > 1 };
  }

  /** Which mouse button turns (orbits) the view and which slides (pans) it: 'left' | 'middle' | 'right'. */
  setMouseButtons(rotate = 'middle', pan = 'right') {
    const M = THREE.MOUSE, mb = { LEFT: -1, MIDDLE: M.DOLLY, RIGHT: -1 };
    const key = b => b.toUpperCase();
    if (pan && pan !== rotate) mb[key(pan)] = M.PAN;
    mb[key(rotate)] = M.ROTATE;
    this.orbit.mouseButtons = mb;
    this.mouse = { rotate, pan };
  }

  // ================= undo =================
  _pushUndo(label, undo, redo) {
    this.undoStack.push({ label, undo, redo });
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() { const e = this.undoStack.pop(); if (!e) return this.msg('Nothing to undo'); e.undo(); this.redoStack.push(e); this._afterRestore(); return this.msg('Undo: ' + e.label); }
  redo() { const e = this.redoStack.pop(); if (!e) return this.msg('Nothing to redo'); e.redo(); this.undoStack.push(e); this._afterRestore(); return this.msg('Redo: ' + e.label); }
  _afterRestore() { this._invalidateTopo(); this._clearPointSel(); this._syncGizmo(); this.changed(); }

  _snap(k) {
    const s = {};
    if (k.rig) s.rig = {
      bones: this.allBones().map(b => ({ b, parent: b.parent, name: b.name, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() })),
      skels: this.skeletons().map(sk => ({ sk, inv: sk.boneInverses.map(m => m.clone()) })),
    };
    if (k.anim) s.anim = { clips: this.clips.map(cloneClip), clipIndex: this.clipIndex };
    if (k.pos) s.pos = k.pos.map(m => ({ m, arr: m.geometry.attributes.position.array.slice(), det: new Set(this._det(m.geometry)) }));
    if (k.geo) s.geo = k.geo.map(m => ({ m, g: m.geometry.clone(), det: new Set(this._det(m.geometry)) }));
    if (k.objs) s.objs = k.objs.map(o => ({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
    return s;
  }
  _restore(s) {
    if (s.rig) {
      const keep = new Set(s.rig.bones.map(e => e.b));
      for (const b of this.allBones()) if (!keep.has(b)) b.removeFromParent();
      for (const e of s.rig.bones) {
        if (e.b.parent !== e.parent) { e.b.removeFromParent(); e.parent?.add(e.b); }
        e.b.name = e.name; e.b.position.copy(e.p); e.b.quaternion.copy(e.q); e.b.scale.copy(e.s);
      }
      for (const e of s.rig.skels) e.inv.forEach((m, i) => e.sk.boneInverses[i]?.copy(m));
      this.sel.bones = this.sel.bones.filter(b => b.parent);
    }
    if (s.anim) { this.clips = s.anim.clips.map(cloneClip); this.clipIndex = s.anim.clipIndex; this._rebuildAction(); }
    if (s.pos) for (const e of s.pos) {
      const a = e.m.geometry.attributes.position;
      if (a.array.length === e.arr.length) { a.array.set(e.arr); a.needsUpdate = true; }
      this._detached.set(e.m.geometry, new Set(e.det));
      this._finishGeometry(e.m, null);
    }
    if (s.geo) for (const e of s.geo) {
      const old = e.m.geometry; e.m.geometry = e.g.clone(); makeEditable(e.m.geometry); old.dispose();
      this._detached.set(e.m.geometry, new Set(e.det));
      this._finishGeometry(e.m, null);
    }
    if (s.objs) for (const e of s.objs) { e.o.position.copy(e.p); e.o.quaternion.copy(e.q); e.o.scale.copy(e.s); }
    this.root.updateMatrixWorld(true);
  }
  /** Run fn as one undoable step. kinds: {rig, anim, pos:[meshes], geo:[meshes], objs:[objects]} */
  _op(label, kinds, fn) {
    const before = this._snap(kinds);
    let r;
    try { r = fn(); } catch (e) { this._restore(before); this._afterRestore(); throw e; } // a failed step leaves nothing half-done
    const after = this._snap(kinds);
    this._pushUndo(label, () => this._restore(before), () => this._restore(after));
    this.changed();
    return r;
  }

  // ================= load / save =================
  /** Where to fetch a model from: a full disk path (C:\…), a URL, or a library path. */
  static srcUrl(src) { return /^[a-zA-Z]:[\\/]/.test(src) ? '/api/local?path=' + encodeURIComponent(src) : /^(\/|https?:|blob:|data:)/.test(src) ? src : '/api/lib/file?rel=' + encodeURIComponent(src); }
  async load(src, name) {
    let buf = src;
    this.libRel = null;
    if (typeof src === 'string') {
      const url = Editor.srcUrl(src);
      if (url.startsWith('/api/lib/file?rel=')) this.libRel = src;
      const res = await fetch(url); if (!res.ok) throw new Error('Fetch failed: ' + url);
      buf = await res.arrayBuffer(); name ||= src.split(/[\\/]/).pop();
    } else if (src instanceof Blob) { name ||= src.name; buf = await src.arrayBuffer(); }
    let gltf, bbReport = null;
    const head = new Uint8Array(buf, 0, Math.min(64, buf.byteLength)), firstChar = String.fromCharCode(...head).trimStart()[0];
    if (/\.bbmodel$/i.test(name || '') || (firstChar === '{' && /"meta"\s*:\s*\{[^}]*format_version/.test(new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(4096, buf.byteLength)))))) {
      // a Blockbench model: rigid parts, one bone per group (src/bbimport.js)
      const { importBlockbench } = await import('./bbimport.js');
      const stem = (name || 'model').replace(/\.bbmodel$/i, '');
      gltf = await importBlockbench(JSON.parse(new TextDecoder().decode(buf)), { name: stem });
      bbReport = gltf.report; name = stem + '.glb'; this.libRel = null;
    } else gltf = await new Promise((res, rej) => this.loader.parse(buf, '', res, rej));
    this.importReport = bbReport;
    this.clear(true);
    const s = gltf.scene;
    s.updateMatrixWorld(true);
    while (s.children.length) this.root.add(s.children[0]);
    this.root.traverse(o => {
      if (o.isMesh) { makeEditable(o.geometry); if (o.isSkinnedMesh) o.frustumCulled = false; }
    });
    this.clips = gltf.animations.map(fromThreeClip);
    readFrameKeys(this.root, this.clips);
    this.clipIndex = this.clips.length ? 0 : -1;
    this.fileName = (name || 'model.glb').replace(/\.gltf$/i, '.glb');
    this._rebuildAction();
    this._measure(); this.frame();
    this.changed();
    if (bbReport) return this.msg(`Imported Blockbench model ${this.fileName}: ${bbReport.bones} bones, ${bbReport.trianglesOut} triangles (${bbReport.culled} hidden faces dropped, ${bbReport.merged} flat faces merged), ${this.clips.length} animations, ${bbReport.locators} attach points. Save it to keep it in the library.`);
    return this.msg(`Loaded ${this.fileName}: ${this.meshes().length} meshes, ${this.allBones().length} bones, ${this.clips.length} clips`);
  }
  clear(silent) {
    this.pause(); this.setAnimMode(false);
    for (const c of [...this.root.children]) { c.removeFromParent(); disposeTree(c); } // free the old model's GPU memory
    this.sel = { meshes: [], bones: [], pts: new Map(), edges: new Map(), activePt: null, activeEdge: null };
    this.clips = []; this.clipIndex = -1; this.time = 0;
    this.mixer.stopAllAction(); this.mixer = new THREE.AnimationMixer(this.root); this._action = null;
    this.undoStack = []; this.redoStack = []; this._savedStep = null;
    this._invalidateTopo(); this._syncGizmo();
    if (!silent) { this.fileName = 'model.glb'; this.changed(); this.msg('Cleared'); }
  }
  /** Start over: empty scene, no animations, a fresh Build-mode project, nothing to undo. */
  newProject(name = 'new_model') {
    if (this.mode === 'build') this.setMode('object');
    this.clear(true); this.libRel = null; this.fileName = 'model.glb';
    this.build?.newDoc(name);
    this.view('persp'); this.changed();
    return this.msg('New project — open or build a model to start');
  }
  /**
   * Copy animation clips from another .glb into the open model, by joint name (no retargeting: rotations / positions /
   * scales are copied as stored). src = library path, '/url', full file path or File. opts: { names: [clip names] (default all),
   * replace: true (a clip with the same name is replaced; false = the copy gets a new name) }.
   * Expression frame keys (extras.frameKeys) come too when the open model has a framed mesh of the same name with those frames.
   * Returns a report { copied: [names], skippedTracks: ['clip: joint.prop'], frameKeys: n, skippedFrames: [...] }.
   */
  async importClips(src, { names = null, replace = true } = {}) {
    let buf, label = typeof src === 'string' ? src : src?.name;
    if (typeof src === 'string') {
      const url = Editor.srcUrl(src);
      const res = await fetch(url); if (!res.ok) throw new Error('Could not read ' + src); buf = await res.arrayBuffer();
    } else if (src instanceof Blob) buf = await src.arrayBuffer();
    else throw new Error('Give a .glb (library path, full path or File)');
    const gltf = await new Promise((res, rej) => this.loader.parse(buf, '', res, rej));
    const clips = gltf.animations.map(fromThreeClip);
    readFrameKeys(gltf.scene, clips);
    if (!clips.length) throw new Error(`${label} has no animations`);
    const r = this._mergeClips(clips, { names, replace, label: 'Import clips' });
    this.msg(`Copied ${r.copied.length} clip${r.copied.length === 1 ? '' : 's'} from ${label}${r.skippedTracks.length ? ` (${r.skippedTracks.length} track${r.skippedTracks.length === 1 ? '' : 's'} skipped: no joint of that name here)` : ''}${r.frameKeys ? `, ${r.frameKeys} expression key${r.frameKeys === 1 ? '' : 's'}` : ''}`);
    return r;
  }
  /** Add clips (editor format) to the model, keeping only tracks whose joint / object exists here. One undo step. */
  _mergeClips(clips, { names = null, replace = true, label = 'Import clips' } = {}) {
    const want = names ? new Set([].concat(names)) : null, report = { copied: [], skippedTracks: [], frameKeys: 0, skippedFrames: [] };
    if (want) { const missing = [...want].filter(n => !clips.some(c => c.name === n)); if (missing.length) throw new Error(`No clip called ${missing.join(', ')} (clips: ${clips.map(c => c.name).join(', ')})`); }
    const framed = new Map(this._framedMeshes().map(m => [m.name, m]));
    this._op(label, { anim: true }, () => {
      for (const c of clips) {
        if (want && !want.has(c.name)) continue;
        const nc = { name: c.name, duration: c.duration, tracks: {}, raw: [], frames: {} };
        for (const [node, props] of Object.entries(c.tracks)) {
          if (!this.root.getObjectByName(node)) { for (const p of Object.keys(props)) report.skippedTracks.push(`${c.name}: ${node}.${p}`); continue; }
          nc.tracks[node] = JSON.parse(JSON.stringify(props));
        }
        for (const [mesh, keys] of Object.entries(c.frames || {})) {
          const m = framed.get(mesh), missing = m ? [...new Set(keys.map(k => k.frame))].filter(f => !m.userData.frames[f]) : null;
          if (!m || missing.length) { report.skippedFrames.push(`${c.name}: ${mesh}${m ? ` (no frame ${missing.join(', ')})` : ' (no framed mesh of that name)'}`); continue; }
          nc.frames[mesh] = keys.map(k => ({ t: k.t, frame: k.frame })); report.frameKeys += keys.length;
        }
        const at = this.clips.findIndex(x => x.name === nc.name);
        if (at >= 0 && replace) this.clips[at] = nc;
        else { if (at >= 0) { let i = 2; while (this.clips.some(x => x.name === `${c.name}_${i}`)) i++; nc.name = `${c.name}_${i}`; } this.clips.push(nc); }
        report.copied.push(nc.name);
      }
      if (this.clipIndex < 0 && this.clips.length) this.clipIndex = 0;
      this._rebuildAction(); if (this.animMode) this.setTime(this.time);
    });
    return report;
  }
  /** The clips as three.js AnimationClips (used by the watch page publisher). */
  _threeClips() { return this.clips.map(toThreeClip); }
  // ---------------- colliders (empty nodes with userData.collider = {shape: 'box'|'sphere'|'capsule', size:[x,y,z], radius?, height?})
  _colliderNodes() { const a = []; this.root.traverse(o => { if (o.userData?.collider) a.push(o); }); return a; }
  _updateColliders() {
    this._colHelpers ||= new Map();
    const show = this.showColliders !== false, seen = new Set();
    for (const o of show ? this._colliderNodes() : []) {
      const c = o.userData.collider, key = JSON.stringify(c); seen.add(o);
      let h = this._colHelpers.get(o);
      if (!h || h.userData.key !== key) {
        if (h) { h.geometry.dispose(); this.overlay.remove(h); }
        const g = c.shape === 'sphere' ? new THREE.SphereGeometry(c.radius || Math.max(...c.size) / 2, 16, 10) : c.shape === 'capsule' ? new THREE.CapsuleGeometry(c.radius || c.size[0] / 2, Math.max(0, (c.height || c.size[1]) - 2 * (c.radius || c.size[0] / 2)), 6, 16) : new THREE.BoxGeometry(...c.size);
        h = new THREE.LineSegments(new THREE.WireframeGeometry(g), this._colMat ||= new THREE.LineBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.75 })); g.dispose();
        h.matrixAutoUpdate = false; h.userData.key = key; h.renderOrder = 6; this._colHelpers.set(o, h); this.overlay.add(h);
      }
      h.matrix.copy(o.matrixWorld); h.visible = true;
    }
    for (const [o, h] of this._colHelpers) if (!seen.has(o)) { this.overlay.remove(h); h.geometry.dispose(); this._colHelpers.delete(o); }
  }
  /** Colliders of the model: [{name, joint, shape, size, radius?, height?, center (world)}]. */
  colliders() { return this._colliderNodes().map(o => ({ name: o.name, joint: o.parent?.isBone ? o.parent.name : null, ...o.userData.collider, center: o.getWorldPosition(new THREE.Vector3()).toArray().map(v => Math.round(v * 1e4) / 1e4) })); }
  /** Add a collider to the model. opts: { shape: 'box'|'sphere'|'capsule', joint (bone name, default none), center: [x,y,z] world, size: [x,y,z] (box), radius, height }. */
  addCollider(name = 'collider', { shape = 'box', joint = null, center = [0, 0.9, 0], size = [0.5, 1.8, 0.4], radius, height } = {}) {
    if (!['box', 'sphere', 'capsule'].includes(shape)) throw new Error("Collider shape must be 'box', 'sphere' or 'capsule'");
    const parent = joint ? this.bone(joint) : this.root, o = new THREE.Object3D();
    let n = name, i = 2; while (this.root.getObjectByName(n)) n = `${name}_${i++}`; o.name = n;
    const c = { shape, size: size.map(Number) }; if (shape === 'sphere') c.radius = radius ?? Math.max(...c.size) / 2; if (shape === 'capsule') { c.radius = radius ?? Math.max(c.size[0], c.size[2]) / 2; c.height = height ?? c.size[1]; }
    o.userData.collider = c;
    this.root.updateMatrixWorld(true); parent.add(o); o.position.copy(parent.worldToLocal(new THREE.Vector3(...center)));
    this._pushUndo('Add collider', () => o.removeFromParent(), () => parent.add(o)); this.changed();
    return this.msg(`Added a ${shape} collider “${n}”${joint ? ` on ${joint}` : ''}`);
  }
  /** Change a collider: { shape, size, radius, height, center (world) }. */
  setCollider(name, props = {}) {
    const o = this._colliderNodes().find(x => x.name === name); if (!o) throw new Error(`No collider called “${name}”`);
    const before = { c: JSON.parse(JSON.stringify(o.userData.collider)), p: o.position.clone() };
    const c = o.userData.collider; for (const k of ['shape', 'size', 'radius', 'height']) if (props[k] !== undefined) c[k] = props[k];
    if (props.center) { this.root.updateMatrixWorld(true); o.position.copy(o.parent.worldToLocal(new THREE.Vector3(...props.center))); }
    const after = { c: JSON.parse(JSON.stringify(c)), p: o.position.clone() };
    this._pushUndo('Change collider', () => { o.userData.collider = JSON.parse(JSON.stringify(before.c)); o.position.copy(before.p); }, () => { o.userData.collider = JSON.parse(JSON.stringify(after.c)); o.position.copy(after.p); });
    this.changed(); return this.msg(`Changed collider ${name}`);
  }
  removeCollider(name) {
    const o = this._colliderNodes().find(x => x.name === name); if (!o) throw new Error(`No collider called “${name}”`);
    const parent = o.parent; o.removeFromParent(); this._pushUndo('Remove collider', () => parent.add(o), () => o.removeFromParent()); this.changed();
    return this.msg(`Removed collider ${name}`);
  }
  /** A capsule-ish T-pose dummy (1.8 units tall), useful for testing. */
  loadDummy() {
    this.clear(true); this.libRel = null;
    const parts = [];
    const cyl = (r1, r2, len, seg, x, y, z, rz = 0) => {
      const g = new THREE.CylinderGeometry(r1, r2, len, 14, seg, false);
      if (rz) g.rotateZ(rz); g.translate(x, y, z); parts.push(g);
    };
    const sph = (r, x, y, z) => { const g = new THREE.SphereGeometry(r, 16, 12); g.translate(x, y, z); parts.push(g); };
    for (const s of [1, -1]) {
      cyl(0.075, 0.06, 0.9, 12, 0.1 * s, 0.47, 0);          // leg
      sph(0.065, 0.1 * s, 0.03, 0.03);                         // foot
      cyl(0.055, 0.045, 0.72, 12, 0.53 * s, 1.45, 0, Math.PI / 2); // arm
      sph(0.05, 0.9 * s, 1.45, 0);                             // hand
    }
    cyl(0.15, 0.17, 0.62, 10, 0, 1.2, 0);   // torso
    cyl(0.05, 0.05, 0.12, 2, 0, 1.56, 0);   // neck
    sph(0.12, 0, 1.68, 0);                  // head
    const g = mergeGeometries(parts, false);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xc9b8a6, roughness: 0.7 }));
    mesh.name = 'Dummy'; makeEditable(g); this.root.add(mesh);
    this.fileName = 'dummy.glb';
    this._measure(); this.frame(); this.changed();
    return this.msg('Loaded test dummy');
  }
  _measure() {
    const b = new THREE.Box3().setFromObject(this.root);
    this.sceneSize = b.isEmpty() ? 2 : Math.max(b.getSize(v1).length(), 0.01);
  }
  async exportGLB() {
    const wasAnim = this.animMode, t = this.time;
    this.setAnimMode(false);
    this.root.updateMatrixWorld(true);
    this._framedMeshes().forEach(m => { // expression keys travel as plain data on the mesh: extras.frameKeys = {clip: [[t, frame], ...]}
      const fk = {}; for (const c of this.clips) { const keys = c.frames?.[m.name]; if (keys?.length) fk[c.name] = keys.slice().sort((a, b) => a.t - b.t).map(k => [Math.round(k.t * 1e4) / 1e4, k.frame]); }
      if (Object.keys(fk).length) m.userData.frameKeys = fk; else delete m.userData.frameKeys;
    });
    const animations = this.clips.map(toThreeClip);
    const result = await new GLTFExporter().parseAsync(this.root, { binary: true, animations, onlyVisible: false });
    if (wasAnim) { this.setAnimMode(true); this.setTime(t); }
    return result; // ArrayBuffer
  }
  async download(name = this.fileName) {
    const buf = await this.exportGLB();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
    a.download = name.endsWith('.glb') ? name : name + '.glb'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return this.msg('Downloaded ' + a.download);
  }
  /** Clothing layers of the model (meshes made from slot__set parts): [{name, layer, visible, triangles}] — every mesh if none are tagged. */
  layers() {
    const a = []; this.root.traverse(o => { if (o.isMesh) a.push({ name: o.name, layer: o.userData.layer || null, visible: o.visible, triangles: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 }); });
    return a;
  }
  /** Show / hide a layer mesh: its name ('hat__cap'), or a whole slot ('hat' = every hat__* set). Not saved as hidden: a .glb has no hidden flag, the game picks. */
  setLayer(nameOrSlot, visible = true) {
    const hit = []; this.root.traverse(o => { if (o.isMesh && (o.name === nameOrSlot || (o.userData.layer || '').startsWith(nameOrSlot + '__'))) { o.visible = !!visible; hit.push(o.name); } });
    if (!hit.length) throw new Error(`No layer called “${nameOrSlot}” (layers: ${this.layers().map(l => l.name).join(', ') || 'none'})`);
    this.sel.meshes = this.sel.meshes.filter(m => m.visible); this._syncGizmo(); this.changed();
    return this.msg(`${visible ? 'Showing' : 'Hiding'} ${hit.join(', ')}`);
  }
  /** Save ONE layer (e.g. 'hat__cap') with the shared skeleton as its own .glb, so new clothing can ship without re-exporting the body. */
  async saveLayer(layer, name = layer, dir) {
    const keep = []; this.root.traverse(o => { if (o.isMesh && o.name === layer) keep.push(o); });
    if (!keep.length) throw new Error(`No layer called “${layer}”`);
    const others = []; this.root.traverse(o => { if (o.isMesh && !keep.includes(o)) others.push({ o, parent: o.parent }); });
    const was = { fileName: this.fileName, libRel: this.libRel }, vis = keep.map(m => m.visible);
    others.forEach(x => x.parent.remove(x.o)); keep.forEach(m => { m.visible = true; });
    try { return await this.save(name, dir); }
    finally { others.forEach(x => x.parent.add(x.o)); keep.forEach((m, i) => { m.visible = vis[i]; }); Object.assign(this, was); this.changed(); }
  }
  /** Library folder save() uses when none is given: the open file's folder ('' = top). */
  _saveDir() { return this.libRel && this.libRel.includes('/') ? this.libRel.slice(0, this.libRel.lastIndexOf('/')) : ''; }
  /** Save into the model library. dir: library folder ('' = top). Overwrites a file of the same name. */
  async save(name = this.fileName, dir) {
    if (dir === undefined) dir = this._saveDir();
    if (!/\.glb$/i.test(name)) name += '.glb';
    const buf = await this.exportGLB();
    const res = await fetch(`/api/lib/file?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}&overwrite=1`, { method: 'PUT', body: buf });
    const out = await res.json();
    if (!res.ok) throw new Error('Save failed: ' + (out.error || res.status));
    this.fileName = name; this.libRel = out.rel; this._markSaved(); this.changed();
    this.dispatchEvent(new Event('library'));
    return this.msg(`Saved to Library/${out.rel} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
  }
  /** Every model in the library as library-relative paths. */
  async listFiles() {
    const tree = await (await fetch('/api/lib/list')).json(), out = [];
    (function walk(n) { n.files.forEach(f => out.push(f.rel)); n.dirs.forEach(walk); })(tree);
    return out;
  }

  // ================= modes / selection =================
  setMode(m) {
    if (!MODES.includes(m)) throw new Error('Mode must be one of ' + MODES.join(', '));
    if ((m === 'vertex' || m === 'edge' || m === 'draw' || m === 'build') && this.animMode) this.setAnimMode(false);
    this.mode = m;
    this.build?.setActive(m === 'build'); // Build mode (src/build.js) shows its own parts instead of the model
    if (m === 'vertex' || m === 'edge') { for (const mesh of this.meshes()) this._refreshWorld(mesh); }
    const pO = m === 'vertex' || m === 'edge';
    this.root.traverse(o => {
      if (!o.isMesh) return;
      for (const mat of [].concat(o.material)) { mat.polygonOffset = pO; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1; }
    });
    if (m === 'bone' || m === 'draw') this.gizmoMode = this.animMode ? 'rotate' : 'translate';
    this._setHover(null);
    this._syncGizmo(); this._updateMeshOverlays(); this.changed();
    return this.msg('Mode: ' + m);
  }
  setGizmo(mode) { this.gizmoMode = mode; this._syncGizmo(); this.changed(); }
  setXray(on) { this.xray = on; this._updateMeshOverlays(); this.changed(); }
  /** Point size in pixels (3..30). The click area grows with it. */
  setPointSize(px) {
    this.pointSize = THREE.MathUtils.clamp(Math.round(px), 3, 30);
    this._ptMat.size = this.pointSize; this._hoverPt.material.size = this.pointSize + 7;
    this.changed(); return this.pointSize;
  }
  /** How far (pixels) from a point a click may land and still pick it. */
  get pickRadius() { return Math.max(20, this.pointSize * 1.8); }

  /**
   * Which points the camera can actually see (not hidden behind the model). Renders the model's depth once
   * per view and compares each point with it, so it stays fast on big models. Cached until the view or the
   * points change. Returns { maps: Map(mesh -> Uint8Array visible) }.
   */
  _visibility() {
    const cam = this.camera, r = this.renderer, w = this.dom.width, h = this.dom.height;
    cam.updateMatrixWorld();
    const key = cam.matrixWorld.elements.join(',') + cam.projectionMatrix.elements.join(',') + `|${this._geoVer}|${w}x${h}|${this.time}|${this.animMode}`;
    if (this._vis && this._vis.key === key) return this._vis;
    if (!this._depthRT || this._depthRT.width !== w || this._depthRT.height !== h) { this._depthRT?.dispose(); this._depthRT = new THREE.WebGLRenderTarget(w, h); }
    const hide = [this.overlay, this.grid, this.gizmo, this.pivot], was = hide.map(o => o.visible);
    hide.forEach(o => { o.visible = false; });
    const bg = this.scene.background, prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    this.scene.background = null; this.scene.overrideMaterial = this._depthMat;
    r.setRenderTarget(this._depthRT); r.setClearColor(0xffffff, 1); r.clear(); r.render(this.scene, cam);
    const buf = new Uint8Array(w * h * 4); r.readRenderTargetPixels(this._depthRT, 0, 0, w, h, buf);
    r.setRenderTarget(null); r.setClearColor(prevClear, prevAlpha);
    this.scene.overrideMaterial = null; this.scene.background = bg; hide.forEach((o, i) => { o.visible = was[i]; });
    // depth (0..1, three r160 RGBA packing) -> distance in front of the camera
    const near = cam.near, far = cam.far, dist = d => (near * far) / (far - (far - near) * d);
    const depthAt = (px, py) => {
      if (px < 0 || py < 0 || px >= w || py >= h) return 1;
      const o = (py * w + px) * 4;
      return (255 / 256) * (buf[o] / 255 / 16777216 + buf[o + 1] / 255 / 65536 + buf[o + 2] / 255 / 256 + buf[o + 3] / 255);
    };
    const tol = this.sceneSize * 0.004, maps = new Map(), scr = new Map(), p = new THREE.Vector3(), q = new THREE.Vector3();
    const cw = this.dom.clientWidth, ch = this.dom.clientHeight;
    for (const mesh of this.meshes()) {
      const t = this.topo(mesh), P = t.points.length, vis = new Uint8Array(P), sp = new Float32Array(P * 3).fill(NaN);
      for (let i = 0; i < P; i++) {
        p.fromArray(t.world, i * 3); const camDist = -q.copy(p).applyMatrix4(cam.matrixWorldInverse).z;
        p.project(cam); if (p.z > 1 || p.z < -1) continue;
        sp[i * 3] = (p.x + 1) / 2 * cw; sp[i * 3 + 1] = (1 - p.y) / 2 * ch; sp[i * 3 + 2] = camDist;
        const px = Math.round((p.x + 1) / 2 * w), py = Math.round((p.y + 1) / 2 * h);
        let far2 = 0; // farthest surface in a 3x3 pixel neighbourhood: lenient at the outline
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) far2 = Math.max(far2, depthAt(px + dx, py + dy));
        vis[i] = far2 >= 0.999999 || camDist <= dist(far2) + tol ? 1 : 0;
      }
      maps.set(mesh, vis); scr.set(mesh, sp);
    }
    return (this._vis = { key, maps, scr });
  }
  /** Point the hover highlight at a point ({mesh,pid}), an edge ({mesh,key}) or nothing. */
  _setHover(h) {
    this._hover = h;
    this._hoverPt.visible = this._hoverLine.visible = false;
    if (!h) return;
    const t = this.topo(h.mesh);
    if (h.pid !== undefined) {
      this._hoverPt.geometry.attributes.position.array.set(t.world.subarray(h.pid * 3, h.pid * 3 + 3));
      this._hoverPt.geometry.attributes.position.needsUpdate = true; this._hoverPt.visible = true;
    } else {
      const P = t.points.length, a = Math.floor(h.key / P), b = h.key % P, arr = this._hoverLine.geometry.attributes.position.array;
      arr.set(t.world.subarray(a * 3, a * 3 + 3), 0); arr.set(t.world.subarray(b * 3, b * 3 + 3), 3);
      this._hoverLine.geometry.attributes.position.needsUpdate = true; this._hoverLine.visible = true;
    }
  }
  _updateHover() {
    this._hoverQueued = false;
    const m = this._mxy, busy = this._down || this._drag;
    if (!m || busy || (this.mode !== 'vertex' && this.mode !== 'edge')) return this._setHover(null);
    this._setHover(this.mode === 'vertex' ? this.pickPoint(m.x, m.y) : this.pickEdge(m.x, m.y));
  }

  clearSelection() {
    if (this.mode === 'object') this.sel.meshes = [];
    else if (this.mode === 'bone' || this.mode === 'draw') this.sel.bones = [];
    else this._clearPointSel();
    this._syncGizmo(); this._updateMeshOverlays(); this.changed();
  }
  _clearPointSel() { this.sel.pts = new Map(); this.sel.edges = new Map(); this.sel.activePt = this.sel.activeEdge = null; this._updateMeshOverlays(); }
  selectBones(list, add = false) {
    const bones = [].concat(list).map(x => this.bone(x));
    if (!add) this.sel.bones = [];
    for (const b of bones) { this.sel.bones = this.sel.bones.filter(x => x !== b); this.sel.bones.push(b); }
    this._syncGizmo(); this.changed();
  }
  selectMeshes(list, add = false) {
    const ms = [].concat(list).map(x => this.mesh(x));
    if (!add) this.sel.meshes = [];
    for (const m of ms) if (!this.sel.meshes.includes(m)) this.sel.meshes.push(m);
    this._syncGizmo(); this.changed();
  }
  /** Select points (vertex groups) of a mesh by point id. */
  selectPoints(meshName, pids, add = false) {
    const mesh = this.mesh(meshName);
    if (!add) this._clearPointSel();
    const set = this.sel.pts.get(mesh) || new Set(); this.sel.pts.set(mesh, set);
    for (const p of pids) set.add(p);
    if (pids.length) this.sel.activePt = { mesh, pid: pids[pids.length - 1] };
    this._syncGizmo(); this._updateMeshOverlays(); this.changed();
    return set.size;
  }
  /** Return point ids within `radius` of world point `p` (optionally limited to one mesh). */
  findPoints(p, radius, meshName) {
    const out = [];
    const c = new THREE.Vector3().fromArray(p), r2 = radius * radius;
    for (const mesh of meshName ? [this.mesh(meshName)] : this.meshes()) {
      const t = this._refreshWorld(mesh), w = t.world, pids = [];
      for (let i = 0; i < t.points.length; i++) {
        const dx = w[i * 3] - c.x, dy = w[i * 3 + 1] - c.y, dz = w[i * 3 + 2] - c.z;
        if (dx * dx + dy * dy + dz * dz <= r2) pids.push(i);
      }
      if (pids.length) out.push({ mesh: mesh.name, pids });
    }
    return out;
  }
  selectPointsNear(p, radius, add = false) {
    if (!add) this._clearPointSel();
    for (const { mesh, pids } of this.findPoints(p, radius)) this.selectPoints(mesh, pids, true);
    return this.selectedPointCount();
  }
  selectAll() {
    if (this.mode === 'bone' || this.mode === 'draw') this.sel.bones = this.allBones();
    else if (this.mode === 'object') this.sel.meshes = this.meshes();
    else if (this.mode === 'vertex') for (const m of this.meshes()) this.sel.pts.set(m, new Set(this.topo(m).points.keys()));
    else for (const m of this.meshes()) { const t = this.topo(m), P = t.points.length, s = new Set(); for (let i = 0; i < t.edges.length; i += 2) s.add(t.edges[i] * P + t.edges[i + 1]); this.sel.edges.set(m, s); }
    this._syncGizmo(); this._updateMeshOverlays(); this.changed();
  }
  /** Map<mesh, Set<pid>> of the currently selected points (edges are expanded to their endpoints). */
  selectedPoints() {
    if (this.mode !== 'edge') return this.sel.pts;
    const out = new Map();
    for (const [mesh, keys] of this.sel.edges) {
      const P = this.topo(mesh).points.length, s = new Set();
      for (const k of keys) { s.add(Math.floor(k / P)); s.add(k % P); }
      out.set(mesh, s);
    }
    return out;
  }
  selectedPointCount() { let n = 0; for (const s of this.selectedPoints().values()) n += s.size; return n; }

  // ================= topology =================
  _det(g) { let s = this._detached.get(g); if (!s) { s = new Set(); this._detached.set(g, s); } return s; }
  _invalidateTopo(mesh) {
    this._geoVer++;
    const list = mesh ? [mesh] : [...this._ovl.keys()];
    if (!mesh) this._topo = new WeakMap(); else this._topo.delete(mesh);
    for (const m of list) { const o = this._ovl.get(m); if (o) { o.points.removeFromParent(); o.wire.removeFromParent(); o.points.geometry.dispose(); o.wire.geometry.dispose(); this._ovl.delete(m); } }
    this._updateMeshOverlays();
  }
  /** Points = vertices welded by position (so UV/normal seams move together). */
  topo(mesh) {
    let t = this._topo.get(mesh);
    if (t && t.geometry === mesh.geometry) return t;
    const g = mesh.geometry; makeEditable(g);
    const pos = g.attributes.position, n = pos.count, a = pos.array;
    g.computeBoundingBox();
    const eps = Math.max(g.boundingBox.getSize(v1).length() * 1e-6, 1e-9);
    const det = this._det(g), map = new Map(), pointOf = new Int32Array(n).fill(-1), points = [];
    let used = null; // vertices that belong to at least one face (others are never shown or picked)
    if (g.index) { used = new Uint8Array(n); const ia = g.index.array; for (let i = 0; i < ia.length; i++) used[ia[i]] = 1; }
    for (let i = 0; i < n; i++) {
      if (used && !used[i]) continue;
      let pid;
      if (det.has(i)) pid = points.length;
      else {
        const key = Math.round(a[i * 3] / eps) + ',' + Math.round(a[i * 3 + 1] / eps) + ',' + Math.round(a[i * 3 + 2] / eps);
        pid = map.get(key);
        if (pid === undefined) { pid = points.length; map.set(key, pid); }
      }
      if (pid === points.length) points.push([]);
      points[pid].push(i); pointOf[i] = pid;
    }
    const P = points.length, idx = g.index, triCount = idx ? idx.count / 3 : n / 3;
    const corner = idx ? c => idx.getX(c) : c => c;
    const seen = new Set(), edges = [];
    const add = (p, q) => { if (p === q) return; if (p > q) [p, q] = [q, p]; const k = p * P + q; if (!seen.has(k)) { seen.add(k); edges.push(p, q); } };
    // vertex -> faces (CSR) for normal updates
    const vfCount = new Uint32Array(n + 1);
    for (let f = 0; f < triCount; f++) for (let k = 0; k < 3; k++) vfCount[corner(f * 3 + k) + 1]++;
    for (let i = 0; i < n; i++) vfCount[i + 1] += vfCount[i];
    const vf = new Uint32Array(triCount * 3), fill = vfCount.slice(0, n);
    for (let f = 0; f < triCount; f++) {
      const i0 = corner(f * 3), i1 = corner(f * 3 + 1), i2 = corner(f * 3 + 2);
      add(pointOf[i0], pointOf[i1]); add(pointOf[i1], pointOf[i2]); add(pointOf[i2], pointOf[i0]);
      vf[fill[i0]++] = f; vf[fill[i1]++] = f; vf[fill[i2]++] = f;
    }
    t = { geometry: g, pointOf, points, edges: Uint32Array.from(edges), world: new Float32Array(P * 3), vf, vfOff: vfCount, corner, triCount };
    this._topo.set(mesh, t);
    this._refreshWorld(mesh, t);
    return t;
  }
  _vertexWorld(mesh, i, target) { return mesh.getVertexPosition(i, target).applyMatrix4(mesh.matrixWorld); }
  _refreshWorld(mesh, t = this.topo(mesh), pids) {
    mesh.updateWorldMatrix(true, false);
    if (mesh.isSkinnedMesh) { mesh.skeleton.bones.forEach(b => b.updateWorldMatrix(true, false)); mesh.skeleton.update(); }
    const list = pids || t.points.keys();
    for (const pid of list) { this._vertexWorld(mesh, t.points[pid][0], v1); t.world[pid * 3] = v1.x; t.world[pid * 3 + 1] = v1.y; t.world[pid * 3 + 2] = v1.z; }
    const o = this._ovl.get(mesh); if (o) { o.points.geometry.attributes.position.needsUpdate = true; o.wire.geometry.attributes.position.needsUpdate = true; }
    return t;
  }
  /** inverse of (matrixWorld * skinMatrix) for one vertex: world -> geometry space */
  _vertexInv(mesh, i, out) {
    out.identity();
    if (mesh.isSkinnedMesh) {
      const g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, bm = mesh.skeleton.boneMatrices;
      const e = _invScratch.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = sw[GETS[k]](i); if (!w) continue;
        const j = si[GETS[k]](i);
        for (let q = 0; q < 16; q++) e[q] += w * bm[j * 16 + q];
      }
      out.fromArray(e).premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
    }
    return out.premultiply(mesh.matrixWorld).invert();
  }
  /** Set world positions of points: list of [pid, Vector3]. */
  _setPointsWorld(mesh, list) {
    this._geoVer++;
    const t = this.topo(mesh), pos = mesh.geometry.attributes.position, M = new THREE.Matrix4(), l = new THREE.Vector3();
    for (const [pid, w] of list) {
      for (const i of t.points[pid]) { this._vertexInv(mesh, i, M); l.copy(w).applyMatrix4(M); pos.setXYZ(i, l.x, l.y, l.z); }
      t.world[pid * 3] = w.x; t.world[pid * 3 + 1] = w.y; t.world[pid * 3 + 2] = w.z;
    }
    pos.needsUpdate = true;
    const o = this._ovl.get(mesh); if (o) { o.points.geometry.attributes.position.needsUpdate = true; o.wire.geometry.attributes.position.needsUpdate = true; }
  }
  /** Recompute normals around changed points (keeps hard edges / UV seams intact). */
  _finishGeometry(mesh, pids) {
    const g = mesh.geometry, t = this.topo(mesh), nrm = g.attributes.normal, pos = g.attributes.position;
    if (nrm && t.triCount) {
      let pts;
      if (!pids) pts = t.points.keys();
      else { // changed points + neighbours sharing a face
        const s = new Set();
        for (const pid of pids) for (const i of t.points[pid]) for (let k = t.vfOff[i]; k < t.vfOff[i + 1]; k++) {
          const f = t.vf[k]; for (let c = 0; c < 3; c++) s.add(t.pointOf[t.corner(f * 3 + c)]);
        }
        pts = s;
      }
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3(), sum = new THREE.Vector3();
      const faceN = f => {
        a.fromBufferAttribute(pos, t.corner(f * 3)); b.fromBufferAttribute(pos, t.corner(f * 3 + 1)); c.fromBufferAttribute(pos, t.corner(f * 3 + 2));
        return fn.subVectors(c, b).cross(v1.subVectors(a, b));
      };
      for (const pid of pts) {
        const mem = t.points[pid];
        let smooth = true; // were the members' normals the same (a smooth seam) or different (a hard edge)?
        v2.fromBufferAttribute(nrm, mem[0]);
        for (const i of mem) if (v3.fromBufferAttribute(nrm, i).dot(v2) < 0.95) { smooth = false; break; }
        const vn = mem.map(i => { const n = new THREE.Vector3(); for (let k = t.vfOff[i]; k < t.vfOff[i + 1]; k++) n.add(faceN(t.vf[k])); return n; });
        if (smooth) { sum.set(0, 0, 0); vn.forEach(n => sum.add(n)); sum.normalize(); mem.forEach(i => nrm.setXYZ(i, sum.x, sum.y, sum.z)); }
        else mem.forEach((i, j) => { vn[j].normalize(); nrm.setXYZ(i, vn[j].x, vn[j].y, vn[j].z); });
      }
      nrm.needsUpdate = true;
    }
    pos.needsUpdate = true;
    g.computeBoundingBox(); g.computeBoundingSphere();
    if (mesh.isSkinnedMesh) { mesh.boundingBox = null; mesh.boundingSphere = null; }
  }

  // ================= overlays =================
  _updateMeshOverlays() {
    const showPts = this.mode === 'vertex', showWire = this.mode === 'vertex' || this.mode === 'edge';
    const meshes = showWire ? this.meshes() : [];
    for (const [m, o] of this._ovl) if (!meshes.includes(m)) { o.points.visible = o.wire.visible = false; }
    this._ptMat.depthTest = this._wireMat.depthTest = !this.xray;
    const selPts = this.selectedPoints();
    for (const mesh of meshes) {
      const t = this.topo(mesh);
      let o = this._ovl.get(mesh);
      if (!o) {
        const pg = new THREE.BufferGeometry();
        const wattr = new THREE.BufferAttribute(t.world, 3);
        pg.setAttribute('position', wattr);
        pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(t.points.length * 3), 3));
        const points = new THREE.Points(pg, this._ptMat);
        const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.BufferAttribute(t.world, 3)); wg.setIndex(new THREE.BufferAttribute(t.edges, 1));
        const wire = new THREE.LineSegments(wg, this._wireMat);
        points.frustumCulled = wire.frustumCulled = false; points.renderOrder = 4; wire.renderOrder = 3;
        this.overlay.add(points, wire);
        o = { points, wire }; this._ovl.set(mesh, o);
      }
      o.points.visible = showPts; o.wire.visible = true;
      const col = o.points.geometry.attributes.color, sel = selPts.get(mesh);
      const hid = this.xray && showPts ? this._visibility().maps.get(mesh) : null; // X-ray: points behind the model look dimmer
      for (let i = 0; i < t.points.length; i++) (hid && !hid[i] ? C.pointHidden : C.point).toArray(col.array, i * 3);
      const pv = this.preview?.get(mesh); if (pv) for (const [p, c] of pv) c.toArray(col.array, p * 3);
      if (sel) for (const p of sel) C.pointSel.toArray(col.array, p * 3);
      const ap = this.sel.activePt; if (ap && ap.mesh === mesh && this.mode === 'vertex') C.pointActive.toArray(col.array, ap.pid * 3);
      col.needsUpdate = true;
    }
    this._updateSelWire();
  }
  _updateSelWire() {
    const segs = [];
    if (this.mode === 'edge') for (const [mesh, keys] of this.sel.edges) {
      const t = this.topo(mesh), P = t.points.length, w = t.world;
      for (const k of keys) { const a = Math.floor(k / P), b = k % P; segs.push(w[a * 3], w[a * 3 + 1], w[a * 3 + 2], w[b * 3], w[b * 3 + 1], w[b * 3 + 2]); }
    }
    this._selWire.geometry.dispose(); this._selWire.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    this._selWireMat.depthTest = !this.xray;
  }
  _initBoneOverlay() {
    this._boneCap = 0; this._stickCap = 0;
    this._jointGeo = new THREE.SphereGeometry(1, 12, 8);
    this._stickGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0);
    this._jointMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 });
    this._stickMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.75 });
  }
  _updateBoneOverlay() {
    const bones = this.allBones();
    let sticks = 0; for (const b of bones) for (const c of b.children) if (c.isBone) sticks++;
    if (!this._joints || bones.length > this._boneCap || sticks > this._stickCap) {
      for (const o of [this._joints, this._sticks]) { o?.removeFromParent(); o?.dispose(); }
      this._boneCap = Math.max(64, bones.length * 2); this._stickCap = this._boneCap * 2;
      this._joints = new THREE.InstancedMesh(this._jointGeo, this._jointMat, this._boneCap);
      this._sticks = new THREE.InstancedMesh(this._stickGeo, this._stickMat, this._stickCap);
      this._joints.renderOrder = 11; this._sticks.renderOrder = 10;
      this._joints.frustumCulled = this._sticks.frustumCulled = false;
      this.overlay.add(this._joints, this._sticks);
    }
    const show = this.showBones || this.mode === 'bone' || this.mode === 'draw';
    this._joints.visible = this._sticks.visible = show;
    if (!show) return;
    const rJ = this.sceneSize * 0.009, rS = this.sceneSize * 0.0035;
    const selSet = new Set(this.sel.bones), act = this.activeBone, q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(), dir = new THREE.Vector3();
    let si = 0;
    bones.forEach((b, i) => {
      b.getWorldPosition(v1);
      m1.compose(v1, q.identity(), s.setScalar(b === act ? rJ * 1.4 : rJ));
      this._joints.setMatrixAt(i, m1);
      this._joints.setColorAt(i, b === act ? C.jointActive : selSet.has(b) ? C.jointSel : C.joint);
      for (const c of b.children) {
        if (!c.isBone) continue;
        c.getWorldPosition(v2); dir.subVectors(v2, v1); const len = dir.length();
        q.setFromUnitVectors(up, len > 1e-9 ? dir.divideScalar(len) : up);
        m1.compose(v1, q, s.set(rS, len, rS));
        this._sticks.setMatrixAt(si, m1);
        this._sticks.setColorAt(si, selSet.has(b) ? C.jointSel : C.joint); si++;
      }
    });
    this._joints.count = bones.length; this._sticks.count = si;
    this._joints.instanceMatrix.needsUpdate = this._sticks.instanceMatrix.needsUpdate = true;
    if (this._joints.instanceColor) this._joints.instanceColor.needsUpdate = true;
    if (this._sticks.instanceColor) this._sticks.instanceColor.needsUpdate = true;
  }
  _updateBoxHelpers() {
    const want = this.mode === 'object' ? this.sel.meshes : [];
    while (this._boxHelpers.length > want.length) { const h = this._boxHelpers.pop(); h.removeFromParent(); h.geometry.dispose(); h.material.dispose(); }
    want.forEach((m, i) => {
      if (!this._boxHelpers[i]) { const h = new THREE.BoxHelper(m, 0xff8c1a); this.overlay.add(h); this._boxHelpers[i] = h; }
      this._boxHelpers[i].setFromObject(m);
    });
  }

  // ================= gizmo =================
  _syncGizmo() {
    const g = this.gizmo;
    let target = null;
    if (this.mode === 'object') target = this.sel.meshes[this.sel.meshes.length - 1] || null;
    else if (this.mode === 'bone' || this.mode === 'draw') target = this.activeBone;
    else if (this.mode === 'paint' || this.mode === 'build') target = null;
    else if (this.selectedPointCount()) {
      const c = new THREE.Vector3(); let n = 0;
      for (const [mesh, s] of this.selectedPoints()) { const w = this.topo(mesh).world; for (const p of s) { c.x += w[p * 3]; c.y += w[p * 3 + 1]; c.z += w[p * 3 + 2]; n++; } }
      this.pivot.position.copy(c.divideScalar(n)); this.pivot.quaternion.identity(); this.pivot.scale.set(1, 1, 1);
      this.pivot.updateMatrixWorld(); target = this.pivot;
    }
    if (target) { if (g.object !== target) g.attach(target); } else g.detach();
    g.setMode(this.gizmoMode);
    g.setSpace((this.mode === 'bone' || this.mode === 'draw') && this.gizmoMode === 'rotate' ? 'local' : 'world');
  }
  _dragStart() {
    const o = this.gizmo.object; if (!o) return;
    if (o === this.pivot) {
      this.pivot.updateMatrixWorld();
      const meshes = [...this.selectedPoints().keys()];
      this._drag = { kind: 'pts', before: this._snap({ pos: meshes }), start: this.pivot.matrixWorld.clone(), items: [] };
      for (const [mesh, s] of this.selectedPoints()) {
        const t = this.topo(mesh);
        for (const pid of s) this._drag.items.push({ mesh, pid, w: new THREE.Vector3().fromArray(t.world, pid * 3) });
      }
      const c = this.pivot.position; // the point you "hold" = the picked point nearest the gizmo
      this._drag.lead = this._drag.items.reduce((a, b) => (b.w.distanceToSquared(c) < a.w.distanceToSquared(c) ? b : a), this._drag.items[0]);
    } else if (o.isBone) {
      this._drag = { kind: 'bone', bone: o, before: this._snap({ rig: true, anim: true }) };
      if (!this.animMode) {
        this._drag.rest = this._beginRestEdit();
        if (!this.childrenFollow) this._drag.kids = o.children.filter(c => c.isBone).map(c => ({ c, m: c.matrixWorld.clone() }));
      }
    } else this._drag = { kind: 'obj', before: this._snap({ objs: [o] }), o };
  }
  _dragChange() {
    const d = this._drag; if (!d) return;
    if (d.kind === 'pts') {
      this.pivot.updateMatrixWorld();
      const T = new THREE.Matrix4().multiplyMatrices(this.pivot.matrixWorld, new THREE.Matrix4().copy(d.start).invert());
      // Snap & merge: the held point jumps onto the nearest other point under the cursor
      d.snap = this.snapping ? this._snapTarget(d) : null;
      const delta = d.snap ? d.snap.w.clone().sub(d.lead.w) : null;
      const byMesh = new Map();
      for (const it of d.items) { let l = byMesh.get(it.mesh); if (!l) byMesh.set(it.mesh, l = []); l.push([it.pid, delta ? it.w.clone().add(delta) : it.w.clone().applyMatrix4(T)]); }
      for (const [mesh, l] of byMesh) this._setPointsWorld(mesh, l);
      this._showSnapMarker(d.snap);
      this._updateSelWire();
    } else if (d.kind === 'bone') {
      const sl = this.animMode && this._slideOf(d.bone);
      if (sl) {
        const rest = new THREE.Vector3().fromArray(sl.rest), ax = new THREE.Vector3().fromArray(sl.axis);
        const off = THREE.MathUtils.clamp(d.bone.position.clone().sub(rest).dot(ax), sl.min, sl.max);
        d.bone.position.copy(rest).addScaledVector(ax, off); if (sl.restQ) d.bone.quaternion.fromArray(sl.restQ); else { d.slideQ ||= d.bone.quaternion.clone(); d.bone.quaternion.copy(d.slideQ); } // never turns
      }
      if (d.kids) { d.bone.updateMatrixWorld(true); for (const k of d.kids) this._setWorldMatrix(k.c, k.m); }
      if (d.rest) this._applyRestEdit(d.rest);
    }
  }
  _dragEnd() {
    const d = this._drag; this._drag = null; if (!d) return;
    if (d.kind === 'pts') {
      this._showSnapMarker(null);
      const meshes = [...new Set(d.items.map(i => i.mesh))];
      let merged = 0;
      if (d.snap) merged = this._weldAfterSnap(d);
      else for (const mesh of meshes) this._finishGeometry(mesh, d.items.filter(i => i.mesh === mesh).map(i => i.pid));
      const after = this._snap({ pos: meshes });
      this._pushUndo(merged ? 'Snap & merge' : 'Move points', () => this._restore(d.before), () => this._restore(after));
      if (merged) { this._clearPointSel(); this._syncGizmo(); this.msg(`Merged ${merged} point${merged > 1 ? 's' : ''} — the faces stretch to follow`); }
    } else if (d.kind === 'bone') {
      if (this.animMode && this.autoKey) this._keyInternal([d.bone], [this._slideOf(d.bone) ? 'position' : { translate: 'position', rotate: 'quaternion', scale: 'scale' }[this.gizmoMode]]);
      if (!this.animMode && this._slideOf(d.bone)) d.bone.userData.slide.rest = d.bone.position.toArray(); // moved in Edit mode: the rail moves with it
      const after = this._snap({ rig: true, anim: true });
      this._pushUndo(this.animMode ? 'Pose bone' : 'Move joint', () => this._restore(d.before), () => this._restore(after));
    } else {
      const after = this._snap({ objs: [d.o] });
      this._pushUndo('Move object', () => this._restore(d.before), () => this._restore(after));
    }
    this.changed();
  }
  _setWorldMatrix(o, m) {
    o.parent.updateWorldMatrix(true, false);
    m1.copy(o.parent.matrixWorld).invert().multiply(m);
    m1.decompose(o.position, o.quaternion, o.scale); o.updateMatrixWorld(true);
  }
  get snapping() { return this.snapMerge || this.snapHeld; }
  /** Nearest point (not being dragged) to the mouse cursor, within 22 px. */
  _snapTarget(d) {
    if (!this._mxy) return null;
    const skip = new Map(); for (const it of d.items) { let s = skip.get(it.mesh); if (!s) skip.set(it.mesh, s = new Set()); s.add(it.pid); }
    let best = null, bd = 22;
    for (const mesh of this.meshes()) {
      const t = this.topo(mesh), sk = skip.get(mesh);
      for (let p = 0; p < t.points.length; p++) {
        if (sk && sk.has(p)) continue;
        const sc = this.toScreen(v1.fromArray(t.world, p * 3)); if (sc.behind) continue;
        const dd = Math.hypot(sc.x - this._mxy.x, sc.y - this._mxy.y);
        if (dd < bd) { bd = dd; best = { mesh, pid: p, w: new THREE.Vector3().fromArray(t.world, p * 3) }; }
      }
    }
    return best;
  }
  _showSnapMarker(snap) {
    const mk = this._snapMarker; mk.visible = !!snap; if (!snap) return;
    mk.position.copy(snap.w); mk.quaternion.copy(this.camera.quaternion);
    mk.scale.setScalar(snap.w.distanceTo(this.camera.position) * 0.018);
  }
  /** After a snapped drop: make the held point (and any other dragged point that landed on a point) one point. */
  _weldAfterSnap(d) {
    const pairs = [{ it: d.lead, target: d.snap }];
    const tol = this.sceneSize * 0.002, delta = d.snap.w.clone().sub(d.lead.w);
    for (const it of d.items) { // e.g. dragging an edge onto an edge: the other end lands too
      if (it === d.lead) continue;
      const p = it.w.clone().add(delta), t = this.topo(it.mesh), mine = new Set(d.items.filter(i => i.mesh === it.mesh).map(i => i.pid));
      let best = null, bd = tol;
      for (let q = 0; q < t.points.length; q++) { if (mine.has(q)) continue; const dd = p.distanceTo(v1.fromArray(t.world, q * 3)); if (dd < bd) { bd = dd; best = { mesh: it.mesh, pid: q, w: v1.clone() }; } }
      if (best) pairs.push({ it, target: best });
    }
    for (const { it, target } of pairs) {
      const t = this.topo(it.mesh), det = this._det(it.mesh.geometry), pos = it.mesh.geometry.attributes.position;
      if (target.mesh === it.mesh) {
        const tv = t.points[target.pid][0]; // copy the exact stored position so they group as one point
        for (const v of t.points[it.pid]) pos.setXYZ(v, pos.getX(tv), pos.getY(tv), pos.getZ(tv));
        for (const v of [...t.points[it.pid], ...t.points[target.pid]]) det.delete(v);
      } else this._setPointsWorld(it.mesh, [[it.pid, target.w]]); // different part: line them up exactly
      pos.needsUpdate = true;
    }
    for (const mesh of new Set(d.items.map(i => i.mesh))) {
      this._invalidateTopo(mesh);
      this._finishGeometry(mesh, null); // re-shade the part so the stretched faces look right
    }
    return pairs.length;
  }
  /** Rest edits: keep skinned meshes still while joints move (recompute inverse bind matrices). */
  _beginRestEdit() {
    this.root.updateMatrixWorld(true);
    return this.skeletons().map(sk => ({ sk, w: sk.bones.map(b => b.matrixWorld.clone()), inv: sk.boneInverses.map(m => m.clone()) }));
  }
  _applyRestEdit(rest) {
    this.root.updateMatrixWorld(true);
    for (const { sk, w, inv } of rest) sk.bones.forEach((b, i) => {
      sk.boneInverses[i].copy(b.matrixWorld).invert().multiply(w[i]).multiply(inv[i]);
    });
  }

  // ================= pointer / picking =================
  _initPointer() {
    const el = this.dom;
    this._box = document.createElement('div'); this._box.className = 'selbox'; this.container.appendChild(this._box);
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerleave', () => { this._mxy = null; this._setHover(null); });
    el.addEventListener('pointerdown', e => {
      if (this.viewOnly) return; // a Claude session's tab you have not taken over: look only
      const r = el.getBoundingClientRect();
      const gizmo = (this.gizmo.axis !== null && !!this.gizmo.object) || !!this.build?.gizmoActive();
      this._down = { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, gizmo, box: false };
      const leftOrbits = this.mouse.rotate === 'left' || this.mouse.pan === 'left';
      if (e.button === 0 && !gizmo && (!leftOrbits || e.ctrlKey || e.metaKey) && ['vertex', 'edge', 'bone', 'build'].includes(this.mode)) {
        this._down.box = true; if (leftOrbits) this.orbit.enabled = false;
      }
    });
    el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      this._mxy = { x, y };
      if (!this._hoverQueued) { this._hoverQueued = true; requestAnimationFrame(() => this._updateHover()); }
      const d = this._down; if (!d || !d.box) return;
      if (!d.boxing && Math.hypot(x - d.x, y - d.y) < 5) return;
      d.boxing = true;
      Object.assign(this._box.style, { display: 'block', left: Math.min(x, d.x) + 'px', top: Math.min(y, d.y) + 'px', width: Math.abs(x - d.x) + 'px', height: Math.abs(y - d.y) + 'px' });
    });
    el.addEventListener('pointerup', e => {
      const d = this._down; this._down = null; if (!d) return;
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (d.box && d.boxing) { this._box.style.display = 'none'; this.orbit.enabled = true; this.boxSelect(Math.min(x, d.x), Math.min(y, d.y), Math.max(x, d.x), Math.max(y, d.y), e.shiftKey); return; }
      if (d.gizmo || Math.hypot(x - d.x, y - d.y) > 4) return;
      this.clickAt(x, y, { shift: e.shiftKey, button: d.button });
    });
  }
  _ray(x, y) {
    this.raycaster.setFromCamera({ x: x / this.dom.clientWidth * 2 - 1, y: -(y / this.dom.clientHeight) * 2 + 1 }, this.camera);
    return this.raycaster;
  }
  _hit(x, y) { return this._ray(x, y).intersectObjects(this.meshes(), false)[0] || null; }
  /** Simulate a viewport click at canvas pixel (x, y). */
  clickAt(x, y, { shift = false, button = 0 } = {}) {
    const m = this.mode;
    if (m === 'build') return this.build?.click(x, y, { shift, button });
    if (m === 'object') {
      const h = this._hit(x, y);
      if (h) { if (shift && this.sel.meshes.includes(h.object)) this.sel.meshes = this.sel.meshes.filter(o => o !== h.object); else this.selectMeshes(h.object, shift); }
      else if (!shift) this.sel.meshes = [];
    } else if (m === 'bone') {
      const b = this.pickBone(x, y);
      if (b) { if (shift && this.sel.bones.includes(b) && b === this.activeBone) this.sel.bones = this.sel.bones.filter(o => o !== b); else this.selectBones(b, shift); }
      else if (!shift) this.sel.bones = [];
    } else if (m === 'draw') {
      if (button === 2) { this.sel.bones = []; this.msg('Chain ended — next click starts a new chain'); }
      else {
        const b = this.pickBone(x, y, 12, false);
        if (b) this.selectBones(b);
        else { const p = this._drawPoint(x, y); this.addBone(null, this.activeBone, p.toArray()); }
      }
    } else if (m === 'vertex') {
      const p = this.pickPoint(x, y);
      if (p) {
        const s = this.sel.pts.get(p.mesh);
        if (shift && s && s.has(p.pid)) s.delete(p.pid); else this.selectPoints(p.mesh, [p.pid], shift);
      } else if (!shift) this._clearPointSel();
    } else if (m === 'edge') {
      const e = this.pickEdge(x, y);
      if (e) {
        if (!shift) this.sel.edges = new Map();
        let s = this.sel.edges.get(e.mesh); if (!s) this.sel.edges.set(e.mesh, s = new Set());
        if (shift && s.has(e.key)) s.delete(e.key); else { s.add(e.key); this.sel.activeEdge = e; }
      } else if (!shift) this._clearPointSel();
    }
    this._syncGizmo(); this._updateMeshOverlays(); this.changed();
  }
  pickBone(x, y, px = 14, sticks = true) {
    let best = null, bd = px;
    for (const b of this.allBones()) {
      const s = this.toScreen(b.getWorldPosition(v1)); if (s.behind) continue;
      const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = b; }
    }
    if (best || !sticks) return best;
    bd = 6; // fall back to clicking on a stick: selects the parent joint
    for (const b of this.allBones()) for (const c of b.children) {
      if (!c.isBone) continue;
      const a = this.toScreen(b.getWorldPosition(v1)), e = this.toScreen(c.getWorldPosition(v2));
      const d = segDist(x, y, a.x, a.y, e.x, e.y); if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  /** The point a click at (x, y) picks: the nearest one within pickRadius pixels that you can see (any, with X-ray). */
  pickPoint(x, y) {
    const V = this._visibility(); // also caches every point's screen position for this view (fast on big models)
    let best = null, bd = this.pickRadius, bz = Infinity;
    for (const mesh of this.meshes()) {
      const t = this.topo(mesh), sv = this.xray ? null : V.maps.get(mesh), sp = V.scr.get(mesh);
      for (let p = 0; p < t.points.length; p++) {
        if (sv && !sv[p]) continue;
        const sx = sp[p * 3]; if (sx !== sx) continue; // behind the camera
        const dx = sx - x, dy = sp[p * 3 + 1] - y; if (Math.abs(dx) > bd || Math.abs(dy) > bd) continue;
        const d = Math.hypot(dx, dy), z = sp[p * 3 + 2];
        if (d < bd - 1 || (Math.abs(d - bd) <= 1 && z < bz)) { bd = d; bz = z; best = { mesh, pid: p }; }
      }
    }
    return best;
  }
  pickEdge(x, y) {
    const h = this._hit(x, y);
    const consider = (mesh, a, b, bestRef) => {
      const t = this.topo(mesh);
      const sa = this.toScreen(v1.fromArray(t.world, a * 3)), sb = this.toScreen(v2.fromArray(t.world, b * 3));
      if (sa.behind || sb.behind) return;
      const d = segDist(x, y, sa.x, sa.y, sb.x, sb.y);
      if (d < bestRef.d) { const [p, q] = a < b ? [a, b] : [b, a]; Object.assign(bestRef, { d, mesh, key: p * t.points.length + q }); }
    };
    const best = { d: h ? Infinity : Math.max(12, this.pointSize), mesh: null };
    const vis = this.xray ? null : this._visibility();
    if (h && h.face) {
      const t = this.topo(h.object), pa = t.pointOf[h.face.a], pb = t.pointOf[h.face.b], pc = t.pointOf[h.face.c];
      consider(h.object, pa, pb, best); consider(h.object, pb, pc, best); consider(h.object, pc, pa, best);
    } else for (const mesh of this.meshes()) {
      const t = this.topo(mesh), sv = vis?.maps.get(mesh);
      for (let i = 0; i < t.edges.length; i += 2) if (!sv || (sv[t.edges[i]] && sv[t.edges[i + 1]])) consider(mesh, t.edges[i], t.edges[i + 1], best);
    }
    return best.mesh ? { mesh: best.mesh, key: best.key } : null;
  }
  boxSelect(x0, y0, x1, y1, add = false) {
    if (this.mode === 'build') return this.build?.boxSelect(x0, y0, x1, y1, add);
    const inside = s => !s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    if (this.mode === 'bone') {
      const hits = this.allBones().filter(b => inside(this.toScreen(b.getWorldPosition(v1))));
      if (!add) this.sel.bones = [];
      for (const b of hits) if (!this.sel.bones.includes(b)) this.sel.bones.push(b);
    } else {
      if (!add) this._clearPointSel();
      const vis = this.xray ? null : this._visibility(); // without X-ray, a box only takes the points you can see
      for (const mesh of this.meshes()) {
        const t = this.topo(mesh), P = t.points.length, ins = new Uint8Array(P), sv = vis?.maps.get(mesh);
        for (let p = 0; p < P; p++) ins[p] = (!sv || sv[p]) && inside(this.toScreen(v1.fromArray(t.world, p * 3))) ? 1 : 0;
        if (this.mode === 'vertex') {
          const s = this.sel.pts.get(mesh) || new Set();
          for (let p = 0; p < P; p++) if (ins[p]) s.add(p);
          if (s.size) this.sel.pts.set(mesh, s);
        } else {
          const s = this.sel.edges.get(mesh) || new Set();
          for (let i = 0; i < t.edges.length; i += 2) if (ins[t.edges[i]] && ins[t.edges[i + 1]]) s.add(t.edges[i] * P + t.edges[i + 1]);
          if (s.size) this.sel.edges.set(mesh, s);
        }
      }
      this.sel.activePt = this.sel.activeEdge = null;
    }
    this._syncGizmo(); this._updateMeshOverlays(); this.changed();
  }
  /** Where a drawn joint lands: middle of the mesh thickness under the cursor, or on a camera-facing plane. */
  _drawPoint(x, y) {
    const rc = this._ray(x, y), meshes = this.meshes();
    const hits = rc.intersectObjects(meshes, false);
    if (hits.length) {
      const p1 = hits[0].point, dir = rc.ray.direction.clone(), L = this.sceneSize * 2;
      const far = p1.clone().addScaledVector(dir, L);
      const back = new THREE.Raycaster(far, dir.clone().negate(), 0, L - this.sceneSize * 1e-4).intersectObjects(meshes, false);
      const p2 = back.length ? back[back.length - 1].point : null;
      return p2 ? p1.clone().add(p2).multiplyScalar(0.5) : p1.clone();
    }
    const anchor = this.activeBone ? this.activeBone.getWorldPosition(new THREE.Vector3()) : this.orbit.target.clone();
    const n = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, anchor);
    return rc.ray.intersectPlane(plane, new THREE.Vector3()) || anchor;
  }

  // ================= bones / rig =================
  armature() {
    let a = this.root.children.find(o => o.name === 'Armature' && !o.isBone);
    if (!a) { a = new THREE.Object3D(); a.name = this.uniqueName('Armature'); this.root.add(a); }
    return a;
  }
  _container(b) { let t = b; while (t.parent && t.parent.isBone) t = t.parent; return t.parent || this.root; }
  /** Add a joint at world position p (array). parent: name/bone or null (new chain). */
  addBone(name, parent, p = [0, 1, 0]) {
    this._requireRest();
    return this._op('Add joint', { rig: true }, () => {
      const par = parent ? this.bone(parent) : this.armature();
      const b = new THREE.Bone(); b.name = this.uniqueName(name || 'Bone');
      par.add(b); par.updateMatrixWorld(true);
      b.position.copy(par.worldToLocal(new THREE.Vector3().fromArray(p)));
      b.updateMatrixWorld(true);
      this.sel.bones = [b]; this._syncGizmo();
      this.msg(`Added ${b.name}${parent ? ' → child of ' + par.name : ''}`);
      return b.name;
    });
  }
  /** Read the joints off the model's shape and build a humanoid skeleton there (replaces nothing; adds a new one). */
  fitSkeleton() {
    this._requireRest();
    const defs = fitDefs(this);
    return this._op('Fit skeleton', { rig: true }, () => this._makeBones(defs, `Skeleton fitted to the model (${defs.length} joints). Check the joints, then Bind.`));
  }
  /** Make (or replace) a looping walk animation on a humanoid skeleton. opts: see autorig.makeWalk. */
  makeWalk(opts = {}) {
    const w = walkKeys(this, opts);
    return this._op('Make walk', { anim: true }, () => {
      let i = this.clips.findIndex(c => c.name === w.name);
      const clip = { name: w.name, duration: w.duration, tracks: {}, raw: [] };
      for (const [n, props] of Object.entries(w.keys)) clip.tracks[n] = props;
      if (i < 0) { this.clips.push(clip); i = this.clips.length - 1; } else this.clips[i] = clip;
      this.clipIndex = i; this.time = 0; this.loop = true;
      this.setAnimMode(true); this._rebuildAction(); this.setTime(0);
      this.msg(`Walk made: ${Math.round(w.duration * this.fps)} frames, loops. Press Play.`);
      return w.name;
    });
  }
  /** Build a humanoid stick-figure skeleton fitted to the model's bounding box. */
  stickFigure() {
    this._requireRest();
    const box = new THREE.Box3();
    for (const m of this.meshes()) box.expandByObject(m);
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.9, 0, -0.15), new THREE.Vector3(0.9, 1.8, 0.15));
    const size = box.getSize(new THREE.Vector3()), cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    const h = size.y, y0 = box.min.y, half = size.x / 2;
    const tpose = half >= 0.33 * h, xEnd = Math.min(half, 0.5 * h) * 0.95;
    const P = (x, y, z = 0) => [cx + x, y0 + y * h, cz + z * h];
    const defs = [
      ['Hips', null, P(0, 0.53)], ['Spine', 'Hips', P(0, 0.63)], ['Chest', 'Spine', P(0, 0.74)],
      ['Neck', 'Chest', P(0, 0.85)], ['Head', 'Neck', P(0, 0.9)], ['HeadEnd', 'Head', P(0, 1.0)],
    ];
    for (const [s, sx] of [['L', 1], ['R', -1]]) {
      const arm = tpose
        ? [P(sx * 0.1 * h, 0.81), P(sx * (0.1 * h + (xEnd - 0.1 * h) * 0.47), 0.81), P(sx * (0.1 * h + (xEnd - 0.1 * h) * 0.9), 0.81), P(sx * xEnd, 0.81)]
        : [P(sx * 0.1 * h, 0.81), P(sx * 0.17 * h, 0.64), P(sx * 0.19 * h, 0.49), P(sx * 0.2 * h, 0.42)];
      defs.push(
        [`Shoulder_${s}`, 'Chest', P(sx * 0.03 * h, 0.81)], [`UpperArm_${s}`, `Shoulder_${s}`, arm[0]],
        [`LowerArm_${s}`, `UpperArm_${s}`, arm[1]], [`Hand_${s}`, `LowerArm_${s}`, arm[2]], [`HandEnd_${s}`, `Hand_${s}`, arm[3]],
        [`UpperLeg_${s}`, 'Hips', P(sx * 0.055 * h, 0.5)], [`LowerLeg_${s}`, `UpperLeg_${s}`, P(sx * 0.055 * h, 0.28)],
        [`Foot_${s}`, `LowerLeg_${s}`, P(sx * 0.055 * h, 0.05)], [`Toe_${s}`, `Foot_${s}`, P(sx * 0.055 * h, 0.0, 0.07)],
      );
    }
    return this._op('Stick figure', { rig: true }, () => this._makeBones(defs, `Stick figure added (${defs.length} joints${tpose ? ', T-pose' : ', arms down'}). Adjust joints in Bone mode, then Bind.`));
  }
  /** defs = [[name, parentName|null, [x,y,z] world]] (parents first) -> bones under the armature; picks Hips, returns its name. */
  _makeBones(defs, message) {
    const made = {}, arm = this.armature();
    for (const [n, parent, p] of defs) {
      const par = parent ? made[parent] : arm;
      const b = new THREE.Bone(); b.name = this.uniqueName(n); made[n] = b;
      par.add(b); par.updateMatrixWorld(true);
      b.position.copy(par.worldToLocal(new THREE.Vector3().fromArray(p))); b.updateMatrixWorld(true);
    }
    this.sel.bones = [made.Hips]; this._syncGizmo();
    this.msg(message);
    return made.Hips.name;
  }
  /** Move a joint. Edit mode: changes the rest pose (mesh stays put). Animate mode: poses it. */
  setBonePosition(name, p, space = 'world') {
    const b = this.bone(name);
    return this._boneEdit(b, () => {
      if (space === 'world') { b.parent.updateMatrixWorld(true); b.position.copy(b.parent.worldToLocal(new THREE.Vector3().fromArray(p))); }
      else b.position.fromArray(p);
    }, 'position');
  }
  /** Set local rotation (degrees, XYZ euler). */
  setBoneRotation(name, deg) {
    const b = this.bone(name);
    return this._boneEdit(b, () => b.rotation.set(...deg.map(THREE.MathUtils.degToRad)), 'quaternion');
  }
  _boneEdit(b, fn, prop) {
    return this._op(this.animMode ? 'Pose bone' : 'Move joint', { rig: true, anim: true }, () => {
      const rest = this.animMode ? null : this._beginRestEdit();
      const kids = !this.animMode && !this.childrenFollow ? b.children.filter(c => c.isBone).map(c => ({ c, m: c.matrixWorld.clone() })) : null;
      fn(); b.updateMatrixWorld(true);
      if (kids) for (const k of kids) this._setWorldMatrix(k.c, k.m);
      if (rest) this._applyRestEdit(rest);
      if (this.animMode && this.autoKey) this._keyInternal([b], [prop]);
      return arr3(b.getWorldPosition(new THREE.Vector3()));
    });
  }
  rename(oldName, newName) {
    const o = this.obj(oldName); if (!o) throw new Error('Not found: ' + oldName);
    newName = THREE.PropertyBinding.sanitizeNodeName(newName);
    if (!newName || newName === o.name) return o.name;
    if (this.root.getObjectByName(newName)) newName = this.uniqueName(newName);
    const old = o.name;
    return this._op('Rename', { rig: true, anim: true }, () => {
      o.name = newName;
      for (const c of this.clips) {
        if (c.tracks[old]) { c.tracks[newName] = c.tracks[old]; delete c.tracks[old]; }
        c.raw = c.raw.map(tr => { if (!tr.name.startsWith(old + '.')) return tr; const n = tr.clone(); n.name = newName + tr.name.slice(old.length); return n; });
      }
      this._rebuildAction();
      return newName;
    });
  }
  /** Delete joints (children are re-attached to the deleted joint's parent). */
  deleteBones(list = this.sel.bones) {
    this._requireRest();
    const bones = [].concat(list).map(x => this.bone(x)); if (!bones.length) return this.msg('No joints selected');
    const bound = new Set(this.skeletons().flatMap(s => s.bones));
    return this._op('Delete joints', { rig: true }, () => {
      for (const b of bones) { for (const c of [...b.children]) b.parent.attach(c); b.removeFromParent(); }
      this.sel.bones = []; this._syncGizmo();
      return this.msg(`Deleted ${bones.length} joint(s)` + (bones.some(b => bound.has(b)) ? ' — skin used them: Bind again' : ''));
    });
  }
  /** Attach (parent) child joint(s) to a parent joint. Default: selected joints → active joint. */
  attachBones(children, parent) {
    this._requireRest();
    const par = parent ? this.bone(parent) : this.activeBone;
    const kids = (children ? [].concat(children).map(x => this.bone(x)) : this.sel.bones.filter(b => b !== par));
    if (!par || !kids.length) return this.msg('Select the child joint(s), then shift-click the new parent last');
    return this._op('Attach joints', { rig: true }, () => {
      let n = 0;
      for (const k of kids) {
        let a = par; while (a && a !== k) a = a.parent; if (a === k) continue; // no cycles
        par.attach(k); n++;
      }
      return this.msg(`Attached ${n} joint(s) to ${par.name}`);
    });
  }
  /** Detach joint(s) from their parent (they become separate chains). */
  detachBones(list = this.sel.bones) {
    this._requireRest();
    const bones = [].concat(list).map(x => this.bone(x)); if (!bones.length) return this.msg('No joints selected');
    return this._op('Detach joints', { rig: true }, () => {
      for (const b of bones) this._container(b).attach(b);
      return this.msg(`Detached ${bones.length} joint(s)`);
    });
  }
  _rigBones() {
    const start = this.activeBone || this.allBones()[0];
    if (!start) return [];
    const out = []; this._container(start).traverse(o => { if (o.isBone) out.push(o); });
    return out;
  }
  /** Skin meshes to the skeleton with automatic weights (measured along the surface; opts.method 'distance' = straight distance to bone segments). */
  bind(opts = {}) {
    this._requireRest();
    const bones = opts.bones ? opts.bones.map(x => this.bone(x)) : this._rigBones();
    if (!bones.length) throw new Error('No bones — add a skeleton first');
    const meshes = (opts.meshes ? opts.meshes.map(x => this.mesh(x)) : this.meshes());
    if (!meshes.length) throw new Error('No meshes');
    this.root.updateMatrixWorld(true);
    // bone segments (joint → each child joint; leaves extend along their parent's direction)
    const segs = bones.map(b => {
      const a = b.getWorldPosition(new THREE.Vector3());
      const kids = b.children.filter(c => c.isBone).map(c => c.getWorldPosition(new THREE.Vector3()));
      if (!kids.length) {
        // an "...End" joint marks the tip of the part (finger tips, top of the head): it reaches no further
        if (/End(_[A-Za-z]+)?$/i.test(b.name)) kids.push(a.clone()); // HeadEnd, HandEnd_L ...
        else {
          const pp = b.parent && b.parent.isBone ? b.parent.getWorldPosition(new THREE.Vector3()) : a.clone().add(new THREE.Vector3(0, -0.1, 0));
          kids.push(a.clone().add(a.clone().sub(pp).multiplyScalar(0.5)));
        }
      }
      return { a, ends: kids };
    });
    const skeleton = new THREE.Skeleton(bones);
    const seg = new THREE.Line3();
    for (let mesh of meshes) {
      const t = this.topo(mesh); this._refreshWorld(mesh, t);
      if (mesh.isSkinnedMesh) { // bake the current rest shape into the geometry
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) { mesh.getVertexPosition(i, v1); pos.setXYZ(i, v1.x, v1.y, v1.z); }
      }
      const n = mesh.geometry.attributes.position.count;
      const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      const sc = new Float64Array(bones.length);
      if (opts.method !== 'distance') { // weights measured along the surface (default)
        const W = surfaceWeights(t, bones, segs, this.sceneSize / 1.2);
        for (let pid = 0; pid < t.points.length; pid++) for (const i of t.points[pid]) for (let k = 0; k < 4; k++) { si[i * 4 + k] = W.idx[pid * 4 + k]; sw[i * 4 + k] = W.w[pid * 4 + k]; }
      } else for (let pid = 0; pid < t.points.length; pid++) {
        v1.fromArray(t.world, pid * 3);
        for (let j = 0; j < segs.length; j++) {
          let d = Infinity;
          for (const e of segs[j].ends) { seg.set(segs[j].a, e); seg.closestPointToPoint(v1, true, v2); d = Math.min(d, v2.distanceToSquared(v1)); }
          sc[j] = 1 / (d * d + 1e-12);
        }
        const top = [...sc.keys()].sort((p, q) => sc[q] - sc[p]).slice(0, 4);
        let sum = 0; top.forEach(j => sum += sc[j]);
        for (const i of t.points[pid]) top.forEach((j, k) => { si[i * 4 + k] = j; sw[i * 4 + k] = sc[j] / sum; });
      }
      const g = mesh.geometry;
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      if (!mesh.isSkinnedMesh) {
        const sm = new THREE.SkinnedMesh(g, mesh.material);
        sm.name = mesh.name; sm.position.copy(mesh.position); sm.quaternion.copy(mesh.quaternion); sm.scale.copy(mesh.scale);
        sm.visible = mesh.visible; sm.userData = mesh.userData;
        const par = mesh.parent; par.children[par.children.indexOf(mesh)] = sm; sm.parent = par; mesh.parent = null;
        while (mesh.children.length) sm.add(mesh.children[0]);
        mesh = sm;
      }
      mesh.frustumCulled = false;
      mesh.updateMatrixWorld(true);
      mesh.bind(skeleton, mesh.matrixWorld);
      mesh.boundingBox = mesh.boundingSphere = null;
    }
    this.undoStack = []; this.redoStack = []; this._savedStep = {}; // (= not saved) binding replaces objects; history before it is not restorable
    this.sel.meshes = []; this._invalidateTopo(); this._syncGizmo(); this.changed();
    return this.msg(`Bound ${meshes.length} mesh(es) to ${bones.length} joints. Switch to Animate (Tab) to pose.`);
  }
  _requireRest() { if (this.animMode) this.setAnimMode(false); }

  // ================= points: attach / detach / cleanup =================
  /** Attach (weld) selected points: snap them onto the active point (or their centre). Two edges: snap edge onto edge. */
  attachPoints() {
    const sel = this.selectedPoints(); const meshes = [...sel.keys()];
    if (this.selectedPointCount() < 2) return this.msg('Select 2+ points (or 2 edges) to attach');
    return this._op('Attach points', { pos: meshes }, () => {
      const moves = new Map(); // mesh -> [[pid, Vector3]]
      const add = (mesh, pid, w) => { let l = moves.get(mesh); if (!l) moves.set(mesh, l = []); l.push([pid, w]); };
      const edgeList = this.mode === 'edge' ? [...this.sel.edges].flatMap(([m, ks]) => [...ks].map(k => ({ mesh: m, key: k }))) : [];
      if (this.mode === 'edge' && edgeList.length === 2) {
        const act = this.sel.activeEdge && edgeList.find(e => e.mesh === this.sel.activeEdge.mesh && e.key === this.sel.activeEdge.key) || edgeList[1];
        const other = edgeList.find(e => e !== act);
        const ends = e => { const t = this.topo(e.mesh), P = t.points.length; return [Math.floor(e.key / P), e.key % P].map(p => ({ p, w: new THREE.Vector3().fromArray(t.world, p * 3) })); };
        const [a0, a1] = ends(act), [b0, b1] = ends(other);
        const straight = b0.w.distanceTo(a0.w) + b1.w.distanceTo(a1.w) <= b0.w.distanceTo(a1.w) + b1.w.distanceTo(a0.w);
        add(other.mesh, b0.p, (straight ? a0 : a1).w); add(other.mesh, b1.p, (straight ? a1 : a0).w);
      } else {
        let target;
        const ap = this.sel.activePt;
        if (this.mode === 'vertex' && ap && sel.get(ap.mesh)?.has(ap.pid)) target = new THREE.Vector3().fromArray(this.topo(ap.mesh).world, ap.pid * 3);
        else { target = new THREE.Vector3(); let n = 0; for (const [m, s] of sel) for (const p of s) { target.add(v1.fromArray(this.topo(m).world, p * 3)); n++; } target.divideScalar(n); }
        for (const [m, s] of sel) for (const p of s) add(m, p, target.clone());
      }
      let n = 0;
      for (const [mesh, l] of moves) {
        const t = this.topo(mesh), det = this._det(mesh.geometry);
        this._setPointsWorld(mesh, l); n += l.length;
        for (const [pid] of l) for (const i of t.points[pid]) det.delete(i);
        this._finishGeometry(mesh, l.map(e => e[0]));
      }
      for (const m of moves.keys()) this._invalidateTopo(m);
      this._clearPointSel(); this._syncGizmo();
      return this.msg(`Attached ${n} point(s)`);
    });
  }
  /** Detach (rip) selected points: every face corner gets its own vertex so faces can be pulled apart. */
  detachPoints() {
    const sel = this.selectedPoints(); const meshes = [...sel.keys()];
    if (!this.selectedPointCount()) return this.msg('Select points to detach');
    const count = this.selectedPointCount();
    return this._op('Detach points', { geo: meshes }, () => {
      let made = 0;
      for (const [mesh, s] of sel) {
        const g = mesh.geometry, t = this.topo(mesh), det = this._det(g);
        const verts = [...s].flatMap(p => t.points[p]);
        if (g.index) {
          const vset = new Set(verts), seen = new Set(), corners = [], src = [];
          const idx = g.index;
          for (let c = 0; c < idx.count; c++) { const v = idx.getX(c); if (!vset.has(v)) continue; if (!seen.has(v)) { seen.add(v); continue; } corners.push(c); src.push(v); }
          if (src.length) {
            ensureIndex(g, src.length);
            const base = appendVertices(g, src);
            corners.forEach((c, j) => { g.index.setX(c, base + j); det.add(base + j); });
            g.index.needsUpdate = true; made += src.length;
          }
        }
        verts.forEach(v => det.add(v));
        this._invalidateTopo(mesh);
      }
      this._clearPointSel(); this._syncGizmo();
      return this.msg(`Detached ${count} point(s)` + (made ? ` (+${made} new vertices)` : '') + '. Click a face corner to grab one piece.');
    });
  }
  /** Weld points closer than `threshold` (world units). Scope: selected points, else all points of target meshes. */
  mergeByDistance(threshold = 0.001, meshNames) {
    const sel = this.selectedPoints();
    const useSel = this.selectedPointCount() > 0 && !meshNames;
    const meshes = meshNames ? meshNames.map(x => this.mesh(x)) : useSel ? [...sel.keys()] : (this.sel.meshes.length ? this.sel.meshes : this.meshes());
    return this._op('Merge by distance', { pos: meshes }, () => {
      let merged = 0;
      for (const mesh of meshes) {
        const t = this._refreshWorld(mesh), w = t.world;
        const pids = useSel ? [...sel.get(mesh)] : [...t.points.keys()];
        const parent = new Map(pids.map(p => [p, p]));
        const find = p => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
        const cell = new Map(), th2 = threshold * threshold, key = (a, b, c) => a + ',' + b + ',' + c;
        for (const p of pids) {
          const cx = Math.floor(w[p * 3] / threshold), cy = Math.floor(w[p * 3 + 1] / threshold), cz = Math.floor(w[p * 3 + 2] / threshold);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const l = cell.get(key(cx + dx, cy + dy, cz + dz)); if (!l) continue;
            for (const q of l) {
              const ex = w[p * 3] - w[q * 3], ey = w[p * 3 + 1] - w[q * 3 + 1], ez = w[p * 3 + 2] - w[q * 3 + 2];
              if (ex * ex + ey * ey + ez * ez <= th2) parent.set(find(p), find(q));
            }
          }
          const k = key(cx, cy, cz); (cell.get(k) || cell.set(k, []).get(k)).push(p);
        }
        const groups = new Map();
        for (const p of pids) { const r = find(p); (groups.get(r) || groups.set(r, []).get(r)).push(p); }
        const moves = [], det = this._det(mesh.geometry);
        for (const g of groups.values()) {
          if (g.length < 2) continue;
          const c = new THREE.Vector3(); g.forEach(p => c.add(v1.fromArray(w, p * 3))); c.divideScalar(g.length);
          g.forEach(p => { moves.push([p, c.clone()]); t.points[p].forEach(i => det.delete(i)); });
          merged += g.length - 1;
        }
        if (moves.length) { this._setPointsWorld(mesh, moves); this._finishGeometry(mesh, moves.map(m => m[0])); this._invalidateTopo(mesh); }
      }
      this._clearPointSel(); this._syncGizmo();
      return this.msg(`Merged away ${merged} point(s) within ${threshold}`);
    });
  }
  /**
   * Smooth the shape: each point moves toward the middle of its neighbours, then back out a little
   * (Taubin smoothing), so lumps and dents even out without the model shrinking.
   * Scope: selected points, else selected meshes, else all. opts: { iterations=3, strength=0.3 }.
   * Points on the scope's border stay put, so a smoothed patch blends into the rest.
   */
  smoothPoints({ iterations = 3, strength = 0.3 } = {}) {
    const sel = this.selectedPoints(), useSel = this.selectedPointCount() > 0;
    const meshes = useSel ? [...sel.keys()] : (this.sel.meshes.length ? this.sel.meshes : this.meshes());
    if (!meshes.length) return this.msg('Load a model first');
    const lam = THREE.MathUtils.clamp(strength, 0.05, 0.9), mu = -(lam + 0.02 + 0.03 * lam); // shrink then inflate
    return this._op('Smooth shape', { pos: meshes }, () => {
      let moved = 0;
      for (const mesh of meshes) {
        const t = this._refreshWorld(mesh), P = t.points.length, E = t.edges;
        const nb = Array.from({ length: P }, () => []);
        for (let k = 0; k < E.length; k += 2) { nb[E[k]].push(E[k + 1]); nb[E[k + 1]].push(E[k]); }
        const inSel = useSel ? sel.get(mesh) : null;
        // with a selection, only points whose neighbours are all picked move (the border holds the patch in place)
        let free = [...t.points.keys()].filter(p => nb[p].length && (!inSel || (inSel.has(p) && nb[p].every(q => inSel.has(q)))));
        if (inSel && !free.length) free = [...inSel].filter(p => nb[p].length); // a few loose points: just relax them
        let w = Float64Array.from(t.world);
        const step = f => {
          const out = Float64Array.from(w);
          for (const p of free) {
            let x = 0, y = 0, z = 0; for (const q of nb[p]) { x += w[q * 3]; y += w[q * 3 + 1]; z += w[q * 3 + 2]; }
            const n = nb[p].length;
            out[p * 3] = w[p * 3] + f * (x / n - w[p * 3]); out[p * 3 + 1] = w[p * 3 + 1] + f * (y / n - w[p * 3 + 1]); out[p * 3 + 2] = w[p * 3 + 2] + f * (z / n - w[p * 3 + 2]);
          }
          w = out;
        };
        for (let i = 0; i < iterations; i++) { step(lam); step(mu); }
        const list = free.map(p => [p, new THREE.Vector3(w[p * 3], w[p * 3 + 1], w[p * 3 + 2])]);
        this._setPointsWorld(mesh, list); this._finishGeometry(mesh, null); moved += list.length;
      }
      this._syncGizmo();
      return this.msg(`Smoothed ${moved} point(s)`);
    });
  }
  /**
   * Smooth shading on/off. On: the surface is lit as one soft curve (normals averaged at every point,
   * even across texture seams). Off: flat facets, the low-poly look.
   */
  smoothShading(on = true, meshNames) {
    const meshes = meshNames ? meshNames.map(x => this.mesh(x)) : (this.sel.meshes.length ? this.sel.meshes : this.meshes());
    const snap = () => meshes.map(m => ({ m, n: m.geometry.attributes.normal?.array.slice(), flat: [].concat(m.material).map(x => x.flatShading) }));
    const put = s => s.forEach(({ m, n, flat }) => {
      if (n && m.geometry.attributes.normal?.array.length === n.length) { m.geometry.attributes.normal.array.set(n); m.geometry.attributes.normal.needsUpdate = true; }
      [].concat(m.material).forEach((x, i) => { x.flatShading = flat[i]; x.needsUpdate = true; });
    });
    const before = snap();
    for (const mesh of meshes) {
      const g = mesh.geometry, t = this.topo(mesh), pos = g.attributes.position;
      if (on) {
        if (!g.attributes.normal) g.computeVertexNormals();
        const nrm = g.attributes.normal, acc = Array.from({ length: t.points.length }, () => new THREE.Vector3());
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
        for (let f = 0; f < t.triCount; f++) {
          const vi = [t.corner(f * 3), t.corner(f * 3 + 1), t.corner(f * 3 + 2)], P3 = [a, b, c];
          vi.forEach((v, k) => P3[k].fromBufferAttribute(pos, v));
          fn.subVectors(b, a).cross(e1.subVectors(c, a)); if (fn.lengthSq() < 1e-20) continue; fn.normalize();
          for (let k = 0; k < 3; k++) { // weight by the corner angle: even, seam-free shading
            e1.subVectors(P3[(k + 1) % 3], P3[k]).normalize(); e2.subVectors(P3[(k + 2) % 3], P3[k]).normalize();
            acc[t.pointOf[vi[k]]].addScaledVector(fn, Math.acos(THREE.MathUtils.clamp(e1.dot(e2), -1, 1)));
          }
        }
        t.points.forEach((mem, p) => { acc[p].normalize(); for (const i of mem) nrm.setXYZ(i, acc[p].x, acc[p].y, acc[p].z); });
        nrm.needsUpdate = true;
      }
      [].concat(mesh.material).forEach(x => { x.flatShading = !on; x.needsUpdate = true; });
    }
    const after = snap();
    this._pushUndo(on ? 'Smooth shading' : 'Flat shading', () => put(before), () => put(after));
    this.changed();
    return this.msg(on ? 'Smooth shading: the surface now looks like one soft curve' : 'Flat shading: crisp low-poly facets');
  }
  /**
   * Paint the picked area into the model's texture: every face whose corners are all picked gets the colour.
   * keep (0..1) = how much of the old texture's light and dark detail shows through (folds, shading).
   * rim = width in texture pixels of a darker seam drawn round the edge of the painted area (0 = none).
   * opts: { color='#7b4f33', keep=0.55, rim=0, rimColor }
   */
  paintFaces({ color = '#7b4f33', keep = 0.55, rim = 0, rimColor } = {}) {
    const sel = this.selectedPoints();
    if (!this.selectedPointCount()) return this.msg('Pick the points of the area to paint first');
    const out = [];
    for (const [mesh, pset] of sel) {
      const mats = [].concat(mesh.material), mat = mats[0], old = mat.map;
      if (!old?.image) { out.push(`${mesh.name}: has no texture to paint on`); continue; }
      const t = this.topo(mesh), g = mesh.geometry, uv = g.attributes.uv;
      const Wt = old.image.width, Ht = old.image.height;
      const px = i => [uv.getX(i) * Wt, (old.flipY ? 1 - uv.getY(i) : uv.getY(i)) * Ht];
      const faces = [], inside = new Uint8Array(t.triCount);
      for (let f = 0; f < t.triCount; f++) {
        const vs = [t.corner(f * 3), t.corner(f * 3 + 1), t.corner(f * 3 + 2)];
        if (vs.every(v => pset.has(t.pointOf[v]))) { inside[f] = 1; faces.push(vs); }
      }
      if (!faces.length) { out.push(`${mesh.name}: pick at least 3 points that make a face`); continue; }
      const cv = document.createElement('canvas'); cv.width = Wt; cv.height = Ht;
      const x = cv.getContext('2d'); x.drawImage(old.image, 0, 0);
      const tri = vs => { x.beginPath(); vs.map(px).forEach(([a, b], k) => (k ? x.lineTo(a, b) : x.moveTo(a, b))); x.closePath(); };
      const area = () => { x.beginPath(); for (const vs of faces) { const p = vs.map(px); x.moveTo(...p[0]); x.lineTo(...p[1]); x.lineTo(...p[2]); x.closePath(); } };
      // 1) cover the old colours, 2) put back their light/dark detail, 3) colour it
      x.save(); area(); x.clip();
      x.globalAlpha = 1 - keep; x.fillStyle = color; for (const vs of faces) { tri(vs); x.fill(); x.lineWidth = 2; x.strokeStyle = color; x.stroke(); }
      x.globalAlpha = 1; x.globalCompositeOperation = 'color'; for (const vs of faces) { tri(vs); x.fill(); x.lineWidth = 2; x.stroke(); }
      x.globalCompositeOperation = 'source-over';
      if (rim > 0) { // a seam along the outline: edges where a painted face meets an unpainted one (by position, across UV seams)
        const P = t.points.length, count = new Map(), uvOf = new Map();
        for (let f = 0; f < t.triCount; f++) for (let k = 0; k < 3; k++) {
          const a = t.corner(f * 3 + k), b = t.corner(f * 3 + (k + 1) % 3), pa = t.pointOf[a], pb = t.pointOf[b];
          const key = pa < pb ? pa * P + pb : pb * P + pa, c = count.get(key) || [0, 0]; c[inside[f]]++; count.set(key, c);
          if (inside[f]) uvOf.set(key, [px(a), px(b)]);
        }
        x.strokeStyle = rimColor || new THREE.Color(color).multiplyScalar(0.45).getStyle(); x.lineWidth = rim; x.lineCap = 'round';
        for (const [key, [o, i]] of count) if (i && o) { const [a, b] = uvOf.get(key); x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.stroke(); }
      }
      x.restore();
      this._putPaintedTexture(mats, old, cv, 'Paint');
      out.push(`${mesh.name}: painted ${faces.length} face(s)`);
    }
    this.changed();
    return this.msg(out.join('; '));
  }
  /**
   * Paint a band along a path on the surface, into the texture (like a brush stroke: a strap, a stripe, a belt).
   * path = world points [[x,y,z], ...]; each is pulled onto the surface first, so they only need to be close.
   * Works texel by texel and across texture seams. opts: { width=0.02, color, keep=0.5, rim=0.25 (share of the
   * width drawn darker at both edges), meshName }. Returns how many texels were painted.
   */
  paintStroke(path, { width = 0.02, color = '#7b4f33', keep = 0.5, rim = 0.25, meshName } = {}) {
    const mesh = meshName ? this.mesh(meshName) : (this.sel.meshes[0] || this.meshes()[0]);
    if (!mesh) return this.msg('Load a model first');
    if (!Array.isArray(path) || path.length < 2) return this.msg('A stroke needs at least 2 points');
    const mats = [].concat(mesh.material), old = mats[0].map;
    if (!old?.image) return this.msg(`${mesh.name} has no texture to paint on`);
    const t = this._refreshWorld(mesh), g = mesh.geometry, uv = g.attributes.uv, W = t.world;
    const Wt = old.image.width, Ht = old.image.height;
    const tris = [];
    for (let f = 0; f < t.triCount; f++) {
      const vs = [t.corner(f * 3), t.corner(f * 3 + 1), t.corner(f * 3 + 2)];
      tris.push({ vs, P: vs.map(v => new THREE.Vector3().fromArray(W, t.pointOf[v] * 3)) });
    }
    // pull the path onto the surface, then sample it densely
    const tri3 = new THREE.Triangle(), cp = new THREE.Vector3();
    tris.forEach(tr => { tr.n = new THREE.Triangle(...tr.P).getNormal(new THREE.Vector3()); });
    let lastN = null; // the surface normal where the last point landed
    const onSurface = p => { let best = null, bd = Infinity; for (const tr of tris) { tri3.set(...tr.P); tri3.closestPointToPoint(p, cp); const d = cp.distanceToSquared(p); if (d < bd) { bd = d; best = cp.clone(); lastN = tr.n; } } return best; };
    const keyPts = path.map(p => onSurface(new THREE.Vector3(...p)));
    const pts = [], nrms = [];
    for (let i = 0; i < keyPts.length - 1; i++) {
      const a = keyPts[i], b = keyPts[i + 1], n = Math.max(1, Math.ceil(a.distanceTo(b) / (width * 0.25)));
      for (let k = 0; k < n; k++) { pts.push(onSurface(a.clone().lerp(b, k / n))); nrms.push(lastN); }
    }
    pts.push(onSurface(keyPts[keyPts.length - 1])); nrms.push(lastN);
    const seg = new THREE.Line3(), q = new THREE.Vector3();
    // distance to the stroke, counting only stretches of the stroke on a surface facing the same way
    // (so an arm resting against the body, facing the other way, is never painted)
    const dist = (p, fn) => { let d = Infinity; for (let i = 0; i < pts.length - 1; i++) { if (fn.dot(nrms[i]) < 0.2 && fn.dot(nrms[i + 1]) < 0.2) continue; seg.set(pts[i], pts[i + 1]); seg.closestPointToPoint(p, true, q); d = Math.min(d, q.distanceTo(p)); } return d; };
    const cv = document.createElement('canvas'); cv.width = Wt; cv.height = Ht;
    const x = cv.getContext('2d'); x.drawImage(old.image, 0, 0);
    const img = x.getImageData(0, 0, Wt, Ht), D = img.data;
    const col = new THREE.Color(color), dark = col.clone().multiplyScalar(0.5), half = width / 2;
    const lum = (r, g2, b) => (0.299 * r + 0.587 * g2 + 0.114 * b) / 255;
    const box = new THREE.Box3(); pts.forEach(p => box.expandByPoint(p)); box.expandByScalar(half + 1e-4);
    let painted = 0; const done = new Uint8Array(Wt * Ht), p3 = new THREE.Vector3();
    for (const tr of tris) {
      const tb = new THREE.Box3().setFromPoints(tr.P); if (!tb.intersectsBox(box)) continue;
      const U = tr.vs.map(v => [uv.getX(v) * Wt, (old.flipY ? 1 - uv.getY(v) : uv.getY(v)) * Ht]);
      const x0 = Math.max(0, Math.floor(Math.min(U[0][0], U[1][0], U[2][0])) - 1), x1 = Math.min(Wt - 1, Math.ceil(Math.max(U[0][0], U[1][0], U[2][0])) + 1);
      const y0 = Math.max(0, Math.floor(Math.min(U[0][1], U[1][1], U[2][1])) - 1), y1 = Math.min(Ht - 1, Math.ceil(Math.max(U[0][1], U[1][1], U[2][1])) + 1);
      const den = (U[1][1] - U[2][1]) * (U[0][0] - U[2][0]) + (U[2][0] - U[1][0]) * (U[0][1] - U[2][1]); if (Math.abs(den) < 1e-9) continue;
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const sx = px + 0.5, sy = py + 0.5;
        const w0 = ((U[1][1] - U[2][1]) * (sx - U[2][0]) + (U[2][0] - U[1][0]) * (sy - U[2][1])) / den;
        const w1 = ((U[2][1] - U[0][1]) * (sx - U[2][0]) + (U[0][0] - U[2][0]) * (sy - U[2][1])) / den, w2 = 1 - w0 - w1;
        const tol = -1.2 / Math.max(x1 - x0, y1 - y0, 1); // a hair outside the triangle too, so seams close up
        if (w0 < tol || w1 < tol || w2 < tol) continue;
        const o = py * Wt + px; if (done[o]) continue;
        p3.copy(tr.P[0]).multiplyScalar(w0).addScaledVector(tr.P[1], w1).addScaledVector(tr.P[2], w2);
        const d = dist(p3, tr.n); if (d > half) continue;
        done[o] = 1; painted++;
        const edge = d > half * (1 - rim) ? dark : col; // darker at both edges, like a stitched strap
        const L = lum(D[o * 4], D[o * 4 + 1], D[o * 4 + 2]), detail = THREE.MathUtils.lerp(1, 0.6 + 0.9 * L, keep);
        D[o * 4] = Math.min(255, edge.r * 255 * detail); D[o * 4 + 1] = Math.min(255, edge.g * 255 * detail); D[o * 4 + 2] = Math.min(255, edge.b * 255 * detail);
      }
    }
    x.putImageData(img, 0, 0);
    this._putPaintedTexture(mats, old, cv, 'Paint stroke');
    this.changed();
    this.msg(`Painted a stroke (${painted} texels)`);
    return painted;
  }
  /** Swap the texture old for a copy showing canvas cv on every material in mats, as one undo step. */
  _putPaintedTexture(mats, old, cv, label) {
    const tex = old.clone(); tex.source = new THREE.Source(cv); tex.needsUpdate = true; // own picture: clone() shares the old one
    const put = m => () => { mats.forEach(mt => { if (mt.map === old || mt.map === tex) { mt.map = m; mt.needsUpdate = true; } }); };
    put(tex)();
    this._pushUndo(label, put(old), put(tex));
  }
  /** Per-point weights of a skinned mesh as dense rows (one number per skeleton bone). */
  _weightRows(mesh, t) {
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight, B = mesh.skeleton.bones.length;
    return t.points.map(mem => { const r = new Float64Array(B), v = mem[0]; for (let k = 0; k < 4; k++) r[si.getComponent(v, k)] += sw.getComponent(v, k); return r; });
  }
  /** Write dense weight rows back (keeps the 4 biggest, normalised) for the given points. */
  _writeWeightRows(mesh, t, rows, pids) {
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    for (const p of pids) {
      const top = [...rows[p].keys()].sort((a, b) => rows[p][b] - rows[p][a]).slice(0, 4), sum = top.reduce((s, j) => s + rows[p][j], 0) || 1;
      for (const v of t.points[p]) top.forEach((j, k) => { si.setComponent(v, k, j); sw.setComponent(v, k, rows[p][j] / sum); });
    }
    si.needsUpdate = sw.needsUpdate = true;
  }
  /**
   * Give the picked points to a joint (or a mix of joints): mix = 'Chest' or { Chest: 0.6, Spine: 0.4 }.
   * Use it when a bit of skin follows the wrong joint (a backpack following an arm, a coat tail following a leg).
   */
  assignWeights(mix) {
    if (typeof mix === 'string') mix = { [mix]: 1 };
    const sel = this.selectedPoints();
    if (!this.selectedPointCount()) return this.msg('Pick the points first');
    const meshes = [...sel.keys()].filter(m => m.isSkinnedMesh);
    if (!meshes.length) return this.msg('Bind the model to a skeleton first');
    return this._op('Give to joint', { geo: meshes }, () => {
      let n = 0;
      for (const mesh of meshes) {
        const t = this.topo(mesh), bones = mesh.skeleton.bones, row = new Float64Array(bones.length);
        for (const [name, w] of Object.entries(mix)) { const j = bones.findIndex(b => b.name === name); if (j < 0) throw new Error('No joint called ' + name); row[j] = w; }
        const rows = this._weightRows(mesh, t), pids = [...sel.get(mesh)];
        pids.forEach(p => { rows[p] = row.slice(); }); this._writeWeightRows(mesh, t, rows, pids); n += pids.length;
      }
      return this.msg(`${n} point(s) now follow ${Object.keys(mix).join(' + ')}`);
    });
  }
  /**
   * Smooth weights: each point's joint mix blends toward its neighbours', so skin hands over gently from one
   * joint to the next instead of pinching. Picked points, else the whole model. opts: { iterations=2, strength=0.5 }
   */
  smoothWeights({ iterations = 2, strength = 0.5 } = {}) {
    const sel = this.selectedPoints(), useSel = this.selectedPointCount() > 0;
    const meshes = (useSel ? [...sel.keys()] : this.meshes()).filter(m => m.isSkinnedMesh);
    if (!meshes.length) return this.msg('Bind the model to a skeleton first');
    return this._op('Smooth weights', { geo: meshes }, () => {
      let n = 0;
      for (const mesh of meshes) {
        const t = this.topo(mesh), E = t.edges, P = t.points.length;
        const nb = Array.from({ length: P }, () => []); for (let k = 0; k < E.length; k += 2) { nb[E[k]].push(E[k + 1]); nb[E[k + 1]].push(E[k]); }
        const pids = useSel ? [...sel.get(mesh)] : [...t.points.keys()];
        let rows = this._weightRows(mesh, t);
        for (let it = 0; it < iterations; it++) {
          const next = rows.map(r => r.slice());
          for (const p of pids) { if (!nb[p].length) continue; const avg = new Float64Array(rows[p].length); for (const q of nb[p]) for (let j = 0; j < avg.length; j++) avg[j] += rows[q][j] / nb[p].length; for (let j = 0; j < avg.length; j++) next[p][j] = rows[p][j] + strength * (avg[j] - rows[p][j]); }
          rows = next;
        }
        this._writeWeightRows(mesh, t, rows, pids); n += pids.length;
      }
      return this.msg(`Smoothed the weights of ${n} point(s)`);
    });
  }
  /** Delete faces touching selected points (vertex mode) or containing selected edges (edge mode). */
  deleteFaces() {
    const sel = this.selectedPoints(); const meshes = [...sel.keys()];
    if (!this.selectedPointCount()) return this.msg('Nothing selected');
    return this._op('Delete faces', { geo: meshes }, () => {
      let removed = 0;
      for (const mesh of meshes) {
        const t = this.topo(mesh), P = t.points.length;
        const pset = sel.get(mesh), ekeys = this.mode === 'edge' ? this.sel.edges.get(mesh) : null;
        const kill = (f, a, b, c) => {
          const pa = t.pointOf[a], pb = t.pointOf[b], pc = t.pointOf[c];
          if (!ekeys) return pset.has(pa) || pset.has(pb) || pset.has(pc);
          const k = (p, q) => p < q ? p * P + q : q * P + p;
          return ekeys.has(k(pa, pb)) || ekeys.has(k(pb, pc)) || ekeys.has(k(pc, pa));
        };
        removed += this._removeFaces(mesh, kill, true); // rebuild even when no face went: picked points without faces are dropped too
      }
      this._clearPointSel(); this._syncGizmo();
      return this.msg(`Deleted ${removed} face(s) and the points they left behind`);
    });
  }
  /**
   * Remove faces from a mesh (no undo of its own: call inside _op). kill(faceIndex, a, b, c) -> true to remove,
   * where a/b/c are vertex indices. Points no face uses any more are dropped too. Returns how many faces went.
   * always: rebuild the geometry even if no face went (deleteFaces relies on it).
   */
  _removeFaces(mesh, kill, always = false) {
    const g = mesh.geometry, idx = ensureIndex(g).array;
    const groups = g.groups.length ? g.groups.map(x => ({ ...x })) : [{ start: 0, count: idx.length, materialIndex: 0 }];
    const out = [], ng = []; let removed = 0;
    for (const gr of groups) {
      const start = out.length;
      for (let c = gr.start; c < Math.min(gr.start + gr.count, idx.length); c += 3) {
        if (kill(c / 3, idx[c], idx[c + 1], idx[c + 2])) { removed++; continue; }
        out.push(idx[c], idx[c + 1], idx[c + 2]);
      }
      ng.push({ start, count: out.length - start, materialIndex: gr.materialIndex });
    }
    if (!removed && !always) return 0;
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(out), 1));
    const had = g.groups.length; g.clearGroups(); if (had) ng.forEach(x => g.addGroup(x.start, x.count, x.materialIndex));
    const remap = compactGeometry(g);
    if (remap) { const nd = new Set(); for (const v of this._det(g)) if (remap[v] >= 0) nd.add(remap[v]); this._detached.set(g, nd); }
    this._invalidateTopo(mesh); g.computeBoundingBox(); g.computeBoundingSphere();
    if (mesh.isSkinnedMesh) { mesh.boundingBox = null; mesh.boundingSphere = null; }
    return removed;
  }
  /** Make a face from 3 or 4 selected points of one mesh (in selection order). */
  makeFace() {
    const sel = this.selectedPoints();
    if (sel.size !== 1) return this.msg('Select 3 or 4 points on one mesh');
    const [mesh, s] = [...sel][0], pids = [...s];
    if (pids.length < 3 || pids.length > 4) return this.msg('Select 3 or 4 points on one mesh');
    return this._op('Make face', { geo: [mesh] }, () => {
      const t = this.topo(mesh), g = mesh.geometry, vs = pids.map(p => t.points[p][0]);
      const w = pids.map(p => new THREE.Vector3().fromArray(t.world, p * 3));
      const n = new THREE.Vector3().subVectors(w[2], w[1]).cross(v1.subVectors(w[0], w[1]));
      const toCam = new THREE.Vector3().subVectors(this.camera.position, w[0]);
      if (n.dot(toCam) < 0) vs.reverse();
      const tris = vs.length === 3 ? [vs] : [[vs[0], vs[1], vs[2]], [vs[0], vs[2], vs[3]]];
      const idx = ensureIndex(g), old = idx.array, out = new Uint32Array(old.length + tris.length * 3);
      out.set(old); let o = old.length; for (const tr of tris) for (const v of tr) out[o++] = v;
      g.setIndex(new THREE.BufferAttribute(out, 1));
      if (g.groups.length) { const last = g.groups[g.groups.length - 1]; if (last.start + last.count === old.length) last.count += tris.length * 3; else g.addGroup(old.length, tris.length * 3, 0); }
      this._invalidateTopo(mesh); this._finishGeometry(mesh, null);
      this._clearPointSel(); this._syncGizmo();
      return this.msg(`Made ${tris.length} triangle(s)`);
    });
  }
  /** Move the selected points by a world offset [dx,dy,dz]. */
  movePoints(offset) {
    const sel = this.selectedPoints(); const meshes = [...sel.keys()];
    if (!this.selectedPointCount()) return this.msg('Nothing selected');
    const d = new THREE.Vector3().fromArray(offset);
    return this._op('Move points', { pos: meshes }, () => {
      for (const [mesh, s] of sel) {
        const t = this.topo(mesh);
        this._setPointsWorld(mesh, [...s].map(p => [p, new THREE.Vector3().fromArray(t.world, p * 3).add(d)]));
        this._finishGeometry(mesh, [...s]);
      }
      this._syncGizmo(); this._updateSelWire();
      return this.selectedPointCount();
    });
  }
  /** Set one point's world position. */
  setPoint(meshName, pid, p) {
    const mesh = this.mesh(meshName);
    return this._op('Move point', { pos: [mesh] }, () => { this._setPointsWorld(mesh, [[pid, new THREE.Vector3().fromArray(p)]]); this._finishGeometry(mesh, [pid]); this._syncGizmo(); });
  }
  getPoints(meshName, pids) {
    const t = this._refreshWorld(this.mesh(meshName));
    return (pids || [...t.points.keys()]).map(p => [p, ...arr3(v1.fromArray(t.world, p * 3))]);
  }

  // ================= objects =================
  setObjectTransform(name, { position, rotation, scale } = {}) {
    const o = this.obj(name); if (!o) throw new Error('Not found: ' + name);
    return this._op('Move object', { objs: [o] }, () => {
      if (position) o.position.fromArray(position);
      if (rotation) o.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
      if (scale) o.scale.set(...(Array.isArray(scale) ? scale : [scale, scale, scale]));
      o.updateMatrixWorld(true); this._invalidateTopo(); this._syncGizmo();
    });
  }

  // ================= animation =================
  setAnimMode(on) {
    on = !!on;
    if (on && this.mode === 'build') { if (!this.root.children.length) throw new Error('Build mode makes the shape: press Make model first, then animate the model'); this.setMode('object'); } // animating means the model, not the build
    if (on === this.animMode) return;
    if (on) {
      this._rest = new Map(); this.root.traverse(o => this._rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
      if (this.mode === 'vertex' || this.mode === 'edge' || this.mode === 'draw') this.mode = 'bone';
      this.animMode = true;
      if (!this.clip) this.newClip();
      this._rebuildAction(); this.setTime(this.time);
      if (this.mode === 'bone') this.gizmoMode = 'rotate';
    } else {
      this.playing = false;
      if (this._rest) for (const [o, [p, q, s]] of this._rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
      this._rest = null; this.animMode = false;
      this._framedMeshes().forEach(m => this._showFrame(m, m.userData.frameDefault));
      this.root.updateMatrixWorld(true);
      if (this.mode === 'bone') this.gizmoMode = 'translate';
    }
    this.setMode(this.mode);
    this.msg(on ? 'Animate mode: rotate joints, keys are set automatically' : 'Edit mode: rest pose');
  }
  newClip(name = 'Action', duration = 2) {
    return this._op('New clip', { anim: true }, () => {
      let n = name, i = 2; while (this.clips.some(c => c.name === n)) n = `${name}_${i++}`;
      this.clips.push({ name: n, duration, tracks: {}, raw: [], frames: {} }); this.clipIndex = this.clips.length - 1;
      this.time = 0; this._rebuildAction(); return n;
    });
  }
  setClip(i) { this.clipIndex = typeof i === 'string' ? this.clips.findIndex(c => c.name === i) : i; this._rebuildAction(); this.setTime(0); this.changed(); }
  deleteClip(i = this.clipIndex) {
    return this._op('Delete clip', { anim: true }, () => { this.clips.splice(i, 1); this.clipIndex = Math.min(this.clipIndex, this.clips.length - 1); this._rebuildAction(); });
  }
  setClipProps({ name, duration } = {}) {
    if (!this.clip) return;
    return this._op('Clip settings', { anim: true }, () => { if (name) this.clip.name = name; if (duration > 0) this.clip.duration = duration; this._rebuildAction(); this.setTime(Math.min(this.time, this.clip.duration)); });
  }
  _rebuildAction() {
    this.mixer.stopAllAction();
    if (this._built) this.mixer.uncacheClip(this._built);
    this._built = null; this._action = null;
    const c = this.clip; if (!c) return;
    this._built = toThreeClip(c);
    this._action = this.mixer.clipAction(this._built);
    this._action.setLoop(this.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this._action.clampWhenFinished = true;
    this._action.play();
    if (this.animMode) this.mixer.setTime(this.time);
  }
  setTime(t) {
    const c = this.clip;
    this.time = Math.max(0, c ? Math.min(t, c.duration) : t);
    if (this.animMode && this._action) { this._action.reset(); this.mixer.setTime(this.time); this.root.updateMatrixWorld(true); } // reset: with Loop off a clip that reached its end is 'finished' and would ignore the new time
    if (this.animMode) this._applyFrameKeys();
    this.dispatchEvent(new Event('time'));
  }
  play() { if (!this.animMode) this.setAnimMode(true); if (this.clip && this.time >= this.clip.duration - 1e-6 && !this.loop) this.time = 0; this.playing = true; this.changed(); }
  pause() { this.playing = false; if (this.clip) this.setTime(Math.round(this.time * this.fps) / this.fps); this.changed(); }
  togglePlay() { this.playing ? this.pause() : this.play(); }
  setLoop(on) { this.loop = !!on; this._rebuildAction(); this.changed(); }
  /** Key selected joints (or given names) at the current time. props: subset of position/quaternion/scale. */
  key(names, props = PROPS) {
    if (!this.animMode) this.setAnimMode(true);
    const objs = names ? [].concat(names).map(x => this.obj(x)) : this.sel.bones.length ? this.sel.bones : this.mode === 'object' ? this.sel.meshes : [];
    if (!objs.length) return this.msg('Select joints to key');
    return this._op('Key', { anim: true }, () => { this._keyInternal(objs, props); return this.msg(`Keyed ${objs.length} at ${this.time.toFixed(2)}s`); });
  }
  _keyInternal(objs, props) {
    if (!this.clip) { this.clips.push({ name: 'Action', duration: 2, tracks: {}, raw: [] }); this.clipIndex = this.clips.length - 1; }
    const t = Math.round(this.time * this.fps) / this.fps;
    for (const o of objs) {
      const tr = this.clip.tracks[o.name] ||= {};
      for (const p of props) {
        const keys = tr[p] ||= [], v = o[p].toArray();
        const k = keys.find(k => Math.abs(k.t - t) < 1e-4);
        if (k) k.v = v; else { keys.push({ t, v }); keys.sort((a, b) => a.t - b.t); }
      }
    }
    this._rebuildAction();
  }
  /**
   * Slide joints (bone.userData.slide = {axis:[x,y,z] in the parent's frame, min, max in model units, rest:[x,y,z]}):
   * slide(name, v 0..1, t) puts the joint at that point of its rail and keys its position (Animate mode). Clamped to the ends.
   */
  slide(name, v, t) {
    const b = this.bone(name), s = this._slideOf(b);
    if (!s) throw new Error(`“${b.name}” is not a slide joint (make it one with editor.setSlide or in Build mode)`);
    if (!this.animMode) this.setAnimMode(true);
    if (t !== undefined) this.setTime(t);
    v = THREE.MathUtils.clamp(+v || 0, 0, 1);
    return this._op('Slide', { anim: true, rig: true }, () => {
      b.position.fromArray(s.rest).addScaledVector(new THREE.Vector3().fromArray(s.axis), s.min + v * (s.max - s.min));
      if (s.restQ) b.quaternion.fromArray(s.restQ);
      this._keyInternal([b], ['position']); this.setTime(this.time);
      return this.time;
    });
  }
  /** Where a slide joint is now on its rail, 0..1 (null if it is not one). */
  slideValue(name) {
    const b = this.bone(name), s = this._slideOf(b); if (!s) return null;
    const off = b.position.clone().sub(new THREE.Vector3().fromArray(s.rest)).dot(new THREE.Vector3().fromArray(s.axis));
    return THREE.MathUtils.clamp((off - s.min) / (s.max - s.min || 1), 0, 1);
  }
  /** Make a joint slide along a rail: {axis:[x,y,z] (its parent's frame), min, max} in model units from where it is now; null = normal joint. */
  setSlide(name, opts) {
    const b = this.bone(name);
    if (this.animMode) this.setAnimMode(false);
    return this._op(opts ? 'Make slide joint' : 'Remove slide joint', { rig: true }, () => {
      if (!opts) { delete b.userData.slide; return this.msg(`${b.name} is a normal joint again`); }
      const axis = new THREE.Vector3(...(opts.axis || [0, 1, 0])); if (axis.lengthSq() < 1e-12) throw new Error('The axis has no direction'); axis.normalize();
      let min = +(opts.min ?? 0), max = +(opts.max ?? 0.05); if (min > max) [min, max] = [max, min];
      b.userData.slide = { axis: axis.toArray(), min, max, rest: b.position.toArray(), restQ: b.quaternion.toArray() };
      return this.msg(`${b.name} now slides from ${min} to ${max} along its rail and does not turn`);
    });
  }
  _slideOf(b) { const s = b?.userData?.slide; if (!s || !s.axis) return null; if (!s.rest) s.rest = b.position.toArray(); return s; }
  // ---------------- expression frames (meshes made from framed sides: userData.frames = {name: [u, v, w, h]}, frame, frameDefault)
  _framedMeshes() { const a = []; this.root.traverse(o => { if (o.isMesh && o.userData.frames) a.push(o); }); return a; }
  _framedMesh(name) { const m = this._framedMeshes().find(o => o.name === name); if (!m) throw new Error(`No mesh with frames called “${name}” (framed: ${this._framedMeshes().map(o => o.name).join(', ') || 'none — add frames to a painted side in Build mode, then Make model'})`); return m; }
  /** Swap the picture: every uv moves by (new frame rect - default frame rect), from the uvs saved at the default frame. */
  _showFrame(m, frame) {
    const F = m.userData.frames, def = F[m.userData.frameDefault], to = F[frame]; if (!to || !def) return false;
    const uv = m.geometry.attributes.uv; if (!uv) return false;
    if (!m._uvBase) { // remember the uvs at the default frame (the ones that were saved)
      const cur = F[m.userData.frame] || def, dx = def[0] - cur[0], dy = def[1] - cur[1];
      m._uvBase = Array.from({ length: uv.count }, (_, i) => [uv.getX(i) + dx, uv.getY(i) + dy]);
    }
    const dx = to[0] - def[0], dy = to[1] - def[1];
    m._uvBase.forEach(([x, y], i) => uv.setXY(i, x + dx, y + dy)); uv.needsUpdate = true;
    m.userData.frame = frame; return true;
  }
  /** Frames of a framed mesh: {frames:[names], current, default}. */
  frames(name) { const m = this._framedMesh(name); return { frames: Object.keys(m.userData.frames), current: m.userData.frame, default: m.userData.frameDefault }; }
  /** Show a frame on a framed mesh (preview; in Animate mode use frameKey to make it part of the animation). */
  setFrame(name, frame) { const m = this._framedMesh(name); if (!this._showFrame(m, frame)) throw new Error(`No frame “${frame}” on ${name} (frames: ${Object.keys(m.userData.frames).join(', ')})`); this.changed(); return this.msg(`${name}: ${frame}`); }
  /** Make a frame the default (the picture the saved .glb starts with, and shown in Edit mode). */
  setDefaultFrame(name, frame) { const m = this._framedMesh(name); if (!m.userData.frames[frame]) throw new Error(`No frame “${frame}”`); this._showFrame(m, frame); m._uvBase = null; m.userData.frameDefault = frame; this._showFrame(m, frame); this.changed(); return this.msg(`${name} starts on “${frame}”`); }
  /** Key a frame switch at time t in the current animation (a step: it holds until the next key). */
  frameKey(name, frame, t) {
    const m = this._framedMesh(name); if (!m.userData.frames[frame]) throw new Error(`No frame “${frame}” on ${name} (frames: ${Object.keys(m.userData.frames).join(', ')})`);
    if (!this.animMode) this.setAnimMode(true);
    if (t !== undefined) this.setTime(t);
    return this._op('Frame key', { anim: true }, () => {
      const c = this.clip; c.frames ||= {}; const keys = (c.frames[name] ||= []);
      const i = keys.findIndex(k => Math.abs(k.t - this.time) < 1e-4); if (i >= 0) keys[i].frame = frame; else keys.push({ t: this.time, frame });
      keys.sort((a, b) => a.t - b.t); this._applyFrameKeys();
      return this.msg(`${name} shows “${frame}” from ${this.time.toFixed(2)} s`);
    });
  }
  _applyFrameKeys() {
    const c = this.clip; if (!c) return;
    for (const m of this._framedMeshes()) {
      const keys = c.frames?.[m.name]; let f = m.userData.frameDefault;
      if (keys?.length) { f = keys[0].frame; for (const k of keys) if (k.t <= this.time + 1e-6) f = k.frame; }
      if (m.userData.frame !== f || !m._uvBase) this._showFrame(m, f);
    }
  }
  /** Pose a joint by local euler degrees and key it (Animate mode). */
  pose(name, deg, t) {
    if (this._slideOf(this.bone(name))) throw new Error(`“${name}” is a slide joint: it moves along its rail and does not turn — use editor.slide('${name}', 0..1, t)`);
    if (!this.animMode) this.setAnimMode(true);
    if (t !== undefined) this.setTime(t);
    const b = this.bone(name);
    return this._op('Pose', { anim: true, rig: true }, () => {
      b.rotation.set(...deg.map(THREE.MathUtils.degToRad)); this._keyInternal([b], ['quaternion']); this.setTime(this.time);
      return this.time;
    });
  }
  /** Delete keys at time t (default: now) for given/selected objects (all objects if none selected). */
  deleteKeys(t = this.time, names) {
    if (!this.clip) return;
    const only = names ? [].concat(names).map(x => this.obj(x).name) : this.sel.bones.length ? this.sel.bones.map(b => b.name) : null;
    return this._op('Delete keys', { anim: true }, () => {
      let n = 0;
      for (const [node, props] of Object.entries(this.clip.tracks)) {
        if (only && !only.includes(node)) continue;
        for (const p of Object.keys(props)) { const before = props[p].length; props[p] = props[p].filter(k => Math.abs(k.t - t) > 1e-4); n += before - props[p].length; if (!props[p].length) delete props[p]; }
        if (!Object.keys(props).length) delete this.clip.tracks[node];
      }
      for (const [mesh, keys] of Object.entries(this.clip.frames || {})) { if (only && !only.includes(mesh)) continue; const before = keys.length; this.clip.frames[mesh] = keys.filter(k => Math.abs(k.t - t) > 1e-4); n += before - this.clip.frames[mesh].length; if (!this.clip.frames[mesh].length) delete this.clip.frames[mesh]; }
      this._rebuildAction(); this.setTime(this.time);
      return this.msg(`Deleted ${n} key(s)`);
    });
  }
  /** Move keys from time a to time b (given/selected objects, or all). */
  moveKeys(a, b, names) {
    if (!this.clip) return;
    b = Math.max(0, Math.min(this.clip.duration, Math.round(b * this.fps) / this.fps));
    const only = names ? [].concat(names) : null;
    return this._op('Move keys', { anim: true }, () => {
      for (const [node, props] of Object.entries(this.clip.tracks)) {
        if (only && !only.includes(node)) continue;
        for (const keys of Object.values(props)) {
          const k = keys.find(k => Math.abs(k.t - a) < 1e-4); if (!k) continue;
          const i = keys.findIndex(x => x !== k && Math.abs(x.t - b) < 1e-4); if (i >= 0) keys.splice(i, 1);
          k.t = b; keys.sort((x, y) => x.t - y.t);
        }
      }
      this._rebuildAction(); this.setTime(this.time);
    });
  }
  /** Make the loop seamless: copy the keys at t=0 to the end of the clip. */
  closeLoop() {
    if (!this.clip) return;
    return this._op('Close loop', { anim: true }, () => {
      const d = this.clip.duration; let n = 0;
      for (const props of Object.values(this.clip.tracks)) for (const keys of Object.values(props)) {
        const first = keys.find(k => Math.abs(k.t) < 1e-4) || keys[0]; if (!first) continue;
        const end = keys.find(k => Math.abs(k.t - d) < 1e-4);
        if (end) end.v = first.v.slice(); else keys.push({ t: d, v: first.v.slice() });
        keys.sort((a, b) => a.t - b.t); n++;
      }
      this._rebuildAction(); this.setTime(this.time);
      return this.msg(`Loop closed (${n} tracks end where they start)`);
    });
  }
  /** Sorted unique key times; for one object name, or the whole clip. */
  keyTimes(name) {
    const s = new Set(); if (!this.clip) return [];
    for (const [node, props] of Object.entries(this.clip.tracks)) { if (name && node !== name) continue; for (const keys of Object.values(props)) keys.forEach(k => s.add(Math.round(k.t * 1e4) / 1e4)); }
    for (const [mesh, keys] of Object.entries(this.clip.frames || {})) { if (name && mesh !== name) continue; keys.forEach(k => s.add(Math.round(k.t * 1e4) / 1e4)); }
    return [...s].sort((a, b) => a - b);
  }

  // ================= camera / info =================
  frame(sel = true) {
    if (this.mode === 'build' && this.build) return this.build.frame();
    const box = new THREE.Box3();
    if (sel && this.mode === 'object' && this.sel.meshes.length) this.sel.meshes.forEach(m => box.expandByObject(m));
    else if (sel && (this.mode === 'bone' || this.mode === 'draw') && this.sel.bones.length) this.sel.bones.forEach(b => box.expandByPoint(b.getWorldPosition(v1)));
    else if (sel && this.selectedPointCount()) for (const [m, s] of this.selectedPoints()) { const w = this.topo(m).world; for (const p of s) box.expandByPoint(v1.fromArray(w, p * 3)); }
    if (box.isEmpty()) box.setFromObject(this.root);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(v1).length() / 2, this.sceneSize * 0.05);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c); this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = dist / 1000; this.camera.far = dist * 100; this.camera.updateProjectionMatrix(); this.orbit.update();
  }
  /** Set the camera: view('front'|'back'|'left'|'right'|'top'|'persp') */
  view(name = 'persp') {
    const d = this.camera.position.distanceTo(this.orbit.target), t = this.orbit.target;
    if (!VIEW_DIRS[name]) throw new Error('View must be ' + Object.keys(VIEW_DIRS).join(', '));
    this.camera.position.copy(t).addScaledVector(new THREE.Vector3(...VIEW_DIRS[name]).normalize(), d); this.orbit.update();
  }
  /** Compact JSON summary of the scene, rig, clips and selection. */
  info() {
    this.root.updateMatrixWorld(true);
    const bones = this.allBones();
    return {
      file: this.fileName, mode: this.mode, animMode: this.animMode, time: r3(this.time),
      meshes: this.meshes().map(m => { const t = this.topo(m); return { name: m.name, verts: m.geometry.attributes.position.count, points: t.points.length, edges: t.edges.length / 2, tris: t.triCount, skinned: !!m.isSkinnedMesh }; }),
      bones: bones.map(b => ({ name: b.name, parent: b.parent?.isBone ? b.parent.name : null, world: arr3(b.getWorldPosition(v1)) })),
      clips: this.clips.map((c, i) => ({ name: c.name, duration: c.duration, active: i === this.clipIndex, tracks: Object.keys(c.tracks).length, keyTimes: i === this.clipIndex ? this.keyTimes() : undefined })),
      selection: {
        meshes: this.sel.meshes.map(m => m.name), bones: this.sel.bones.map(b => b.name),
        points: [...this.selectedPoints()].map(([m, s]) => ({ mesh: m.name, count: s.size, pids: [...s].slice(0, 50) })),
      },
      undo: this.undoStack.map(e => e.label).slice(-5),
    };
  }
  /** What is on show: the Build parts in Build mode, else the model (null if empty). */
  _contentBox() {
    const box = new THREE.Box3();
    if (this.mode === 'build' && this.build?.active) this.scene.getObjectByName('__build')?.traverseVisible(o => { if (o.isMesh && !(o.material?.wireframe)) box.expandByObject(o); });
    else this.root.traverseVisible(o => { if (o.isMesh) box.expandByObject(o); });
    return box.isEmpty() ? null : box;
  }
  /**
   * A picture made off-screen, the same size whatever the window / docked panels look like, without moving the view.
   * opts: width (800), height (width × 3/4), view (front|back|left|right|top|bottom|persp; default the current angle) or
   * views: [...] = a contact sheet (2 or 3 columns, each labelled), whole (true: fit the whole model, ignoring what is picked;
   * false: the current camera). Returns a PNG data URL.
   */
  snapshot({ width = 800, height = null, view = null, views = null, whole = true } = {}) {
    const list = views?.length ? views : [view];
    for (const v of list) if (v && !VIEW_DIRS[v]) throw new Error('View must be ' + Object.keys(VIEW_DIRS).join(', '));
    const cols = list.length === 1 ? 1 : list.length <= 4 ? 2 : 3, rows = Math.ceil(list.length / cols);
    const W = Math.max(100, Math.min(2400, Math.round(width))), H = Math.max(80, Math.min(2400, Math.round(height || W * 3 / 4)));
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
    this._tick(); // overlays and Build parts up to date (also for a tab in the background)
    const cam = this.camera.clone(); cam.aspect = cw / ch;
    const box = whole ? this._contentBox() : null, out = document.createElement('canvas'); out.width = cw * cols; out.height = ch * rows;
    const cx = out.getContext('2d'), rt = new THREE.WebGLRenderTarget(cw, ch, { samples: 4, colorSpace: THREE.SRGBColorSpace }), buf = new Uint8Array(cw * ch * 4), img = new ImageData(cw, ch);
    const hide = [this.gizmo, this.build?._internals?.tc].filter(o => o?.visible); hide.forEach(o => { o.visible = false; });
    const prev = this.renderer.getRenderTarget();
    try {
      list.forEach((v, i) => {
        const target = box ? box.getCenter(new THREE.Vector3()) : this.orbit.target.clone();
        const dir = v ? new THREE.Vector3(...VIEW_DIRS[v]).normalize() : this.camera.position.clone().sub(this.orbit.target).normalize();
        let dist = this.camera.position.distanceTo(this.orbit.target);
        if (box) { const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.02), fv = THREE.MathUtils.degToRad(cam.fov / 2), fh = Math.atan(Math.tan(fv) * cam.aspect); dist = r / Math.sin(Math.min(fv, fh)) * 1.05; }
        cam.position.copy(target).addScaledVector(dir, dist); cam.up.set(0, 1, 0); cam.near = dist / 1000; cam.far = dist * 100; cam.lookAt(target); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        this.renderer.setRenderTarget(rt); this.renderer.render(this.scene, cam);
        this.renderer.readRenderTargetPixels(rt, 0, 0, cw, ch, buf);
        for (let y = 0; y < ch; y++) img.data.set(buf.subarray((ch - 1 - y) * cw * 4, (ch - y) * cw * 4), y * cw * 4);
        const x0 = (i % cols) * cw, y0 = Math.floor(i / cols) * ch; cx.putImageData(img, x0, y0);
        if (list.length > 1) { cx.font = '600 14px system-ui, sans-serif'; cx.fillStyle = this.light ? '#1d2229' : '#dfe3ea'; cx.fillText(v || 'view', x0 + 8, y0 + 20); cx.strokeStyle = this.light ? '#b0b6c0' : '#14161a'; cx.strokeRect(x0 + 0.5, y0 + 0.5, cw - 1, ch - 1); }
      });
    } finally { this.renderer.setRenderTarget(prev); rt.dispose(); hide.forEach(o => { o.visible = true; }); }
    return out.toDataURL('image/png');
  }
  /** Sprite sheets (src/sprites.js): PNG + JSON into Library/Sprites/<model>/. See CLAUDE.md "Sprite sheets". */
  async renderSprites(opts = {}) { const { renderSprites } = await import('./sprites.js'); return renderSprites(this, opts); }
  screenshotDataURL(w = 800) {
    this._tick(); // a full frame (overlays, Build parts), also for a tab in the background that is not drawing by itself
    const c = document.createElement('canvas'), src = this.dom; c.width = w; c.height = Math.round(w * src.height / src.width);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/png');
  }

  // ================= loop =================
  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.playing && this.animMode && this.clip) {
      let t = this.time + dt * this.speed;
      const d = this.clip.duration;
      if (t > d) { if (this.loop) t = t % d; else { t = d; this.playing = false; this.changed(); } }
      this.setTime(t);
    }
    this.scene.updateMatrixWorld();
    this.build?.tick();
    this._updateColliders();
    this._updateBoneOverlay();
    this._updateBoxHelpers();
    this.renderer.render(this.scene, this.camera);
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
