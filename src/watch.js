// Watch publisher: keeps the read-only watch page (watch.html) up to date with what the editor shows.
// After every editing step (anything that makes an undo step, loads, clears, switches mode or shows/hides things) the
// visible scene is exported as a .glb and sent to the local server; a small state (mode, animation, time, last message)
// is sent a few times a second. The page plays animations itself, so playback costs nothing here.
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export function initWatch(ed) { // one feed per tab: ed.watchInfo() = {key, label, claude, active} (set by tabs.js)
  let editVer = 1, sentVer = 0, busy = false, lastState = '', lastSceneAt = 0, viewers = 0, lastPing = 0;
  const bump = () => { editVer++; };
  const wrap = (obj, name, after = bump) => { const f = obj?.[name]; if (typeof f !== 'function') return; obj[name] = function (...a) { const r = f.apply(this, a); if (r && typeof r.then === 'function') return r.then(v => { after(); return v; }, e => { after(); throw e; }); after(); return r; }; };
  for (const n of ['_pushUndo', 'undo', 'redo', 'load', 'clear', 'setLayer', 'setFrame', 'setDefaultFrame', 'setMode', 'loadDummy', 'newProject']) wrap(ed, n);
  const b = ed.build;
  for (const n of ['open', 'newDoc', 'setLayerVisible', 'setCollidersVisible']) wrap(b, n); // (Build edits go through _pushUndo)

  const exporter = new GLTFExporter();
  async function publishScene() {
    busy = true;
    const v = editVer;
    try {
      let target, animations = [];
      const hidden = [];
      if (ed.mode === 'build' && b?.active) {
        target = ed.scene.getObjectByName('__build');
        target.traverse(o => { if (o.isMesh && [].concat(o.material).some(m => m?.wireframe) && o.visible) { o.visible = false; hidden.push(o); } }); // colliders / markers stay out
      } else {
        target = ed.root;
        animations = ed._threeClips ? ed._threeClips() : [];
      }
      target.updateMatrixWorld(true);
      const glb = await exporter.parseAsync(target, { binary: true, animations, onlyVisible: true });
      hidden.forEach(o => { o.visible = true; });
      await fetch('/api/watch/scene?tab=' + encodeURIComponent(info().key), { method: 'PUT', body: glb });
      sentVer = v; lastSceneAt = performance.now(); lastState = ''; // send the state right after a new scene
    } catch (e) { console.warn('watch: could not publish the scene', e); sentVer = v; }
    finally { busy = false; }
  }
  function state() {
    const c = ed.clip;
    return {
      mode: ed.mode, build: ed.mode === 'build', anim: !!ed.animMode, clip: c?.name || null, duration: c?.duration || 0,
      time: Math.round(ed.time * 1000) / 1000, playing: !!ed.playing, speed: ed.speed || 1, loop: !!ed.loop,
      file: ed.mode === 'build' ? (b?.libRel || (b?.doc?.name ? b.doc.name + '.bbmodel' : '')) : (ed.libRel || ed.fileName || ''),
      message: ed.lastMessage || '', busy: editVer !== sentVer,
    };
  }
  const info = () => ed.watchInfo?.() || { key: 'main', label: '', claude: false, active: true };
  const timer = setInterval(() => {
    if (ed.disposed) { clearInterval(timer); fetch('/api/watch/state?tab=' + encodeURIComponent(info().key), { method: 'POST', body: '{"gone":true}' }).catch(() => {}); return; } // tab closed
    if (viewers && !busy && editVer !== sentVer && performance.now() - lastSceneAt > 350) publishScene(); // nobody watching = no export
    const w = info(), s = { ...state(), label: w.label, claude: w.claude, active: w.active }, key = JSON.stringify({ ...s, time: s.playing ? 0 : s.time }); // while playing the page keeps time itself
    if (key !== lastState || performance.now() - lastPing > 2000) { // also asks every 2 s whether anyone is watching
      lastState = key; lastPing = performance.now();
      fetch('/api/watch/state?tab=' + encodeURIComponent(w.key), { method: 'POST', body: JSON.stringify(s) }).then(r => r.json()).then(j => { viewers = j.viewers || 0; }).catch(() => {});
    }
  }, 250);
  return { bump };
}
