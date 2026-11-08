import Logger from "@utils/Logger";
import { fetchAreaIndex, fetchDeviceNameIndex, normalizeEntity, AreaRef, HaState, NormalizedEntity } from "@modules/ha/HaStates";
import { haCache } from "@modules/ha/HaCache";

type Listener = (entity: NormalizedEntity) => void;
export type LinkListener = (connected: boolean) => void;

/** Current link to Home Assistant. `at` is the ISO time of the last real transition, null before the first one. */
export interface HaLinkStatus {
  connected: boolean;
  at: string | null;
}

/** Reconnect delays in ms; the last one repeats. Reset after a successful auth. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const SUBSCRIBE_ID = 1;
/** Application-level heartbeat: a half-open TCP link is only detected by a missing pong. */
const HEARTBEAT_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
/** The area index is optional; a failing one is logged at most once per minute. */
const AREA_WARN_MS = 60_000;

/**
 * One shared Home Assistant WebSocket. Normally it is opened when the first
 * listener subscribes and closed when the last one leaves. After `keepAlive()`
 * (019) it stays open for the life of the process: reconnects are forever and
 * subscribe/unsubscribe no longer close it. The token is only sent inside the
 * auth message and is never logged.
 */
export class HaEventHub {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private linkListeners = new Set<LinkListener>();
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private permanent = false;
  private link: HaLinkStatus = { connected: false, at: null };
  private lastAreaWarnAt = Number.NEGATIVE_INFINITY;

  /** Registers a listener and returns the function that removes it. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (!this.ws && !this.timer) this.connect();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.close();
    };
  }

  /** Keeps the socket open for the life of the process (called once at boot). */
  keepAlive(): void {
    this.permanent = true;
    if (!this.ws && !this.timer) this.connect();
  }

  /** Registers a callback fired only on real link transitions. Returns the removal function. */
  onLink(fn: LinkListener): () => void {
    this.linkListeners.add(fn);
    return () => {
      this.linkListeners.delete(fn);
    };
  }

  /** Current link state, used to send the initial `ha_link` frame to new SSE clients. */
  get status(): HaLinkStatus {
    return { ...this.link };
  }

  private connect(): void {
    let base = process.env.HA_URL ?? "";
    while (base.endsWith("/")) base = base.slice(0, -1);
    const token = process.env.HA_TOKEN ?? "";
    if (!base || !token) {
      Logger.write("HA_URL or HA_TOKEN missing: state stream idle", "StreamHub", "WARN");
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(`${base.replace(/^http/i, "ws")}/api/websocket`);
    this.ws = ws;
    let nextId = SUBSCRIBE_ID + 1;
    /** Every command on this socket takes the next id (shared with the heartbeat and the HA cache). */
    const send = (payload: Record<string, unknown>): number => {
      const id = nextId++;
      ws.send(JSON.stringify({ ...payload, id }));
      return id;
    };
    let heartbeat: NodeJS.Timeout | null = null;
    let pongTimer: NodeJS.Timeout | null = null;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (pongTimer) clearTimeout(pongTimer);
      heartbeat = null;
      pongTimer = null;
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_ok") {
        this.attempt = 0;
        Logger.write("HA state stream connected", "StreamHub");
        this.setLinked(true);
        ws.send(JSON.stringify({ id: SUBSCRIBE_ID, type: "subscribe_events", event_type: "state_changed" }));
        haCache.start(send);
        stopHeartbeat();
        heartbeat = setInterval(() => {
          if (this.ws !== ws) return stopHeartbeat(); // detached by close() or a previous timeout
          if (pongTimer) return;
          try {
            ws.send(JSON.stringify({ id: nextId++, type: "ping" }));
          } catch {
            // send failure: the pong timer below forces the reconnect
          }
          pongTimer = setTimeout(() => {
            pongTimer = null;
            if (this.ws !== ws) return;
            Logger.write("HA stream heartbeat missed, reconnecting", "StreamHub", "WARN");
            stopHeartbeat();
            this.ws = null;
            this.setLinked(false);
            ws.close();
            this.scheduleReconnect();
          }, PONG_TIMEOUT_MS);
        }, HEARTBEAT_MS);
      } else if (msg.type === "pong") {
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = null;
      } else if (msg.type === "auth_invalid") {
        Logger.write("HA rejected the access token", "StreamHub", "WARN");
        stopHeartbeat();
        this.setLinked(false);
        ws.close();
      } else if (msg.type === "result") {
        haCache.onResult(msg);
      } else if (msg.type === "event" && msg.id === SUBSCRIBE_ID) {
        haCache.onStateChanged(msg.event?.data);
        void this.onStateChanged(msg.event?.data?.new_state as HaState | null | undefined);
      } else if (msg.type === "event" && haCache.ownsSubscription(msg.id)) {
        haCache.onRegistryEvent(msg.id);
      }
    };

    ws.onclose = () => {
      stopHeartbeat();
      if (this.ws !== ws) return; // closed on purpose by close() or by the heartbeat
      this.ws = null;
      this.setLinked(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles the reconnect; nothing to add here.
    };
  }

  /** Updates the link state and notifies link listeners, only when the value really changes. */
  private setLinked(connected: boolean): void {
    if (this.link.connected === connected) return;
    if (!connected) haCache.onDisconnect();
    this.link = { connected, at: new Date().toISOString() };
    for (const fn of this.linkListeners) {
      try {
        fn(connected);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        Logger.error(`HA link listener failed: ${reason}`, "StreamHub");
      }
    }
  }

  private async onStateChanged(state: HaState | null | undefined): Promise<void> {
    if (!state || this.listeners.size === 0) return;
    const [areas, devices] = await Promise.all([
      fetchAreaIndex().catch((err): Map<string, AreaRef> => {
        this.warnAreaIndex(err);
        return new Map();
      }),
      fetchDeviceNameIndex(),
    ]);
    const entity = normalizeEntity(state, areas, devices);
    for (const fn of this.listeners) fn(entity);
  }

  private warnAreaIndex(err: unknown): void {
    const now = Date.now();
    if (now - this.lastAreaWarnAt < AREA_WARN_MS) return;
    this.lastAreaWarnAt = now;
    const reason = err instanceof Error ? err.message : "unknown error";
    Logger.write(`area index unavailable, emitting empty areas: ${reason}`, "StreamHub", "WARN");
  }

  private wanted(): boolean {
    return this.permanent || this.listeners.size > 0;
  }

  private scheduleReconnect(): void {
    if (!this.wanted() || this.timer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted() && !this.ws) this.connect();
    }, delay);
  }

  private close(): void {
    if (this.permanent) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    const ws = this.ws;
    this.ws = null;
    this.setLinked(false);
    ws?.close();
  }
}

export const haEvents = new HaEventHub();
