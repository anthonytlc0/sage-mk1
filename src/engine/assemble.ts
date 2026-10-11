/**
 * Main-thread reassembly of streamed exports (ruling R47). The processor answers `exportTracks` with `tracksStart`
 * (every track's length and metadata), `tracksPart`s (pieces of at most one block's budget, buffers transferred) and
 * `tracksEnd`. The full arrays are allocated here, on the main thread, when the header arrives; each part is copied
 * into place and dropped. `tracksEnd` yields the `tracks` event the controller expects.
 */

import type { EngineEvent, TrackAudio } from '../shared/protocol';

export type ExportEvent = Extract<EngineEvent, { t: 'tracksStart' | 'tracksPart' | 'tracksEnd' }>;
type TracksEvent = Extract<EngineEvent, { t: 'tracks' }>;

export function isExportEvent(e: EngineEvent): e is ExportEvent {
  return e.t === 'tracksStart' || e.t === 'tracksPart' || e.t === 'tracksEnd';
}

export class ExportAssembler {
  /** Exports in progress, by request. */
  private readonly pending = new Map<number, (TrackAudio | null)[]>();

  /** Takes one export event; returns the finished `tracks` event when `e` completes a request, else null. */
  take(e: ExportEvent): TracksEvent | null {
    switch (e.t) {
      case 'tracksStart':
        this.pending.set(
          e.reqId,
          e.tracks.map((m) =>
            m === null
              ? null
              : {
                  L: new Float32Array(m.frames),
                  R: new Float32Array(m.frames),
                  sampleRate: m.sampleRate,
                  recordedTempo: m.recordedTempo,
                  measures: m.measures,
                },
          ),
        );
        return null;
      case 'tracksPart': {
        const t = this.pending.get(e.reqId)?.[e.track];
        // A part that does not fit its track is dropped rather than thrown on (the result would be short anyway).
        if (t && e.offset >= 0 && e.offset + e.L.length <= t.L.length && e.R.length === e.L.length) {
          t.L.set(e.L, e.offset);
          t.R.set(e.R, e.offset);
        }
        return null;
      }
      case 'tracksEnd': {
        const tracks = this.pending.get(e.reqId);
        if (tracks === undefined) return null;
        this.pending.delete(e.reqId);
        return { t: 'tracks', reqId: e.reqId, tracks };
      }
    }
  }
}
