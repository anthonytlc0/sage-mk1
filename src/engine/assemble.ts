/**
 * Main-thread reassembly of streamed exports (ruling R47). The processor answers `exportTracks` with `tracksStart`
 * (every track's length and metadata), `tracksPart`s (pieces of at most one block's budget, buffers transferred) and
 * `tracksEnd`, or `tracksAbort` when it gave the export up. The full arrays are allocated here, on the main thread, when
 * the header arrives; each part is copied into place (in any order) and dropped.
 *
 * `tracksEnd` yields the `tracks` event the controller expects only when every frame of every track arrived: the arrays
 * are full length from the start, so a missing part would otherwise be a silent hole in the saved loop. An incomplete
 * export, an aborted one, or an end that came before its parts is discarded (and logged); the controller's
 * EXPORT_TIMEOUT_MS then answers the request. Anything for a request not in progress is ignored.
 */

import type { EngineEvent, TrackAudio } from '../shared/protocol';

export type ExportEvent = Extract<EngineEvent, { t: 'tracksStart' | 'tracksPart' | 'tracksEnd' | 'tracksAbort' }>;
type TracksEvent = Extract<EngineEvent, { t: 'tracks' }>;

export function isExportEvent(e: EngineEvent): e is ExportEvent {
  return e.t === 'tracksStart' || e.t === 'tracksPart' || e.t === 'tracksEnd' || e.t === 'tracksAbort';
}

interface Pending {
  readonly tracks: (TrackAudio | null)[];
  /** Per track, the [start, end) frame spans received so far, flattened. */
  readonly spans: number[][];
}

export class ExportAssembler {
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly log: (message: string, detail?: unknown) => void = () => undefined) {}

  /** Exports in progress (their arrays are held until they end, abort or are cleared). */
  get inProgress(): number {
    return this.pending.size;
  }

  /** Takes one export event; returns the finished `tracks` event when `e` completes a request, else null. */
  take(e: ExportEvent): TracksEvent | null {
    switch (e.t) {
      case 'tracksStart':
        this.pending.set(e.reqId, {
          tracks: e.tracks.map((m) =>
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
          spans: e.tracks.map(() => []),
        });
        return null;
      case 'tracksPart': {
        const p = this.pending.get(e.reqId);
        const t = p?.tracks[e.track];
        // A part that does not fit its track is dropped; the export then ends incomplete.
        if (p && t && e.offset >= 0 && e.offset + e.L.length <= t.L.length && e.R.length === e.L.length) {
          t.L.set(e.L, e.offset);
          t.R.set(e.R, e.offset);
          p.spans[e.track]!.push(e.offset, e.offset + e.L.length);
        }
        return null;
      }
      case 'tracksAbort':
        this.pending.delete(e.reqId);
        return null;
      case 'tracksEnd': {
        const p = this.pending.get(e.reqId);
        if (p === undefined) return null;
        this.pending.delete(e.reqId);
        const short = p.tracks.findIndex((t, i) => t !== null && !covers(p.spans[i]!, t.L.length));
        if (short >= 0) {
          this.log(`engine: export ${e.reqId} incomplete (track ${short + 1} is missing frames); discarded`);
          return null;
        }
        return { t: 'tracks', reqId: e.reqId, tracks: p.tracks };
      }
    }
  }

  /** Drops every export in progress. */
  clear(): void {
    this.pending.clear();
  }
}

/** The flattened [start, end) spans cover [0, frames) without a gap. */
function covers(flat: number[], frames: number): boolean {
  const spans: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) spans.push([flat[i]!, flat[i + 1]!]);
  spans.sort((a, b) => a[0] - b[0]);
  let reached = 0;
  for (const [a, b] of spans) {
    if (a > reached) return false;
    if (b > reached) reached = b;
  }
  return reached >= frames;
}
