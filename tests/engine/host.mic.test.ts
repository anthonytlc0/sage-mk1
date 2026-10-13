import { describe, expect, it } from 'vitest';
import { defaultSystem } from '../../src/schema/system';
import { freeSettings } from './helpers';
import { FakeContext, FakeNav, settle, startHost } from './hostFakes';

describe('EngineHost.restartMic (MENU > SETUP > MIC PROCESS)', () => {
  it('stops the old tracks, asks for the mic again with the current echoCancellation, and reconnects it', async () => {
    const rig = await startHost();
    const first = rig.nav.streams[0]!;
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = true;
    }));
    await rig.host.restartMic();
    expect(first.track.stopped).toBe(true);
    expect(rig.nav.streams).toHaveLength(2);
    expect(rig.nav.lastAudio().echoCancellation).toBe(true);
    expect(rig.ctx.sources.at(-1)!.node.connections).toEqual([rig.node]);
    expect(rig.ctx.sources[0]!.node.disconnects).toBe(1);
    expect(rig.host.micAvailable).toBe(true);
  });

  it('a settings change and the controller hook in the same tick reopen the mic once', async () => {
    const rig = await startHost();
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = true;
    }));
    const hook = rig.host.restartMic();
    await hook;
    await settle();
    expect(rig.nav.streams).toHaveLength(2);
  });

  it('a request made while a restart runs queues another, so the last setting wins', async () => {
    const rig = await startHost();
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = true;
    }));
    await Promise.resolve(); // the first restart has started (it waits for getUserMedia)
    await Promise.resolve();
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = false;
    }));
    await rig.host.restartMic();
    await settle();
    expect(rig.nav.lastAudio().echoCancellation).toBe(false);
    const live = rig.nav.streams.filter((s) => !s.track.stopped);
    expect(live).toHaveLength(1);
  });

  it('a host that had a mic and cannot get it back gives NO INPUT and asks for TAP POWER TO RESUME', async () => {
    const nav = new FakeNav();
    const rig = await startHost({ nav, system: defaultSystem() });
    nav.fail = true;
    await rig.host.restartMic();
    await settle();
    expect(rig.host.micAvailable).toBe(false);
    expect(rig.events.some((e) => e.t === 'message' && e.text === 'NO INPUT')).toBe(true);
    expect(rig.host.needsResume).toBe(true);
  });

  it('a host that never had a mic (a desktop without one) gives NO INPUT only: no TAP POWER TO RESUME', async () => {
    const nav = new FakeNav();
    nav.fail = true;
    const rig = await startHost({ nav });
    await settle();
    // MENU > SETUP > MIC PROCESS: the settings path skips a host without a stream, the controller hook still calls
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = true;
    }));
    await rig.host.restartMic();
    await settle();
    expect(nav.constraints).toHaveLength(2); // it did try
    expect(rig.events.filter((e) => e.t === 'message' && e.text === 'NO INPUT').length).toBeGreaterThanOrEqual(1);
    expect(rig.host.needsResume).toBe(false);
  });

  it('never rejects, even when reconnecting the mic throws', async () => {
    const rig = await startHost();
    rig.ctx.createMediaStreamSource = () => {
      throw new Error('boom');
    };
    await expect(rig.host.restartMic()).resolves.toBeUndefined();
    expect(rig.logs.some(([m]) => m === 'engine: mic restart failed')).toBe(true);
    // and a later restart still runs
    rig.ctx.createMediaStreamSource = FakeContext.prototype.createMediaStreamSource.bind(rig.ctx);
    await expect(rig.host.restartMic()).resolves.toBeUndefined();
    expect(rig.host.micAvailable).toBe(true);
  });

  it('does nothing once the host is stopped', async () => {
    const rig = await startHost();
    await rig.host.stop();
    await rig.host.restartMic();
    expect(rig.nav.streams).toHaveLength(1);
  });
});
