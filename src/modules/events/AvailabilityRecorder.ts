import { eventLog as defaultLog, EventInput } from "./EventLog";

/** At most one `availability` event per entity inside this window; extras are dropped. */
export const AVAILABILITY_GUARD_MS = 10_000;
/** An entity absent from a full snapshot and unseen for this long is dropped from memory. */
export const PRUNE_AFTER_MS = 30 * 60_000;
const UNAVAILABLE = "unavailable";

/** Minimal shape the recorder needs from an HA state. */
export interface StateSighting {
  entityId: string;
  state: string;
}

/** Logs device availability transitions (unavailable <-> anything else) into the event log (019). */
export class AvailabilityRecorder {
  /** Last known state per entity, kept in memory. Silent seeding happens here. */
  private readonly last = new Map<string, string>();
  /** Time of the last recorded availability event per entity (noise guard). */
  private readonly lastRecordedAt = new Map<string, number>();
  /** Sequence number of the last live update per entity, used to tell stale snapshot rows apart. */
  private readonly liveSeq = new Map<string, number>();
  /** Last time (ms) an entity was seen, live or in an applied snapshot. Drives pruning. */
  private readonly seenAt = new Map<string, number>();
  private seq = 0;
  /** Generation of the latest snapshot request. */
  private generation = 0;
  /** In-flight snapshot requests: token -> value of `seq` when that request was made. */
  private readonly pending = new Map<number, number>();

  constructor(private readonly log: { record(input: EventInput): void } = defaultLog) {}

  /** A live `state_changed` for one entity. The first sighting of an entity only seeds the state. */
  observe(sighting: StateSighting, now: number = Date.now()): void {
    this.seq += 1;
    this.liveSeq.set(sighting.entityId, this.seq);
    this.apply(sighting.entityId, sighting.state, now, false);
  }

  /** Call when a `GET /api/states` snapshot is requested. Returns the token of that request, to pass to `resync` or `cancel`. */
  mark(): number {
    this.generation += 1;
    this.pending.set(this.generation, this.seq);
    return this.generation;
  }

  /** Releases the token of a snapshot request that failed, so no mark is left hanging. */
  cancel(token: number): void {
    this.pending.delete(token);
  }

  /**
   * Compares one `GET /api/states` snapshot with the last known states (sent on every
   * (re)connect). Entities never seen before are seeded silently; changes are recorded with `resync: true`.
   * `token` is the one `mark()` returned for this request (default: the oldest in flight; none in flight = unguarded).
   * A snapshot from a request older than the latest, or with an unknown/cancelled token, is stale and dropped entirely.
   * Entities that received a live update after their own `mark()` are skipped: the snapshot may be older than them.
   */
  resync(states: ReadonlyArray<{ entity_id: string; state: string }>, now: number = Date.now(), token?: number): void {
    let since = Number.POSITIVE_INFINITY;
    const id = token ?? this.pending.keys().next().value;
    if (id !== undefined) {
      const mark = this.pending.get(id);
      this.pending.delete(id);
      if (mark === undefined || id < this.generation) return;
      since = mark;
    }
    const inSnapshot = new Set<string>();
    for (const s of states) {
      inSnapshot.add(s.entity_id);
      const live = this.liveSeq.get(s.entity_id);
      if (live !== undefined && live > since) continue;
      this.apply(s.entity_id, s.state, now, true);
    }
    this.prune(inSnapshot, now);
  }

  /** Forgets entities missing from a full snapshot and unseen for `PRUNE_AFTER_MS`, so the maps stay bounded by HA's entity count. */
  private prune(inSnapshot: ReadonlySet<string>, now: number): void {
    for (const [id, at] of this.seenAt) {
      if (inSnapshot.has(id) || now - at <= PRUNE_AFTER_MS) continue;
      this.seenAt.delete(id);
      this.last.delete(id);
      this.lastRecordedAt.delete(id);
      this.liveSeq.delete(id);
    }
  }

  private apply(entityId: string, state: string, now: number, resync: boolean): void {
    this.seenAt.set(entityId, now);
    const prev = this.last.get(entityId);
    this.last.set(entityId, state);
    if (prev === undefined || prev === state) return;

    let payload: Record<string, unknown> | null = null;
    if (state === UNAVAILABLE) {
      payload = { available: false, from: prev };
    } else if (prev === UNAVAILABLE) {
      payload = { available: true, to: state };
    }
    if (!payload) return;

    const lastAt = this.lastRecordedAt.get(entityId);
    if (lastAt !== undefined && now - lastAt < AVAILABILITY_GUARD_MS) return;
    this.lastRecordedAt.set(entityId, now);

    if (resync) payload.resync = true;
    this.log.record({ type: "availability", source: "ha", entityId, payload });
  }
}
