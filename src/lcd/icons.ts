import { type Framebuffer, type Bitmap, parseBitmap } from './framebuffer';

export const ICON_NAMES = ['trkPlay', 'trkStop', 'trkEmpty', 'current', 'phantom', 'lock', 'note'] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Original 1-bit artwork, drawn as '#' dark / '.' light. Sizes: track icons 20x20, current 5x5, phantom 23x7, lock 7x9, note 6x9. */
const ICONS: Readonly<Record<IconName, Bitmap>> = {
  // Track recording, playing back or overdubbing: boxed with a two-pixel frame and a solid disc.
  trkPlay: parseBitmap(`
    ...##############...
    ..################..
    .###............###.
    ###..............###
    ##................##
    ##................##
    ##......####......##
    ##.....######.....##
    ##....########....##
    ##....########....##
    ##....########....##
    ##....########....##
    ##.....######.....##
    ##......####......##
    ##................##
    ##................##
    ###..............###
    .###............###.
    ..################..
    ...##############...
  `),
  // Track stopped with a phrase recorded: solid box.
  trkStop: parseBitmap(`
    ...##############...
    ..################..
    .##################.
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    ####################
    .##################.
    ..################..
    ...##############...
  `),
  // Track with no phrase: thin frame on a heavy base.
  trkEmpty: parseBitmap(`
    ...##############...
    ..#..............#..
    .#................#.
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    #..................#
    .##################.
    ..################..
    ...##############...
  `),
  // Current-track marker: a 5x5 dot. Draw it at (x + 7, y + 7) over a 20x20 track icon, with { invert: true } on a solid one.
  current: parseBitmap(`
    .###.
    #####
    #####
    #####
    .###.
  `),
  // Phantom power on for MIC 1 / MIC 2: two boxed labels.
  phantom: parseBitmap(`
    ###########.###########
    #.##...#..#.#.##..##..#
    #.#.#.##..#.#.#.#...#.#
    #.##...#..#.#.##...#..#
    #.#....#..#.#.#...#...#
    #.#...###.#.#.#...###.#
    ###########.###########
  `),
  // Knob lock is on: padlock.
  lock: parseBitmap(`
    ..###..
    .#...#.
    .#...#.
    #######
    #######
    ###.###
    ###.###
    #######
    #######
  `),
  // Quarter note, the tempo marker.
  note: parseBitmap(`
    ....#.
    ....#.
    ....#.
    ....#.
    ....#.
    ..###.
    .####.
    .####.
    ..##..
  `),
};

export function iconSize(name: IconName): { w: number; h: number } {
  const { w, h } = ICONS[name];
  return { w, h };
}

/**
 * Draws icon `name` with its top-left at (x, y); light pixels of the artwork are transparent.
 * `invert: true` erases the icon's dark pixels instead, for cutting a mark out of a solid shape.
 */
export function icon(fb: Framebuffer, x: number, y: number, name: IconName, opts: { invert?: boolean } = {}): void {
  fb.blit(ICONS[name], x, y, opts.invert ? 0 : 1);
}
