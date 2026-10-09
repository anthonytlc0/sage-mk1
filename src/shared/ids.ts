export type TrackIndex = 0 | 1 | 2 | 3 | 4;
export const TRACKS: readonly TrackIndex[] = [0, 1, 2, 3, 4];
type N = 1 | 2 | 3 | 4 | 5;
type Slot = 'A' | 'B' | 'C' | 'D';
export type ButtonId =
  | `trk${N}.rec` | `trk${N}.stop` | `trk${N}.track` | `trk${N}.fx`
  | `in.${Slot}` | 'in.edit' | `tr.${Slot}` | 'tr.edit'
  | 'allStartStop' | 'undoRedo' | 'menu' | 'loop' | 'exit' | 'enter' | 'left' | 'right'
  | 'tapTempo' | 'rhythmEdit' | 'rhythmStartStop'
  | 'knob1' | 'knob2' | 'knob3' | 'knob4';            // encoder push
export type EncoderId = 'knob1' | 'knob2' | 'knob3' | 'knob4';
export type AbsoluteId = 'in.knob' | 'tr.knob' | 'outputLevel' | `trk${N}.fader`;
export type ControlEvent =
  | { kind: 'press'; id: ButtonId; t: number }        // t = event.timeStamp (performance.now ms)
  | { kind: 'release'; id: ButtonId; t: number }
  | { kind: 'turn'; id: EncoderId; steps: number; t: number } // signed detent steps
  | { kind: 'set'; id: AbsoluteId; value: number; t: number }; // 0..1 physical position
