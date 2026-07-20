// apps/desktop/src/lib/services-api.ts

export interface CatalogItem {
	category: "agent" | "tool" | "provider" | "voice" | "media" | "embedding";
	deprecated: boolean;
	description: string;
	displayName: string;
	installedVersion: string | null;
	installState: "not_installed" | "installing" | "installed" | "failed";
	latestVersion: string | null;
	name: string;
	/** OS families this entry runs on (e.g. ["macos"]). Empty = every platform. */
	platforms: string[];
	recommended: boolean;
	/**
	 * Whether the Core NODE (which may be remote) can actually run/install this
	 * entry on its own OS + CPU arch. When false, the client must disable the
	 * install/enable controls regardless of the client's own platform.
	 */
	supported: boolean;
}

// NOTE: agent CRUD (`/api/agents`) and engine endpoints (`/api/engines`,
// `/api/engine/active`) moved to the typed client modules under
// `src/lib/api/{agents,engines}.ts` (DA0). Import from there. This file retains
// only the catalog / sidecar / dependency helpers used by the services page.

/** ACP or external agent entry returned by GET /api/agents (registry built-ins). */
export interface ExternalAgent {
	description: string | null;
	id: string;
	installed: boolean | null;
	installHint: string | null;
	name: string;
}

export async function fetchExternalAgents(
	nodeUrl: string,
	token: string | null
): Promise<ExternalAgent[]> {
	const headers = makeHeaders(token);
	const resp = await fetch(`${nodeUrl}/api/agents`, { headers });
	if (!resp.ok) {
		throw new Error(`agents fetch failed: ${resp.status}`);
	}
	const json = await resp.json();
	// biome-ignore lint/suspicious/noExplicitAny: external JSON shape
	return (json.agents ?? []).map(
		(a: any): ExternalAgent => ({
			id: a.id,
			name: a.name,
			description: a.description ?? null,
			installHint: a.install_hint ?? null,
			installed: a.installed ?? null,
		})
	);
}

export interface SidecarRunStatus {
	name: string;
	running: boolean;
}

export interface DependencyStatus {
	installed: boolean;
	name: string;
}

function makeHeaders(token: string | null): HeadersInit {
	const headers: HeadersInit = { "Content-Type": "application/json" };
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/**
 * POST a sidecar/setup action and surface backend failures.
 *
 * Core's lifecycle endpoints answer with HTTP 200 even when the action fails,
 * carrying `{ success: false, error }` in the body (e.g. "'gateway' is not
 * installed"). A bare `resp.ok` check silently swallows those, which is why the
 * buttons looked like no-ops. Throw on either a non-2xx status or an explicit
 * `success: false` so callers can show a real error.
 */
async function postAction(
	nodeUrl: string,
	token: string | null,
	path: string,
	label: string
): Promise<void> {
	const resp = await fetch(`${nodeUrl}${path}`, {
		method: "POST",
		headers: makeHeaders(token),
	});
	let body: { success?: boolean; error?: string } | null = null;
	try {
		body = await resp.json();
	} catch {
		body = null;
	}
	if (!resp.ok) {
		throw new Error(body?.error ?? `${label} failed: ${resp.status}`);
	}
	if (body?.success === false) {
		throw new Error(body.error ?? `${label} failed`);
	}
}

export async function fetchCatalog(
	nodeUrl: string,
	token: string | null
): Promise<CatalogItem[]> {
	const resp = await fetch(`${nodeUrl}/api/catalog`, {
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		throw new Error(`catalog fetch failed: ${resp.status}`);
	}
	const json = await resp.json();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return json.sidecars.map(
		(s: any): CatalogItem => ({
			name: s.name,
			displayName: s.display_name,
			description: s.description,
			category: s.category,
			deprecated: s.deprecated,
			recommended: s.recommended,
			latestVersion: s.latest_version ?? null,
			installedVersion: s.installed_version ?? null,
			installState: s.install_state,
			platforms: s.platforms ?? [],
			// Default to supported when an older Core omits the field, so existing
			// engines are never spuriously disabled by a version skew.
			supported: s.supported ?? true,
		})
	);
}

export async function fetchSidecarStatus(
	nodeUrl: string,
	token: string | null
): Promise<Record<string, boolean>> {
	const resp = await fetch(`${nodeUrl}/api/sidecar/status`, {
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		throw new Error(`sidecar status failed: ${resp.status}`);
	}
	const json = await resp.json();
	// Returns { sidecars: [{ name, running }] } — normalize to a map
	const map: Record<string, boolean> = {};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for (const s of json.sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}

export async function fetchDependencies(
	nodeUrl: string,
	token: string | null
): Promise<DependencyStatus[]> {
	const resp = await fetch(`${nodeUrl}/api/dependencies/check`, {
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		throw new Error(`deps check failed: ${resp.status}`);
	}
	const json = await resp.json();
	// Backend returns { dependencies: { git: bool, rust: bool, ... }, all_installed: bool }
	const deps = json.dependencies as Record<string, boolean> | undefined;
	if (!deps) {
		return [];
	}
	return Object.entries(deps).map(([name, installed]) => ({ name, installed }));
}

export async function installSidecar(
	nodeUrl: string,
	token: string | null,
	name: string
): Promise<void> {
	await postAction(nodeUrl, token, `/api/setup/${name}/install`, "install");
}

export async function uninstallSidecar(
	nodeUrl: string,
	token: string | null,
	name: string
): Promise<void> {
	await postAction(nodeUrl, token, `/api/setup/${name}/uninstall`, "uninstall");
}

export async function startSidecar(
	nodeUrl: string,
	token: string | null,
	name: string
): Promise<void> {
	await postAction(nodeUrl, token, `/api/sidecar/${name}/start`, "start");
}

export async function stopSidecar(
	nodeUrl: string,
	token: string | null,
	name: string
): Promise<void> {
	await postAction(nodeUrl, token, `/api/sidecar/${name}/stop`, "stop");
}

export async function restartSidecar(
	nodeUrl: string,
	token: string | null,
	name: string
): Promise<void> {
	await postAction(nodeUrl, token, `/api/sidecar/${name}/restart`, "restart");
}

export async function startAll(
	nodeUrl: string,
	token: string | null
): Promise<void> {
	await postAction(nodeUrl, token, "/api/sidecar/start-all", "start all");
}

export async function stopAll(
	nodeUrl: string,
	token: string | null
): Promise<void> {
	await postAction(nodeUrl, token, "/api/sidecar/stop-all", "stop all");
}

// ── Sandbox backend (M6 / issues #190, #191) ─────────────────────────────────

export interface DockerAvailability {
	available: boolean;
	/** Human-readable reason when unavailable (daemon absent, timed out, etc.) */
	reason: string | null;
}

export interface SandboxStatus {
	/** Whether the wasmtime backend is compiled in and enabled. */
	available: boolean;
	/** Docker daemon detection result (M6 / #191). Present on Core builds >= #191. */
	docker: DockerAvailability;
	enabled: boolean;
}

export async function fetchSandboxStatus(
	nodeUrl: string,
	token: string | null
): Promise<SandboxStatus> {
	const resp = await fetch(`${nodeUrl}/api/mcp/sandbox/status`, {
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		// Core may not yet expose this endpoint (older build) — degrade gracefully.
		return {
			enabled: false,
			available: false,
			docker: { available: false, reason: null },
		};
	}
	const json = await resp.json();
	const dockerRaw = json.docker ?? {};
	return {
		enabled: Boolean(json.enabled),
		available: Boolean(json.available),
		docker: {
			available: Boolean(dockerRaw.available),
			reason: dockerRaw.reason ?? null,
		},
	};
}

export async function enableSandbox(
	nodeUrl: string,
	token: string | null
): Promise<void> {
	const resp = await fetch(`${nodeUrl}/api/mcp/sandbox/enable`, {
		method: "POST",
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		throw new Error(`sandbox enable failed: ${resp.status}`);
	}
}

export async function disableSandbox(
	nodeUrl: string,
	token: string | null
): Promise<void> {
	const resp = await fetch(`${nodeUrl}/api/mcp/sandbox/disable`, {
		method: "POST",
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		throw new Error(`sandbox disable failed: ${resp.status}`);
	}
}

export async function installMissingDeps(
	nodeUrl: string,
	token: string | null
): Promise<Record<string, "installed" | "already_installed" | "failed">> {
	const resp = await fetch(`${nodeUrl}/api/dependencies/install`, {
		method: "POST",
		headers: makeHeaders(token),
	});
	if (!resp.ok) {
		throw new Error(`deps install failed: ${resp.status}`);
	}
	const json = await resp.json();
	return (json.results ?? {}) as Record<
		string,
		"installed" | "already_installed" | "failed"
	>;
}
