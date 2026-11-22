// Preload: the only bridge from the editor window to the desktop side. It exposes the in-app terminal (Claude Code)
// (AI assistant plugins) as window.glbTerm, plus window.glbApp (focus, the menu line); nothing else. (Runs sandboxed: only `electron` can be required here.)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glbApp', { focus: () => ipcRenderer.send('win:focus'), // bring the window forward (clicking a notification)
  menu: () => ipcRenderer.invoke('menu:get'), menuRun: (what, checked) => ipcRenderer.send('menu:run', what, checked) }); // the menu line (main.js menuTemplate)
contextBridge.exposeInMainWorld('glbTerm', {
  agents: () => ipcRenderer.invoke('agents:list'),           // the AI assistant plugins: [{id, name, program, icon, installed, install, signIn:[{id,label,tip}], signOut, ...}]
  openAgentsFolder: () => ipcRenderer.invoke('agents:openFolder'), // your plugins folder in Explorer (made if missing, with the guide) -> its path
  info: agent => ipcRenderer.invoke('term:info', agent),     // one plugin (same shape)
  status: agent => ipcRenderer.invoke('term:status', agent), // its sign-in status: {installed, loggedIn, method}
  start: opts => ipcRenderer.invoke('term:start', opts),     // {agent, kind: 'chat'|'signin'|'signout'|'version', signInId, cwd, cols, rows} -> id
  pickFolder: start => ipcRenderer.invoke('term:pickFolder', start), // the Windows folder picker -> path | null
  folderExists: p => ipcRenderer.invoke('term:folderExists', p),
  write: (id, data) => ipcRenderer.send('term:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  kill: id => ipcRenderer.send('term:kill', id),
  onData: cb => ipcRenderer.on('term:data', (_e, id, data) => cb(id, data)),
  onExit: cb => ipcRenderer.on('term:exit', (_e, id, code) => cb(id, code)),
  update: (what, tag) => ipcRenderer.invoke('aipanel:update', what, tag), // panel updates: 'check' | 'install' (tag) | 'builtin'
});
