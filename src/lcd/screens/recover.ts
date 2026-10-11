/**
 * RECOVER? (non-hardware addition, crash recovery): shown at power-on when the last session ended without a clean
 * POWER off and left a checkpoint (`Recovery.needsRecovery()`).
 *
 *   ENTER  restores the checkpoint as the current memory, unsaved (EXECUTING... while its audio loads); WRITE keeps it.
 *   EXIT   discards the checkpoint.
 *
 * `showBootPrompts` is what the app shell calls once after power-on: RECOVER? when needed, then the first-run
 * CALIBRATE? offer under it.
 */

import type { Controller } from '../../control/controller';
import type { Recovery } from '../../storage/recovery';
import type { MenuSystem, Screen } from '../menu';
import { showCalibratePrompt } from './latency';
import { PromptScreen } from './prompt';

export const RECOVER_PROMPT = 'RECOVER? ENTER/EXIT';

/** The parts of `Recovery` the prompt uses. */
export type RecoverySource = Pick<Recovery, 'take' | 'discard'>;

/**
 * The RECOVER? prompt. ENTER closes it at once and restores the checkpoint behind EXECUTING... (it is read from
 * storage, audio included); EXIT closes it and discards the checkpoint. Push it with `menu.push(recoverScreen(...))`.
 */
export function recoverScreen(recovery: RecoverySource): Screen {
  return new PromptScreen('RECOVER', RECOVER_PROMPT, {
    enter: (ctx) => {
      ctx.showMessage('EXECUTING...', Infinity);
      void restore(recovery, ctx);
      return 'pop';
    },
    exit: () => {
      recovery.discard().catch((e: unknown) => console.error('discarding the recovery checkpoint failed', e));
      return 'pop';
    },
  });
}

async function restore(recovery: RecoverySource, ctx: Controller): Promise<void> {
  try {
    const rec = await recovery.take();
    ctx.clearMessage();
    if (rec) ctx.restoreRecovery(rec);
  } catch (e) {
    console.error('restoring the recovery checkpoint failed', e);
    ctx.clearMessage();
    ctx.showMessage('DATA READ ERR');
  }
}

/**
 * The power-on prompts, for the app shell to call once after `boot()` and `menu.showStartScreen()`: RECOVER? when the
 * last session crashed with unsaved work, and CALIBRATE? (`showCalibratePrompt`) while the device is uncalibrated,
 * shown after RECOVER? is answered.
 */
export async function showBootPrompts(
  menu: MenuSystem,
  ctx: Controller,
  recovery: RecoverySource & Pick<Recovery, 'needsRecovery'>,
): Promise<void> {
  showCalibratePrompt(menu, ctx);
  let needed = false;
  try {
    needed = await recovery.needsRecovery();
  } catch (e) {
    console.error('reading the recovery state failed', e);
  }
  if (needed) menu.push(recoverScreen(recovery));
}
