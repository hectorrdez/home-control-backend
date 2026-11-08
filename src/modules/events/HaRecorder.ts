import Logger from "@utils/Logger";
import { haEvents, HaEventHub } from "@modules/stream/HaEvents";
import { fetchStates } from "@modules/ha/HaStates";
import { appEvents } from "@shared/events/AppEvents";
import { eventLog as defaultLog, EventLog } from "./EventLog";
import { AvailabilityRecorder } from "./AvailabilityRecorder";

/**
 * Wires the always-on HA recorder (019): every HA link transition goes to the
 * event log and the change bus (`ha_link`), and every state change feeds the
 * availability recorder. On each (re)connect one `GET /api/states` snapshot is
 * diffed against the last known states. Returns a function that stops it.
 */
export function startHaRecorder(
  hub: HaEventHub = haEvents,
  log: EventLog = defaultLog,
  availability: AvailabilityRecorder = new AvailabilityRecorder(log)
): () => void {
  const offLink = hub.onLink((connected) => {
    const at = hub.status.at ?? new Date().toISOString();
    log.record({ type: "ha_link", source: "ha", payload: { connected } });
    appEvents.emit({ type: "ha_link", connected, at });
    if (!connected) return;
    const token = availability.mark();
    fetchStates()
      .then((states) => availability.resync(states, undefined, token))
      .catch((err: unknown) => {
        availability.cancel(token);
        const reason = err instanceof Error ? err.message : String(err);
        Logger.write(`HA snapshot unavailable, availability not resynced: ${reason}`, "HaRecorder", "WARN");
      });
  });
  // The recorder is a permanent subscriber, so the hub also feeds it while no SSE client is connected.
  const offState = hub.subscribe((entity) => availability.observe({ entityId: entity.entityId, state: entity.state }));
  return () => {
    offLink();
    offState();
  };
}
