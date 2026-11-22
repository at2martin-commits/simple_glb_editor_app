// Copies the parts of three.js the editor uses into vendor/three (served at /vendor/three/).
// Runs automatically before `npm run dist`; run manually after upgrading three.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'node_modules', 'three'), out = path.join(__dirname, '..', 'vendor', 'three');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'build'), { recursive: true });
fs.copyFileSync(path.join(src, 'build', 'three.module.js'), path.join(out, 'build', 'three.module.js'));
fs.cpSync(path.join(src, 'examples', 'jsm'), path.join(out, 'jsm'), { recursive: true });
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE')); // (MIT: the notice travels with the copy)
console.log('three.js vendored to', out);
// three-bvh-csg (combine shapes in Build mode) + three-mesh-bvh, plain ES modules served at /vendor/<name>/
for (const pkg of ['three-mesh-bvh', 'three-bvh-csg']) {
  const from = path.join(__dirname, '..', 'node_modules', pkg), to = path.join(__dirname, '..', 'vendor', pkg);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(from, 'src'), path.join(to, 'src'), { recursive: true });
  fs.copyFileSync(path.join(from, 'LICENSE'), path.join(to, 'LICENSE'));
  console.log(pkg, 'vendored to', to);
}
// qrcode-generator (MIT): QR codes in the "Watch from other devices" window, a classic script at /vendor/qrcode/qrcode.js
{
  const to = path.join(__dirname, '..', 'vendor', 'qrcode');
  fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'qrcode-generator', 'qrcode.js'), path.join(to, 'qrcode.js'));
  console.log('qrcode-generator vendored to', to);
}
// xterm.js (MIT): the in-app Claude Code terminal, classic scripts at /vendor/xterm/ (window.Terminal, window.FitAddon)
{
  const to = path.join(__dirname, '..', 'vendor', 'xterm'), nm = path.join(__dirname, '..', 'node_modules', '@xterm');
  fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(nm, 'xterm', 'lib', 'xterm.js'), path.join(to, 'xterm.js'));
  fs.copyFileSync(path.join(nm, 'xterm', 'css', 'xterm.css'), path.join(to, 'xterm.css'));
  fs.copyFileSync(path.join(nm, 'addon-fit', 'lib', 'addon-fit.js'), path.join(to, 'addon-fit.js'));
  fs.copyFileSync(path.join(nm, 'xterm', 'LICENSE'), path.join(to, 'LICENSE'));
  console.log('xterm vendored to', to);
}
// the shared AI panel (github.com/Marty-s-Stuff/ai-panel, the tag in package.json): its page files at /vendor/ai-panel/
// (its engine, node/aipanel.js, and built-in plugins are used straight from node_modules by main.js; xterm stays ours above)
{
  const to = path.join(__dirname, '..', 'vendor', 'ai-panel'), from = path.join(__dirname, '..', 'node_modules', 'ai-panel');
  fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true });
  for (const f of ['ai-panel.html', 'ai-panel.css', 'ai-panel.js']) fs.copyFileSync(path.join(from, f), path.join(to, f));
  console.log('ai-panel vendored to', to);
}
