import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/monitors.ts
//
// Typed client for the Core website-monitoring API (`/api/monitors/*`). Field
// names are snake_case to match Core's serde shapes exactly (the Rust structs
// use no rename). The alert SSE stream uses fetch + ReadableStream rather than
// EventSource so the bearer token can be attached.

import { type ApiTarget, request } from "./client.ts";
import { streamChannel } from "./eventStream.ts";
import { encodePathId } from "./path-id.ts";

export type {
	Alert,
	CheckStatus,
	CheckType,
	FetchBackend,
	Monitor,
	MonitorInput,
	NotifyTarget,
	NumComparator,
	ProviderUsageSnapshot,
	Snapshot,
	UsageProviderOption,
} from "@ryuhq/core-client/monitors.ts";

import type {
	Alert,
	CheckStatus,
	Monitor,
	MonitorInput,
	Snapshot,
} from "@ryuhq/core-client/monitors.ts";

const monitorAlertFields = z.object({
	acknowledged: z.boolean(),
	created_at: z.string(),
	id: z.number(),
	kind: z.string(),
	message: z.string(),
	monitor_id: z.string(),
	monitor_name: z.string(),
	title: z.string(),
});
const monitorAlertSchema = z.custom<z.output<typeof monitorAlertFields>>(
	(value) => monitorAlertFields.safeParse(value).success
);

const checkStatusFields = z.enum(["ok", "triggered", "error"]);
const comparatorFields = z.enum([
	"changed",
	"less_than",
	"greater_than",
	"drops_by_pct",
	"rises_by_pct",
]);
const checkFields = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("uptime"),
		expect_status: z.array(z.number()).optional(),
	}),
	z.object({
		type: z.literal("keyword"),
		pattern: z.string(),
		is_regex: z.boolean().optional(),
		case_sensitive: z.boolean().optional(),
		alert_when_present: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("content_diff"),
		region_regex: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("price"),
		extract_regex: z.string(),
		comparator: comparatorFields.optional(),
		threshold: z.number().nullable().optional(),
	}),
	z.object({
		type: z.literal("stock"),
		in_stock_pattern: z.string(),
		is_regex: z.boolean().optional(),
		alert_when_in_stock: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("provider_usage_reset"),
		provider_id: z.string(),
		target_ids: z.array(z.string()),
		minimum_drop_percent: z.number(),
	}),
]);
const notifyFields = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("webhook"), url: z.string() }),
	z.object({
		kind: z.literal("telegram"),
		chat_id: z.string(),
		has_bot_token: z.boolean().optional(),
		bot_token: z.string().optional(),
	}),
	z.object({ kind: z.literal("expo_push"), token: z.string() }),
	z.object({ kind: z.literal("email"), to: z.string() }),
]);
const monitorFields = z.object({
	backend: z.enum(["http", "spider", "agentbrowser"]),
	check: checkFields,
	created_at: z.string(),
	enabled: z.boolean(),
	id: z.string(),
	interval: z.string(),
	last_check_at: z.string().nullable().optional(),
	last_status: checkStatusFields.nullable().optional(),
	last_value: z.string().nullable().optional(),
	name: z.string(),
	notify: z.array(notifyFields),
	updated_at: z.string(),
	url: z.string(),
});
const snapshotFields = z.object({
	checked_at: z.string(),
	content_hash: z.string().nullable().optional(),
	http_status: z.number().nullable().optional(),
	id: z.number(),
	latency_ms: z.number().nullable().optional(),
	monitor_id: z.string(),
	note: z.string().nullable().optional(),
	status: checkStatusFields,
	value: z.string().nullable().optional(),
});
function monitorResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			gatewayJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const monitorsResponseSchema = monitorResponse(
	z.object({
		monitors: z.array(monitorFields).optional(),
		error: z.string().optional(),
	})
);
const monitorResponseSchema = monitorResponse(
	z.object({
		monitor: monitorFields.optional(),
		error: z.string().optional(),
	})
);
const runResponseSchema = monitorResponse(
	z.object({
		status: checkStatusFields.optional(),
		error: z.string().optional(),
	})
);
const snapshotsResponseSchema = monitorResponse(
	z.object({
		snapshots: z.array(snapshotFields).optional(),
		error: z.string().optional(),
	})
);
const alertsResponseSchema = monitorResponse(
	z.object({
		alerts: z.array(monitorAlertSchema).optional(),
		error: z.string().optional(),
	})
);
const okResponseSchema = monitorResponse(z.object({ ok: z.boolean() }));

export async function listMonitors(target: ApiTarget): Promise<Monitor[]> {
	const json = await request(
		target,
		"/api/monitors",
		undefined,
		monitorsResponseSchema
	);
	return json.monitors ?? [];
}

export async function getMonitor(
	target: ApiTarget,
	id: string
): Promise<Monitor> {
	const json = await request(
		target,
		`/api/monitors/${encodePathId(id)}`,
		undefined,
		monitorResponseSchema
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
	const json = await request(
		target,
		"/api/monitors",
		{ method: "POST", body: data },
		monitorResponseSchema
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
	const json = await request(
		target,
		`/api/monitors/${encodePathId(id)}`,
		{ method: "PUT", body: data },
		monitorResponseSchema
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
	await request(
		target,
		`/api/monitors/${encodePathId(id)}`,
		{ method: "DELETE" },
		okResponseSchema
	);
}

export async function runMonitor(
	target: ApiTarget,
	id: string
): Promise<CheckStatus> {
	const json = await request(
		target,
		`/api/monitors/${encodePathId(id)}/run`,
		{ method: "POST" },
		runResponseSchema
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
	const json = await request(
		target,
		`/api/monitors/${encodePathId(id)}/snapshots?limit=${limit}`,
		undefined,
		snapshotsResponseSchema
	);
	return json.snapshots ?? [];
}

export async function listMonitorAlerts(
	target: ApiTarget,
	id: string,
	limit = 100
): Promise<Alert[]> {
	const json = await request(
		target,
		`/api/monitors/${encodePathId(id)}/alerts?limit=${limit}`,
		undefined,
		alertsResponseSchema
	);
	return json.alerts ?? [];
}

export async function listAllAlerts(
	target: ApiTarget,
	limit = 100
): Promise<Alert[]> {
	const json = await request(
		target,
		`/api/monitors/alerts?limit=${limit}`,
		undefined,
		alertsResponseSchema
	);
	return json.alerts ?? [];
}

export async function ackAlert(target: ApiTarget, id: number): Promise<void> {
	await request(
		target,
		`/api/monitors/alerts/${id}/ack`,
		{ method: "POST" },
		okResponseSchema
	);
}

/**
 * Subscribe to monitor alert events and invoke `onAlert` for every event.
 * Resolves when `signal` aborts. Shares the single multiplexed node connection
 * (`/api/events/all`, see eventStream.ts) instead of its own HTTP socket.
 * `onResync` runs after that connection re-opens, since alerts raised while it
 * was down are not replayed.
 */
export function streamMonitorAlerts(
	target: ApiTarget,
	onAlert: (alert: Alert) => void,
	signal?: AbortSignal,
	onResync?: () => void
): Promise<void> {
	return streamChannel(
		target,
		"monitors",
		onAlert,
		signal,
		monitorAlertSchema,
		{ onResync }
	);
}
