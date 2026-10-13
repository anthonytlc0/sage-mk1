import type { Beat, InputChannel, InputSource, OutputChannel, OutputDest, OutputJack } from './types';

/** Enumerated value lists transcribed from the Parameter Guide (the function lists are in functions.ts). */

// RHYTHM ----------------------------------------------------------------------------------------------------------------

/** GENRE as printed in the guide (p. 7). Phase 1 only offers GUIDE; the rest arrive with the rhythm section in phase 3. */
export const RHYTHM_GENRES: readonly string[] = [
  'ACOUSTIC', 'BALLAD', 'BLUES', 'JAZZ', 'FUSION', 'R&B', 'SOUL', 'FUNK', 'POP', 'SOFT ROCK', 'ROCK', 'ALT ROCK', 'PUNK', 'HEAVY ROCK',
  'METAL', 'TRAD', 'WORLD', 'BALLRM', 'ELCTRO', 'GUIDE', 'USER',
];
/** The phase-1 selectable genres. */
export const PHASE1_GENRES: readonly string[] = ['GUIDE'];

/** KIT (p. 7). */
export const RHYTHM_KITS: readonly string[] = [
  'STUDIO', 'LIVE', 'LIGHT', 'HEAVY', 'ROCK', 'METAL', 'JAZZ', 'BRUSH', 'CAJON', 'DRUM&BASS', 'R&B', 'DANCE', 'TECHNO', 'DANCE BEATS',
  'HIPHOP', '808+909',
];

const b = (num: number, den: 4 | 8): Beat => ({ num, den });
/** The patterns of the GUIDE genre with their beat (Rhythm Pattern List, p. 45). Pattern names are factual and used as-is. */
export const GUIDE_PATTERNS: readonly { pattern: string; beat: Beat }[] = [
  { pattern: '2/4 TRIPLE', beat: b(2, 4) },
  { pattern: '3/4', beat: b(3, 4) }, { pattern: '3/4 TRIPLE', beat: b(3, 4) },
  { pattern: '4/4', beat: b(4, 4) }, { pattern: '4/4 TRIPLE', beat: b(4, 4) },
  { pattern: 'BD 8BEAT', beat: b(4, 4) }, { pattern: 'BD 16BEAT', beat: b(4, 4) }, { pattern: 'BD SHUFFLE', beat: b(4, 4) },
  { pattern: 'HH 8BEAT', beat: b(4, 4) }, { pattern: 'HH 16BEAT', beat: b(4, 4) }, { pattern: 'HH SWING1', beat: b(4, 4) }, { pattern: 'HH SWING2', beat: b(4, 4) },
  { pattern: '8BEAT1', beat: b(4, 4) }, { pattern: '8BEAT2', beat: b(4, 4) }, { pattern: '8BEAT3', beat: b(4, 4) }, { pattern: '8BEAT4', beat: b(4, 4) },
  { pattern: '5/4', beat: b(5, 4) }, { pattern: '5/4 TRIPLE', beat: b(5, 4) },
  { pattern: '6/4', beat: b(6, 4) }, { pattern: '6/4 TRIPLE', beat: b(6, 4) },
  { pattern: '7/4', beat: b(7, 4) }, { pattern: '7/4 TRIPLE', beat: b(7, 4) },
  { pattern: '5/8', beat: b(5, 8) }, { pattern: '6/8', beat: b(6, 8) }, { pattern: '7/8', beat: b(7, 8) }, { pattern: '8/8', beat: b(8, 8) },
  { pattern: '9/8', beat: b(9, 8) }, { pattern: '10/8', beat: b(10, 8) }, { pattern: '11/8', beat: b(11, 8) }, { pattern: '12/8', beat: b(12, 8) },
  { pattern: '13/8', beat: b(13, 8) }, { pattern: '14/8', beat: b(14, 8) }, { pattern: '15/8', beat: b(15, 8) },
];

// TRACK / REC / PLAY ----------------------------------------------------------------------------------------------------

export const START_MODES = ['IMMEDIATE', 'FADE'] as const;
export const STOP_MODES = ['IMMEDIATE', 'FADE', 'LOOP'] as const;
export const DUB_MODES = ['OVERDUB', 'REPLACE1', 'REPLACE2'] as const;
export const PLAY_MODES = ['MULTI', 'SINGLE'] as const;
export const LOOP_SYNC_MODES = ['IMMEDIATE', 'MEASURE', 'LOOP LENGTH'] as const;
export const TEMPO_SYNC_MODES = ['PITCH', 'XFADE'] as const;
export const TEMPO_SYNC_SPEEDS = ['HALF', 'NORMAL', 'DOUBLE'] as const;
export const REC_ACTIONS = ['REC->DUB', 'REC->PLAY'] as const;
export const QUANTIZE_MODES = ['OFF', 'MEASURE'] as const;
export const S_TRK_CHANGES = ['IMMEDIATE', 'LOOP END', 'MEASURE'] as const;
export const SPEED_CHANGES = ['IMMEDIATE', 'LOOP END'] as const;
export const SYNC_ADJUSTS = ['MEASURE', 'BEAT'] as const;
export const VARIATIONS = ['A', 'B', 'C', 'D'] as const;
export const START_TRIGS = ['LOOP START', 'REC END', 'BEFORE LOOP'] as const;
export const STOP_TRIGS = ['OFF', 'LOOP STOP', 'REC END'] as const;
export const VAR_CHANGES = ['MEASURE', 'LOOP END'] as const;

// INPUT / OUTPUT --------------------------------------------------------------------------------------------------------

export const INPUT_CHANNELS: readonly InputChannel[] = ['MIC1', 'MIC2', 'INST1L', 'INST1R', 'INST2L', 'INST2R'];
export const INPUT_SOURCES: readonly InputSource[] = [...INPUT_CHANNELS, 'RHYTHM'];
export const OUTPUT_CHANNELS: readonly OutputChannel[] = ['MAINL', 'MAINR', 'SUB1L', 'SUB1R', 'SUB2L', 'SUB2R'];
export const OUTPUT_JACKS: readonly OutputJack[] = [...OUTPUT_CHANNELS, 'PHONES'];
export const OUTPUT_DESTS: readonly OutputDest[] = ['MAIN', 'SUB1', 'SUB2', 'PHONES'];

/** EQ LO MID / HI MID FREQ: 20.0 Hz-10.0 kHz. The guide prints only the range; the series is the standard 1/3-octave steps (INFERRED). */
export const EQ_FREQS: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
];
/** EQ Q: 0.5-16, octave steps (INFERRED). */
export const EQ_QS: readonly number[] = [0.5, 1, 2, 4, 8, 16];
/** LO CUT: FLAT, 20-800 Hz. */
export const EQ_LO_CUTS: readonly (string | number)[] = ['FLAT', ...EQ_FREQS.filter((f) => f <= 800)];
/** HI CUT: 630 Hz-12.5 kHz, FLAT. */
export const EQ_HI_CUTS: readonly (string | number)[] = [...EQ_FREQS.filter((f) => f >= 630), 12500, 'FLAT'];

export const PHONES_OUT_SW = ['MAIN-L, R', 'SUB1-L, R', 'SUB2-L, R', 'INDIVIDUAL'] as const;
export const MASTER_INSERTS = ['MAIN-L', 'MAIN-R', 'SUB1-L', 'SUB1-R', 'SUB2-L', 'SUB2-R', 'OFF'] as const;

// SETUP / USB / MIDI ----------------------------------------------------------------------------------------------------

export const DISPLAY_MODES = ['MEMORY NUMBER', 'TRACK STATUS', 'LOOP TRACKS', 'LOOP STATUS', 'LOOP LEVEL', 'INPUT FX', 'TRACK FX'] as const;
export const INDICATOR_MODES = ['STATUS', 'LOOP POSITION', 'LEVEL'] as const;
export const LOOP_STATUS_COLORS = ['OFF', 'RED', 'GREEN', 'AMBER', 'BLUE', 'PURPLE', 'CYAN', 'WHITE'] as const;

/**
 * FACTORY RESET is an action, not a stored parameter. Labelled as on the Owner's Manual p. 24 (the Parameter Guide's
 * table abbreviates the last one to MEM+SYS).
 */
export const FACTORY_RESET_TARGETS = ['MEMORY', 'SYSTEM', 'MEMORY+SYSTEM'] as const;
