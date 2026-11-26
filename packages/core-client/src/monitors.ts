// Typed client for the Core website-monitoring API (`/api/monitors/*`). The
// canonical wire model (snake_case, as Core's serde shapes) is in
// monitors-types.ts and re-exported here. The alert SSE stream uses fetch +
// ReadableStream rather than EventSource so the bearer token can be attached.
//
// Monitors is an app that Core serves through a mount: Core decodes the path
// tail once and matches the decoded path against the routes of
// apps-store/monitors/manifest.json. Every monitor id therefore goes through
// encodeMountPathId with MONITOR_ROUTE_NAMES, so a slash, a backslash, a dot
// segment or a static route name cannot steer a request onto another route of
// the app.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";
import {
	type Alert,
	alertSchema,
	alertsResponseSchema,
	type CheckStatus,
	type Monitor,
	type MonitorInput,
	monitorResponseSchema,
	monitorsResponseSchema,
	okResponseSchema,
	type ProviderUsageSnapshot,
	providersResponseSchema,
	runResponseSchema,
	type Snapshot,
	snapshotsResponseSchema,
	type UsageProviderOption,
	usageResponseSchema,
} from "./monitors-types.ts";
import { encodeMountPathId, encodePathId } from "./path-id.ts";

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
	PublicNotifyTarget,
	Snapshot,
	UsageMeterTarget,
	UsageMeterValueTarget,
	UsageProviderAccountOption,
	UsageProviderOption,
	UsageWindowTarget,
} from "./monitors-types.ts";
export { monitorNotifyTargetsInputSchema } from "./monitors-types.ts";

/**
 * The one-segment static routes of apps-store/monitors/manifest.json beside
 * `/:id` (`GET /alerts`, `POST /list`, `POST /run`). A monitor id equal to one
 * of them would reach that route instead of the monitor. monitors-path-id.test.ts
 * reads the manifest and fails when this list and the manifest differ.
 */
export const MONITOR_ROUTE_NAMES: readonly string[] = ["alerts", "list", "run"];

/** A monitor id as one path segment under the monitors mount. */
function monitorPath(id: string): string {
	return `/api/monitors/${encodeMountPathId(id, MONITOR_ROUTE_NAMES)}`;
}

/** Providers with a supported normalized usage reader for reset monitoring. */
export async function listUsageProviders(
	target: ApiTarget
): Promise<UsageProviderOption[]> {
	const json = await request(
		target,
		"/api/monitors/usage/providers",
		undefined,
		providersResponseSchema
	);
	return json.providers ?? [];
}

/**
 * Read a provider's usage windows and credit meters. Without `accountId` Core
 * reads the active account; with it, exactly that saved account (an unknown id
 * reads `account_not_found`, never another account).
 */
export async function queryProviderUsage(
	target: ApiTarget,
	providerId: string,
	accountId?: string
): Promise<ProviderUsageSnapshot> {
	return request(
		target,
		"/api/monitors/usage/query",
		{
			method: "POST",
			body: accountId
				? { provider_id: providerId, account_id: accountId }
				: { provider_id: providerId },
		},
		usageResponseSchema
	);
}

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
		monitorPath(id),
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
		monitorPath(id),
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
		monitorPath(id),
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
		`${monitorPath(id)}/run`,
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
		`${monitorPath(id)}/snapshots?limit=${limit}`,
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
		`${monitorPath(id)}/alerts?limit=${limit}`,
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
		`/api/monitors/alerts/${encodePathId(String(id))}/ack`,
		{ method: "POST" },
		okResponseSchema
	);
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/monitors/alerts/stream"),
		{
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
	if (!(resp.ok && resp.body)) {
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
					onAlert(alertSchema.parse(JSON.parse(data)));
				} catch {
					// Ignore malformed frames; the next event self-heals the feed.
				}
			}
			buffer = buffer.slice(sep + SSE_FRAME_SEPARATOR.length);
			sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		}
	}
}
