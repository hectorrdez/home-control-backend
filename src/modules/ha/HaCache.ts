import Logger from "@utils/Logger";
import type { AreaRef, HaState } from "./HaStates";

/** Lists loaded over the WebSocket after every auth_ok. */
type ListKind = "get_states" | "area_registry" | "device_registry" | "entity_registry";
const LIST_KINDS: ListKind[] = ["get_states", "area_registry", "device_registry", "entity_registry"];
const LIST_COMMANDS: Record<ListKind, Record<string, unknown>> = {
  get_states: { type: "get_states" },
  area_registry: { type: "config/area_registry/list" },
  device_registry: { type: "config/device_registry/list" },
  entity_registry: { type: "config/entity_registry/list" },
};
/** Registry change events -> the one list to re-request. */
const REGISTRY_EVENTS: Record<string, Exclude<ListKind, "get_states">> = {
  area_registry_updated: "area_registry",
  device_registry_updated: "device_registry",
  entity_registry_updated: "entity_registry",
};
const REFRESH_DEBOUNCE_MS = 1_000;
const RETRY_MS = 5_000;

export type CacheStatus = "ready" | "warming" | "off";
/** Sends one WebSocket command with a fresh id and returns that id. */
export type CacheSend = (payload: Record<string, unknown>) => number;

interface AreaRegistryRow {
  area_id: string;
  name?: string | null;
}
interface DeviceRegistryRow {
  id: string;
  area_id?: string | null;
  name?: string | null;
  name_by_user?: string | null;
}
interface EntityRegistryRow {
  entity_id: string;
  area_id?: string | null;
  device_id?: string | null;
}

const time = (s: HaState): number => Date.parse(s.last_updated ?? s.last_changed) || 0;

/**
 * In-memory copy of HA states and registries, fed by the WebSocket hub (019/022).
 * Ready only after all four lists arrived on the current socket; readers fall back to REST otherwise.
 */
export class HaCache {
  private send: CacheSend | null = null;
  private connected = false;
  private ready = false;
  private pending = new Map<number, ListKind>();
  private subscriptions = new Map<number, string>();
  private loaded = new Set<ListKind>();
  private timers = new Map<ListKind, NodeJS.Timeout>();

  private stateMap = new Map<string, HaState>();
  private areaRegistry: AreaRegistryRow[] = [];
  private deviceRegistry: DeviceRegistryRow[] = [];
  private entityRegistry: EntityRegistryRow[] = [];
  private areaByEntity = new Map<string, AreaRef>();
  private areaList: AreaRef[] = [];
  private deviceNames = new Map<string, string>();

  /** Called on every auth_ok: resets state, requests the four lists and subscribes to registry events. */
  start(send: CacheSend): void {
    this.reset();
    this.send = send;
    this.connected = true;
    for (const kind of LIST_KINDS) this.request(kind);
    for (const event of Object.keys(REGISTRY_EVENTS)) {
      this.subscriptions.set(send({ type: "subscribe_events", event_type: event }), event);
    }
  }

  /** Called whenever the link drops: readers go back to REST until the next load. */
  onDisconnect(): void {
    this.reset();
    this.connected = false;
  }

  private reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.send = null;
    this.ready = false;
    this.pending.clear();
    this.subscriptions.clear();
    this.loaded.clear();
    this.stateMap.clear();
    this.areaRegistry = [];
    this.deviceRegistry = [];
    this.entityRegistry = [];
    this.rebuild();
  }

  private request(kind: ListKind): void {
    if (!this.send) return;
    this.pending.set(this.send(LIST_COMMANDS[kind]), kind);
  }

  status(): CacheStatus {
    if (this.ready) return "ready";
    return this.connected ? "warming" : "off";
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Handles a `result` frame. Returns false when the id is not one of ours. */
  onResult(msg: { id: number; success?: boolean; result?: unknown }): boolean {
    const kind = this.pending.get(msg.id);
    if (!kind) return false;
    this.pending.delete(msg.id);

    if (msg.success === false || !Array.isArray(msg.result)) {
      Logger.write(`ha cache: ${kind} failed, retrying`, "HaCache", "WARN");
      this.schedule(kind, RETRY_MS);
      return true;
    }
    const rows = msg.result;
    if (kind === "get_states") {
      this.stateMap = new Map((rows as HaState[]).map((s) => [s.entity_id, s]));
    } else if (kind === "area_registry") {
      this.areaRegistry = rows as AreaRegistryRow[];
    } else if (kind === "device_registry") {
      this.deviceRegistry = rows as DeviceRegistryRow[];
    } else {
      this.entityRegistry = rows as EntityRegistryRow[];
    }
    this.rebuild();
    this.loaded.add(kind);
    if (!this.ready && this.loaded.size === LIST_KINDS.length) {
      this.ready = true;
      Logger.write(
        `ha cache ready: ${this.stateMap.size} states, ${this.areaList.length} areas, ${this.deviceNames.size} devices`,
        "HaCache"
      );
    }
    return true;
  }

  /** True when a subscription id belongs to a registry event. */
  ownsSubscription(id: number): boolean {
    return this.subscriptions.has(id);
  }

  /** A registry changed in HA: re-request only that list, debounced. */
  onRegistryEvent(id: number): void {
    const event = this.subscriptions.get(id);
    if (!event) return;
    this.schedule(REGISTRY_EVENTS[event], REFRESH_DEBOUNCE_MS);
  }

  private schedule(kind: ListKind, ms: number): void {
    const prior = this.timers.get(kind);
    if (prior) clearTimeout(prior);
    this.timers.set(
      kind,
      setTimeout(() => {
        this.timers.delete(kind);
        if (this.connected) this.request(kind);
      }, ms)
    );
  }

  /** Applies one state_changed event data object (`new_state: null` removes the entity). */
  onStateChanged(data: { entity_id?: string; new_state?: HaState | null } | undefined): void {
    if (!this.ready || !data?.entity_id) return;
    if (data.new_state === null) {
      this.stateMap.delete(data.entity_id);
      return;
    }
    if (data.new_state) this.applyState(data.new_state);
  }

  /** Stores a state unless the cached copy is newer (action replies and events may race). */
  applyState(state: HaState): void {
    if (!this.ready) return;
    const cached = this.stateMap.get(state.entity_id);
    if (cached && time(state) < time(cached)) return;
    this.stateMap.set(state.entity_id, state);
  }

  /** Rebuilds the derived indexes. Entity area: its own area, else its device's area. */
  private rebuild(): void {
    const areaNames = new Map(this.areaRegistry.map((a) => [a.area_id, a.name || a.area_id]));
    const deviceArea = new Map(this.deviceRegistry.map((d) => [d.id, d.area_id ?? null]));
    const deviceName = new Map(this.deviceRegistry.map((d) => [d.id, d.name_by_user || d.name || null]));
    this.areaByEntity = new Map();
    this.deviceNames = new Map();
    for (const e of this.entityRegistry) {
      const areaId = e.area_id ?? (e.device_id ? (deviceArea.get(e.device_id) ?? null) : null);
      if (areaId) this.areaByEntity.set(e.entity_id, { areaId, areaName: areaNames.get(areaId) ?? areaId });
      const name = e.device_id ? deviceName.get(e.device_id) : null;
      if (name) this.deviceNames.set(e.entity_id, name);
    }
    this.areaList = this.areaRegistry.map((a) => ({ areaId: a.area_id, areaName: a.name || a.area_id }));
  }

  allStates(): HaState[] {
    return [...this.stateMap.values()];
  }

  state(entityId: string): HaState | null {
    return this.stateMap.get(entityId) ?? null;
  }

  areas(): Map<string, AreaRef> {
    return this.areaByEntity;
  }

  areaEntries(): AreaRef[] {
    return this.areaList;
  }

  devices(): Map<string, string> {
    return this.deviceNames;
  }
}

export const haCache = new HaCache();
