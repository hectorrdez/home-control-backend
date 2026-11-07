import init001 from "./001_init";

export interface Migration {
  version: number;
  name: string;
  /** SQL script; may hold several statements. Run inside the migration's transaction. */
  up: string;
}

/** Ordered by version. Add new migrations at the end; never edit an applied one. */
export const migrations: Migration[] = [init001];
