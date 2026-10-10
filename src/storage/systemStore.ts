/** System settings: one record in the `system` store. */

import { reconcileSystem } from '../schema/params';
import type { SystemSettings } from '../schema/types';
import { SYSTEM, reqP, writeTx } from './db';

const KEY = 'settings';

export class SystemStore {
  constructor(private readonly db: IDBDatabase) {}

  /**
   * The stored settings reconciled with the current schema (groups and leaves added since they were saved are filled
   * with defaults; wrong-typed values and unknown keys are dropped), or the factory defaults when nothing was saved.
   */
  async load(): Promise<SystemSettings> {
    const stored = await reqP<unknown>(this.db.transaction(SYSTEM, 'readonly').objectStore(SYSTEM).get(KEY));
    return reconcileSystem(stored);
  }

  save(settings: SystemSettings): Promise<void> {
    return writeTx(this.db, [SYSTEM], (tx) => {
      tx.objectStore(SYSTEM).put(settings, KEY);
    });
  }
}
