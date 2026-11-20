// Desktop notifications ("Claude is done", "Claude asks you something") — only while you are not looking at that work.
// Uses the browser Notification API (a Windows toast in the desktop app; main.js sets the app id). Clicking one brings
// the editor forward and runs onClick. Switch: settings.notify (View > "Notify me when Claude finishes").
import { settings } from './settings.js';

export const notifyOn = () => settings.get('notify', true) !== false;
/** true when the editor window is not the one you are using right now */
export const away = () => document.hidden || !document.hasFocus();

let lastKey = '', lastAt = 0;
export function notify(title, body, onClick) {
  if (!notifyOn() || typeof Notification === 'undefined') return null;
  const key = title + '|' + body; if (key === lastKey && performance.now() - lastAt < 8000) return null; // no repeats
  lastKey = key; lastAt = performance.now();
  try {
    const n = new Notification(title, { body, icon: '/icon.png', silent: false });
    n.onclick = () => { window.glbApp?.focus?.(); window.focus(); try { onClick?.(); } catch {} n.close(); };
    return n;
  } catch { return null; }
}
