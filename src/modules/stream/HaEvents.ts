import Logger from "@utils/Logger";
import { fetchAreaIndex, normalizeEntity, HaState, NormalizedEntity } from "@modules/ha/HaStates";

type Listener = (entity: NormalizedEntity) => void;

/** Reconnect delays in ms; the last one repeats. Reset after a successful auth. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const SUBSCRIBE_ID = 1;

/**
 * One shared Home Assistant WebSocket for every SSE client. Opened when the
 * first listener subscribes, closed when the last one leaves, and reconnected
 * with backoff while anyone is still listening. The token is only sent inside
 * the auth message and is never logged.
 */
class HaEventHub {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;

  /** Registers a listener and returns the function that removes it. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (!this.ws && !this.timer) this.connect();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.close();
    };
  }

  private connect(): void {
    const base = (process.env.HA_URL ?? "").replace(/\/+$/, "");
    const token = process.env.HA_TOKEN ?? "";
    if (!base || !token) {
      Logger.write("HA_URL or HA_TOKEN missing: state stream idle", "StreamHub", "WARN");
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(`${base.replace(/^http/i, "ws")}/api/websocket`);
    this.ws = ws;

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
        ws.send(JSON.stringify({ id: SUBSCRIBE_ID, type: "subscribe_events", event_type: "state_changed" }));
      } else if (msg.type === "auth_invalid") {
        Logger.write("HA rejected the access token", "StreamHub", "WARN");
        ws.close();
      } else if (msg.type === "event" && msg.id === SUBSCRIBE_ID) {
        void this.onStateChanged(msg.event?.data?.new_state as HaState | null | undefined);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // closed on purpose by close()
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles the reconnect; nothing to add here.
    };
  }

  private async onStateChanged(state: HaState | null | undefined): Promise<void> {
    if (!state || this.listeners.size === 0) return;
    const areas = await fetchAreaIndex().catch(() => new Map());
    const entity = normalizeEntity(state, areas);
    for (const fn of this.listeners) fn(entity);
  }

  private scheduleReconnect(): void {
    if (this.listeners.size === 0 || this.timer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.listeners.size > 0 && !this.ws) this.connect();
    }, delay);
  }

  private close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export const haEvents = new HaEventHub();
