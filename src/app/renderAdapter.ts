/**
 * Where LOOP MIX gets its mixer: Task 9's `renderMix` (src/core/render.ts). Ruling R56 kept this behind an adapter that
 * returned null (LOOP MIX said NOT READY) until renderMix existed; the pod still accepts null for a build without one.
 */

import { renderMix } from '../core/render';
import type { RenderMixFn } from '../recorder/loopMix';

/** The mixer behind LOOP MIX (`renderMix`'s shape). */
export type RenderFn = RenderMixFn;

/** The LOOP MIX renderer, or null while there is none. */
export function getLoopMixRenderer(): RenderFn | null {
  return renderMix;
}
