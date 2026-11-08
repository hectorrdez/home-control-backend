/** A successful panel action on one entity, kept long enough to tell a user-caused state change from a device event. */
export interface RecentAction {
  clientId: string | null;
  clientName: string | null;
  /** Epoch ms of the successful action. */
  at: number;
}

/** A state change of the entity within this window after an action counts as interacted. */
export const INTERACTED_WINDOW_MS = 10_000;

/**
 * In-memory map of the latest successful action per entity (018 action hook point).
 * `take` consumes the entry: one action explains at most one state change.
 */
export class RecentActions {
  private readonly byEntity = new Map<string, RecentAction>();

  record(entityId: string, action: { clientId: string | null; clientName: string | null }, now: number = Date.now()): void {
    this.byEntity.set(entityId, { clientId: action.clientId, clientName: action.clientName, at: now });
  }

  /** Returns and removes the action of `entityId` when it happened within INTERACTED_WINDOW_MS; otherwise undefined. */
  take(entityId: string, now: number = Date.now()): RecentAction | undefined {
    const entry = this.byEntity.get(entityId);
    if (!entry) return undefined;
    this.byEntity.delete(entityId);
    return now - entry.at <= INTERACTED_WINDOW_MS ? entry : undefined;
  }
}

export const recentActions = new RecentActions();
