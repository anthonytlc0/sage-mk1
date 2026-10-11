/**
 * The TRACK screen (Owner's Manual p. 14; Parameter Guide pp. 2-3): the settings of one track on five pages of four
 * knobs, the guide's order. The last page is INPUT, a row of switches. It opens from the TRACK button (the PANEL PLAY
 * default is TRACK EDIT, which also makes that track the current one) and from LOOP > TRACK. The LOOP button switches
 * to the next track (manual memo: "You can also press the [LOOP] button to switch tracks"; the order is INFERRED),
 * staying on the same page.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { TRACKS } from '../../shared/ids';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { PageSet, defsOf, paramPages, switchPage } from './editPages';
import type { SwitchItemSpec } from './editPages';

const TITLES: readonly string[] = TRACKS.map((t) => `TRACK${t + 1}`);

const PAGES: readonly (readonly string[])[] = [
  ['track.*.reverse', 'track.*.oneShot', 'track.*.pan', 'track.*.playLevel'],
  ['track.*.startMode', 'track.*.stopMode', 'track.*.dubMode', 'track.*.fx'],
  ['track.*.playMode', 'track.*.measure', 'track.*.loopSyncSw', 'track.*.loopSyncMode'],
  ['track.*.tempoSyncSw', 'track.*.tempoSyncMode', 'track.*.tempoSyncSpeed', 'track.*.bounceIn'],
];

/**
 * INPUT: the six input channels and the rhythm. A stereo-linked pair is one switch for both channels ("When stereo link
 * is ON, the MIC 1, 2 and L/R channels are shown as a single connector"), so the list depends on the three links.
 * Captions are three letters over the channel (INFERRED: the manual does not show this page).
 */
function inputSets(track: number): SwitchItemSpec[][] {
  const id = (src: string): string => `track.${track}.input.${src}`;
  const sets: SwitchItemSpec[][] = [];
  for (let key = 0; key < 8; key++) {
    const items: SwitchItemSpec[] = [];
    const pair = (linked: boolean, top: string, a: string, b: string, l: string, r: string): void => {
      if (linked) items.push({ top, bottom: `${l}+${r}`, ids: [id(a), id(b)] });
      else {
        items.push({ top, bottom: l, ids: [id(a)] });
        items.push({ top, bottom: r, ids: [id(b)] });
      }
    };
    pair((key & 1) !== 0, 'MIC', 'MIC1', 'MIC2', '1', '2');
    pair((key & 2) !== 0, 'IN1', 'INST1L', 'INST1R', 'L', 'R');
    pair((key & 4) !== 0, 'IN2', 'INST2L', 'INST2R', 'L', 'R');
    items.push({ top: 'RHY', bottom: '', ids: [id('RHYTHM')] });
    sets.push(items);
  }
  return sets;
}

/** The index into `inputSets` for the current stereo links: MIC, INST1 and INST2 as bits 0, 1 and 2. */
const inputVariant = (ctx: Controller): number => {
  const link = ctx.session.system.input.stereoLink;
  return (+link.MIC) | (+link.INST1 << 1) | (+link.INST2 << 2);
};

function buildPages(track: number): PageSet {
  const title = TITLES[track]!;
  const pages: Screen[] = PAGES.flatMap((ids) => paramPages(title, defsOf(ids), track));
  pages.push(switchPage(title, { groups: [{ label: 'INPUT', knob: 0, cols: 4, sets: inputSets(track), variant: inputVariant }] }));
  return new PageSet(title, pages);
}

class TrackScreen implements Screen {
  private readonly sets: (PageSet | undefined)[] = TRACKS.map(() => undefined);

  constructor(private track: number) {}

  get title(): string {
    return TITLES[this.track]!;
  }

  private get current(): PageSet {
    return (this.sets[this.track] ??= buildPages(this.track));
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.current.render(fb, ctx);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'press' && e.id === 'loop') {
      const page = this.current.page;
      this.track = (this.track + 1) % TRACKS.length;
      this.current.goto(page);
      return 'handled';
    }
    return this.current.onEvent(e, ctx);
  }

  dispose(): void {
    for (const s of this.sets) s?.dispose();
  }
}

/** The TRACK screen of `track` (0-4). */
export function trackScreen(track: number): Screen {
  if (!Number.isInteger(track) || track < 0 || track >= TRACKS.length) throw new RangeError(`trackScreen: no track ${track}`);
  return new TrackScreen(track);
}
