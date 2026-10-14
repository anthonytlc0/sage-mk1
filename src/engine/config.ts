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
 * A touch device (an iPad): `navigator.maxTouchPoints > 1`. Told by the touch points, never the user agent (an iPad
 * reports a Mac one); the same rule as `isTouchDevice` in storage/share.ts, restated so the engine does not depend on
 * the storage layer.
 */
export function isTouch(nav: { maxTouchPoints?: number } | undefined): boolean {
  return (nav?.maxTouchPoints ?? 0) > 1;
}

/**
 * Seconds of audio an export streams per render block on a touch device (ledger 298). The desktop streams 1 s (384 KB
 * of fresh arrays per 2.7 ms quantum at 48 kHz); the iPad runs a checkpoint export after every punch-out, so it takes
 * a quarter of that per block: 96 KB. A full 384 MiB memory then streams in about 11 s, inside EXPORT_TIMEOUT_MS.
 */
export const TOUCH_EXPORT_SECONDS_PER_BLOCK = 0.25;

/** Seconds of audio per export part for this device: TOUCH_EXPORT_SECONDS_PER_BLOCK on a touch device, else 1. */
export function exportSecondsPerBlock(nav: { maxTouchPoints?: number } | undefined = globalThis.navigator): number {
  return isTouch(nav) ? TOUCH_EXPORT_SECONDS_PER_BLOCK : 1;
}

/** The looper's memory budget for this device: TOUCH_MEMORY_BUDGET on a touch device, else DESKTOP_MEMORY_BUDGET. */
export function memoryBudgetBytes(nav: { maxTouchPoints?: number } | undefined = globalThis.navigator): number {
  return isTouch(nav) ? TOUCH_MEMORY_BUDGET : DESKTOP_MEMORY_BUDGET;
}
