// Renders icon.svg to icon.png (256x256) with Electron:  npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(__dirname, '..', 'icon.svg'), 'utf8').replace('width="512" height="512"', 'width="256" height="256"');
  await w.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise(r => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.writeFileSync(path.join(__dirname, '..', 'icon.png'), img.resize({ width: 256, height: 256 }).toPNG());
  app.quit();
});
