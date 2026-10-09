/** System settings: one record in the `system` store. */

import { defaultSystem } from '../schema/params';
import type { SystemSettings } from '../schema/types';
import { SYSTEM, reqP, writeTx } from './db';

const KEY = 'settings';

export class SystemStore {
  constructor(private readonly db: IDBDatabase) {}

  /** The stored settings, or the factory defaults when nothing has been saved. */
  async load(): Promise<SystemSettings> {
    const stored = await reqP<SystemSettings | undefined>(this.db.transaction(SYSTEM, 'readonly').objectStore(SYSTEM).get(KEY));
    return stored ?? defaultSystem();
  }

  save(settings: SystemSettings): Promise<void> {
    return writeTx(this.db, [SYSTEM], (tx) => {
      tx.objectStore(SYSTEM).put(settings, KEY);
    });
  }
}
