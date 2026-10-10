/**
 * Schema reconciliation for stored settings.
 *
 * Settings saved by an older (or newer, or damaged) build may lack groups and leaves the current schema has, carry
 * leaves of the wrong type, or hold keys the schema no longer knows. `reconcile` deep-merges the stored data over a
 * fresh defaults object so the result always has exactly the shape of the defaults:
 *
 *  - a plain object in the defaults recurses key by key; a key missing from storage takes the default; a stored key the
 *    defaults do not contain is dropped; a stored non-object where the defaults have an object gives the default;
 *  - an array always has the length of the default array: element i comes from storage and is reconciled against
 *    default element i by these same rules (so a primitive is type-checked and an object is completed and cleaned, a
 *    field added to a track or an ASSIGN later is filled in); a missing element is the default element, and elements
 *    beyond the default length are dropped. A stored non-array gives the default array;
 *  - any other leaf (number, string, boolean) comes from storage when its type matches the default's type (numbers must
 *    also be finite); otherwise the default wins.
 *
 * Type matching cannot tell that some parameters legitimately hold either of two types (a default 'OFF' that also
 * accepts a number; a MEASURE of 'FREE' or `{ note }`), nor that a number is out of range. `options.accept` lets the
 * caller, who knows the schema, decide those paths. It is called for every node that storage has a value for (array
 * elements included), with the path of keys from the root, and returns:
 *   - `{ value }` to use that value (the caller's coerced version of the stored one: clamped, cleaned);
 *   - true to take the stored value as it is, false to use the default;
 *   - undefined to apply the rules above.
 */

/** What `ReconcileOptions.accept` may return; see the module comment. */
export type AcceptVerdict = boolean | undefined | { readonly value: unknown };

export interface ReconcileOptions {
  accept?: (path: readonly string[], stored: unknown) => AcceptVerdict;
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function merge(stored: unknown, def: unknown, path: readonly string[], options: ReconcileOptions | undefined): unknown {
  if (stored === undefined) return def;
  const verdict = options?.accept?.(path, stored);
  if (verdict !== undefined) {
    if (typeof verdict === 'object') return verdict.value;
    return verdict ? stored : def;
  }

  if (isPlain(def)) {
    if (!isPlain(stored)) return def;
    const out: Plain = {};
    for (const key of Object.keys(def)) {
      out[key] = Object.prototype.hasOwnProperty.call(stored, key)
        ? merge(stored[key], def[key], [...path, key], options)
        : def[key];
    }
    return out;
  }

  if (Array.isArray(def)) {
    if (!Array.isArray(stored)) return def;
    return def.map((d: unknown, i: number) => merge(stored[i], d, [...path, String(i)], options));
  }

  if (typeof stored !== typeof def) return def;
  if (typeof stored === 'number' && !Number.isFinite(stored)) return def;
  return stored;
}

/** Merges `stored` over `defaults`; see the module comment for the exact rules. `defaults` must be a fresh object. */
export function reconcile<T>(stored: unknown, defaults: T, options?: ReconcileOptions): T {
  return merge(stored, defaults, [], options) as T;
}
