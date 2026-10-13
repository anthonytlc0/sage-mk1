/**
 * Playwright init scripts for the mic (`page.addInitScript(fakeMic)`), so the app's power-on runs the same way in
 * Chromium and WebKit, with no permission prompt and no real device:
 *  - `fakeMic`: getUserMedia gives a 440 Hz sine at -12 dBFS (OscillatorNode -> GainNode -> MediaStreamDestination),
 *    from one AudioContext of its own shared by every call;
 *  - `noMic`: getUserMedia rejects as a refused permission does (NotAllowedError).
 * They replace `MediaDevices.prototype.getUserMedia`, not the method on `navigator.mediaDevices`: WebKit may collect
 * that wrapper object and hand out a fresh one later, which would lose a property set on the old one.
 * Each is serialised into the page, so it must not use anything from outside its own body.
 */

export function fakeMic(): void {
  if (typeof MediaDevices === 'undefined') return;
  let ctx: AudioContext | null = null;
  const getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (!constraints?.audio) throw new DOMException('fake mic: audio only', 'NotSupportedError');
    ctx ??= new AudioContext();
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 440 });
    const gain = new GainNode(ctx, { gain: 10 ** (-12 / 20) }); // -12 dBFS peak
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    void ctx.resume().catch(() => undefined);
    return dest.stream;
  };
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: getUserMedia, configurable: true, writable: true });
}

export function noMic(): void {
  if (typeof MediaDevices === 'undefined') return;
  const getUserMedia = (): Promise<MediaStream> => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: getUserMedia, configurable: true, writable: true });
}
