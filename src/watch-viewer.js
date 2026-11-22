// The read-only watch page: shows what the editor shows (its model or its Build-mode parts), live, with its own camera.
// It only ever reads: GET /api/watch/events (version + state), GET /api/watch/scene (.glb). Nothing here can edit.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = s => document.querySelector(s);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('#view').appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2b2d31);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(3, 5, 4); scene.add(sun);
const grid = new THREE.GridHelper(10, 20, 0x5a5d63, 0x3a3d42); scene.add(grid);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000); camera.position.set(2.6, 1.8, 3.6);
const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 0.9, 0); controls.enableDamping = true; controls.update();
const loader = new GLTFLoader();

let content = null, mixer = null, clips = [], action = null, framedOnce = false, loadedVer = -1, loading = false, wantVer = 0;
let st = {}, stAt = performance.now(), skel = null, showBones = false, rest = [];
let pick = new URLSearchParams(location.search).get('tab') || 'follow', es = null, curTab = null; // which editor tab to watch ('follow' = the one shown in the editor)

function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

function frame() {
  if (!content) return;
  const box = new THREE.Box3().setFromObject(content); if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.05);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1, dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c); camera.position.copy(c).addScaledVector(dir, dist); camera.near = dist / 1000; camera.far = dist * 100; camera.updateProjectionMatrix(); controls.update();
}
$('#btnFrame').onclick = frame;
$('#btnBones').onclick = () => { showBones = !showBones; if (skel) skel.visible = showBones; $('#btnBones').style.borderColor = showBones ? '#ff8c1a' : ''; };

async function loadScene(ver) {
  if (loading) { wantVer = ver; return; }
  loading = true; const forTab = curTab;
  try {
    const res = await fetch(`/api/watch/scene?tab=${encodeURIComponent(curTab || 'follow')}&v=${ver}`, { cache: 'no-store' });
    if (res.status === 204) { loadedVer = ver; return; }
    if (!res.ok) throw new Error(res.status);
    const buf = await res.arrayBuffer(), gltf = await new Promise((ok, no) => loader.parse(buf, '', ok, no));
    if (forTab !== curTab) return; // switched to another tab meanwhile
    if (content) { scene.remove(content); content.traverse(o => { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) { m.map?.dispose?.(); m.dispose?.(); } }); }
    if (skel) { scene.remove(skel); skel = null; }
    content = gltf.scene; scene.add(content);
    content.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    let hasBones = false; content.traverse(o => { if (o.isBone) hasBones = true; });
    if (hasBones) { skel = new THREE.SkeletonHelper(content); skel.visible = showBones; scene.add(skel); }
    rest = []; content.traverse(o => rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()])); // the pose to go back to when no animation plays
    clips = gltf.animations || []; mixer = clips.length ? new THREE.AnimationMixer(content) : null; action = null;
    $('#empty').style.display = 'none';
    if (!framedOnce && !new THREE.Box3().setFromObject(content).isEmpty()) { framedOnce = true; frame(); } // fit the first time there is something to see
    loadedVer = ver; applyState();
  } catch (e) { console.warn(e); }
  finally { loading = false; if (wantVer && (wantVer > loadedVer || forTab !== curTab)) { const v = wantVer; wantVer = 0; loadScene(v); } }
}
function applyState() {
  $('#file').textContent = st.file || '';
  $('#mode').textContent = st.mode ? (st.build ? 'Build' : st.mode) + (st.anim ? ' · animate' : '') : '';
  $('#msg').textContent = st.message || '';
  $('#msg').title = st.message || '';
  if (!mixer) return;
  const clip = st.anim && st.clip ? clips.find(c => c.name === st.clip) : null;
  if (!clip) { if (action) { mixer.stopAllAction(); action = null; for (const [o, p, q, sc] of rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); } } return; }
  if (!action || action.getClip() !== clip) { mixer.stopAllAction(); action = mixer.clipAction(clip); action.setLoop(st.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); action.clampWhenFinished = true; action.play(); }
}
function clipTime() { // where the editor is in its animation now (it sends a time when playback starts / stops; we keep the clock)
  let t = st.time || 0;
  if (st.playing) { t += (performance.now() - stAt) / 1000 * (st.speed || 1); const d = st.duration || action?.getClip().duration || 1; t = st.loop ? t % d : Math.min(t, d); }
  return t;
}

function renderPicker(d) {
  const sel = $('#tabPick'), opts = [['follow', 'Follow the editor'], ...d.tabs.map(t => [t.key, t.label])];
  const html = opts.map(([k, l]) => `<option value="${k}">${l.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</option>`).join('');
  if (html !== sel.dataset.html) { sel.dataset.html = html; sel.innerHTML = html; }
  sel.value = opts.some(o => o[0] === pick) ? pick : 'follow';
  sel.hidden = d.tabs.length < 2 && pick === 'follow';
}
function connect() {
  es?.close();
  es = new EventSource('/api/watch/events?tab=' + encodeURIComponent(pick));
  es.onopen = () => { $('#live').textContent = 'Live'; $('#live').classList.add('on'); };
  es.onmessage = e => {
    const d = JSON.parse(e.data); renderPicker(d);
    const tab = pick !== 'follow' && d.feeds[pick] ? pick : d.active, f = d.feeds[tab];
    if (!f) { if (pick !== 'follow' && !d.feeds[pick]) $('#msg').textContent = 'That tab was closed — following the editor'; return; }
    if (tab !== curTab) { curTab = tab; loadedVer = -1; } // another tab: load its scene
    st = f.state || {}; stAt = performance.now();
    if (f.ver > loadedVer) loadScene(f.ver); else applyState();
  };
  es.onerror = () => { $('#live').textContent = 'Editor not reachable — retrying…'; $('#live').classList.remove('on'); };
}
$('#tabPick').onchange = e => { pick = e.target.value; const u = new URL(location.href); if (pick === 'follow') u.searchParams.delete('tab'); else u.searchParams.set('tab', pick); history.replaceState(null, '', u); connect(); };
connect();

renderer.setAnimationLoop(() => {
  if (mixer && action) { action.reset(); mixer.setTime(clipTime()); } // reset: a finished one-shot clip would ignore the new time
  controls.update();
  renderer.render(scene, camera);
});
