/**
 * The POWER switch and the TAP POWER TO RESUME prompt: shell controls on the tabletop, outside the panel replica (the
 * hardware's power switch is on its rear panel).
 *
 *  - POWER acts on `click`. On a touch screen a tap only counts as a user activation when it ends, and the
 *    AudioContext and getUserMedia need that activation, so pointerdown would be too early on the iPad.
 *  - It is a `div` with role="switch", never focusable: Space and Enter belong to the panel's keyboard map.
 *  - The prompt covers the panel (so taps on a looper without audio do nothing) but not the shelf: POWER and the
 *    recorder pod stay usable above it. A tap on the prompt itself resumes too.
 */

import type { PowerState } from '../app/unit';

export interface PowerSwitch {
  /** Shows the power state (booting and stopping show the switch moving, its LED blinking). */
  setState(state: PowerState): void;
  /** Shows or hides TAP POWER TO RESUME. */
  setResume(on: boolean): void;
  /** A short note beside the switch (AUDIO ERROR, STORAGE ERROR), or null. */
  setNote(text: string | null): void;
  dispose(): void;
}

/**
 * Mounts the switch into `shelf` and the resume prompt into `overlayRoot`. `onTap` runs for a tap on either, inside
 * the click handler (so with its user activation).
 */
export function mountPowerSwitch(shelf: HTMLElement, overlayRoot: HTMLElement, onTap: () => void): PowerSwitch {
  const doc = shelf.ownerDocument;
  const span = (cls: string, text?: string): HTMLSpanElement => {
    const s = doc.createElement('span');
    s.className = cls;
    if (text !== undefined) s.textContent = text;
    return s;
  };

  const wrap = doc.createElement('div');
  wrap.className = 'power';
  const sw = doc.createElement('div');
  sw.className = 'power-switch';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Power');
  sw.setAttribute('aria-checked', 'false');
  sw.dataset.state = 'off';
  const rocker = span('power-rocker');
  rocker.append(span('power-knob'));
  sw.append(span('power-led'), rocker, span('power-label', 'POWER'));
  const note = doc.createElement('div');
  note.className = 'power-note';
  note.setAttribute('role', 'status');
  wrap.append(sw, note);
  shelf.append(wrap);

  const overlay = doc.createElement('div');
  overlay.className = 'resume-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-label', 'Tap power to resume');
  const card = doc.createElement('div');
  card.className = 'resume-card';
  card.append(span('resume-title', 'AUDIO STOPPED'), span('resume-text', 'TAP POWER TO RESUME'));
  overlay.append(card);
  overlayRoot.append(overlay);

  const onClick = (e: Event): void => {
    e.preventDefault();
    onTap();
  };
  const noFocus = (e: Event): void => e.preventDefault(); // a mouse press must not move focus or select text
  sw.addEventListener('click', onClick);
  sw.addEventListener('mousedown', noFocus);
  overlay.addEventListener('click', onClick);

  return {
    setState(state) {
      sw.dataset.state = state;
      sw.setAttribute('aria-checked', String(state === 'on' || state === 'booting'));
    },
    setResume(on) {
      overlay.hidden = !on;
      sw.classList.toggle('is-resume', on);
    },
    setNote(text) {
      note.textContent = text ?? '';
    },
    dispose() {
      sw.removeEventListener('click', onClick);
      sw.removeEventListener('mousedown', noFocus);
      overlay.removeEventListener('click', onClick);
      wrap.remove();
      overlay.remove();
    },
  };
}
