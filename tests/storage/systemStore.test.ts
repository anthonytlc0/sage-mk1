import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db';
import { SystemStore } from '../../src/storage/systemStore';
import { defaultSystem } from '../../src/schema/params';

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
