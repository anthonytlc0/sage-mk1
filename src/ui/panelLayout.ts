import type { AbsoluteId, ButtonId } from '../shared/ids';

/**
 * Panel geometry in SVG user units: 4 units per mm of the 420 x 234 mm top panel. Positions were measured off the
 * top-panel illustration in the Owner's Manual (p.4) and tidied so the panel is mirror-symmetric about x = 840,
 * as the hardware is.
 */
export const PANEL_VIEWBOX = { w: 1680, h: 936 } as const;

export type LayoutShape = 'round' | 'rect' | 'knob' | 'fader' | 'lcd' | 'ring';

/**
 * A control's rect in viewBox units, top-left at (x, y). Round buttons, knobs and rings are squares around their
 * centre. For a fader the rect is the travel of the cap's centre (top = 1, bottom = 0), so a drag of `h` units moves
 * the cap the full range; the slot artwork extends a little above and below it.
 */
export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: LayoutShape;
}

export type RingId = `ring${1 | 2 | 3 | 4 | 5}`;
export type LayoutId = ButtonId | AbsoluteId | 'lcd' | RingId;

export const ALL_BUTTON_IDS = [
  'trk1.rec', 'trk2.rec', 'trk3.rec', 'trk4.rec', 'trk5.rec',
  'trk1.stop', 'trk2.stop', 'trk3.stop', 'trk4.stop', 'trk5.stop',
  'trk1.track', 'trk2.track', 'trk3.track', 'trk4.track', 'trk5.track',
  'trk1.fx', 'trk2.fx', 'trk3.fx', 'trk4.fx', 'trk5.fx',
  'in.A', 'in.B', 'in.C', 'in.D', 'in.edit',
  'tr.A', 'tr.B', 'tr.C', 'tr.D', 'tr.edit',
  'allStartStop', 'undoRedo', 'menu', 'loop', 'exit', 'enter', 'left', 'right',
  'tapTempo', 'rhythmEdit', 'rhythmStartStop',
  'knob1', 'knob2', 'knob3', 'knob4',
] as const satisfies readonly ButtonId[];

export const ALL_ABSOLUTE_IDS = [
  'in.knob', 'tr.knob', 'outputLevel',
  'trk1.fader', 'trk2.fader', 'trk3.fader', 'trk4.fader', 'trk5.fader',
] as const satisfies readonly AbsoluteId[];

// Compile-time exhaustiveness: adding an id to the unions in shared/ids.ts without listing it here is a type error.
type Missing<All, Listed> = Exclude<All, Listed>;
const buttonsComplete: [Missing<ButtonId, (typeof ALL_BUTTON_IDS)[number]>] extends [never] ? true : never = true;
const absolutesComplete: [Missing<AbsoluteId, (typeof ALL_ABSOLUTE_IDS)[number]>] extends [never] ? true : never = true;
void buttonsComplete;
void absolutesComplete;

/** Panel centre line; the left and right halves mirror each other about it. */
export const CENTER_X = PANEL_VIEWBOX.w / 2;

/** Rows of the top band (centre y). */
export const ROW = { upper: 138, middle: 210, lower: 310, encoders: 308, fxKnobs: 167 } as const;

/** Track columns: centre x of each REC/PLAY button, and the y positions shared by every column. */
export const TRACK_PITCH = 305;
export const TRACK_X = [0, 1, 2, 3, 4].map((i) => CENTER_X + (i - 2) * TRACK_PITCH) as readonly number[];
export const TRACK_ROW = { fx: 440, track: 518, stop: 632, rec: 803, clearLabel: 573, number: 700 } as const;
/** Horizontal offsets inside a track column, relative to the REC/PLAY centre. */
export const TRACK_COL = { buttons: -68, fader: 74, number: -108, halfWidth: 142 } as const;

/** Sizes (viewBox units). */
export const SIZE = {
  fxKnobR: 64, // INPUT FX / TRACK FX knob cap
  outputKnobR: 32,
  encoderR: 30, // knobs [1]-[4]
  slotR: 23, // A-D
  editR: 24, // INPUT FX / TRACK FX EDIT
  smallR: 18, // MENU, LOOP, EXIT, ENTER, arrows, RHYTHM EDIT
  stopR: 43,
  recR: 59,
  ringR: 106, // outer radius of the loop-indicator ring
  pill: { w: 84, h: 40 }, // FX, TRACK
  wide: { w: 88, h: 44 }, // ALL START/STOP, UNDO/REDO, TAP TEMPO, RHYTHM START/STOP
  fader: { w: 94, top: 447, travel: 187 },
  lcd: { x: 728, y: 115, w: 224, h: 112 },
} as const;

const round = (cx: number, cy: number, r: number, shape: LayoutShape = 'round'): LayoutRect => ({
  x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, shape,
});
const box = (cx: number, cy: number, w: number, h: number, shape: LayoutShape = 'rect'): LayoutRect => ({
  x: cx - w / 2, y: cy - h / 2, w, h, shape,
});
const mirror = (x: number): number => PANEL_VIEWBOX.w - x;

/** INPUT FX A-D centres; TRACK FX mirrors them (tr.A sits where in.D's mirror image is). The FX knob sits over B (C). */
const IN_SLOT_X = [82, 159, 236, 313] as const;
const IN_KNOB_X = IN_SLOT_X[1];
const IN_EDIT_X = IN_SLOT_X[3];
const MENU_X = 636;
const EXIT_X = mirror(MENU_X);
const ENTER_X = 1128;
const OUTPUT_LEVEL = { x: 1252, y: 124 } as const;
const RHYTHM_EDIT_X = 1222;
const WIDE_X = [427, 551] as const; // ALL START/STOP, UNDO/REDO; TAP TEMPO and RHYTHM START/STOP mirror them
const ENCODER_X = [684, 788, 892, 996] as const;

function buildLayout(): Record<LayoutId, LayoutRect> {
  const L: Partial<Record<LayoutId, LayoutRect>> = {};

  // INPUT FX (left) and TRACK FX (right).
  L['in.knob'] = round(IN_KNOB_X, ROW.fxKnobs, SIZE.fxKnobR, 'knob');
  L['tr.knob'] = round(mirror(IN_KNOB_X), ROW.fxKnobs, SIZE.fxKnobR, 'knob');
  L['in.edit'] = round(IN_EDIT_X, ROW.middle, SIZE.editR);
  L['tr.edit'] = round(mirror(IN_EDIT_X), ROW.middle, SIZE.editR);
  (['A', 'B', 'C', 'D'] as const).forEach((s, i) => {
    L[`in.${s}`] = round(IN_SLOT_X[i], ROW.lower, SIZE.slotR);
    L[`tr.${s}`] = round(mirror(IN_SLOT_X[3 - i]), ROW.lower, SIZE.slotR);
  });

  // Centre block.
  L.menu = round(MENU_X, ROW.upper, SIZE.smallR);
  L.loop = round(MENU_X, ROW.middle, SIZE.smallR);
  L.exit = round(EXIT_X, ROW.upper, SIZE.smallR);
  L.enter = round(ENTER_X, ROW.upper, SIZE.smallR);
  L.left = round(EXIT_X, ROW.middle, SIZE.smallR);
  L.right = round(ENTER_X, ROW.middle, SIZE.smallR);
  L.outputLevel = round(OUTPUT_LEVEL.x, OUTPUT_LEVEL.y, SIZE.outputKnobR, 'knob');
  L.rhythmEdit = round(RHYTHM_EDIT_X, ROW.middle, SIZE.smallR);
  L.allStartStop = box(WIDE_X[0], ROW.lower, SIZE.wide.w, SIZE.wide.h);
  L.undoRedo = box(WIDE_X[1], ROW.lower, SIZE.wide.w, SIZE.wide.h);
  L.tapTempo = box(mirror(WIDE_X[1]), ROW.lower, SIZE.wide.w, SIZE.wide.h);
  L.rhythmStartStop = box(mirror(WIDE_X[0]), ROW.lower, SIZE.wide.w, SIZE.wide.h);
  (['knob1', 'knob2', 'knob3', 'knob4'] as const).forEach((id, i) => {
    L[id] = round(ENCODER_X[i], ROW.encoders, SIZE.encoderR, 'knob');
  });
  L.lcd = { ...SIZE.lcd, shape: 'lcd' };

  // Track columns.
  TRACK_X.forEach((x, i) => {
    const n = (i + 1) as 1 | 2 | 3 | 4 | 5;
    const bx = x + TRACK_COL.buttons;
    L[`trk${n}.fx`] = box(bx, TRACK_ROW.fx, SIZE.pill.w, SIZE.pill.h);
    L[`trk${n}.track`] = box(bx, TRACK_ROW.track, SIZE.pill.w, SIZE.pill.h);
    L[`trk${n}.stop`] = round(bx, TRACK_ROW.stop, SIZE.stopR);
    L[`trk${n}.rec`] = round(x, TRACK_ROW.rec, SIZE.recR);
    L[`ring${n}`] = round(x, TRACK_ROW.rec, SIZE.ringR, 'ring');
    L[`trk${n}.fader`] = {
      x: x + TRACK_COL.fader - SIZE.fader.w / 2, y: SIZE.fader.top, w: SIZE.fader.w, h: SIZE.fader.travel, shape: 'fader',
    };
  });

  return L as Record<LayoutId, LayoutRect>;
}

/** Every control, the LCD and the five loop-indicator rings, in viewBox units. */
export const LAYOUT: Readonly<Record<LayoutId, LayoutRect>> = buildLayout();
