import type { Beat } from './types';

/** LCD text helpers for ParamDef.display. Everything is ASCII so it fits the LCD's bitmap font. */

export const onOff = (v: unknown): string => (v ? 'ON' : 'OFF');

/** PAN: -50 -> 'L50', 0 -> 'CENTER', 50 -> 'R50'. */
export function formatPan(v: unknown): string {
  const n = Number(v);
  if (n === 0) return 'CENTER';
  return n < 0 ? `L${-n}` : `R${n}`;
}

/** Equalizer gain: '-20dB', '0dB', '+20dB'. */
export function formatDb(v: unknown): string {
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n}dB`;
}

/** Frequency: '250Hz', '31.5Hz', '1.25kHz', '10.0kHz'. A keyword such as 'FLAT' is shown as is. */
export function formatHz(v: unknown): string {
  if (typeof v === 'string') return v;
  const n = Number(v);
  return n < 1000 ? `${n}Hz` : `${(n / 1000).toPrecision(3)}kHz`;
}

/** A note length or a number of measures. `suffix` is appended to measures, e.g. 'MEAS' -> '2MEAS'. Keywords ('AUTO', 'FREE') pass through. */
export function formatNoteOrMeasures(suffix = '') {
  return (v: unknown): string => {
    if (typeof v === 'string') return v;
    const o = v as { note?: string; measures?: number };
    return o.note !== undefined ? o.note : `${o.measures}${suffix}`;
  };
}

export const beatLabel = (b: Beat): string => `${b.num}/${b.den}`;
export const formatBeat = (v: unknown): string => (typeof v === 'string' ? v : beatLabel(v as Beat));

/** '5/8' -> { num: 5, den: 8 }; null if it is not of the form n/4 or n/8. */
export function parseBeat(label: string): Beat | null {
  const m = /^(\d{1,2})\/(4|8)$/.exec(label);
  return m ? { num: Number(m[1]), den: Number(m[2]) as 4 | 8 } : null;
}

export const formatTempo = (v: unknown): string => Number(v).toFixed(1);
export const pad2 = (v: unknown): string => String(v).padStart(2, '0');
/** CURRENT TRACK: 0 -> 'TRACK1'. */
export const formatTrack = (v: unknown): string => `TRACK${Number(v) + 1}`;
export const plain = (v: unknown): string => String(v);
