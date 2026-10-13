/** Clock text and file names for the recorder pod. Pure, so they can be tested without a DOM. */

import { EXPORT_RATE } from '../shared/constants';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `frames` of 44.1 kHz audio as `mm:ss` (whole seconds; the minutes keep counting past 99). */
export function formatClock(frames: number): string {
  const total = Number.isFinite(frames) && frames > 0 ? Math.floor(frames / EXPORT_RATE) : 0;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** `YYYY-MM-DD HH-MM` in local time (a colon is not allowed in file names on every system). */
function stamp(when: Date | number): string {
  const d = new Date(when);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
}

/** `Sage MK1 take YYYY-MM-DD HH-MM.wav`, from the moment the take started. */
export function takeFilename(startedAt: Date | number): string {
  return `Sage MK1 take ${stamp(startedAt)}.wav`;
}

/** `Sage MK1 loop mix YYYY-MM-DD HH-MM.wav`. */
export function mixFilename(when: Date | number): string {
  return `Sage MK1 loop mix ${stamp(when)}.wav`;
}
