import fs from "fs";
import path from "path";
import Logger from "@utils/Logger";
import { pool, withTransaction, TxSource } from "../db/pool";
import { JsonFileStore, JsonFileStoreOptions } from "./JsonFileStore";

export interface PgDocumentStoreOptions<V> {
  /** Logger scope. */
  scope: string;
  /** Rows of the `documents` table with this collection name. */
  collection: string;
  /** Singular noun used in the "ignored N invalid ... entries" log. */
  entryLabel: string;
  /** Max entries kept on load. */
  max: number;
  /** Returns the sanitized value, or undefined when the entry is invalid. */
  parseEntry: (key: string, raw: unknown) => V | undefined;
  /** Error thrown (as-is) when persisting fails. */
  createWriteError: () => Error;
  /** Top-level property of the legacy JSON file, read only by importLegacyJson. */
  legacyProperty: string;
  /** Database source; defaults to the 013 pool. Injectable for tests. */
  db?: TxSource;
  /** Called after a successful commit with the changed and removed keys and the writer (`by`, or null). */
  onChanged?: (keys: string[], by: string | null) => void;
}

/** Per-write context given to `mutate` callbacks. `now` is the instant written to `updated_at`. */
export interface MutateContext {
  now: string;
}

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1);

/**
 * Keyed document store backed by the `documents` table. Same in-memory API as
 * JsonFileStore; memory is loaded once at startup and swapped only after a
 * successful commit. Writes are serialized through one queue.
 */
export class PgDocumentStore<V> {
  private map = new Map<string, V>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly opts: PgDocumentStoreOptions<V>) {}

  private get db(): TxSource {
    return this.opts.db ?? pool;
  }

  /** Reads the collection into memory. Bad rows are skipped and counted; a db error throws. */
  async load(): Promise<void> {
    const { rows } = await this.db.query("SELECT key, value FROM documents WHERE collection = $1 ORDER BY key", [
      this.opts.collection,
    ]);
    const { max, parseEntry, entryLabel, scope } = this.opts;
    const map = new Map<string, V>();
    let skipped = 0;
    for (const row of rows) {
      const value = parseEntry(row.key, row.value);
      if (value === undefined || map.size >= max) {
        skipped++;
        continue;
      }
      map.set(row.key, value);
    }
    this.map = map;
    if (skipped > 0) Logger.write(`ignored ${skipped} invalid ${entryLabel} entries on load`, scope, "WARN");
  }

  /** Entries sorted by key. */
  entries(): [string, V][] {
    return [...this.map.entries()].sort(byKey);
  }

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  /**
   * Applies `change` to a copy of the map, persists the diff in one transaction,
   * then publishes it. `change` returns false when nothing changed (no write).
   * `ctx.now` is the single instant used for both the caller's stored value and
   * the row's `updated_at`, so they always match.
   * Throws the error from `change` (validation) or the configured write error;
   * memory is unchanged on any throw.
   */
  mutate(
    change: (draft: Map<string, V>, ctx: MutateContext) => boolean,
    opts: { by?: string | null } = {}
  ): Promise<void> {
    const run = this.queue.then(async () => {
      const now = new Date().toISOString();
      const draft = new Map(this.map);
      if (!change(draft, { now })) return;
      const by = opts.by ?? null;

      const upserts: [string, V][] = [];
      for (const [key, value] of draft) {
        if (!this.map.has(key) || JSON.stringify(this.map.get(key)) !== JSON.stringify(value)) {
          upserts.push([key, value]);
        }
      }
      const removed = [...this.map.keys()].filter((key) => !draft.has(key));
      if (upserts.length === 0 && removed.length === 0) return;

      await this.persist(upserts, removed, by, now);
      this.map = draft;
      // The write is already committed and published: an observer failure must not reject the caller.
      try {
        this.opts.onChanged?.([...upserts.map(([key]) => key), ...removed], by);
      } catch (err) {
        Logger.error(`onChanged observer failed: ${(err as Error)?.message ?? String(err)}`, this.opts.scope);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** True when the collection has at least one row, valid or not. */
  async hasRows(): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM documents WHERE collection = $1 LIMIT 1", [
      this.opts.collection,
    ]);
    return rows.length > 0;
  }

  /** Options of the legacy JSON file reader used by importLegacyJson. */
  legacyOptions(): JsonFileStoreOptions<V> {
    const { scope, legacyProperty, entryLabel, max, parseEntry, createWriteError } = this.opts;
    return { scope, property: legacyProperty, entryLabel, max, parseEntry, createWriteError };
  }

  private async persist(upserts: [string, V][], removed: string[], by: string | null, now: string): Promise<void> {
    const { collection, scope, createWriteError } = this.opts;
    try {
      await withTransaction(async (tx) => {
        for (const [key, value] of upserts) {
          await tx.query(
            `INSERT INTO documents (collection, key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (collection, key) DO UPDATE SET value = EXCLUDED.value,
               version = documents.version + 1, updated_at = $5, updated_by = $4`,
            [collection, key, JSON.stringify(value), by, now]
          );
        }
        for (const key of removed) {
          await tx.query("DELETE FROM documents WHERE collection = $1 AND key = $2", [collection, key]);
        }
      }, this.db);
    } catch (err) {
      Logger.error((err as Error)?.message ?? String(err), scope);
      throw createWriteError();
    }
  }
}

/**
 * One-time import of the legacy JSON file. Runs only when the collection has no
 * rows and the file exists. On success the file is renamed to
 * `<file>.imported-<epochMs>`. Failures are logged and the file is left in place.
 */
export async function importLegacyJson<V>(store: PgDocumentStore<V>, file: string): Promise<void> {
  const { scope, entryLabel } = store.opts;
  const base = path.basename(file);
  if (!fs.existsSync(file)) return;
  try {
    if (await store.hasRows()) return;

    // JsonFileStore checks the version and quarantines unreadable files itself.
    const legacy = new JsonFileStore<V>(store.legacyOptions());
    legacy.load(file);
    if (!fs.existsSync(file)) return; // quarantined as corrupt: nothing to import

    const entries = legacy.entries();
    await store.mutate((draft) => {
      for (const [key, value] of entries) draft.set(key, value);
      return true;
    });
    fs.renameSync(file, `${file}.imported-${Date.now()}`);
    Logger.write(`imported ${entries.length} ${entryLabel} entries from ${base}`, scope);
  } catch (err) {
    Logger.error(`legacy import of ${base} failed, file kept: ${(err as Error)?.message ?? String(err)}`, scope);
  }
}
