/**
 * Schema reconciliation for stored settings.
 *
 * Settings saved by an older (or newer, or damaged) build may lack groups and leaves the current schema has, carry
 * leaves of the wrong type, or hold keys the schema no longer knows. `reconcile` deep-merges the stored data over a
 * fresh defaults object so the result always has exactly the shape of the defaults:
 *
 *  - a plain object in the defaults recurses key by key; a key missing from storage takes the default; a stored key the
 *    defaults do not contain is dropped; a stored non-object where the defaults have an object gives the default;
 *  - an array comes from storage when storage holds an array (otherwise the default array). The elements that are plain
 *    objects in the defaults are themselves reconciled, so a field added to a track or an ASSIGN later is filled in;
 *  - any other leaf (number, string, boolean) comes from storage when its type matches the default's type (numbers must
 *    also be finite); otherwise the default wins.
 *
 * Type matching cannot tell that some parameters legitimately hold either of two types (a default 'OFF' that also
 * accepts a number; a MEASURE of 'FREE' or `{ note }`). `options.accept` lets the caller, who knows the schema, decide
 * those paths. It is called for every node that storage has a value for, with the path of keys from the root, and
 * returns true to take the stored value as it is, false to use the default, or undefined to apply the rules above.
 */

export interface ReconcileOptions {
  accept?: (path: readonly string[], stored: unknown) => boolean | undefined;
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
  if (verdict !== undefined) return verdict ? stored : def;

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
    return stored.map((el: unknown, i: number) => {
      const d: unknown = def[i];
      return isPlain(d) ? merge(el, d, [...path, String(i)], options) : el;
    });
  }

  if (typeof stored !== typeof def) return def;
  if (typeof stored === 'number' && !Number.isFinite(stored)) return def;
  return stored;
}

/** Merges `stored` over `defaults`; see the module comment for the exact rules. `defaults` must be a fresh object. */
export function reconcile<T>(stored: unknown, defaults: T, options?: ReconcileOptions): T {
  return merge(stored, defaults, [], options) as T;
}
