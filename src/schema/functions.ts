/**
 * Function lists transcribed from the Parameter Guide: PANEL PLAY / PANEL UNDO (pp. 14-16), CTL1-4 (pp. 17-22),
 * EXP1/2 (p. 23), ASSIGN SOURCE/TARGET (pp. 24-28) and SETUP KNOB FUNC (pp. 30-33).
 *
 * The guide writes groups of values compactly ("TRK1-5 CLEAR", "IN FX A-D PRM1-4", "MIDI CC#01-31"). The lists below
 * expand those into one entry per selectable value. A stored function is its LCD label, e.g. 'TRK2 CLEAR'.
 */

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Expands the guide's grouped notation: TRK1-5 / TRK 1-5, AA-DD, A-D, PRM1-4, CC#nn-mm. */
export function expand(spec: string): string[] {
  const rules: [RegExp, (m: RegExpExecArray) => string[]][] = [
    [/TRK ?1-5/, () => range(1, 5).map((n) => `TRK${n}`)],
    [/\bAA-DD\b/, () => ['AA', 'BB', 'CC', 'DD']],
    [/\bA-D\b/, () => ['A', 'B', 'C', 'D']],
    [/PRM1-4/, () => range(1, 4).map((n) => `PRM${n}`)],
    [/CC#(\d+)-(\d+)/, (m) => range(Number(m[1]), Number(m[2])).map((n) => `CC#${String(n).padStart(2, '0')}`)],
  ];
  let out = [spec];
  for (const [re, f] of rules) {
    out = out.flatMap((s) => {
      const m = re.exec(s);
      return m ? f(m).map((r) => s.slice(0, m.index) + r + s.slice(m.index + m[0].length)) : [s];
    });
  }
  return out;
}
const expandAll = (specs: readonly string[]): string[] => specs.flatMap(expand);

// ---------------------------------------------------------------------------------------------------------------------
// Button / footswitch functions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One selectable function of a [TRACK]/[FX] button or a footswitch. `id` is the LCD label and is what gets stored.
 * `push` / `hold` / `click` name what the switch does when pressed / held / double-clicked ('---' = nothing on push).
 */
export interface PanelFunction {
  id: string;
  label: string;
  push: string;
  hold?: string;
  click?: string;
  /** For 'TRKn ...' functions: the track 0-4 the function acts on. */
  track?: number;
  /** For 'CUR.TRK ...' functions: acts on the currently selected track. */
  current?: true;
}

/** [name, push, hold?, click?] */
type Fn = readonly [name: string, push: string, hold?: string, click?: string];

function make(label: string, f: Fn, extra: Partial<PanelFunction> = {}): PanelFunction {
  const out: PanelFunction = { id: label, label, push: f[1], ...extra };
  if (f[2] !== undefined) out.hold = f[2];
  if (f[3] !== undefined) out.click = f[3];
  return out;
}

/** Per-track functions: template-major, i.e. 'TRK1 X', 'TRK2 X', ... then the next template. */
function perTrack(fns: readonly Fn[]): PanelFunction[] {
  return fns.flatMap((f) => range(1, 5).map((n) => make(`TRK${n} ${f[0]}`, f, { track: n - 1 })));
}
function currentTrack(fns: readonly Fn[]): PanelFunction[] {
  return fns.map((f) => make(`CUR.TRK ${f[0]}`, f, { current: true }));
}
function globals(fns: readonly Fn[]): PanelFunction[] {
  return fns.flatMap((f) => expand(f[0]).map((label) => make(label, f)));
}

const OFF_FN: PanelFunction = make('OFF', ['OFF', '---']);

/** The track functions common to PANEL and CTL (guide: CLEAR ... TRACK FX). `undo` is the push label of UNDO/REDO. */
const trackEditFns = (undo: string): Fn[] => [
  ['CLEAR', 'CLEAR'],
  ['REVERSE', 'REVERSE'],   // the guide prints 'CLEAR' as the CUR.TRK REVERSE push label: a copy error, corrected here
  ['UNDO/REDO', undo],
  ['MARK BACK1', 'MARK BACK'],
  ['MARK BACK2', 'MARK BACK', 'REC BACK'],
  ['REC BACK', 'REC BACK'],
  ['MARK SET1', 'MARK SET'],
  ['MARK SET2', 'MARK SET', 'MARK CLEAR'],
  ['MARK CLEAR', 'MARK CLEAR'],
  ['HALF SPEED', 'HALF SPEED'],
  ['HALF SPEED (MOMENT)', 'HALF SPEED'],
  ['DOUBLE SPEED', 'DOUBLE SPEED'],
  ['DOUBLE SPEED (MOMENT)', 'DOUBLE SPEED'],
  ['TRACK EDIT', 'TRACK EDIT'],
  ['TRACK FX', 'FX ON/OFF'],
];

/** PANEL PLAY / PANEL UNDO / (guide pp. 14-16). 101 entries. */
export const PANEL_FUNCTIONS: readonly PanelFunction[] = [
  OFF_FN,
  ...perTrack(trackEditFns('UNDO/REDO')),
  ...currentTrack(trackEditFns('UNDO')),
  ...currentTrack([['INC', 'INC', 'INC'], ['DEC', 'DEC', 'INC']]),
  ...globals([
    ['TEMPO UP', 'TEMPO DOUBLE'],
    ['TEMPO DOWN', 'TEMPO HALF'],
    ['INPUT FX ON/OFF', 'FX ON/OFF'],
    ['TRACK FX ON/OFF', 'FX ON/OFF'],
    ['MIC IN MUTE', 'MUTE ON/OFF'],
    ['MIC1 IN MUTE', 'MUTE ON/OFF'],
    ['MIC2 IN MUTE', 'MUTE ON/OFF'],
    ['LED', 'TOGGLE COLOR'],
  ]),
];

const ctlTrackFns: Fn[] = [
  ['REC/PLAY1', 'REC/PLAY'],
  ['REC/PLAY2', 'REC/PLAY', 'UNDO (PLAY)'],
  ['REC/PLAY3', 'REC/PLAY', 'UNDO (PLAY)', 'STOP'],
  ['REC/PLAY4', 'REC/PLAY', 'UNDO, CLEAR', 'STOP'],
  ['MOMENT PLAY', 'PLAY'],
  ['PLAY/STOP1', 'PLAY/STOP'],
  ['PLAY/STOP2', 'PLAY/STOP', 'UNDO (PLAY)'],
  ['PLAY/STOP3', 'PLAY/STOP', 'UNDO, CLEAR'],
  ['STOP1', 'STOP'],
  ['STOP2', 'STOP', undefined, 'TAP TEMPO'],
  ['STOP3', 'STOP', 'CLEAR', 'TAP TEMPO'],
  ['STOP4', 'STOP', 'CLEAR'],
  ['STOP5', 'STOP', undefined, 'CLEAR'],
  ...trackEditFns('UNDO'),
];

/** CTL1-4 footswitch functions (guide pp. 17-22). 208 entries. */
export const CTL_FUNCTIONS: readonly PanelFunction[] = [
  OFF_FN,
  ...perTrack(ctlTrackFns),
  ...currentTrack([
    ...ctlTrackFns,
    ['INC1', 'INC', 'INC'], ['INC2', 'INC', 'DEC'], ['DEC1', 'DEC', 'DEC'], ['DEC2', 'DEC', 'INC'],
    ['NUM', '---'],
  ]),
  ...globals([
    ['ALL START/STOP1', 'ALL START/STOP'],
    ['ALL START/STOP2', 'ALL START/STOP', 'ALL CLEAR'],
    ['ALL START/STOP3', 'ALL START/STOP', undefined, 'ALL CLEAR'],   // the guide prints the push label as 'ALL START/STP'
    ['ALL START/STOP4', 'IMM ALL ST/STOP'],
    ['ALL START/STOP5', 'IMM ALL ST/STOP', 'ALL CLEAR'],
    ['ALL START/STOP6', 'IMM ALL ST/STOP', undefined, 'ALL CLEAR'],
    ['ALL CLEAR1', 'ALL CLEAR'],
    ['ALL CLEAR2', '---', 'ALL CLEAR'],
    ['TAP TEMPO', 'TAP TEMPO', 'TEMPO REVERT'],
    ['TEMPO UP', 'TEMPO DOUBLE'],
    ['TEMPO DOWN', 'TEMPO HALF'],
    ['INPUT FX', 'FX ON/OFF'],
    ['INPUT FX A-D', 'FX ON/OFF'],
    ['INPUT FX CUR', 'FX ON/OFF'],
    ['TRACK FX', 'FX ON/OFF'],
    ['TRACK FX A-D', 'FX ON/OFF'],
    ['TRACK FX CUR', 'FX ON/OFF'],
    ['RHYTHM START/STOP', 'RHY START/STOP'],
    ['RHYTHM START', 'RHYTHM START'],
    ['RHYTHM STOP', 'RHYTHM STOP'],
    ['MEMORY INC1', 'INC', 'INC'],
    ['MEMORY INC2', 'INC', 'DEC'],
    ['MEMORY DEC1', 'DEC', 'DEC'],
    ['MEMORY DEC2', 'DEC', 'INC'],
    ['MEMORY WRITE', 'WRITE'],
    ['MIC IN MUTE', 'MUTE ON/OFF'],
    ['MIC1 IN MUTE', 'MUTE ON/OFF'],
    ['MIC2 IN MUTE', 'MUTE ON/OFF'],
  ]),
];

/** EXP1/2 FUNC (guide p. 23). The guide's '(EXP1)' / '(EXP2)' marks only say which pedal each is the default of. 27 entries. */
export const EXP_FUNCTIONS: readonly string[] = expandAll([
  'OFF', 'TRK1-5 LEVEL1', 'TRK1-5 LEVEL2', 'CUR.TRK LEVEL1', 'CUR.TRK LEVEL2', 'TEMPO UP', 'TEMPO DOWN',
  'IN FX A-D CTL', 'IN FX CUR CTL', 'TR FX A-D CTL', 'TR FX CUR CTL', 'RHYTHM LEVEL1', 'RHYTHM LEVEL2',
]);

// ---------------------------------------------------------------------------------------------------------------------
// SETUP > KNOB FUNC 1-4 (guide pp. 30-33)
// ---------------------------------------------------------------------------------------------------------------------

const EQ_KNOBS = ['EQ SW', 'EQ LO G', 'EQ HI G', 'EQ LM F', 'EQ LM Q', 'EQ LM G', 'EQ HM F', 'EQ HM Q', 'EQ HM G', 'EQ LVL', 'EQ LO C', 'EQ HI C'];
const eqBlock = (channels: string): string[] => EQ_KNOBS.map((p) => `${channels} ${p}`);

/**
 * KNOB FUNC values, 213 entries. The guide lists 'RHYTHM LEVEL' twice (as the rhythm volume and again as the rhythm sound
 * output level); it is kept once, at its first position.
 */
export const KNOB_FUNCS: readonly string[] = expandAll([
  'OFF', 'MEMORY',
  'TRK 1-5 REVERSE', 'TRK 1-5 1SHOT', 'TRK 1-5 PAN', 'TRK 1-5 LEVEL', 'TRK 1-5 DUB', 'TRK 1-5 FX', 'TRK 1-5 BNC IN',
  'DUB MODE', 'AUTO REC', 'BOUNCE', 'CURRENT TRACK', 'FD TIME IN', 'FD TIME OUT',
  'IN FX A-D SW', 'IN FX A-D TYPE', 'IN FX A-D PRM1-4', 'IN FX A-D SW MODE',
  'IN FX BANK', 'IN FX MODE', 'IN FX SW', 'IN FX TARGET', 'IN FX SW MODE',
  'TR FX A-D SW', 'TR FX A-D TYPE', 'TR FX A-D PRM1-4', 'TR FX A-D SW MODE',
  'TR FX BANK', 'TR FX MODE', 'TR FX SW', 'TR FX TARGET', 'TR FX SW MODE',
  'RHYTHM LEVEL', 'RHYTHM VARI', 'RHYTHM KIT', 'RHYTHM R.INTRO', 'RHYTHM P.INTRO', 'RHYTHM ENDING',
  'MIC1, 2 LEVEL', 'MIC1, 2 MUTE', 'INST1, 2 LEVEL', 'INST1, 2 MUTE', 'INST1(R), 2(R) LEVEL', 'INST1(R), 2(R) MUTE',
  'LOOP LEVEL', 'MAIN LEVEL', 'MAIN(R) LEVEL', 'SUB1, 2 LEVEL', 'SUB1(R), 2(R) LEVEL', 'PHONES LEVEL', 'MASTER LEVEL',
  'INST 1, 2 GAIN',
  ...eqBlock('MIC1, 2'), ...eqBlock('INST1-L, R'), ...eqBlock('INST2-L, R'),
  'MIC1, 2 COMP', 'MIC1, 2 NS', 'INST 1, 2 NS',
  'RHYTHM OUT', 'INPUT THRU', 'PHONES MONITOR', 'PHONES OUT',
  ...eqBlock('MAIN-L, R'), ...eqBlock('SUB1-L, R'), ...eqBlock('SUB2-L, R'),
  'MFX COMP', 'MFX REVERB', 'PANEL MODE', 'DISPLAY MODE', 'INDICATOR',
]);

// ---------------------------------------------------------------------------------------------------------------------
// ASSIGN 1-16 (guide pp. 24-28)
// ---------------------------------------------------------------------------------------------------------------------

/** ASSIGN SOURCE, 100 entries. */
export const ASSIGN_SOURCES: readonly string[] = expandAll([
  'TRK1-5 REC/DB', 'TRK1-5 PLY/STP', 'SYNC ST/STP',
  'TRK1-5 FX (PLY)', 'TRK1-5 TR (PLY)', 'TRK1-5 FX (UND)', 'TRK1-5 TR (UND)',
  'IN FX KNOB', 'TR FX KNOB', 'CTL1, 2', 'CTL3, 4', 'EXP1', 'EXP2',
  'MIDI CC#01-31', 'MIDI CC#64-95',
]);

const TRACK_TARGETS = ['REC/PLY', 'PLY/STP', 'STOP', 'CLEAR', 'REVERSE', 'UN/RED', 'M.BACK', 'R.BACK', 'M.SET', 'M.CLEAR', 'LEVEL'];
/** The function sets of FX A-D / AA-DD (the guide's 'A-A through D-D'). */
const fxSet = (prefix: string): string[] =>
  ['', ' CTL', ' TYPE', ' TYP INC', ' TYP DEC', ' SW MODE', ' PRM1-4', ' SEQ', ' S.SYNC', ' S.RTRIG', ' S.RATE', ' S.MAX'].map((s) => prefix + s);
/** The currently selected FX: 'CR' for on/off, type and mode, 'CUR' for the parameters, as the guide prints them. */
const curSet = (prefix: string): string[] => [
  `${prefix} CR`, `${prefix} CR CTL`, `${prefix} CR TYPE`, `${prefix} CR TYP INC`, `${prefix} CR TYP DEC`, `${prefix} CR SW MODE`,
  `${prefix} CUR PRM1-4`, `${prefix} CUR SEQ`, `${prefix} CUR S.SYNC`, `${prefix} CUR S.RTRIG`, `${prefix} CUR S.RATE`, `${prefix} CUR S.MAX`,
];

/** ASSIGN TARGET, 511 entries. */
export const ASSIGN_TARGETS: readonly string[] = expandAll([
  ...TRACK_TARGETS.map((n) => `TRK1-5 ${n}`),
  ...[...TRACK_TARGETS, 'INC', 'DEC', 'NUM'].map((n) => `CUR.TRK ${n}`),
  'ALL ST/STP', 'TAP TEMPO', 'TEMPO', 'INPUT FX',
  'IN FX TGT INC', 'IN FX TGT DEC', 'IN FX BNK INC', 'IN FX BNK DEC', 'IN FX SW MODE',
  ...fxSet('IN FX A-D'), ...fxSet('IN FX AA-DD'), ...curSet('IN FX'),
  'TRK FX', 'TRK FX TGT INC', 'TRK FX TGT DEC', 'TRK FX BNK INC', 'TRK FX BNK DEC', 'TRK FX SW MODE',
  ...fxSet('T FX A-D'), ...fxSet('T FX AA-DD'), ...curSet('T FX'),
  'RHYTHM ST/STP', 'RHYTHM START', 'RHYTHM STOP', 'RHYTHM LEVEL', 'MIC IN MUTE', 'MIC1 IN MUTE', 'MIC2 IN MUTE',
  'TRK 1-5 FADER', 'TRK 1-5 1SHOT', 'TRK 1-5 PAN', 'TRK 1-5 FX', 'TRK 1-5 SPEED', 'TRK 1-5 BNC IN',
  'DUB MODE', 'AUTO REC', 'BOUNCE', 'RHYTHM VARI', 'RHYTHM KIT',
  'MIC 1, 2 LEVEL', 'INST1-L, R LEVEL', 'INST1-L, R MUTE', 'INST2-L, R LEVEL', 'INST2-L, R MUTE',
  'LOOP LEVEL', 'MAIN-L, R LEVEL', 'SUB1-L, R LEVEL', 'SUB2-L, R LEVEL', 'PHONES LEVEL', 'MASTER LEVEL', 'INST1, 2 GAIN',
  'EQ MIC1, 2', 'EQ INST-1L, R', 'EQ INST-2L, R', 'INPUT THRU', 'EQ MAIN-L, R', 'EQ SUB1-L, R', 'EQ SUB2-L, R',
  'PANEL MODE', 'MIDI CC#01-31', 'MIDI CC#64-127',
]);
