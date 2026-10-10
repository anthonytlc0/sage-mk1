import { describe, it, expect, vi } from 'vitest';
import { clickDownloadLink, isTouchDevice, mimeTypeFor, pickWith, saveWith } from '../../src/storage/share';
import type { AnchorLike, PickInput, SaveDeps, ShareNavigator } from '../../src/storage/share';

// There is no jsdom: the decision logic takes `nav` / `doc`-like objects, and these stubs stand in for the browser.

const fakeFile = (name: string, type: string): File => ({ name, type, size: 3 }) as unknown as File;

/** An Error with a DOMException-style name, which is how share() reports AbortError / NotAllowedError. */
const named = (name: string): Error => Object.assign(new Error(name), { name });

interface Rig {
  deps: SaveDeps;
  share: ReturnType<typeof vi.fn>;
  canShare: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  makeFile: ReturnType<typeof vi.fn>;
}

function rig(opts: { touch?: number; canShare?: boolean | 'throws' | 'absent'; share?: 'ok' | Error | 'throws-sync' | 'absent'; download?: 'ok' | 'throws'; makeFile?: 'ok' | 'throws' } = {}): Rig {
  const canShare = vi.fn((_d: { files: File[] }): boolean => {
    if (opts.canShare === 'throws') throw new TypeError('bad data');
    return opts.canShare === undefined || opts.canShare === 'absent' ? true : opts.canShare;
  });
  const share = vi.fn((_d: { files: File[] }): Promise<void> => {
    if (opts.share === 'throws-sync') throw new TypeError('sync failure');
    return opts.share instanceof Error ? Promise.reject(opts.share) : Promise.resolve();
  });
  const download = vi.fn((_b: Blob, _n: string) => {
    if (opts.download === 'throws') throw new Error('no download');
  });
  const makeFile = vi.fn((_b: Blob, name: string, type: string) => {
    if (opts.makeFile === 'throws') throw new TypeError('File is not a constructor');
    return fakeFile(name, type);
  });
  const nav: ShareNavigator = { maxTouchPoints: opts.touch ?? 5 };
  if (opts.canShare !== 'absent') nav.canShare = canShare;
  if (opts.share !== 'absent') nav.share = share;
  return { deps: { nav, makeFile, download }, share, canShare, download, makeFile };
}

const blob = new Blob(['abc'], { type: 'application/zip' });

describe('isTouchDevice', () => {
  it('is true for more than one touch point (an iPad reports 5, whatever its user agent says)', () => {
    expect(isTouchDevice({ maxTouchPoints: 5 })).toBe(true);
    expect(isTouchDevice({ maxTouchPoints: 2 })).toBe(true);
    expect(isTouchDevice({ maxTouchPoints: 10 })).toBe(true);
  });

  it('is false for none, one (a mouse-and-pen desktop can report 1) or an unknown count', () => {
    expect(isTouchDevice({ maxTouchPoints: 0 })).toBe(false);
    expect(isTouchDevice({ maxTouchPoints: 1 })).toBe(false);
    expect(isTouchDevice({})).toBe(false);
    expect(isTouchDevice(undefined)).toBe(false);
  });

  it('never looks at the user agent: an iPad that reports a Mac is touch, a "mobile" UA with no touch points is not', () => {
    expect(isTouchDevice({ maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' } as never)).toBe(true);
    expect(isTouchDevice({ maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' } as never)).toBe(false);
  });
});

describe('mimeTypeFor', () => {
  it('keeps the blob type when it has one', () => {
    expect(mimeTypeFor('a.sagemk1', 'application/zip')).toBe('application/zip');
    expect(mimeTypeFor('a.wav', 'audio/x-wav')).toBe('audio/x-wav');
  });

  it('guesses from the extension when the blob has no type', () => {
    expect(mimeTypeFor('take.wav', '')).toBe('audio/wav');
    expect(mimeTypeFor('TAKE.WAV', '')).toBe('audio/wav');
    expect(mimeTypeFor('loop.sagemk1', '')).toBe('application/octet-stream');
    expect(mimeTypeFor('noext', '')).toBe('application/octet-stream');
  });
});

describe('saveWith', () => {
  it('shares the file on a touch device that can share files, and reports saved', async () => {
    const r = rig();
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('saved');
    expect(r.makeFile).toHaveBeenCalledWith(blob, 'loop.sagemk1', 'application/zip');
    expect(r.share).toHaveBeenCalledTimes(1);
    const data = r.share.mock.calls[0]![0] as { files: File[] };
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({ name: 'loop.sagemk1', type: 'application/zip' });
    expect(r.canShare).toHaveBeenCalledWith({ files: data.files });
    expect(r.download).not.toHaveBeenCalled();
  });

  it('calls share() synchronously, before the returned promise has settled (it needs the tap\'s user activation)', () => {
    const r = rig();
    const pending = saveWith(r.deps, blob, 'loop.sagemk1');
    expect(r.share).toHaveBeenCalledTimes(1); // no await between the call and share()
    return pending;
  });

  it('uses the download link on a desktop, even when the browser could share files', async () => {
    const r = rig({ touch: 0 });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('saved');
    expect(r.download).toHaveBeenCalledWith(blob, 'loop.sagemk1');
    expect(r.share).not.toHaveBeenCalled();
  });

  it('uses the download link when canShare says the files cannot be shared', async () => {
    const r = rig({ canShare: false });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('saved');
    expect(r.share).not.toHaveBeenCalled();
    expect(r.download).toHaveBeenCalledTimes(1);
  });

  it('uses the download link when the share API is missing or navigator is unavailable', async () => {
    for (const r of [rig({ canShare: 'absent' }), rig({ share: 'absent' })]) {
      await expect(saveWith(r.deps, blob, 'a.wav')).resolves.toBe('saved');
      expect(r.download).toHaveBeenCalledTimes(1);
    }
    const r = rig();
    await expect(saveWith({ ...r.deps, nav: undefined }, blob, 'a.wav')).resolves.toBe('saved');
    expect(r.download).toHaveBeenCalledTimes(1);
  });

  it('falls back to the download link when canShare throws or the File cannot be built', async () => {
    for (const r of [rig({ canShare: 'throws' }), rig({ makeFile: 'throws' })]) {
      await expect(saveWith(r.deps, blob, 'a.wav')).resolves.toBe('saved');
      expect(r.share).not.toHaveBeenCalled();
      expect(r.download).toHaveBeenCalledTimes(1);
    }
  });

  it('reports cancelled when the user dismisses the share sheet (AbortError), without downloading', async () => {
    const r = rig({ share: named('AbortError') });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('cancelled');
    expect(r.download).not.toHaveBeenCalled();
  });

  it('falls back to the download link on NotAllowedError (the tap\'s activation was gone)', async () => {
    const r = rig({ share: named('NotAllowedError') });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('saved');
    expect(r.share).toHaveBeenCalledTimes(1);
    expect(r.download).toHaveBeenCalledWith(blob, 'loop.sagemk1');
  });

  it('reports failed when that fallback also fails', async () => {
    const r = rig({ share: named('NotAllowedError'), download: 'throws' });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('failed');
  });

  it('reports failed for any other share error, without downloading', async () => {
    for (const err of [named('DataError'), new TypeError('x'), new Error('plain'), 'a string', undefined]) {
      const r = rig({ share: err as Error });
      if (!(err instanceof Error)) r.share.mockImplementationOnce(() => Promise.reject(err));
      await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('failed');
      expect(r.download).not.toHaveBeenCalled();
    }
  });

  it('reports failed when share() throws synchronously', async () => {
    const r = rig({ share: 'throws-sync' });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('failed');
  });

  it('reports failed when the download link throws', async () => {
    const r = rig({ touch: 0, download: 'throws' });
    await expect(saveWith(r.deps, blob, 'loop.sagemk1')).resolves.toBe('failed');
  });

  it('gives an untyped blob the type its extension suggests', async () => {
    const r = rig();
    await saveWith(r.deps, new Blob(['x']), 'take.wav');
    expect(r.makeFile).toHaveBeenCalledWith(expect.anything(), 'take.wav', 'audio/wav');
  });
});

describe('clickDownloadLink', () => {
  function anchorDoc(): { doc: Parameters<typeof clickDownloadLink>[0]; log: string[]; anchor: AnchorLike } {
    const log: string[] = [];
    const anchor: AnchorLike = {
      href: '', download: '', rel: '', style: { display: '' },
      click: () => log.push(`click href=${anchor.href} download=${anchor.download}`),
      remove: () => log.push('remove'),
    };
    const doc = {
      createElement: (tag: 'a') => (log.push(`create ${tag}`), anchor),
      body: { appendChild: (_a: AnchorLike) => log.push('append') },
    };
    return { doc, log, anchor };
  }

  it('builds a hidden a[download], attaches it, clicks it and removes it', () => {
    const { doc, log, anchor } = anchorDoc();
    clickDownloadLink(doc, 'blob:abc', 'loop.sagemk1');
    expect(log).toEqual(['create a', 'append', 'click href=blob:abc download=loop.sagemk1', 'remove']);
    expect(anchor.style!.display).toBe('none');
  });

  it('removes the link even when the click throws', () => {
    const { doc, log, anchor } = anchorDoc();
    anchor.click = () => {
      throw new Error('blocked');
    };
    expect(() => clickDownloadLink(doc, 'blob:abc', 'a.wav')).toThrow('blocked');
    expect(log).toContain('remove');
  });
});

describe('pickWith', () => {
  type Listener = () => void;
  function inputRig(files: File[] | null = null) {
    const log: string[] = [];
    const listeners: Record<string, Listener[]> = {};
    const input: PickInput = {
      type: '', accept: '', style: { display: '' }, files,
      addEventListener: (type, fn) => void (listeners[type] ??= []).push(fn),
      click: () => void log.push('click'),
      remove: () => void log.push('remove'),
    };
    const doc = { createElement: (_t: 'input') => input, body: { appendChild: (_i: PickInput) => void log.push('append') } };
    const fire = (type: string) => (listeners[type] ?? []).forEach((fn) => fn());
    return { input, doc, log, fire };
  }

  it('adds a hidden file input, clicks it synchronously, and resolves the chosen file', async () => {
    const f = fakeFile('loop.sagemk1', '');
    const { input, doc, log, fire } = inputRig([f]);
    const p = pickWith(doc, { maxTouchPoints: 0 }, '.sagemk1');
    expect(log).toEqual(['append', 'click']); // attached, then clicked, all inside the caller's tap
    expect(input.type).toBe('file');
    expect(input.style.display).toBe('none');
    fire('change');
    await expect(p).resolves.toBe(f);
    expect(log).toEqual(['append', 'click', 'remove']);
  });

  it('sets the accept filter on a desktop', () => {
    const { input, doc } = inputRig();
    void pickWith(doc, { maxTouchPoints: 0 }, '.sagemk1,.zip');
    expect(input.accept).toBe('.sagemk1,.zip');
  });

  it('leaves the accept filter off on a touch device (iOS would grey out files it does not recognise)', () => {
    const { input, doc } = inputRig();
    void pickWith(doc, { maxTouchPoints: 5 }, '.sagemk1');
    expect(input.accept).toBe('');
  });

  it('resolves null when the picker is cancelled, or nothing was chosen', async () => {
    const a = inputRig();
    const pa = pickWith(a.doc, { maxTouchPoints: 0 }, '.sagemk1');
    a.fire('cancel');
    await expect(pa).resolves.toBeNull();
    expect(a.log).toContain('remove');

    const b = inputRig([]);
    const pb = pickWith(b.doc, { maxTouchPoints: 0 }, '.sagemk1');
    b.fire('change');
    await expect(pb).resolves.toBeNull();

    const c = inputRig(null);
    const pc = pickWith(c.doc, undefined, '.sagemk1');
    c.fire('change');
    await expect(pc).resolves.toBeNull();
  });

  it('settles once: a later event changes nothing', async () => {
    const f = fakeFile('a.sagemk1', '');
    const { doc, log, fire } = inputRig([f]);
    const p = pickWith(doc, { maxTouchPoints: 0 }, '.sagemk1');
    fire('change');
    fire('cancel');
    fire('change');
    await expect(p).resolves.toBe(f);
    expect(log.filter((l) => l === 'remove')).toHaveLength(1);
  });
});
