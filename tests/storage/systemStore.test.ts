import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db';
import { SystemStore } from '../../src/storage/systemStore';
import { defaultSystem } from '../../src/schema/params';
import type { SystemSettings } from '../../src/schema/types';

let seq = 0;
let db: IDBDatabase;
beforeEach(async () => {
  db = await openDb(`sys-test-${seq++}`);
});
afterEach(() => db.close());

describe('SystemStore', () => {
  it('loads the defaults when nothing was saved', async () => {
    expect(await new SystemStore(db).load()).toEqual(defaultSystem());
  });

  it('round-trips saved settings, also after reopening the database', async () => {
    const s = defaultSystem();
    s.setup.contrast = 3;
    await new SystemStore(db).save(s);
    expect(await new SystemStore(db).load()).toEqual(s);

    const name = db.name;
    db.close();
    db = await openDb(name);
    expect((await new SystemStore(db).load()).setup.contrast).toBe(3);
  });

  it('completes settings stored by an older schema: missing group and leaf filled, wrong type and unknown keys dropped', async () => {
    const old = defaultSystem() as unknown as Record<string, Record<string, unknown>>;
    delete old.midi;
    delete old.setup!.autoOff;
    old.setup!.contrast = 'high'; // wrong type
    old.setup!.retired = true;
    old.retiredGroup = { a: 1 };
    old.master!.comp = 30; // a number where the default is the keyword OFF
    await new SystemStore(db).save(old as unknown as SystemSettings);

    const out = await new SystemStore(db).load();
    const expected = defaultSystem();
    expected.master.comp = 30;
    expect(out).toEqual(expected);
  });

  it('save replaces the previous settings', async () => {
    const store = new SystemStore(db);
    const a = defaultSystem();
    a.setup.contrast = 1;
    const b = defaultSystem();
    b.setup.contrast = 9;
    await store.save(a);
    await store.save(b);
    expect((await store.load()).setup.contrast).toBe(9);
  });
});
