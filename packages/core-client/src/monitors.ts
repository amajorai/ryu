// apps/desktop/src/lib/api/monitors.ts
//
// Typed client for the Core website-monitoring API (`/api/monitors/*`). Field
// names are snake_case to match Core's serde shapes exactly (the Rust structs
// use no rename). The alert SSE stream uses fetch + ReadableStream rather than
// EventSource so the bearer token can be attached.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

export type FetchBackend = "http" | "spider" | "agentbrowser";

export type NumComparator =
  | "changed"
  | "less_than"
  | "greater_than"
  | "drops_by_pct"
  | "rises_by_pct";

// Internally-tagged union mirroring Core's `CheckType` (`{ "type": ... }`).
export type CheckType =
  | { type: "uptime"; expect_status?: number[] }
  | {
      type: "keyword";
      pattern: string;
      is_regex?: boolean;
      case_sensitive?: boolean;
      alert_when_present?: boolean;
    }
  | { type: "content_diff"; region_regex?: string | null }
  | {
      type: "price";
      extract_regex: string;
      comparator?: NumComparator;
      threshold?: number | null;
    }
  | {
      type: "stock";
      in_stock_pattern: string;
      is_regex?: boolean;
      alert_when_in_stock?: boolean;
    };

export type NotifyTarget =
  | { kind: "webhook"; url: string }
  | { kind: "telegram"; bot_token: string; chat_id: string }
  | { kind: "expo_push"; token: string };

export type CheckStatus = "ok" | "triggered" | "error";

export interface Monitor {
  id: string;
  name: string;
  url: string;
  backend: FetchBackend;
  check: CheckType;
  interval: string;
  enabled: boolean;
  notify: NotifyTarget[];
  created_at: string;
  updated_at: string;
  last_check_at?: string | null;
  last_status?: CheckStatus | null;
  last_value?: string | null;
}

export interface Snapshot {
  id: number;
  monitor_id: string;
  checked_at: string;
  status: CheckStatus;
  http_status?: number | null;
  latency_ms?: number | null;
  value?: string | null;
  content_hash?: string | null;
  note?: string | null;
}

export interface Alert {
  id: number;
  monitor_id: string;
  monitor_name: string;
  created_at: string;
  title: string;
  message: string;
  kind: string;
  acknowledged: boolean;
}

/** The fields needed to create or update a monitor. */
export interface MonitorInput {
  name: string;
  url: string;
  backend: FetchBackend;
  check: CheckType;
  interval: string;
  enabled: boolean;
  notify: NotifyTarget[];
}

export async function listMonitors(target: ApiTarget): Promise<Monitor[]> {
  const json = await request<{ monitors?: Monitor[] }>(target, "/api/monitors");
  return json.monitors ?? [];
}

export async function getMonitor(
  target: ApiTarget,
  id: string
): Promise<Monitor> {
  const json = await request<{ monitor?: Monitor; error?: string }>(
    target,
    `/api/monitors/${id}`
  );
  if (!json.monitor) {
    throw new Error(json.error ?? "monitor not found");
  }
  return json.monitor;
}

export async function createMonitor(
  target: ApiTarget,
  data: MonitorInput
): Promise<Monitor> {
  const json = await request<{ monitor?: Monitor; error?: string }>(
    target,
    "/api/monitors",
    { method: "POST", body: data }
  );
  if (!json.monitor) {
    throw new Error(json.error ?? "failed to create monitor");
  }
  return json.monitor;
}

export async function updateMonitor(
  target: ApiTarget,
  id: string,
  data: MonitorInput
): Promise<Monitor> {
  const json = await request<{ monitor?: Monitor; error?: string }>(
    target,
    `/api/monitors/${id}`,
    { method: "PUT", body: data }
  );
  if (!json.monitor) {
    throw new Error(json.error ?? "failed to update monitor");
  }
  return json.monitor;
}

export async function deleteMonitor(
  target: ApiTarget,
  id: string
): Promise<void> {
  await request(target, `/api/monitors/${id}`, { method: "DELETE" });
}

export async function runMonitor(
  target: ApiTarget,
  id: string
): Promise<CheckStatus> {
  const json = await request<{ status?: CheckStatus; error?: string }>(
    target,
    `/api/monitors/${id}/run`,
    { method: "POST" }
  );
  if (!json.status) {
    throw new Error(json.error ?? "check failed");
  }
  return json.status;
}

export async function listSnapshots(
  target: ApiTarget,
  id: string,
  limit = 50
): Promise<Snapshot[]> {
  const json = await request<{ snapshots?: Snapshot[] }>(
    target,
    `/api/monitors/${id}/snapshots?limit=${limit}`
  );
  return json.snapshots ?? [];
}

export async function listMonitorAlerts(
  target: ApiTarget,
  id: string,
  limit = 100
): Promise<Alert[]> {
  const json = await request<{ alerts?: Alert[] }>(
    target,
    `/api/monitors/${id}/alerts?limit=${limit}`
  );
  return json.alerts ?? [];
}

export async function listAllAlerts(
  target: ApiTarget,
  limit = 100
): Promise<Alert[]> {
  const json = await request<{ alerts?: Alert[] }>(
    target,
    `/api/monitors/alerts?limit=${limit}`
  );
  return json.alerts ?? [];
}

export async function ackAlert(target: ApiTarget, id: number): Promise<void> {
  await request(target, `/api/monitors/alerts/${id}/ack`, { method: "POST" });
}

const SSE_FRAME_SEPARATOR = "\n\n";
const DATA_PREFIX = "data:";

/**
 * Open the alert SSE stream and invoke `onAlert` for every event. Resolves when
 * the stream ends or `signal` aborts; throws on a non-2xx connect so the caller
 * can reconnect.
 */
export async function streamMonitorAlerts(
  target: ApiTarget,
  onAlert: (alert: Alert) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await fetch(apiUrl(target, "/api/monitors/alerts/stream"), {
    method: "GET",
    headers: makeHeaders(target.token),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`alert stream failed: ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith(DATA_PREFIX))
        .map((line) => line.slice(DATA_PREFIX.length).trim())
        .join("\n");
      if (data) {
        try {
          onAlert(JSON.parse(data) as Alert);
        } catch {
          // Ignore malformed frames; the next event self-heals the feed.
        }
      }
      buffer = buffer.slice(sep + SSE_FRAME_SEPARATOR.length);
      sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
    }
  }
}
