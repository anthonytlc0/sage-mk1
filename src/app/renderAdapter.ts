/**
 * Where LOOP MIX gets its mixer (ruling R56). Task 9's `renderMix` (src/core/render.ts) is not built yet, so this
 * returns null and the recorder pod's LOOP MIX says NOT READY. When Task 9 lands this becomes `return renderMix;`.
 */

import type { RenderMixFn } from '../recorder/loopMix';

/** The mixer behind LOOP MIX (`renderMix`'s shape). */
export type RenderFn = RenderMixFn;

/** The LOOP MIX renderer, or null while there is none. */
export function getLoopMixRenderer(): RenderFn | null {
  // TODO(T9): return renderMix from '../core/render' once Task 9 has built it.
  return null;
}
