// apps/desktop/src/lib/api/plugins.ts
//
// Typed client for Core's Plugin lifecycle endpoints (`/api/plugins`). A Plugin
// is a plugin.json bundle descriptor (manifest) with a persisted lifecycle
// record (installed/enabled state). Consumed by the Extensions page via the
// `useApps` hook.
//
// Wire shapes use snake_case as serialised by Rust/serde; camelCase types are
// the client-side view exposed to React components. The internal symbol names
// (App*, fetchApps, etc.) are kept stable to limit churn across importers.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

// ── Wire types (Rust/serde shape) ────────────────────────────────────────────

interface RunnableEntryWire {
	config?: unknown;
	id: string;
	kind: string;
	name: string;
}

interface AppManifestWire {
	// System app fields injected by list_apps for Ghost/Shadow
	built_in: boolean;
	companion?: {
		label: string;
		icon?: string | null;
		shortcut?: string | null;
	} | null;
	enabled: boolean;
	id: string;
	// Injected by list_apps handler
	installed: boolean;
	installed_version: string | null;
	local_only: boolean;
	name: string;
	permission_grants: string[];
	runnables: RunnableEntryWire[];
	sidecar_name: string | null;
	version: string;
	windows_first: boolean;
}

interface AppRecordWire {
	approved_grants: string[];
	created_at: string | null;
	enabled: boolean;
	id: string;
	updated_at: string | null;
	version: string;
}

// ── Client types (camelCase, used by React) ───────────────────────────────────

export interface RunnableEntry {
	config: unknown;
	id: string;
	kind: string;
	name: string;
}

export interface AppInfo {
	builtIn: boolean;
	companion: {
		label: string;
		icon: string | null;
		shortcut: string | null;
	} | null;
	enabled: boolean;
	id: string;
	installed: boolean;
	installedVersion: string | null;
	localOnly: boolean;
	name: string;
	permissionGrants: string[];
	runnables: RunnableEntry[];
	sidecarName: string | null;
	version: string;
	windowsFirst: boolean;
}

export interface AppRecord {
	approvedGrants: string[];
	createdAt: string | null;
	enabled: boolean;
	id: string;
	updatedAt: string | null;
	version: string;
}

// ── Error shape returned by lifecycle endpoints ───────────────────────────────

/** Structured error from enable/disable — used to surface Gateway denial or
 *  unreachability via the UI without leaking raw status codes. */
export interface AppLifecycleError {
	/** True when the Gateway was unreachable (fail-closed). */
	gatewayUnreachable: boolean;
	/** True when the Gateway denied one or more grants. */
	grantsDenied: boolean;
	/** Human-readable reason suitable for display in a UI primitive. */
	message: string;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function toAppInfo(w: AppManifestWire): AppInfo {
	return {
		builtIn: w.built_in ?? false,
		companion: w.companion
			? {
					label: w.companion.label,
					icon: w.companion.icon ?? null,
					shortcut: w.companion.shortcut ?? null,
				}
			: null,
		enabled: w.enabled,
		id: w.id,
		installed: w.installed,
		installedVersion: w.installed_version,
		localOnly: w.local_only ?? false,
		name: w.name,
		permissionGrants: w.permission_grants,
		runnables: w.runnables.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			config: r.config ?? null,
		})),
		sidecarName: w.sidecar_name ?? null,
		version: w.version,
		windowsFirst: w.windows_first ?? false,
	};
}

function toAppRecord(w: AppRecordWire): AppRecord {
	return {
		id: w.id,
		version: w.version,
		enabled: w.enabled,
		approvedGrants: w.approved_grants,
		createdAt: w.created_at,
		updatedAt: w.updated_at,
	};
}

// ── Error parser ──────────────────────────────────────────────────────────────

/** Parse the JSON error body from a failed lifecycle response and produce a
 *  structured {@link AppLifecycleError}. Falls back to a generic message when
 *  the body is not JSON. */
async function parseLifecycleError(
	resp: Response,
	path: string
): Promise<AppLifecycleError> {
	let body: Record<string, unknown> = {};
	try {
		const text = await resp.text();
		body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		// ignore parse errors
	}

	const status = resp.status;
	const rawMessage =
		typeof body.message === "string"
			? body.message
			: `${path} failed: ${status}`;

	const grantsDenied = status === 403;
	const gatewayUnreachable = status === 503;

	let message = rawMessage;
	if (grantsDenied) {
		const denied = Array.isArray(body.denied_grants)
			? (body.denied_grants as string[]).join(", ")
			: null;
		message = denied
			? `Gateway denied grants: ${denied}`
			: "Gateway denied one or more permission grants.";
	} else if (gatewayUnreachable) {
		const reason =
			typeof body.reason === "string" ? body.reason : "gateway unreachable";
		message = `Gateway unreachable (fail-closed): ${reason}`;
	}

	return { message, grantsDenied, gatewayUnreachable };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** `GET /api/plugins` — list all app manifests merged with their lifecycle state. */
export async function fetchApps(target: ApiTarget): Promise<AppInfo[]> {
	const resp = await fetch(apiUrl(target, "/api/plugins"), {
		method: "GET",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins failed: ${resp.status}`);
	}
	const json = (await resp.json()) as { apps?: AppManifestWire[] };
	return (json.apps ?? []).map(toAppInfo);
}

/** `POST /api/plugins/:id/install` — record the app as installed (disabled). */
export async function installApp(
	target: ApiTarget,
	id: string
): Promise<AppRecord> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/install`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/install`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { app: AppRecordWire };
	return toAppRecord(json.app);
}

/** `POST /api/plugins/:id/enable` — validate grants via Gateway then enable app.
 *  Fails closed when the Gateway is unreachable (never silently falls back). */
export async function enableApp(
	target: ApiTarget,
	id: string
): Promise<AppRecord> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/enable`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/enable`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { app: AppRecordWire };
	return toAppRecord(json.app);
}

/** `POST /api/plugins/:id/disable` — disable app and clear approved grants. */
export async function disableApp(
	target: ApiTarget,
	id: string
): Promise<AppRecord> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/disable`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/disable`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { app: AppRecordWire };
	return toAppRecord(json.app);
}

// ── App catalog (browse remote registry + install-from-URL) ───────────────────

/** A single installable-app entry from Core's remote registry
 *  (`GET /api/plugins/catalog`). Pure discovery metadata — lifecycle state
 *  (installed/enabled) lives on {@link AppInfo} and is joined by `id`. */
export interface CatalogEntry {
	built_in: boolean;
	description: string;
	id: string;
	kinds: string[];
	name: string;
	permission_grants: string[];
	source: string;
	tags: string[];
	version: string;
}

/** `GET /api/plugins/catalog` — browse installable apps from the remote registry. */
export async function fetchAppsCatalog(
	target: ApiTarget
): Promise<CatalogEntry[]> {
	const data = await request<{ entries?: CatalogEntry[] }>(
		target,
		"/api/plugins/catalog"
	);
	return data.entries ?? [];
}

/** `POST /api/plugins/install` — install a plugin from an `https://` plugin.json URL.
 *  Core records it installed+disabled (enable is a separate, grant-gated step). */
export async function installAppFromUrl(
	target: ApiTarget,
	url: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/plugins/install"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify({ url }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/install");
		throw Object.assign(new Error(err.message), err);
	}
}

// ── Sidecar control (system apps: Ghost, Shadow) ──────────────────────────────

/** `GET /api/sidecar/status` — fetch running state for all sidecars as a map.
 *  Used by SystemAppCard to poll whether a built-in sidecar is running. */
export async function fetchSidecarStatus(
	target: ApiTarget
): Promise<Record<string, boolean>> {
	const resp = await fetch(apiUrl(target, "/api/sidecar/status"), {
		method: "GET",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/status failed: ${resp.status}`);
	}
	const json = (await resp.json()) as {
		sidecars?: Array<{ name: string; running: boolean }>;
	};
	const map: Record<string, boolean> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}

/** `POST /api/setup/:name/install` — download and install a sidecar binary.
 *  Used for built-in system apps before they can be started. */
export async function installSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, `/api/setup/${name}/install`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`/api/setup/${name}/install failed: ${resp.status}`);
	}
}

/** `POST /api/sidecar/:name/start` — start a sidecar process. */
export async function startSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, `/api/sidecar/${name}/start`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/start failed: ${resp.status}`);
	}
}

/** `POST /api/sidecar/:name/stop` — stop a sidecar process. */
export async function stopSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, `/api/sidecar/${name}/stop`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/stop failed: ${resp.status}`);
	}
}
