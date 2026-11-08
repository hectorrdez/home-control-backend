import { describe, expect, it, vi } from "vitest";
import { appEvents, AppEvent } from "@shared/events/AppEvents";

const evt = (keys: string[] = ["light.a"], by: string | null = null): AppEvent => ({
  type: "resource_changed",
  resource: "aliases",
  keys,
  by,
});

describe("appEvents", () => {
  it("delivers each emitted event to every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = appEvents.subscribe(a);
    const offB = appEvents.subscribe(b);
    appEvents.emit(evt());
    expect(a).toHaveBeenCalledWith(evt());
    expect(b).toHaveBeenCalledWith(evt());
    offA();
    offB();
  });

  it("stops delivering to a subscriber after its unsubscribe function runs", () => {
    const fn = vi.fn();
    const off = appEvents.subscribe(fn);
    off();
    appEvents.emit(evt());
    expect(fn).not.toHaveBeenCalled();
  });

  it("delivers to other subscribers when one stream write fails", () => {
    const failed = vi.fn(() => { throw new Error("socket closed"); });
    const healthy = vi.fn();
    const offFailed = appEvents.subscribe(failed);
    const offHealthy = appEvents.subscribe(healthy);
    try {
      expect(() => appEvents.emit(evt())).not.toThrow();
      expect(healthy).toHaveBeenCalledWith(evt());
    } finally {
      offFailed();
      offHealthy();
    }
  });

  it("allows many subscribers without a listener-count warning", () => {
    const offs = Array.from({ length: 50 }, () => appEvents.subscribe(() => undefined));
    expect(appEvents["emitter"].getMaxListeners()).toBe(0);
    offs.forEach((off) => off());
  });
});

