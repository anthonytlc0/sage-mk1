import { NAME_LEN, TEMPO_MAX, TEMPO_MIN } from '../shared/constants';
import { ParamTable, TRACK_INDICES, buildDefaults } from './define';
import { formatTempo, formatTrack, formatPan } from './format';
import {
  DUB_MODES, GUIDE_PATTERNS, LOOP_SYNC_MODES, PHASE1_GENRES, PLAY_MODES, QUANTIZE_MODES, REC_ACTIONS, RHYTHM_KITS, SPEED_CHANGES,
  START_MODES, START_TRIGS, STOP_MODES, STOP_TRIGS, S_TRK_CHANGES, SYNC_ADJUSTS, TEMPO_SYNC_MODES, TEMPO_SYNC_SPEEDS, VARIATIONS,
  VAR_CHANGES, INPUT_SOURCES,
} from './lists';
import { BEAT_VALUES } from './types';
import type { MemorySettings, ParamDef } from './types';

/**
 * Memory settings (LOOP): TRACK 1-5, REC, PLAY, RHYTHM and NAME of Parameter Guide v1.3 pp. 2-8, plus the memory tempo.
 * Defaults are the bold values of the guide. Where the guide marks none, the choice is noted next to the param.
 * The Input FX / Track FX bank parameters (guide pp. 5-6) are phase 2 and not part of this table.
 */

const t = new ParamTable('memory');

// NAME and tempo ------------------------------------------------------------------------------------------------------

t.section('NAME').text('name', 'NAME', NAME_LEN, '');   // an unnamed memory: the LCD shows it blank

// The memory tempo is set on the TAP TEMPO screen, not listed in the guide. 120.0 is the default (not in the guide).
t.section('TEMPO').float('tempo', 'TEMPO', TEMPO_MIN, TEMPO_MAX, 120, { step: 0.1, display: formatTempo });

// TRACK 1-5 (pp. 2-3). One set per track: ids are 'track.*.name' with the track 0-4 as the index. -------------------------

const TRACK = t.section('TRACK', 1, { scope: 'track', indices: TRACK_INDICES });
TRACK.bool('track.*.reverse', 'REVERSE', false);
TRACK.bool('track.*.oneShot', '1SHOT', false);
TRACK.int('track.*.pan', 'PAN', -50, 50, 0, { display: formatPan });
TRACK.int('track.*.playLevel', 'PLAY LEVEL', 0, 200, 100);
TRACK.enum('track.*.startMode', 'START MODE', START_MODES, 'IMMEDIATE');
TRACK.enum('track.*.stopMode', 'STOP MODE', STOP_MODES, 'IMMEDIATE');
TRACK.enum('track.*.dubMode', 'DUB MODE', DUB_MODES, 'OVERDUB');
TRACK.bool('track.*.fx', 'FX', true);
TRACK.enum('track.*.playMode', 'PLAY MODE', PLAY_MODES, 'MULTI');
// MEASURE: AUTO, FREE, a note, or a number of measures. The guide prints the measure range with its upper end missing
// ("note-1-"); 1..64 is assumed, as for FADE TIME (INFERRED).
TRACK.note('track.*.measure', 'MEASURE', ['AUTO', 'FREE'], 1, 64, 'FREE');
TRACK.bool('track.*.loopSyncSw', 'LOOP SYNC SW', true);
// The guide marks no default for LOOP SYNC MODE; IMMEDIATE (the first value) is used (INFERRED).
TRACK.enum('track.*.loopSyncMode', 'LOOP SYNC MODE', LOOP_SYNC_MODES, 'IMMEDIATE');
TRACK.bool('track.*.tempoSyncSw', 'TEMPO SYNC SW', true);
TRACK.enum('track.*.tempoSyncMode', 'TEMPO SYNC MODE', TEMPO_SYNC_MODES, 'XFADE');
TRACK.enum('track.*.tempoSyncSpeed', 'TEMPO SYNC SPEED', TEMPO_SYNC_SPEEDS, 'NORMAL');
TRACK.bool('track.*.bounceIn', 'BOUNCE IN', false);
const INPUT_LABELS: Record<(typeof INPUT_SOURCES)[number], string> = {
  MIC1: 'INPUT MIC1', MIC2: 'INPUT MIC2', INST1L: 'INPUT INST1 L', INST1R: 'INPUT INST1 R', INST2L: 'INPUT INST2 L', INST2R: 'INPUT INST2 R', RHYTHM: 'INPUT RHYTHM',
};
for (const src of INPUT_SOURCES) TRACK.bool(`track.*.input.${src}`, INPUT_LABELS[src], true);

// REC (p. 4) ----------------------------------------------------------------------------------------------------------

const REC = t.section('REC');
REC.enum('rec.recAction', 'REC ACTION', REC_ACTIONS, 'REC->PLAY');   // bold in the guide: Recording -> Playback -> Overdubbing
REC.enum('rec.quantize', 'QUANTIZE', QUANTIZE_MODES, 'MEASURE');
REC.bool('rec.autoRecSw', 'AUTO REC SW', false);
REC.int('rec.autoRecSens', 'AUTO REC SENS', 1, 100, 50);
REC.bool('rec.bounceSw', 'BOUNCE SW', false);
REC.bool('rec.bounceTrack.*', 'BOUNCE TRACK', true, { indices: TRACK_INDICES });

// PLAY (p. 4) ---------------------------------------------------------------------------------------------------------

const PLAY = t.section('PLAY');
PLAY.enum('play.sTrkChange', 'S.TRK CHANGE', S_TRK_CHANGES, 'IMMEDIATE');
PLAY.int('play.currentTrack', 'CURRENT TRACK', 0, 4, 0, { display: formatTrack });
// FADE TIME: a note or 1MEAS-64MEAS, default 2MEAS.
PLAY.note('play.fadeIn', 'FADE TIME IN', [], 1, 64, { measures: 2 }, { suffix: 'MEAS' });
PLAY.note('play.fadeOut', 'FADE TIME OUT', [], 1, 64, { measures: 2 }, { suffix: 'MEAS' });
PLAY.bool('play.allStartTrk.*', 'ALL START TRK', true, { indices: TRACK_INDICES });
PLAY.bool('play.allStopTrk.*', 'ALL STOP TRK', true, { indices: TRACK_INDICES, phase: 4 });   // acts on MIDI stop data
PLAY.int('play.loopLength', 'LOOP LENGTH', 1, 25362, 'AUTO', { keywords: ['AUTO'] });
PLAY.enum('play.speedChange', 'SPEED CHANGE', SPEED_CHANGES, 'IMMEDIATE');
PLAY.enum('play.syncAdjust', 'SYNC ADJUST', SYNC_ADJUSTS, 'MEASURE');

// RHYTHM (p. 7) -------------------------------------------------------------------------------------------------------

const RHYTHM = t.section('RHYTHM');
// Phase 1 offers only the GUIDE genre (a click); RHYTHM_GENRES keeps all of them for phase 3.
RHYTHM.enum('rhythm.genre', 'GENRE', PHASE1_GENRES, 'GUIDE');
// The guide marks no default pattern. '4/4' (the GUIDE pattern of the default 4/4 beat) is used (INFERRED).
RHYTHM.enum('rhythm.pattern', 'PATTERN', GUIDE_PATTERNS.map((p) => p.pattern), '4/4', { phase: 3 });
RHYTHM.enum('rhythm.variation', 'VARIATION', VARIATIONS, 'A', { phase: 3 });
RHYTHM.enum('rhythm.kit', 'KIT', RHYTHM_KITS, 'STUDIO', { phase: 3 });
RHYTHM.beat('rhythm.beat', 'BEAT', BEAT_VALUES, { num: 4, den: 4 });
RHYTHM.enum('rhythm.startTrig', 'START TRIG', START_TRIGS, 'LOOP START', { phase: 3 });
RHYTHM.enum('rhythm.stopTrig', 'STOP TRIG', STOP_TRIGS, 'LOOP STOP', { phase: 3 });
RHYTHM.bool('rhythm.introRec', 'INTRO REC', false, { phase: 3 });
RHYTHM.bool('rhythm.introPlay', 'INTRO PLAY', false, { phase: 3 });
RHYTHM.bool('rhythm.ending', 'ENDING', false, { phase: 3 });
RHYTHM.bool('rhythm.fill', 'FILL', true, { phase: 3 });
RHYTHM.enum('rhythm.varChange', 'VAR.CHANGE', VAR_CHANGES, 'MEASURE', { phase: 3 });

export const MEMORY_PARAMS: ParamDef[] = t.defs;

/** A fresh memory with every guide default. `prefs` (copies of system groups whose PREFERENCE is MEMORY) starts empty. */
export function defaultMemory(): MemorySettings {
  return { ...(buildDefaults(MEMORY_PARAMS) as unknown as Omit<MemorySettings, 'prefs'>), prefs: {} };
}
