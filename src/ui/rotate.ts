/**
 * The rotate screen: iPadOS has no orientation lock for web apps, so in portrait a full-screen card asks for
 * landscape. It is shown by a CSS media query (shell.css, `orientation: portrait`), not by script, so it follows the
 * device at once and needs no resize listener. It covers everything, so no stray touch reaches the panel meanwhile.
 */

/** Mounts the rotate screen into `root`. Returns a function that removes it. */
export function mountRotateScreen(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const screen = doc.createElement('div');
  screen.className = 'rotate-screen';
  screen.setAttribute('role', 'alert');
  const device = doc.createElement('div');
  device.className = 'rotate-device';
  device.setAttribute('aria-hidden', 'true');
  const text = doc.createElement('p');
  text.className = 'rotate-text';
  text.textContent = 'ROTATE TO LANDSCAPE';
  screen.append(device, text);
  root.append(screen);
  return () => screen.remove();
}
