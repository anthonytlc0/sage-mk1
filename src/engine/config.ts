/**
 * Engine constants shared by the main-thread host and the AudioWorklet processor. Kept in their own module so the host
 * can use them without pulling the processor (and with it the looper core and the DSP) into the main bundle, and the
 * worklet bundle stays free of main-thread code.
 */

/** The name the processor is registered under (`registerProcessor`) and the host creates its node with. */
export const PROCESSOR_NAME = 'sage-processor';

/** Frames per `recorderBlock` event: the recorder bus is posted in batches of this size. */
export const RECORDER_BLOCK = 4096;

/** The memory budget for the current memory's audio on a touch device (the iPad), ruling R9. */
export const TOUCH_MEMORY_BUDGET = 384 * 1024 * 1024;
/** The same budget on a desktop. */
export const DESKTOP_MEMORY_BUDGET = 1024 * 1024 * 1024;

/**
 * The looper's memory budget for this device: TOUCH_MEMORY_BUDGET when `navigator.maxTouchPoints > 1`, else
 * DESKTOP_MEMORY_BUDGET. Touch is told by the touch points, never the user agent (an iPad reports a Mac one); the same
 * rule as `isTouchDevice` in storage/share.ts, restated here so the engine does not depend on the storage layer.
 */
export function memoryBudgetBytes(nav: { maxTouchPoints?: number } | undefined = globalThis.navigator): number {
  return (nav?.maxTouchPoints ?? 0) > 1 ? TOUCH_MEMORY_BUDGET : DESKTOP_MEMORY_BUDGET;
}
