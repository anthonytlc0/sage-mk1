import { describe, expect, it } from 'vitest';
import { defaultSystem } from '../../src/schema/system';
import { freeSettings } from './helpers';
import { FakeNav, settle, startHost } from './hostFakes';

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

  it('gives NO INPUT when the mic cannot be had again', async () => {
    const nav = new FakeNav();
    const rig = await startHost({ nav, system: defaultSystem() });
    nav.fail = true;
    await rig.host.restartMic();
    await settle();
    expect(rig.host.micAvailable).toBe(false);
    expect(rig.events.some((e) => e.t === 'message' && e.text === 'NO INPUT')).toBe(true);
  });

  it('does nothing once the host is stopped', async () => {
    const rig = await startHost();
    await rig.host.stop();
    await rig.host.restartMic();
    expect(rig.nav.streams).toHaveLength(1);
  });
});
