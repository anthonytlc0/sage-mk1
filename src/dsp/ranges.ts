/**
 * The parameter ranges the DSP depends on, read once at module load from the schema (Parameter Guide v1.3) so the
 * numbers live in exactly one place. A range change in the schema flows into the depth and pan mappings here; a missing
 * or renamed id fails loudly at load time instead of silently skewing a curve.
 */

import { TRACK_INDICES, findParam } from '../schema/params';

function numericRange(id: string): { min: number; max: number } {
  const def = findParam(id)?.def;
  if (!def || def.min === undefined || def.max === undefined) throw new Error(`dsp/ranges: '${id}' has no numeric range in the schema`);
  return { min: def.min, max: def.max };
}

/** INPUT › DYNAMICS › MIC1 COMP depth (the numeric part; OFF is a keyword). */
export const MIC_COMP = numericRange('input.dynamics.mic1Comp');
/** INPUT › DYNAMICS › MIC1 NS. */
export const MIC_NS = numericRange('input.dynamics.mic1Ns');
/** OUTPUT › MASTER FX › COMP depth (the numeric part). */
export const MASTER_COMP = numericRange('master.comp');
/** OUTPUT › MASTER FX › REVERB depth. */
export const MASTER_REVERB = numericRange('master.reverb');
/** TRACK › PAN, left to right. */
export const PAN = numericRange('track.*.pan');
/** Number of tracks. */
export const TRACK_COUNT: number = TRACK_INDICES.length;
