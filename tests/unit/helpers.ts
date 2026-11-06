import type { AddressInfo } from "net";
import type { Server } from "http";
import { vi } from "vitest";

/** Silences the console logger; returns the spy so tests can assert on log lines. */
export function silenceConsole() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

/** Starts the real Express app on an ephemeral 127.0.0.1 port. Never touches the dev server port. */
export async function startApp(): Promise<{ base: string; close: () => Promise<void> }> {
  // Fresh module graph so the app's stream hub and caches do not leak between tests.
  vi.resetModules();
  const { default: app } = await import("../../src/app");
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Minimal Express-like response double for helpers that only call status()/json()/writeHead(). */
export function fakeRes(overrides: Partial<{ headersSent: boolean }> = {}) {
  const res: any = {
    locals: { entry: "2026/01/01 00:00:00" },
    headersSent: overrides.headersSent ?? false,
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}
