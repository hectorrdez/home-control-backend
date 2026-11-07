import fs from "fs";
import path from "path";
import Logger from "@utils/Logger";

const FILE_VERSION = 1;

export interface JsonFileStoreOptions<V> {
  /** Logger scope. */
  scope: string;
  /** Top-level property holding the entries, e.g. "aliases". Also used in file-level log messages. */
  property: string;
  /** Singular noun used in the "ignored N invalid ... entries" log. */
  entryLabel: string;
  /** Max entries kept on load. */
  max: number;
  /** Returns the sanitized value, or undefined when the entry is invalid. */
  parseEntry: (key: string, raw: unknown) => V | undefined;
  /** Error thrown (as-is) when persisting fails. */
  createWriteError: () => Error;
}

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1);

/**
 * Generic JSON file store: in-memory map loaded once at startup; writes are
 * serialized and atomic (`<file>.tmp` + rename); the memory map is swapped
 * only after the rename.
 */
export class JsonFileStore<V> {
  private map = new Map<string, V>();
  private file = "";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: JsonFileStoreOptions<V>) {}

  /** Loads the file synchronously at startup. Never throws. */
  load(file: string): void {
    const { property, scope, entryLabel, max, parseEntry } = this.opts;
    this.file = file;
    this.map = new Map();
    if (!fs.existsSync(file)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      parsed = undefined;
    }
    const entries = (parsed as Record<string, unknown> | undefined)?.[property];
    const valid =
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === FILE_VERSION &&
      entries !== null &&
      typeof entries === "object" &&
      !Array.isArray(entries);

    if (!valid) {
      this.quarantine(file);
      return;
    }

    let skipped = 0;
    for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
      const value = parseEntry(key, raw);
      if (value === undefined || this.map.size >= max) {
        skipped++;
        continue;
      }
      this.map.set(key, value);
    }
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
   * Applies `change` to a copy of the map, persists it, then publishes it.
   * `change` returns false when nothing changed (no write). Throws the error
   * from `change` (validation) or the configured write error; memory is unchanged on any throw.
   */
  mutate(change: (draft: Map<string, V>) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      const draft = new Map(this.map);
      if (!change(draft)) return;
      await this.persist(draft);
      this.map = draft;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(data: Map<string, V>): Promise<void> {
    const body = JSON.stringify(
      { version: FILE_VERSION, [this.opts.property]: Object.fromEntries([...data.entries()].sort(byKey)) },
      null,
      2
    );
    const tmp = `${this.file}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const handle = await fs.promises.open(tmp, "w");
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      Logger.error((err as Error)?.message ?? String(err), this.opts.scope);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw this.opts.createWriteError();
    }
  }

  /** Moves an unreadable file aside so the API can start empty. Logs no contents. */
  private quarantine(file: string): void {
    const { property, scope } = this.opts;
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, target);
      Logger.write(`${property} file unreadable or wrong version; moved aside to ${path.basename(target)}`, scope, "WARN");
    } catch {
      Logger.write(`${property} file unreadable or wrong version; could not move it aside`, scope, "WARN");
    }
  }
}
