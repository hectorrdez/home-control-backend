import { haGet } from "./HaClient";

export interface HaStatus {
  online: true;
  message: string | null;
  version: string | null;
}

/** Checks the link to HA: GET /api/ (reachability + auth) and GET /api/config (version). */
export async function haStatus(): Promise<HaStatus[]> {
  const root = await haGet<{ message?: string }>("/api/");
  const config = await haGet<{ version?: string }>("/api/config");
  return [
    {
      online: true,
      message: root.message ?? null,
      version: config.version ?? null,
    },
  ];
}
