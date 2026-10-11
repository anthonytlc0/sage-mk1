/**
 * The RHYTHM screen (Owner's Manual p. 15; Parameter Guide p. 7): twelve parameters on three pages of four knobs, opened
 * by the RHYTHM [EDIT] button and by LOOP > RHYTHM.
 *
 * Phase 1 plays only a click, so GENRE offers GUIDE alone (the schema's value list); PATTERN, VARIATION, KIT, the
 * triggers and the rest are stored with the memory for the later phases.
 *
 * BEAT cannot be changed once a track holds audio (Parameter Guide: "You cannot change the beat after the track is
 * recorded. Be sure to set this before recording."). The turn is refused with a message.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { PageSet, defsOf, paramPages } from './editPages';
import { tracksHaveAudio } from './looperState';

/** What the refused BEAT turn shows. */
// INFERRED: the manual lists no message for it; the wording follows the style of its error list (p. 23).
export const MSG_BEAT_LOCKED = 'CLEAR TRACKS';

const IDS = [
  'rhythm.genre', 'rhythm.pattern', 'rhythm.variation', 'rhythm.kit',
  'rhythm.beat', 'rhythm.startTrig', 'rhythm.stopTrig', 'rhythm.introRec',
  'rhythm.introPlay', 'rhythm.ending', 'rhythm.fill', 'rhythm.varChange',
];

/** A page of parameters that refuses knob [1] turns while a track holds audio. */
class BeatGuard implements Screen {
  constructor(private readonly inner: Screen, readonly title: string) {}

  render(fb: Framebuffer, ctx: Controller): void {
    this.inner.render(fb, ctx);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn' && e.id === 'knob1' && tracksHaveAudio(ctx)) {
      ctx.showMessage(MSG_BEAT_LOCKED);
      return 'handled';
    }
    return this.inner.onEvent(e, ctx);
  }

  dispose(): void {
    this.inner.dispose?.();
  }
}

export function rhythmScreen(): Screen {
  const pages = paramPages('RHYTHM', defsOf(IDS));
  // BEAT is the first knob of the second page
  pages[1] = new BeatGuard(pages[1]!, 'RHYTHM');
  return new PageSet('RHYTHM', pages);
}
