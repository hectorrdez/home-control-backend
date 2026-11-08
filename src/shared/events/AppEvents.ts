import { EventEmitter } from "events";
import Logger from "@utils/Logger";

/** Resources whose changes are announced on the SSE stream. */
export type ChangeResource = "aliases" | "calibrations" | "alert_rules" | "settings";

/**
 * Application events published on the change bus. Later features extend this
 * union (018 `event`, 019 `ha_link`, 020 `alert` / `alert_acked`).
 */
export type AppEvent = {
  type: "resource_changed";
  resource: ChangeResource;
  /** Changed keys; the stream sends `[]` (refetch all) when there are more than 100. */
  keys: string[];
  /** Client id of the writer (X-Client-Id), or null when unknown / timer-driven. */
  by: string | null;
};

export type AppEventListener = (evt: AppEvent) => void;

const CHANNEL = "event";

/** In-process change bus. Publishing is synchronous; no debounce here (clients coalesce). */
class AppEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /**
   * Delivers the event to every subscriber. A listener that throws (e.g. an SSE
   * write to a closed socket) is isolated: the error is logged and delivery
   * continues with the remaining subscribers. Never throws to the publisher.
   */
  emit(evt: AppEvent): void {
    for (const listener of this.emitter.listeners(CHANNEL)) {
      try {
        (listener as AppEventListener)(evt);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        Logger.error(`change bus listener failed: ${reason}`, "EVENTS");
      }
    }
  }

  /** Registers a listener and returns the function that removes it. */
  subscribe(fn: AppEventListener): () => void {
    this.emitter.on(CHANNEL, fn);
    return () => {
      this.emitter.off(CHANNEL, fn);
    };
  }
}

export const appEvents = new AppEventBus();
