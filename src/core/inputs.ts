/**
 * What each track records (Task 9; Parameter Guide p. 3 BOUNCE IN and INPUT, p. 4 BOUNCE SW / BOUNCE TRACK, p. 12 RHYTHM
 * OUT):
 *  - INPUT: the inputs flagged in the track's INPUT. The app's one mic is MIC 1 (the engine's input chain has already
 *    made it the core's `inL`/`inR`); MIC 2 and INST have no jack here. RHYTHM adds the rhythm bus (the GUIDE click,
 *    plus an external rhythm input, silent in phase 1), but only when RHYTHM OUT is LOOP: the guide's "LOOP: lets you
 *    record rhythm sounds in a loop" (with OUTPUT the rhythm only goes to the jacks).
 *  - BOUNCE: a track with BOUNCE IN, or any track while BOUNCE SW is on, also records the playback of the other tracks
 *    selected in BOUNCE TRACK ("the track used for input during bounce recording"), as they sound from the core: after
 *    PLAY LEVEL, PAN and the fades, before the fader (INFERRED).
 *
 * The rhythm bus and the tracks' playback are heard on the output timeline, but the input arriving now belongs to the
 * timeline `lag` frames ago (the latency pipeline). So each reaches a track's input through a delay ring, `lag` frames
 * late, landing on the timeline frame it was heard at. (With no latency the ring hands back what was pushed this
 * very span: sources must be rendered before the tracks that record them, which the core arranges.)
 *
 * Buffers grow only when the block size or the round trip does (a setLatency, or the first larger block), never per
 * block, and nothing else allocates.
 */

/** A stereo delay line indexed by absolute timeline frame. */
class Ring {
  L: Float32Array;
  R: Float32Array;
  private mask: number;
  /** Frames `[from, to)` hold audio; anything else reads as silence. */
  private from = 0;
  private to = 0;

  constructor(size: number) {
    this.L = new Float32Array(size);
    this.R = new Float32Array(size);
    this.mask = size - 1;
  }

  get size(): number {
    return this.mask + 1;
  }

  /** Store `srcL/srcR[a, b)` as timeline frames `[f, f + b - a)`. A gap since the last push reads as silence. */
  push(f: number, srcL: Float32Array, srcR: Float32Array, a: number, b: number): void {
    if (f !== this.to) this.from = f;
    const { L, R, mask } = this;
    for (let i = a; i < b; i++) {
      const x = (f + i - a) & mask;
      L[x] = srcL[i];
      R[x] = srcR[i];
    }
    this.to = f + b - a;
    if (this.to - this.from > mask + 1) this.from = this.to - (mask + 1);
  }

  /** Add timeline frames `[f, f + b - a)` into `dstL/dstR[a, b)`, frames it does not hold counting as silence. */
  addTo(f: number, dstL: Float32Array, dstR: Float32Array, a: number, b: number): void {
    const lo = Math.max(f, this.from) - f;
    const hi = Math.min(f + b - a, this.to) - f;
    const { L, R, mask } = this;
    for (let i = lo; i < hi; i++) {
      const x = (f + i) & mask;
      dstL[a + i] += L[x];
      dstR[a + i] += R[x];
    }
  }
}

export class InputRouter {
  /** All zeros: the input of a track that records nothing from the mic. */
  silence = new Float32Array(0);
  /** Per track: the input built for it. */
  private bufL: Float32Array[] = [];
  private bufR: Float32Array[] = [];
  private rhythm: Ring;
  private tracks: Ring[];
  private block = 0;

  constructor(private readonly count: number) {
    this.rhythm = new Ring(1);
    this.tracks = [];
    for (let i = 0; i < count; i++) this.tracks.push(new Ring(1));
  }

  /** Size everything for blocks of up to `n` frames and a round trip of `lag` frames. Allocates only when they grow. */
  ensure(n: number, lag: number): void {
    if (n > this.block) {
      this.block = n;
      this.silence = new Float32Array(n);
      this.bufL = [];
      this.bufR = [];
      for (let i = 0; i < this.count; i++) {
        this.bufL.push(new Float32Array(n));
        this.bufR.push(new Float32Array(n));
      }
    }
    let size = 1;
    while (size < lag + this.block + 1) size *= 2;
    if (size > this.rhythm.size) {
      this.rhythm = new Ring(size);
      for (let i = 0; i < this.count; i++) this.tracks[i] = new Ring(size);
    }
  }

  /** The rhythm bus for timeline frames `[f, f + b - a)`: the click plus the external rhythm input, from index `a`. */
  pushRhythm(f: number, clickL: Float32Array, clickR: Float32Array, extL: Float32Array, extR: Float32Array, a: number, b: number): void {
    const ring = this.rhythm;
    ring.push(f, clickL, clickR, a, b);
    // The external rhythm is silent in phase 1; add it in place only when it carries something.
    let any = false;
    for (let i = a; i < b && !any; i++) any = extL[i] !== 0 || extR[i] !== 0;
    if (!any) return;
    const { L, R } = ring;
    const mask = ring.size - 1;
    for (let i = a; i < b; i++) {
      const x = (f + i - a) & mask;
      L[x] += extL[i];
      R[x] += extR[i];
    }
  }

  /** Track `i`'s output for timeline frames `[f, f + b - a)`, from index `a`. */
  pushTrack(i: number, f: number, outL: Float32Array, outR: Float32Array, a: number, b: number): void {
    this.tracks[i].push(f, outL, outR, a, b);
  }

  /**
   * Build track `i`'s input for block indices `[a, b)`, the first of which is timeline frame `f`: the mic when `mic`,
   * the rhythm bus when `rhythm`, and the playback of each track whose bit is set in `sources`, the last two read `lag`
   * frames back. Returns nothing: the input is in `inputL(i)`/`inputR(i)`.
   */
  build(
    i: number,
    f: number,
    a: number,
    b: number,
    lag: number,
    mic: boolean,
    inL: Float32Array,
    inR: Float32Array,
    rhythm: boolean,
    sources: number,
  ): void {
    const dL = this.bufL[i];
    const dR = this.bufR[i];
    if (mic) {
      for (let k = a; k < b; k++) {
        dL[k] = inL[k];
        dR[k] = inR[k];
      }
    } else {
      dL.fill(0, a, b);
      dR.fill(0, a, b);
    }
    const g = f - lag;
    if (rhythm) this.rhythm.addTo(g, dL, dR, a, b);
    for (let j = 0; j < this.count; j++) if ((sources & (1 << j)) !== 0) this.tracks[j].addTo(g, dL, dR, a, b);
  }

  inputL(i: number): Float32Array {
    return this.bufL[i];
  }

  inputR(i: number): Float32Array {
    return this.bufR[i];
  }
}
