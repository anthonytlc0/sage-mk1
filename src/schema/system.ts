import { ParamTable, TRACK_INDICES, buildDefaults } from './define';
import type { Index, Section } from './define';
import { formatDb, formatHz, pad2, plain } from './format';
import { ASSIGN_SOURCES, ASSIGN_TARGETS, CTL_FUNCTIONS, EXP_FUNCTIONS, KNOB_FUNCS, PANEL_FUNCTIONS } from './functions';
import {
  DISPLAY_MODES, EQ_FREQS, EQ_HI_CUTS, EQ_LO_CUTS, EQ_QS, INDICATOR_MODES, INPUT_CHANNELS, INPUT_SOURCES, LOOP_STATUS_COLORS,
  MASTER_INSERTS, OUTPUT_CHANNELS, OUTPUT_DESTS, OUTPUT_JACKS, PHONES_OUT_SW,
} from './lists';
import type { OutputJack, ParamDef, SystemSettings } from './types';

/**
 * System settings (MENU) of Parameter Guide v1.3 pp. 9-33: INPUT, OUTPUT (incl. MASTER FX), MIXER, CTL FUNC, ASSIGN, USB,
 * MIDI and SETUP. FACTORY RESET is an action (FACTORY_RESET_TARGETS in lists.ts), not a param.
 *
 * Defaults are the bold values of the guide. Where the guide marks none the choice is noted next to the param.
 * Hardware-only settings (PHANTOM, INST GAIN, STEREO LINK, USB audio, the SUB jacks, AUTO OFF) are stored and shown but
 * have no effect in the app. ASSIGN, MIDI, USB and CTL/EXP are stored but inert until phase 4.
 */

const t = new ParamTable('system');
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const STORE_IN = ['SYSTEM', 'MEMORY'] as const;
const PANEL_IDS = PANEL_FUNCTIONS.map((f) => f.id);
const CTL_IDS = CTL_FUNCTIONS.map((f) => f.id);

// INPUT ---------------------------------------------------------------------------------------------------------------

const IN_SETUP = t.section('INPUT/SETUP');
IN_SETUP.bool('input.phantom.*', 'PHANTOM', false, { indices: ['MIC1', 'MIC2'] });
IN_SETUP.enum('input.instGain.INST1', 'INST1 GAIN', ['INST', 'LINE'], 'INST');
IN_SETUP.enum('input.instGain.INST2', 'INST2 GAIN', ['INST', 'LINE'], 'INST');
IN_SETUP.bool('input.stereoLink.MIC', 'STEREO LINK MIC', false);
IN_SETUP.bool('input.stereoLink.INST1', 'STEREO LINK INST1', true);
IN_SETUP.bool('input.stereoLink.INST2', 'STEREO LINK INST2', true);
IN_SETUP.enum('input.preference.*', 'PREFERENCE', STORE_IN, 'SYSTEM', { indices: ['MIC', 'INST1', 'INST2'] });

/** One EQ per channel (INPUT: MIC1, MIC2, INST1 L/R, INST2 L/R; OUTPUT: MAIN, SUB1, SUB2 L/R). The same table for both. */
function eqParams(s: Section, root: string, indices: readonly Index[]): void {
  const o = { indices };
  s.bool(`${root}.*.sw`, 'SW', false, o);
  s.int(`${root}.*.loGain`, 'LO GAIN', -20, 20, 0, { ...o, display: formatDb });
  s.int(`${root}.*.hiGain`, 'HIGH GAIN', -20, 20, 0, { ...o, display: formatDb });
  s.float(`${root}.*.loMidFreq`, 'LO MID FREQ', 20, 10000, 250, { ...o, choices: EQ_FREQS, display: formatHz });
  s.float(`${root}.*.loMidQ`, 'LO MID Q', 0.5, 16, 0.5, { ...o, choices: EQ_QS });
  s.int(`${root}.*.loMidGain`, 'LO MID GAIN', -20, 20, 0, { ...o, display: formatDb });
  s.float(`${root}.*.hiMidFreq`, 'HI MID FREQ', 20, 10000, 800, { ...o, choices: EQ_FREQS, display: formatHz });
  s.float(`${root}.*.hiMidQ`, 'HI MID Q', 0.5, 16, 0.5, { ...o, choices: EQ_QS });
  s.int(`${root}.*.hiMidGain`, 'HI MID GAIN', -20, 20, 0, { ...o, display: formatDb });
  s.int(`${root}.*.level`, 'LEVEL', -20, 20, 0, { ...o, display: formatDb });
  s.float(`${root}.*.loCut`, 'LO CUT', 20, 800, 'FLAT', { ...o, keywords: ['FLAT'], choices: EQ_LO_CUTS, display: formatHz });
  s.float(`${root}.*.hiCut`, 'HI CUT', 630, 12500, 'FLAT', { ...o, keywords: ['FLAT'], choices: EQ_HI_CUTS, display: formatHz });
}
eqParams(t.section('INPUT/EQ'), 'input.eq', INPUT_CHANNELS);

const DYN = t.section('INPUT/DYNAMICS');
DYN.int('input.dynamics.mic1Comp', 'MIC1 COMP', 1, 100, 'OFF', { keywords: ['OFF'] });
DYN.int('input.dynamics.mic1Ns', 'MIC1 NS', 0, 100, 40);
DYN.int('input.dynamics.mic2Comp', 'MIC2 COMP', 1, 100, 'OFF', { keywords: ['OFF'] });
DYN.int('input.dynamics.mic2Ns', 'MIC2 NS', 0, 100, 40);
DYN.int('input.dynamics.inst1Ns', 'INST 1 NS', 0, 100, 40);
DYN.int('input.dynamics.inst2Ns', 'INST 2 NS', 0, 100, 40);

// OUTPUT --------------------------------------------------------------------------------------------------------------

const OUT_SETUP = t.section('OUTPUT/SETUP');
OUT_SETUP.enum('output.knob', 'OUTPUT KNOB', ['ALL', 'MASTER', 'PHONES', 'OFF'], 'ALL');
OUT_SETUP.bool('output.stereoLink.*', 'STEREO LINK', true, { indices: ['MAIN', 'SUB1', 'SUB2'] });
OUT_SETUP.enum('output.preference.*', 'PREFERENCE', STORE_IN, 'SYSTEM', { indices: ['MAIN', 'SUB1', 'SUB2', 'PHONES', 'RHYTHM', 'MFX'] });

// ROUTING: which tracks go to each output jack (the guide's MAIN-L, R etc. are stored per jack; array index = track 0-4).
const JACK_LABELS: Record<OutputJack, string> = {
  MAINL: 'MAIN-L', MAINR: 'MAIN-R', SUB1L: 'SUB1-L', SUB1R: 'SUB1-R', SUB2L: 'SUB2-L', SUB2R: 'SUB2-R', PHONES: 'PHONES',
};
const ROUTE_TRACK = t.section('OUTPUT/ROUTING/TRACK');
for (const jack of OUTPUT_JACKS) ROUTE_TRACK.bool(`output.routing.track.${jack}.*`, JACK_LABELS[jack], true, { indices: TRACK_INDICES });

// ROUTING: which inputs and the rhythm go to each output.
const ROUTE_INPUT = t.section('OUTPUT/ROUTING/INPUT/RHYTHM');
for (const dest of OUTPUT_DESTS) ROUTE_INPUT.bool(`output.routing.inputRhythm.${dest}.*`, dest, true, { indices: INPUT_SOURCES });
ROUTE_INPUT.bool('output.routing.phonesRhythm', 'PHONES RHYTHM', false);
ROUTE_INPUT.enum('output.routing.rhythmOut', 'RHYTHM OUT', ['OUTPUT', 'LOOP'], 'OUTPUT');
// DEVIATION: the guide's default is ON. It starts OFF so live mic monitoring is off and the iPad speaker cannot feed back (spec assumption).
ROUTE_INPUT.bool('output.routing.inputThru', 'INPUT THRU', false);
t.section('OUTPUT/ROUTING/PHONES OUT').enum('output.routing.phonesOut', 'PHONES OUT SW', PHONES_OUT_SW, 'MAIN-L, R');   // bold: MAIN
t.section('OUTPUT/ROUTING/PHONES MONITOR').bool('output.routing.phonesMonitor', 'PHONES MONITOR', true);

eqParams(t.section('OUTPUT/EQ'), 'output.eq', OUTPUT_CHANNELS);

const MFX = t.section('OUTPUT/MASTER FX');
MFX.int('master.comp', 'COMP', 1, 40, 'OFF', { keywords: ['OFF'] });
MFX.int('master.reverb', 'REVERB', 0, 40, 0);
MFX.enum('master.insert', 'INSERT', MASTER_INSERTS, 'MAIN-L');   // bold: MAIN (-L; both L and R while STEREO LINK is ON)

// MIXER ---------------------------------------------------------------------------------------------------------------

const MIXER = t.section('MIXER');
const mixerLevels: [string, string][] = [
  ['mic1In', 'MIC 1 IN'], ['mic2In', 'MIC 2 IN'], ['inst1LIn', 'INST1-L IN'], ['inst1RIn', 'INST1-R IN'], ['inst2LIn', 'INST2-L IN'], ['inst2RIn', 'INST2-R IN'],
  ['mainLOut', 'MAIN-L OUT'], ['mainROut', 'MAIN-R OUT'], ['sub1LOut', 'SUB1-L OUT'], ['sub1ROut', 'SUB1-R OUT'], ['sub2LOut', 'SUB2-L OUT'], ['sub2ROut', 'SUB2-R OUT'],
  ['loopOut', 'LOOP OUT'], ['rhythmOut', 'RHYTHM OUT'], ['phonesOut', 'PHONES OUT'], ['masterOut', 'MASTER OUT'],
];
for (const [key, label] of mixerLevels) MIXER.int(`mixer.${key}`, label, 0, 200, 100);

// CTL FUNC ------------------------------------------------------------------------------------------------------------
// PANEL PLAY / PANEL UNDO: the [TRACK] and [FX] button of each track, one param per button. The guide marks no defaults;
// they follow the Owner's Manual: [TRACK] edits the track and [FX] switches its effects, and in undo/redo mode [TRACK] is
// MARK SET and [FX] is MARK CLEAR.

const PANEL_PLAY = t.section('CTL FUNC/PANEL PLAY');
for (const n of TRACK_INDICES) PANEL_PLAY.enum(`ctl.panelPlay.track.${n}`, `TRACK/TRK${n + 1}`, PANEL_IDS, `TRK${n + 1} TRACK EDIT`);
for (const n of TRACK_INDICES) PANEL_PLAY.enum(`ctl.panelPlay.fx.${n}`, `FX/TRK${n + 1}`, PANEL_IDS, `TRK${n + 1} TRACK FX`);
const PANEL_UNDO = t.section('CTL FUNC/PANEL UNDO');
for (const n of TRACK_INDICES) PANEL_UNDO.enum(`ctl.panelUndo.track.${n}`, `TRACK/TRK${n + 1}`, PANEL_IDS, `TRK${n + 1} MARK SET1`);
for (const n of TRACK_INDICES) PANEL_UNDO.enum(`ctl.panelUndo.fx.${n}`, `FX/TRK${n + 1}`, PANEL_IDS, `TRK${n + 1} MARK CLEAR`);

// CTL/EXP: footswitches and expression pedals. Stored; they act in phase 4. The guide marks no default for CTL1-4: OFF.
const CTL_EXP = t.section('CTL FUNC/CTL/EXP', 4);
CTL_EXP.enum('ctl.footswitch.*', 'CTL1-4', CTL_IDS, 'OFF', { indices: ['CTL1', 'CTL2', 'CTL3', 'CTL4'] });
// EXP1 defaults to IN FX CUR CTL and EXP2 to TR FX CUR CTL (bold in the guide). MIN/MAX default to the full 0-255 range (not marked in the guide).
CTL_EXP.enum('ctl.exp.EXP1.func', 'EXP1 FUNC', EXP_FUNCTIONS, 'IN FX CUR CTL');
CTL_EXP.int('ctl.exp.EXP1.min', 'EXP1 MIN', 0, 255, 0);
CTL_EXP.int('ctl.exp.EXP1.max', 'EXP1 MAX', 0, 255, 255);
CTL_EXP.enum('ctl.exp.EXP2.func', 'EXP2 FUNC', EXP_FUNCTIONS, 'TR FX CUR CTL');
CTL_EXP.int('ctl.exp.EXP2.min', 'EXP2 MIN', 0, 255, 0);
CTL_EXP.int('ctl.exp.EXP2.max', 'EXP2 MAX', 0, 255, 255);

const CTL_PREF = t.section('CTL FUNC/PREFERENCE');
CTL_PREF.enum('ctl.preference.modePlay', 'MODE PLAY', STORE_IN, 'SYSTEM');
CTL_PREF.enum('ctl.preference.modeUndo', 'MODE UNDO', STORE_IN, 'SYSTEM');
CTL_PREF.bool('ctl.preference.quickClear', 'QUICK CLEAR', false);
CTL_PREF.bool('ctl.preference.allClear', 'ALL CLEAR', false);
CTL_PREF.enum('ctl.preference.footswitch', 'CTL1-4', STORE_IN, 'SYSTEM', { phase: 4 });
CTL_PREF.enum('ctl.preference.exp', 'EXP1, 2', STORE_IN, 'SYSTEM', { phase: 4 });

// ASSIGN 1-16 ---------------------------------------------------------------------------------------------------------
// The guide says the ASSIGN settings are stored per memory; here they are kept with the system settings (stored, inert until phase 4).
// The guide marks no defaults beyond SW: OFF. SOURCE, SOURCE MODE and TARGET start at their first value; ACT LO/HI at the normal 0 and 127.
// TARGET MIN/MAX depend on the target, and no range is printed: 0..65535 holds any of them (INFERRED).

const ASSIGN = t.section('ASSIGN', 4, { indices: range(16) });
ASSIGN.bool('assign.*.sw', 'SW', false);
ASSIGN.enum('assign.*.source', 'SOURCE', ASSIGN_SOURCES, 'TRK1 REC/DB');
ASSIGN.enum('assign.*.sourceMode', 'SOURCE MODE', ['MOMENT', 'TOGGLE'], 'MOMENT');
ASSIGN.int('assign.*.sourceActLo', 'SOURCE ACT. LO', 0, 127, 0);
ASSIGN.int('assign.*.sourceActHi', 'SOURCE ACT. HI', 0, 127, 127);
ASSIGN.enum('assign.*.target', 'TARGET', ASSIGN_TARGETS, 'TRK1 REC/PLY');
ASSIGN.int('assign.*.targetMin', 'TARGET MIN', 0, 65535, 0);
ASSIGN.int('assign.*.targetMax', 'TARGET MAX', 0, 65535, 127);

// USB (p. 28): hardware-only, stored ----------------------------------------------------------------------------------

const USB = t.section('USB', 4);
USB.enum('usb.storage', 'STORAGE', ['OFF', 'CONNECT'], 'OFF');
USB.enum('usb.audioMode', 'AUDIO MODE', ['GENERIC', 'VENDOR'], 'GENERIC');
USB.enum('usb.audioRouting', 'AUDIO ROUTING', ['LINE OUT', 'SUB MIX', 'LOOP IN'], 'LINE OUT');
USB.int('usb.inputLevel', 'INPUT LEVEL', 0, 200, 100);
USB.int('usb.outputLevel', 'OUTPUT LEVEL', 0, 200, 100);

// MIDI (p. 29) --------------------------------------------------------------------------------------------------------

const MIDI = t.section('MIDI', 4);
MIDI.int('midi.rxCh.ctl', 'RX CH CTL', 1, 16, 1);
MIDI.int('midi.rxCh.rhythm', 'RX CH RHYTHM', 1, 16, 10);
MIDI.int('midi.rxCh.voice', 'RX CH VOICE', 1, 16, 1);
MIDI.int('midi.txCh', 'TX CH', 1, 16, 'RX CTL', { keywords: ['RX CTL'], choices: [...Array.from({ length: 16 }, (_, i) => i + 1), 'RX CTL'] });
MIDI.enum('midi.sync.clock', 'SYNC CLOCK', ['AUTO', 'INTERNAL', 'MIDI', 'USB (AUTO)'], 'AUTO');
MIDI.bool('midi.sync.out', 'SYNC OUT', true);
MIDI.enum('midi.sync.start', 'SYNC START', ['OFF', 'ALL', 'RHYTHM'], 'ALL');
MIDI.bool('midi.pcOut', 'PC OUT', true);
MIDI.enum('midi.thru', 'THRU', ['OFF', 'MIDI OUT', 'USB OUT', 'USB & MIDI'], 'OFF');

// SETUP (pp. 30-33) ---------------------------------------------------------------------------------------------------

const SETUP = t.section('SETUP');
SETUP.int('setup.contrast', 'CONTRAST', 1, 10, 5);
SETUP.enum('setup.displayMode', 'DISPLAY MODE', DISPLAY_MODES, 'MEMORY NUMBER');
SETUP.enum('setup.indicator', 'INDICATOR', INDICATOR_MODES, 'STATUS');
SETUP.enum('setup.fxKnobMode', 'FX KNOB MODE', ['IMMEDIATE', 'HOOK'], 'IMMEDIATE', { phase: 2 });
SETUP.bool('setup.autoOff', 'AUTO OFF', true);   // hardware-only
SETUP.int('setup.memoryExt.min', 'MEMORY EXT MIN', 1, 99, 1, { display: pad2 });
SETUP.int('setup.memoryExt.max', 'MEMORY EXT MAX', 1, 99, 99, { display: pad2 });
// KNOB FUNC 1-4: defaults are knob 1 MEMORY, knobs 2 and 3 OFF, knob 4 MFX REVERB (bold in the guide).
const KNOB_DEFAULTS = ['MEMORY', 'OFF', 'OFF', 'MFX REVERB'];
for (const n of range(4)) SETUP.enum(`setup.knobFunc.${n}`, `KNOB FUNC ${n + 1}`, KNOB_FUNCS, KNOB_DEFAULTS[n]!, { display: plain });
// LOOP STATUS COLOR (new in Ver. 1.3): the colour of the [REC/PLAY] button for each track state.
const LED_COLORS: [string, string, string][] = [
  ['rec', 'REC', 'RED'], ['play', 'PLAY', 'GREEN'], ['dub', 'DUB', 'AMBER'], ['stop', 'STOP', 'OFF'], ['blank', 'BLANK', 'OFF'],
];
for (const [key, label, def] of LED_COLORS) SETUP.enum(`setup.loopStatusColor.${key}`, `LOOP STATUS COLOR ${label}`, LOOP_STATUS_COLORS, def);
// APP ADDITION: measured round-trip audio latency in frames (calibrated from the LATENCY menu); -1 = not calibrated.
// The 192000 upper bound (2 s at 96 kHz) is a sanity limit, not a guide value.
SETUP.int('setup.latency', 'LATENCY', -1, 192000, -1);
// APP ADDITION: whether the mic is opened with echo cancellation / noise processing (getUserMedia). Off by default:
// iOS crackles when it is on.
SETUP.bool('setup.micProcess', 'MIC PROCESS', false);
// APP ADDITION: internal flag, set once the first-run latency-calibration prompt has been shown. Not on any menu page.
SETUP.bool('setup.calibPrompted', 'CALIB PROMPTED', false, { hidden: true });

export const SYSTEM_PARAMS: ParamDef[] = t.defs;

/** A fresh system settings object with every guide default (and the one deviation: INPUT THRU off). */
export function defaultSystem(): SystemSettings {
  return buildDefaults(SYSTEM_PARAMS) as unknown as SystemSettings;
}
