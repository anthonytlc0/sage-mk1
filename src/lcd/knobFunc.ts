/**
 * SETUP KNOB FUNC 1-4: what knobs [1]-[4] do on a play screen (Parameter Guide pp. 30-33). The table maps each function
 * label to the parameters it turns; MEMORY (knob [1]'s default) is handled by the play screen itself, and the effect
 * functions (IN FX / TR FX, phase 2) and PANEL MODE do nothing yet, like OFF.
 */

import type { Controller } from '../control/controller';
import { findParam } from '../schema/params';
import { stepParam } from './screens/paramPage';

export type KnobAction =
  /** Turns these parameters together (the first gives the value shown). */
  | { kind: 'params'; ids: readonly string[] | ((ctx: Controller) => readonly string[]) }
  /** Mutes these MIXER inputs (by key, e.g. `mic1In`). */
  | { kind: 'mute'; keys: readonly string[] }
  /** Switches the play screen. */
  | { kind: 'display' };

/** What an action needs from the menu system. */
export interface KnobTarget {
  isMuted(keys: readonly string[]): boolean;
  setMuted(keys: readonly string[], on: boolean): void;
  cyclePlay(steps: number): string;
}

const table = new Map<string, KnobAction>();
const params = (label: string, ...ids: string[]): void => void table.set(label, { kind: 'params', ids });
const mute = (label: string, ...keys: string[]): void => void table.set(label, { kind: 'mute', keys });

for (let n = 1; n <= 5; n++) {
  const t = `track.${n - 1}`;
  params(`TRK${n} REVERSE`, `${t}.reverse`);
  params(`TRK${n} 1SHOT`, `${t}.oneShot`);
  params(`TRK${n} PAN`, `${t}.pan`);
  params(`TRK${n} LEVEL`, `${t}.playLevel`);
  params(`TRK${n} DUB`, `${t}.dubMode`);
  params(`TRK${n} FX`, `${t}.fx`);
  params(`TRK${n} BNC IN`, `${t}.bounceIn`);
}
table.set('DUB MODE', { kind: 'params', ids: (ctx) => [`track.${ctx.session.memory.play.currentTrack}.dubMode`] });
params('AUTO REC', 'rec.autoRecSw');
params('BOUNCE', 'rec.bounceSw');
params('CURRENT TRACK', 'play.currentTrack');
params('FD TIME IN', 'play.fadeIn');
params('FD TIME OUT', 'play.fadeOut');

params('RHYTHM LEVEL', 'mixer.rhythmOut');
params('RHYTHM VARI', 'rhythm.variation');
params('RHYTHM KIT', 'rhythm.kit');
params('RHYTHM R.INTRO', 'rhythm.introRec');
params('RHYTHM P.INTRO', 'rhythm.introPlay');
params('RHYTHM ENDING', 'rhythm.ending');

// "1, 2" in a label means both connectors of that pair: one knob moves both.
params('MIC1, 2 LEVEL', 'mixer.mic1In', 'mixer.mic2In');
mute('MIC1, 2 MUTE', 'mic1In', 'mic2In');
params('INST1, 2 LEVEL', 'mixer.inst1LIn', 'mixer.inst2LIn');
mute('INST1, 2 MUTE', 'inst1LIn', 'inst2LIn');
params('INST1(R), 2(R) LEVEL', 'mixer.inst1RIn', 'mixer.inst2RIn');
mute('INST1(R), 2(R) MUTE', 'inst1RIn', 'inst2RIn');
params('LOOP LEVEL', 'mixer.loopOut');
params('MAIN LEVEL', 'mixer.mainLOut');
params('MAIN(R) LEVEL', 'mixer.mainROut');
params('SUB1, 2 LEVEL', 'mixer.sub1LOut', 'mixer.sub2LOut');
params('SUB1(R), 2(R) LEVEL', 'mixer.sub1ROut', 'mixer.sub2ROut');
params('PHONES LEVEL', 'mixer.phonesOut');
params('MASTER LEVEL', 'mixer.masterOut');
params('INST 1, 2 GAIN', 'input.instGain.INST1', 'input.instGain.INST2');

// the EQs: SW, LO G, HI G, LM F/Q/G, HM F/Q/G, LVL, LO C, HI C of each input or output pair
const EQ_PARTS: [string, string][] = [
  ['SW', 'sw'], ['LO G', 'loGain'], ['HI G', 'hiGain'], ['LM F', 'loMidFreq'], ['LM Q', 'loMidQ'], ['LM G', 'loMidGain'],
  ['HM F', 'hiMidFreq'], ['HM Q', 'hiMidQ'], ['HM G', 'hiMidGain'], ['LVL', 'level'], ['LO C', 'loCut'], ['HI C', 'hiCut'],
];
const EQ_PAIRS: [string, string, string, string][] = [
  ['MIC1, 2', 'input.eq', 'MIC1', 'MIC2'],
  ['INST1-L, R', 'input.eq', 'INST1L', 'INST1R'],
  ['INST2-L, R', 'input.eq', 'INST2L', 'INST2R'],
  ['MAIN-L, R', 'output.eq', 'MAINL', 'MAINR'],
  ['SUB1-L, R', 'output.eq', 'SUB1L', 'SUB1R'],
  ['SUB2-L, R', 'output.eq', 'SUB2L', 'SUB2R'],
];
for (const [name, root, a, b] of EQ_PAIRS) {
  for (const [part, field] of EQ_PARTS) params(`${name} EQ ${part}`, `${root}.${a}.${field}`, `${root}.${b}.${field}`);
}
params('MIC1, 2 COMP', 'input.dynamics.mic1Comp', 'input.dynamics.mic2Comp');
params('MIC1, 2 NS', 'input.dynamics.mic1Ns', 'input.dynamics.mic2Ns');
params('INST 1, 2 NS', 'input.dynamics.inst1Ns', 'input.dynamics.inst2Ns');
params('RHYTHM OUT', 'output.routing.rhythmOut');
params('INPUT THRU', 'output.routing.inputThru');
params('PHONES MONITOR', 'output.routing.phonesMonitor');
params('PHONES OUT', 'output.routing.phonesOut');
params('MFX COMP', 'master.comp');
params('MFX REVERB', 'master.reverb');
params('INDICATOR', 'setup.indicator');
table.set('DISPLAY MODE', { kind: 'display' });

/** The action of a KNOB FUNC label, or null for OFF, MEMORY (the play screen's own), PANEL MODE and the effects. */
export function knobAction(label: string): KnobAction | null {
  return table.get(label) ?? null;
}

function idsOf(a: Extract<KnobAction, { kind: 'params' }>, ctx: Controller): readonly string[] {
  return typeof a.ids === 'function' ? a.ids(ctx) : a.ids;
}

/** Sets every parameter of `ids` to `value` and returns the text of the first as it is now. */
function setAll(ctx: Controller, ids: readonly string[], value: unknown): string {
  for (const id of ids) ctx.setParam(id, value);
  return findParam(ids[0]!)!.def.display(ctx.session.get(ids[0]!));
}

/** A turn of `steps` detents. Returns the text to flash under the knob (the new value), or null. */
export function applyKnobTurn(a: KnobAction, ctx: Controller, target: KnobTarget, steps: number): string | null {
  switch (a.kind) {
    case 'params': {
      const ids = idsOf(a, ctx);
      const def = findParam(ids[0]!)!.def;
      return setAll(ctx, ids, stepParam(def, ctx.session.get(ids[0]!), steps));
    }
    case 'mute':
      if (steps !== 0) target.setMuted(a.keys, steps > 0);
      return target.isMuted(a.keys) ? 'MUTE' : 'OFF';
    case 'display':
      return target.cyclePlay(steps);
  }
}

/** A push of the knob: switches a bool or a mute, does nothing for the rest. */
export function applyKnobPush(a: KnobAction, ctx: Controller, target: KnobTarget): string | null {
  switch (a.kind) {
    case 'params': {
      const ids = idsOf(a, ctx);
      const def = findParam(ids[0]!)!.def;
      if (def.kind !== 'bool') return null;
      return setAll(ctx, ids, !ctx.session.get(ids[0]!));
    }
    case 'mute':
      target.setMuted(a.keys, !target.isMuted(a.keys));
      return target.isMuted(a.keys) ? 'MUTE' : 'OFF';
    case 'display':
      return null;
  }
}
