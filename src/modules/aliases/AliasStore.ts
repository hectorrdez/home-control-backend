import fs from "fs";
import path from "path";
import Logger from "@utils/Logger";
import { AliasWriteFailedError } from "./AliasErrors";
import { isValidAlias, isValidEntityId, MAX_ALIASES } from "./AliasValidation";

const FILE_VERSION = 1;
const SCOPE = "AliasStore";

export interface AliasEntry {
  entityId: string;
  alias: string;
}

/**
 * Tiny JSON file store for user entity aliases. Reads are served from an
 * in-memory map loaded once at startup. Writes are serialized and atomic
 * (`<file>.tmp` + rename); the memory map is swapped only after the rename.
 */
export class AliasStore {
  private map = new Map<string, string>();
  private file = "";
  private queue: Promise<unknown> = Promise.resolve();

  /** Loads the file synchronously at startup. Never throws. */
  load(file: string): void {
    this.file = file;
    this.map = new Map();
    if (!fs.existsSync(file)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      parsed = undefined;
    }
    const aliases = (parsed as { version?: unknown; aliases?: unknown } | undefined)?.aliases;
    const valid =
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === FILE_VERSION &&
      aliases !== null &&
      typeof aliases === "object" &&
      !Array.isArray(aliases);

    if (!valid) {
      this.quarantine(file);
      return;
    }

    let skipped = 0;
    for (const [entityId, raw] of Object.entries(aliases as Record<string, unknown>)) {
      const alias = typeof raw === "string" && isValidAlias(raw) ? raw : undefined;
      if (!isValidEntityId(entityId) || !alias || this.map.size >= MAX_ALIASES) {
        skipped++;
        continue;
      }
      this.map.set(entityId, alias);
    }
    if (skipped > 0) Logger.write(`ignored ${skipped} invalid alias entries on load`, SCOPE, "WARN");
  }

  list(): AliasEntry[] {
    return [...this.map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([entityId, alias]) => ({ entityId, alias }));
  }

  get(entityId: string): string | undefined {
    return this.map.get(entityId);
  }

  /**
   * Applies `change` to a copy of the map, persists it, then publishes it.
   * `change` returns false when nothing changed (no write). Throws the error
   * from `change` (validation) or AliasWriteFailedError; memory is unchanged on any throw.
   */
  mutate(change: (draft: Map<string, string>) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      const draft = new Map(this.map);
      if (!change(draft)) return;
      await this.persist(draft);
      this.map = draft;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(data: Map<string, string>): Promise<void> {
    const body = JSON.stringify(
      {
        version: FILE_VERSION,
        aliases: Object.fromEntries([...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      },
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
      Logger.error((err as Error)?.message ?? String(err), SCOPE);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw new AliasWriteFailedError();
    }
  }

  /** Moves an unreadable file aside so the API can start empty. Logs no contents. */
  private quarantine(file: string): void {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, target);
      Logger.write(`aliases file unreadable or wrong version; moved aside to ${path.basename(target)}`, SCOPE, "WARN");
    } catch {
      Logger.write("aliases file unreadable or wrong version; could not move it aside", SCOPE, "WARN");
    }
  }
}

const aliasStore = new AliasStore();
export default aliasStore;
