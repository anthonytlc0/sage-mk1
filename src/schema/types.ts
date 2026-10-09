/**
 * Settings types for Sage MK1, transcribed from the BOSS RC-505mkII Parameter Guide v1.3.
 * The parameter registry (name, range, default, display) lives in params.ts / memory.ts / system.ts;
 * these are the shapes of the objects those registries read and write.
 */

/** Rhythm beat (time signature). The guide allows 2/4..7/4 and 5/8..15/8. */
export type Beat = { num: number; den: 4 | 8 };

/**
 * Note lengths used by MEASURE and FADE TIME, as printed (as note symbols) in the guide: sixteenth, eighth, quarter and
 * half note, shortest to longest. Labels are the note's fraction of a whole note.
 */
export const NOTE_VALUES: readonly string[] = ['1/16', '1/8', '1/4', '1/2'];
export type NoteLen = (typeof NOTE_VALUES)[number];

/** Allowed BEAT values in the guide's order. */
export const BEAT_VALUES: readonly string[] = [
  '2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '5/8', '6/8', '7/8', '8/8', '9/8', '10/8', '11/8', '12/8', '13/8', '14/8', '15/8',
];

export type MeasureSetting = 'AUTO' | 'FREE' | { note: NoteLen } | { measures: number };
export type FadeTime = { note: NoteLen } | { measures: number };   // 1..64

export type InputChannel = 'MIC1' | 'MIC2' | 'INST1L' | 'INST1R' | 'INST2L' | 'INST2R';
/** The input jacks plus the rhythm; the keys of TRACK INPUT and OUTPUT/ROUTING/INPUT/RHYTHM. */
export type InputSource = InputChannel | 'RHYTHM';
export type OutputChannel = 'MAINL' | 'MAINR' | 'SUB1L' | 'SUB1R' | 'SUB2L' | 'SUB2R';
export type OutputJack = OutputChannel | 'PHONES';
export type OutputDest = 'MAIN' | 'SUB1' | 'SUB2' | 'PHONES';
/** PREFERENCE switches: where a group of settings is stored. */
export type StoreIn = 'SYSTEM' | 'MEMORY';

// ---------------------------------------------------------------------------------------------------------------------
// Memory settings (LOOP)
// ---------------------------------------------------------------------------------------------------------------------

export interface TrackSettings {
  reverse: boolean; oneShot: boolean; pan: number /* -50..50 */; playLevel: number /* 0..200 */;
  startMode: 'IMMEDIATE' | 'FADE'; stopMode: 'IMMEDIATE' | 'FADE' | 'LOOP'; dubMode: 'OVERDUB' | 'REPLACE1' | 'REPLACE2';
  fx: boolean; playMode: 'MULTI' | 'SINGLE'; measure: MeasureSetting;
  loopSyncSw: boolean; loopSyncMode: 'IMMEDIATE' | 'MEASURE' | 'LOOP LENGTH';
  tempoSyncSw: boolean; tempoSyncMode: 'PITCH' | 'XFADE'; tempoSyncSpeed: 'HALF' | 'NORMAL' | 'DOUBLE';
  bounceIn: boolean; input: Record<InputSource, boolean>;
}
export interface RecSettings { recAction: 'REC->DUB' | 'REC->PLAY'; quantize: 'OFF' | 'MEASURE'; autoRecSw: boolean; autoRecSens: number; bounceSw: boolean; bounceTrack: boolean[] }
export interface PlaySettings { sTrkChange: 'IMMEDIATE' | 'LOOP END' | 'MEASURE'; currentTrack: number /*0..4*/; fadeIn: FadeTime; fadeOut: FadeTime;
  allStartTrk: boolean[]; allStopTrk: boolean[]; loopLength: 'AUTO' | number; speedChange: 'IMMEDIATE' | 'LOOP END'; syncAdjust: 'MEASURE' | 'BEAT' }
export interface RhythmSettings { genre: string; pattern: string; variation: 'A' | 'B' | 'C' | 'D'; kit: string; beat: Beat;
  startTrig: 'LOOP START' | 'REC END' | 'BEFORE LOOP'; stopTrig: 'OFF' | 'LOOP STOP' | 'REC END';
  introRec: boolean; introPlay: boolean; ending: boolean; fill: boolean; varChange: 'MEASURE' | 'LOOP END' }
export interface MemorySettings { name: string; tempo: number; track: TrackSettings[]; rec: RecSettings; play: PlaySettings; rhythm: RhythmSettings;
  prefs: Partial<SystemSettings> }   // values for PREFERENCE=MEMORY groups

// ---------------------------------------------------------------------------------------------------------------------
// System settings (MENU)
// ---------------------------------------------------------------------------------------------------------------------

export interface EqSettings {
  sw: boolean; loGain: number; hiGain: number;
  loMidFreq: number; loMidQ: number; loMidGain: number;
  hiMidFreq: number; hiMidQ: number; hiMidGain: number;
  level: number; loCut: 'FLAT' | number; hiCut: 'FLAT' | number;
}
export interface DynamicsSettings { mic1Comp: 'OFF' | number; mic1Ns: number; mic2Comp: 'OFF' | number; mic2Ns: number; inst1Ns: number; inst2Ns: number }
export interface InputSettings {
  phantom: Record<'MIC1' | 'MIC2', boolean>;
  instGain: Record<'INST1' | 'INST2', 'INST' | 'LINE'>;
  stereoLink: Record<'MIC' | 'INST1' | 'INST2', boolean>;
  preference: Record<'MIC' | 'INST1' | 'INST2', StoreIn>;
  eq: Record<InputChannel, EqSettings>;
  dynamics: DynamicsSettings;
}
export interface OutputRouting {
  /** Tracks 1-5 (array index 0-4) sent to each output jack. */
  track: Record<OutputJack, boolean[]>;
  /** Input and rhythm sounds sent to each output. */
  inputRhythm: Record<OutputDest, Record<InputSource, boolean>>;
  phonesRhythm: boolean; rhythmOut: 'OUTPUT' | 'LOOP'; inputThru: boolean;
  phonesOut: 'MAIN-L, R' | 'SUB1-L, R' | 'SUB2-L, R' | 'INDIVIDUAL'; phonesMonitor: boolean;
}
export interface OutputSettings {
  knob: 'ALL' | 'MASTER' | 'PHONES' | 'OFF';
  stereoLink: Record<'MAIN' | 'SUB1' | 'SUB2', boolean>;
  preference: Record<'MAIN' | 'SUB1' | 'SUB2' | 'PHONES' | 'RHYTHM' | 'MFX', StoreIn>;
  routing: OutputRouting;
  eq: Record<OutputChannel, EqSettings>;
}
export interface MasterFxSettings {
  comp: 'OFF' | number; reverb: number;
  insert: 'MAIN-L' | 'MAIN-R' | 'SUB1-L' | 'SUB1-R' | 'SUB2-L' | 'SUB2-R' | 'OFF';
}
export interface MixerSettings {
  mic1In: number; mic2In: number; inst1LIn: number; inst1RIn: number; inst2LIn: number; inst2RIn: number;
  mainLOut: number; mainROut: number; sub1LOut: number; sub1ROut: number; sub2LOut: number; sub2ROut: number;
  loopOut: number; rhythmOut: number; phonesOut: number; masterOut: number;
}
/** Function names are the LCD labels from PANEL_FUNCTIONS / CTL_FUNCTIONS / EXP_FUNCTIONS (e.g. 'TRK1 TRACK EDIT'). */
export interface CtlSettings {
  /** [TRACK] / [FX] button functions of tracks 1-5 (array index 0-4) in normal play and in undo/redo mode. */
  panelPlay: { track: string[]; fx: string[] };
  panelUndo: { track: string[]; fx: string[] };
  footswitch: Record<'CTL1' | 'CTL2' | 'CTL3' | 'CTL4', string>;
  exp: Record<'EXP1' | 'EXP2', { func: string; min: number; max: number }>;
  preference: { modePlay: StoreIn; modeUndo: StoreIn; quickClear: boolean; allClear: boolean; footswitch: StoreIn; exp: StoreIn };
}
export interface AssignSettings {
  sw: boolean; source: string; sourceMode: 'MOMENT' | 'TOGGLE'; sourceActLo: number; sourceActHi: number;
  target: string; targetMin: number; targetMax: number;
}
export interface UsbSettings {
  storage: 'OFF' | 'CONNECT'; audioMode: 'GENERIC' | 'VENDOR'; audioRouting: 'LINE OUT' | 'SUB MIX' | 'LOOP IN';
  inputLevel: number; outputLevel: number;
}
export interface MidiSettings {
  rxCh: { ctl: number; rhythm: number; voice: number };
  txCh: 'RX CTL' | number;
  sync: { clock: 'AUTO' | 'INTERNAL' | 'MIDI' | 'USB (AUTO)'; out: boolean; start: 'OFF' | 'ALL' | 'RHYTHM' };
  pcOut: boolean;
  thru: 'OFF' | 'MIDI OUT' | 'USB OUT' | 'USB & MIDI';
}
export type LoopStatusColor = 'OFF' | 'RED' | 'GREEN' | 'AMBER' | 'BLUE' | 'PURPLE' | 'CYAN' | 'WHITE';
export interface SetupSettings {
  contrast: number;
  displayMode: 'MEMORY NUMBER' | 'TRACK STATUS' | 'LOOP TRACKS' | 'LOOP STATUS' | 'LOOP LEVEL' | 'INPUT FX' | 'TRACK FX';
  indicator: 'STATUS' | 'LOOP POSITION' | 'LEVEL';
  fxKnobMode: 'IMMEDIATE' | 'HOOK'; autoOff: boolean;
  memoryExt: { min: number; max: number };
  /** Functions of the [1]-[4] knobs (array index 0-3); values are KNOB_FUNCS labels. */
  knobFunc: string[];
  loopStatusColor: Record<'rec' | 'play' | 'dub' | 'stop' | 'blank', LoopStatusColor>;
  // APP ADDITION: not in the Parameter Guide.
  latency: number;          // measured round-trip latency in frames; -1 = not calibrated
  micProcess: boolean;      // getUserMedia echoCancellation/noise processing
  calibPrompted: boolean;   // internal flag: the one-time first-run calibration prompt was shown (hidden param)
}
/**
 * The concrete shape of the system settings. `defaultSystem()` generates the object from SYSTEM_PARAMS, so every
 * param id there resolves to a field of this interface (and the defaults tests check it in both directions).
 */
export interface SystemSettings {
  input: InputSettings;
  output: OutputSettings;
  master: MasterFxSettings;
  mixer: MixerSettings;
  ctl: CtlSettings;
  assign: AssignSettings[];   // ASSIGN 1-16
  usb: UsbSettings;
  midi: MidiSettings;
  setup: SetupSettings;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parameter definitions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * 'bool' on/off; 'int' / 'float' numbers (see `values`, `choices`); 'enum' one of `values`; 'note' a MeasureSetting or
 * FadeTime; 'text' a string up to `max` characters; 'beat' a Beat (set by a Beat or its label, e.g. '4/4').
 */
export type ParamKind = 'bool' | 'int' | 'enum' | 'float' | 'note' | 'text' | 'beat';

export interface ParamDef {
  /**
   * Dotted path into MemorySettings/SystemSettings, e.g. 'track.*.playLevel', 'rec.quantize', 'input.eq.*.loGain'.
   * A `*` segment is an index (a track 0-4, an input/output channel, an ASSIGN number...) listed in `indices`;
   * pass it as the last argument of getParam/setParam. See the id convention at the top of params.ts.
   */
  id: string;
  /** As printed in the guide, e.g. 'PLAY LEVEL'. Where one guide row fans out to several stored values, the guide label plus the part. */
  label: string;
  kind: ParamKind;
  /**
   * enum: the ordered options. int/float/note: extra keyword values accepted besides the numeric range (e.g. ['OFF'] for
   * master.comp, ['AUTO'] for loopLength), listed before the numbers in the UI unless `choices` says otherwise.
   */
  values?: readonly string[];
  /** Numeric range. For kind 'note': the range of the `{ measures }` form. For 'text': `max` is the maximum length. */
  min?: number; max?: number; step?: number;
  default: unknown; scope: 'memory' | 'track' | 'system';
  display: (v: unknown) => string;  // LCD text, e.g. pan -50 -> 'L50', 0 -> 'CENTER'
  phase: 1 | 2 | 3 | 4;  // phase whose behavior uses it (stored from phase 1 regardless)
  /** Guide path for menu grouping, e.g. 'INPUT/EQ' or 'OUTPUT/ROUTING/TRACK'. */
  section?: string;
  /** The allowed values of the `*` segment, in UI order. Tracks are the numbers 0-4. */
  indices?: readonly (string | number)[];
  /** Complete ordered list of allowed values (numbers and keywords) for params that move in a fixed series, e.g. EQ frequencies. Numbers snap to the nearest. */
  choices?: readonly (string | number)[];
  /** Internal app flag: not shown on any menu page. */
  hidden?: boolean;
}
