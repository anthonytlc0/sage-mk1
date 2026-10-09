import type { ButtonId } from './ids';

export type LedColor = 'off' | 'red' | 'green' | 'yellow' | 'pink' | 'blue';
export type Blink = 'none' | 'slow' | 'fast' | 'tempo';
export interface LedState { color: LedColor; blink: Blink }
export interface RingState { color: LedColor; blink: Blink; mode: 'status' | 'position' | 'level'; amount: number } // 0..1
export interface PanelState {
  leds: Partial<Record<ButtonId, LedState>>;   // absent key = off
  rings: [RingState, RingState, RingState, RingState, RingState];
  lcd: Uint8Array;                              // 128*64, row-major, 1 = dark pixel
  contrast: number;                             // 1..10
  beatPhase: number;                            // 0..1 within current beat, drives 'tempo' blink
}
