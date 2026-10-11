import type { MemorySettings, SystemSettings, Beat } from '../schema/types';
import type { TrackIndex } from './ids';
export interface TrackAudio { L: Float32Array; R: Float32Array; sampleRate: number; recordedTempo: number; measures: number | null }
export type EngineCommand =
  | { t: 'recPlay'; track: TrackIndex } | { t: 'stop'; track: TrackIndex } | { t: 'clear'; track: TrackIndex }
  | { t: 'clearAll' } | { t: 'allStartStop' }
  | { t: 'undoRedo'; track: TrackIndex } | { t: 'markSet'; track: TrackIndex } | { t: 'markClear'; track: TrackIndex }
  | { t: 'markBack'; track: TrackIndex } | { t: 'recBack'; track: TrackIndex }
  | { t: 'speedMoment'; track: TrackIndex; speed: 'HALF' | 'DOUBLE' | null }
  | { t: 'rhythmStartStop' }
  | { t: 'tempo'; bpm: number }
  | { t: 'fader'; track: TrackIndex; gain: number }        // linear gain from fader taper
  | { t: 'settings'; memory: MemorySettings; system: SystemSettings }
  | { t: 'loadTrack'; track: TrackIndex; audio: TrackAudio | null }
  | { t: 'exportTracks'; reqId: number }
  | { t: 'latency'; roundTripFrames: number; outputLatencyFrames: number }
  | { t: 'recorder'; on: boolean }
  | { t: 'calibrate'; reqId: number }
  | { t: 'interrupt' }                                       // host lost audio: end rec/dub passes
  | { t: 'micMute'; on: boolean };                           // MIC (MIC1/MIC2) IN MUTE: the one mic, ahead of the input chain
export interface TimedCommand { cmd: EngineCommand; at: number | null } // heard-timeline frame; null = now
export type TrackState = 'empty' | 'stopped' | 'recording' | 'overdubbing' | 'playing';
export interface TrackStatus {
  state: TrackState; pending: 'rec' | 'dub' | 'play' | 'stop' | null; stopping: boolean; autoRecWaiting: boolean;
  position: number; lengthFrames: number; measures: number | null; peak: number;
  canUndo: boolean; canRedo: boolean; hasMark: boolean; speed: 'HALF' | 'NORMAL' | 'DOUBLE';
}
export type EngineMessage = 'MEMORY FULL' | 'TEMPO TOO FAST' | 'TEMPO TOO SLOW' | 'NO INPUT';
export interface EngineStatus {
  frame: number; sampleRate: number; tempo: number; beat: Beat; beatPhase: number; measurePhase: number;
  rhythm: 'off' | 'on' | 'standby'; tracks: TrackStatus[]; inputPeak: number; outputPeak: number;
  memoryBytes: number; memoryBudget: number; recorderFrames: number | null; audioDirty: boolean;
}
export type EngineEvent =
  | { t: 'status'; status: EngineStatus }
  | { t: 'tracks'; reqId: number; tracks: (TrackAudio | null)[] }
  | { t: 'recorderBlock'; L: Float32Array; R: Float32Array }
  | { t: 'calibration'; reqId: number; capture: Float32Array; clickFrames: number[] }
  | { t: 'message'; text: EngineMessage };
