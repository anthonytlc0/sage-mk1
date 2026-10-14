/**
 * The POWER switch and the TAP POWER TO RESUME prompt: shell controls on the tabletop, outside the panel replica (the
 * hardware's power switch is on its rear panel).
 *
 *  - POWER acts on `click`. On a touch screen a tap only counts as a user activation when it ends, and the
 *    AudioContext and getUserMedia need that activation, so pointerdown would be too early on the iPad.
 *  - It is a `div` with role="switch", never focusable: Space and Enter belong to the panel's keyboard map.
 *  - The prompt covers the panel (so taps on a looper without audio do nothing) but not the shelf: POWER and the
 *    recorder pod stay usable above it. A tap on the prompt itself always retries the resume. Once a retry has failed
 *    (or one has gone unanswered for a while) the prompt says the next POWER tap switches off (ruling R58), and the
 *    POWER LED blinks faster. When the engine itself has stopped (ruling R67) the prompt says ENGINE STOPPED and asks
 *    for POWER off and on; a tap on it does nothing.
 */

import type { PowerState, ResumePrompt } from '../app/unit';

/** The prompt's lines for each state: a title, the main line and a hint. */
const PROMPT_TEXT: Record<Exclude<ResumePrompt, 'none'>, readonly [string, string, string]> = {
  resume: ['AUDIO STOPPED', 'TAP POWER TO RESUME', ''],
  resuming: ['AUDIO STOPPED', 'RESUMING...', ''],
  slow: ['NOT RESPONDING', 'TAP POWER TO SWITCH OFF', ''],
  off: ['RESUME FAILED', 'TAP POWER TO SWITCH OFF', 'TAP HERE TO TRY AGAIN'],
  // Ruling R67: the engine failed. POWER off keeps the unsaved work for RECOVER? at the next power-on.
  stopped: ['ENGINE STOPPED', 'SWITCH POWER OFF AND ON', 'UNSAVED WORK IS KEPT FOR RECOVER?'],
};

export interface PowerSwitch {
  /** Shows the power state (booting and stopping show the switch moving, its LED blinking). */
  setState(state: PowerState): void;
  /** Shows TAP POWER TO RESUME in the given state, or hides it ('none'). */
  setResume(prompt: ResumePrompt): void;
  /** A short note beside the switch (AUDIO ERROR, STORAGE ERROR), or null. */
  setNote(text: string | null): void;
  dispose(): void;
}

/**
 * Mounts the switch into `shelf` and the resume prompt into `overlayRoot`. `onPower` runs for a tap on POWER and
 * `onPrompt` for a tap on the prompt, inside the click handler (so with its user activation).
 */
export function mountPowerSwitch(shelf: HTMLElement, overlayRoot: HTMLElement, onPower: () => void, onPrompt: () => void): PowerSwitch {
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
  sw.dataset.resume = 'none';
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
  const title = span('resume-title');
  const line = span('resume-text');
  const hint = span('resume-hint');
  card.append(title, line, hint);
  overlay.append(card);
  overlayRoot.append(overlay);

  const onSwitchClick = (e: Event): void => {
    e.preventDefault();
    onPower();
  };
  const onPromptClick = (e: Event): void => {
    e.preventDefault();
    onPrompt();
  };
  const noFocus = (e: Event): void => e.preventDefault(); // a mouse press must not move focus or select text
  sw.addEventListener('click', onSwitchClick);
  sw.addEventListener('mousedown', noFocus);
  overlay.addEventListener('click', onPromptClick);

  return {
    setState(state) {
      sw.dataset.state = state;
      sw.setAttribute('aria-checked', String(state === 'on' || state === 'booting'));
    },
    setResume(prompt) {
      overlay.hidden = prompt === 'none';
      sw.dataset.resume = prompt;
      if (prompt === 'none') return;
      const [t, l, h] = PROMPT_TEXT[prompt];
      title.textContent = t;
      line.textContent = l;
      hint.textContent = h;
      hint.hidden = h === '';
    },
    setNote(text) {
      note.textContent = text ?? '';
    },
    dispose() {
      sw.removeEventListener('click', onSwitchClick);
      sw.removeEventListener('mousedown', noFocus);
      overlay.removeEventListener('click', onPromptClick);
      wrap.remove();
      overlay.remove();
    },
  };
}
