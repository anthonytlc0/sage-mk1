/**
 * Where LOOP MIX gets its mixer: Task 9's `mixRenderer` (src/core/render.ts), streamed (ruling R63). Ruling R56 kept this
 * behind an adapter that returned null (LOOP MIX said NOT READY) until it existed; the pod still accepts null.
 */

import { mixRenderer } from '../core/render';
import type { RenderMixFn } from '../recorder/loopMix';

/** The mixer behind LOOP MIX (`mixRenderer`'s shape). */
export type RenderFn = RenderMixFn;

/** The LOOP MIX renderer, or null while there is none. */
export function getLoopMixRenderer(): RenderFn | null {
  return mixRenderer;
}
