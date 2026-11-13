/**
 * Computer (desktop) notifications through the browser. They show while the CRM is open in a tab,
 * even when the window is minimised or behind other windows. Nothing is shown when the browser is closed.
 */
export const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export const desktopPermission = (): NotificationPermission | 'unsupported' =>
  desktopSupported() ? Notification.permission : 'unsupported';

/** Asks the browser for permission. Must be called from a click. */
export async function requestDesktop(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/** Whether the person is looking at the CRM right now (then the in-page popup is enough). */
export const pageInView = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Shows a computer notification if allowed and the CRM isn't in view.
 * `tag` stops the same alert from showing twice; clicking it brings the CRM forward and runs onClick.
 */
export function notifyDesktop(title: string, opts: { body?: string; tag: string; onClick?: () => void }) {
  if (!desktopSupported() || Notification.permission !== 'granted' || pageInView()) return false;
  try {
    const n = new Notification(title, { body: opts.body, tag: opts.tag, icon: '/favicon-192.png', badge: '/favicon-48.png' });
    n.onclick = () => { window.focus(); opts.onClick?.(); n.close(); };
    return true;
  } catch {
    return false; // Some browsers only allow notifications from a service worker.
  }
}
