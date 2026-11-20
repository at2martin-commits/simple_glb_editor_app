// Settings saved on disk by the local server (key bindings, window layout, mouse buttons, ...).
// Stored on disk rather than in localStorage because the desktop app gets a new port every run.
let data = {};
let pending = {}, timer = 0;

export async function loadSettings() {
  try { data = await (await fetch('/api/settings')).json() || {}; } catch { data = {}; }
  return data;
}
export const settings = {
  get: (k, def) => (data[k] === undefined ? def : data[k]),
  set(k, v) {
    data[k] = v; pending[k] = v;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const body = JSON.stringify(pending); pending = {};
      fetch('/api/settings', { method: 'PUT', body }).catch(() => {});
    }, 250);
  },
};
