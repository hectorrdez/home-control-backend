import Logger from "@utils/Logger";
import { haPostText } from "@modules/ha/HaClient";
import calibrationStore, { CalibrationRecord, CalibrationStore } from "@modules/calibrations/CalibrationStore";
import { NotCalibratedError, PositionUnknownError } from "./CoverMoveErrors";

/** Full-leg timers get a 10% margin: the motor limit stops the cover, the timer only has to outlast it. */
const FULL_LEG_MARGIN = 1.1;

type Direction = 1 | -1; // 1 = open, -1 = close

/** Timed move in flight. startPosition null = unknown, so there is no live estimate. */
interface ActiveMove {
  startedAt: number;
  startPosition: number | null;
  direction: Direction;
  legMs: number;
  timer: unknown;
}

interface PlannedMove {
  entityId: string;
  direction: Direction;
  legMs: number;
  startPosition: number | null;
  durationMs: number;
  end: number;
  /** Intermediate targets stop the motor themselves; full legs rely on the motor limit. */
  stopOnEnd: boolean;
}

/** Injectable collaborators. Tests replace the clock, timers, HA call and store. */
export interface CoverMoveDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  store: CalibrationStore;
  post(path: string, body: unknown): Promise<unknown>;
}

export const defaultCoverMoveDeps: CoverMoveDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  store: calibrationStore,
  post: haPostText,
};

/** Rounds a travelled-percent estimate into 0..100. */
const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

/** Returns the calibration record or throws not_calibrated (409). */
export function requireCalibration(store: CalibrationStore, entityId: string): CalibrationRecord {
  const record = store.get(entityId);
  if (!record) throw new NotCalibratedError();
  return record;
}

/**
 * In-memory timed moves for calibrated covers (one per entity). Timers are lost on restart
 * by design: a move persists position null when it starts, so after a restart the cover is
 * at an unknown position. The estimate is persisted when a move ends or is cancelled.
 */
export class CoverMoves {
  private active = new Map<string, ActiveMove>();

  constructor(private readonly deps: CoverMoveDeps = defaultCoverMoveDeps) {}

  /** Live estimate while a move runs, else the stored position (null = unknown or uncalibrated). */
  estimatedPosition(entityId: string): number | null {
    const move = this.active.get(entityId);
    if (move) return this.estimateAt(move, this.deps.now());
    return this.deps.store.get(entityId)?.position ?? null;
  }

  /**
   * Drives a calibrated cover to `percent`. A running move is interrupted first (stop_cover,
   * estimate kept). Full targets (0/100) run the whole leg; intermediate targets need a known
   * position and stop after the proportional time. Throws not_calibrated / position_unknown before any HA call.
   */
  async moveTo(entityId: string, percent: number): Promise<void> {
    const cal = requireCalibration(this.deps.store, entityId);
    const prior = this.active.get(entityId);
    const current = prior ? this.estimateAt(prior, this.deps.now()) : cal.position;
    const full = percent === 0 || percent === 100;
    if (!full && current === null) throw new PositionUnknownError();

    if (prior) {
      this.cancel(entityId);
      await this.call("stop_cover", entityId);
      void this.setPosition(entityId, current);
    }
    if (!full && percent === current) return;

    const from = current as number | null;
    const direction: Direction = full ? (percent === 100 ? 1 : -1) : percent > (from as number) ? 1 : -1;
    const legMs = direction === 1 ? cal.openMs : cal.closeMs;
    const durationMs = full
      ? Math.round(legMs * FULL_LEG_MARGIN)
      : Math.round((Math.abs(percent - (from as number)) / 100) * legMs);

    await this.call(direction === 1 ? "open_cover" : "close_cover", entityId);
    this.begin({ entityId, direction, legMs, startPosition: from, durationMs, end: percent, stopOnEnd: !full });
  }

  /**
   * Wraps an already validated cover action around its HA call. Cancels a running move first:
   * stop_cover keeps the elapsed estimate, any other action makes the position unknown.
   * open/close then start a full-leg timer (when calibrated) that sets 100/0 once the leg time passes.
   */
  async onAction(entityId: string, action: string, send: () => Promise<unknown>): Promise<void> {
    const prior = this.cancel(entityId);
    if (action === "stop_cover") {
      if (prior) await this.setPosition(entityId, this.estimateAt(prior, this.deps.now()));
    } else if (action !== "open_cover" && action !== "close_cover") {
      await this.setPosition(entityId, null);
    }

    await send();

    if (action !== "open_cover" && action !== "close_cover") return;
    const cal = this.deps.store.get(entityId);
    if (!cal) return;
    const direction: Direction = action === "open_cover" ? 1 : -1;
    const legMs = direction === 1 ? cal.openMs : cal.closeMs;
    this.begin({
      entityId,
      direction,
      legMs,
      startPosition: null,
      durationMs: Math.round(legMs * FULL_LEG_MARGIN),
      end: direction === 1 ? 100 : 0,
      stopOnEnd: false,
    });
  }

  private begin(plan: PlannedMove): void {
    const timer = this.deps.setTimer(() => void this.complete(plan.entityId, plan.end, plan.stopOnEnd), plan.durationMs);
    this.active.set(plan.entityId, {
      startedAt: this.deps.now(),
      startPosition: plan.startPosition,
      direction: plan.direction,
      legMs: plan.legMs,
      timer,
    });
    void this.setPosition(plan.entityId, null);
  }

  /** Timer fired: optionally stop the motor, then persist the reached position. Never rejects. */
  private async complete(entityId: string, end: number, stopOnEnd: boolean): Promise<void> {
    this.active.delete(entityId);
    if (stopOnEnd) {
      await this.call("stop_cover", entityId).catch((err) => this.warn(entityId, err));
    }
    await this.setPosition(entityId, end);
  }

  /** Removes a running move and clears its timer. No HA call, no persistence. */
  private cancel(entityId: string): ActiveMove | undefined {
    const move = this.active.get(entityId);
    if (!move) return undefined;
    this.deps.clearTimer(move.timer);
    this.active.delete(entityId);
    return move;
  }

  private estimateAt(move: ActiveMove, at: number): number | null {
    if (move.startPosition === null) return null;
    const travelled = ((at - move.startedAt) / move.legMs) * 100 * move.direction;
    return clampPercent(move.startPosition + travelled);
  }

  /** Writes the position only for calibrated covers (mutate skips the write otherwise). Never rejects. */
  private setPosition(entityId: string, position: number | null): Promise<void> {
    return this.deps.store
      .mutate((draft) => {
        const record = draft.get(entityId);
        if (!record || record.position === position) return false;
        draft.set(entityId, { ...record, position });
        return true;
      })
      .catch(() => undefined); // JsonFileStore already logs the write failure
  }

  private call(service: "open_cover" | "close_cover" | "stop_cover", entityId: string): Promise<unknown> {
    return this.deps.post(`/api/services/cover/${service}`, { entity_id: entityId });
  }

  private warn(entityId: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : "unknown error";
    Logger.write(`stop_cover failed for ${entityId}: ${reason}`, "CoverMoves", "WARN");
  }
}

/** Shared instance used by the normalized responses and the cover action endpoint. */
const coverMoves = new CoverMoves();
export default coverMoves;
