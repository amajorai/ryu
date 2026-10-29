import { agentsResponseSchema } from "@ryuhq/core-client/agents.ts";
import {
	type CatalogItem as NativeCatalogItem,
	nativeCatalogResponseSchema,
} from "@ryuhq/core-client/catalog.ts";
import {
	type DependencyInstallResults,
	dependenciesCheckResponseSchema,
	dependenciesInstallResponseSchema,
	sandboxStatusResponseSchema,
	setupInstallResponseSchema,
	setupUninstallResponseSchema,
	sidecarActionResponseSchema,
} from "@ryuhq/core-client/services-wire.ts";
import { sidecarStatusResponseSchema } from "@ryuhq/core-client/system.ts";

// apps/desktop/src/lib/services-api.ts

export interface CatalogItem {
	category: NativeCatalogItem["category"];
	deprecated: boolean;
	description: string;
	displayName: string;
	installedVersion: string | null;
	installState: NativeCatalogItem["install_state"];
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
	/**
	 * Core's plain-language reason this node can't run the entry (it knows the
	 * node's OS + arch + placed binaries); null when supported or when an older
	 * Core omits it, in which case the UI falls back to a `platforms` message.
	 */
	unsupportedReason: string | null;
	/**
	 * Whether reinstalling would actually deliver a newer build — decided by the
	 * NODE, never re-derived here. `installedVersion !== latestVersion` is not a
	 * safe client-side substitute: a pinned downloader cannot reach upstream's
	 * newest tag, and some installers record a sentinel ("latest", "adopted")
	 * instead of a version. Both cases rendered an Update button that did nothing.
	 */
	updateAvailable: boolean;
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
	token: string | null,
	userJwt: string | null = null
): Promise<ExternalAgent[]> {
	const headers = makeHeaders(token, userJwt);
	const resp = await fetch(`${nodeUrl}/api/agents`, { headers });
	if (!resp.ok) {
		throw new Error(`agents fetch failed: ${resp.status}`);
	}
	const json = agentsResponseSchema.parse(await resp.json());
	return (json.agents ?? []).map(
		(a): ExternalAgent => ({
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

function makeHeaders(
	token: string | null,
	userJwt: string | null = null
): HeadersInit {
	const headers: HeadersInit = { "Content-Type": "application/json" };
	const admissionBearer = token ?? userJwt;
	if (admissionBearer) {
		headers.Authorization = `Bearer ${admissionBearer}`;
	}
	if (userJwt) {
		headers["x-ryu-user-jwt"] = userJwt;
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
	label: string,
	responseSchema:
		| typeof sidecarActionResponseSchema
		| typeof setupInstallResponseSchema
		| typeof setupUninstallResponseSchema,
	signal?: AbortSignal,
	userJwt: string | null = null
): Promise<void> {
	const resp = await fetch(`${nodeUrl}${path}`, {
		method: "POST",
		headers: makeHeaders(token, userJwt),
		signal,
	});
	let rawBody: Awaited<ReturnType<Response["json"]>>;
	try {
		rawBody = await resp.json();
	} catch {
		rawBody = null;
	}
	const body = rawBody === null ? null : responseSchema.parse(rawBody);
	if (!resp.ok) {
		throw new Error(body?.error ?? `${label} failed: ${resp.status}`);
	}
	if (body?.success === false) {
		throw new Error(body.error ?? `${label} failed`);
	}
}

/**
 * The engine/app catalog. `signal` is optional and exists for callers that poll
 * this in a loop with a wall-clock budget — onboarding's local-stack wait, above
 * all. `fetch` has no default timeout, so a Core that accepts the connection and
 * never answers used to hang the await forever, and a `while (Date.now() < ...)`
 * deadline around it never got another turn to fire.
 */
export async function fetchCatalog(
	nodeUrl: string,
	token: string | null,
	signal?: AbortSignal,
	userJwt: string | null = null
): Promise<CatalogItem[]> {
	const resp = await fetch(`${nodeUrl}/api/catalog`, {
		headers: makeHeaders(token, userJwt),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`catalog fetch failed: ${resp.status}`);
	}
	const json = nativeCatalogResponseSchema.parse(await resp.json());
	const sidecars = json.sidecars;
	if (!sidecars) {
		throw new Error("catalog response missing sidecars");
	}
	return sidecars.map(
		(s): CatalogItem => ({
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
			// Default to supported ONLY when an older Core omits the field, so
			// existing engines are never spuriously disabled by a version skew. A
			// current Core always sends it and gates OS/arch-specific engines itself
			// (and refuses to start an unsupported one), so this default never
			// re-enables an engine that Core reports as unsupported.
			supported: s.supported ?? true,
			unsupportedReason: s.unsupported_reason ?? null,
			// Absent on an older Core: fall back to the version comparison it
			// expected clients to make. Newer Cores answer authoritatively.
			updateAvailable:
				s.update_available ??
				(s.install_state === "installed" &&
					!s.deprecated &&
					s.installed_version != null &&
					s.latest_version != null &&
					s.installed_version !== s.latest_version),
		})
	);
}

export async function fetchSidecarStatus(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<Record<string, boolean>> {
	const resp = await fetch(`${nodeUrl}/api/sidecar/status`, {
		headers: makeHeaders(token, userJwt),
	});
	if (!resp.ok) {
		throw new Error(`sidecar status failed: ${resp.status}`);
	}
	const json = sidecarStatusResponseSchema.parse(await resp.json());
	// Returns { sidecars: [{ name, running }] } — normalize to a map
	const map: Record<string, boolean> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}

export async function fetchDependencies(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<DependencyStatus[]> {
	const resp = await fetch(`${nodeUrl}/api/dependencies/check`, {
		headers: makeHeaders(token, userJwt),
	});
	if (!resp.ok) {
		throw new Error(`deps check failed: ${resp.status}`);
	}
	const json = dependenciesCheckResponseSchema.parse(await resp.json());
	// Backend returns complete dependency probes or its failure envelope.
	const deps = json.dependencies;
	if (!deps) {
		return [];
	}
	return Object.entries(deps).map(([name, installed]) => ({ name, installed }));
}

/**
 * Install a sidecar. Idempotent by default — Core's installers open with an
 * already-installed fast path, which is what makes the auto-install-on-first-use
 * route safe to call repeatedly.
 *
 * Pass `force` to APPLY AN UPDATE: it tells Core to drop the entry's recorded
 * version/checksum first, so the fast path misses and the artifact is genuinely
 * re-downloaded. Without it an update press is indistinguishable from an install
 * and silently does nothing.
 */
export async function installSidecar(
	nodeUrl: string,
	token: string | null,
	name: string,
	force = false,
	signal?: AbortSignal,
	userJwt: string | null = null
): Promise<void> {
	const query = force ? "?force=true" : "";
	await postAction(
		nodeUrl,
		token,
		`/api/setup/${name}/install${query}`,
		force ? "update" : "install",
		setupInstallResponseSchema,
		signal,
		userJwt
	);
}

export async function uninstallSidecar(
	nodeUrl: string,
	token: string | null,
	name: string,
	userJwt: string | null = null
): Promise<void> {
	await postAction(
		nodeUrl,
		token,
		`/api/setup/${name}/uninstall`,
		"uninstall",
		setupUninstallResponseSchema,
		undefined,
		userJwt
	);
}

export async function startSidecar(
	nodeUrl: string,
	token: string | null,
	name: string,
	userJwt: string | null = null
): Promise<void> {
	await postAction(
		nodeUrl,
		token,
		`/api/sidecar/${name}/start`,
		"start",
		sidecarActionResponseSchema,
		undefined,
		userJwt
	);
}

export async function stopSidecar(
	nodeUrl: string,
	token: string | null,
	name: string,
	userJwt: string | null = null
): Promise<void> {
	await postAction(
		nodeUrl,
		token,
		`/api/sidecar/${name}/stop`,
		"stop",
		sidecarActionResponseSchema,
		undefined,
		userJwt
	);
}

export async function restartSidecar(
	nodeUrl: string,
	token: string | null,
	name: string,
	userJwt: string | null = null
): Promise<void> {
	await postAction(
		nodeUrl,
		token,
		`/api/sidecar/${name}/restart`,
		"restart",
		sidecarActionResponseSchema,
		undefined,
		userJwt
	);
}

export async function startAll(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<void> {
	await postAction(
		nodeUrl,
		token,
		"/api/sidecar/start-all",
		"start all",
		sidecarActionResponseSchema,
		undefined,
		userJwt
	);
}

export async function stopAll(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<void> {
	await postAction(
		nodeUrl,
		token,
		"/api/sidecar/stop-all",
		"stop all",
		sidecarActionResponseSchema,
		undefined,
		userJwt
	);
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
	token: string | null,
	userJwt: string | null = null
): Promise<SandboxStatus> {
	const resp = await fetch(`${nodeUrl}/api/mcp/sandbox/status`, {
		headers: makeHeaders(token, userJwt),
	});
	if (!resp.ok) {
		// Core may not yet expose this endpoint (older build) — degrade gracefully.
		return {
			enabled: false,
			available: false,
			docker: { available: false, reason: null },
		};
	}
	const json = sandboxStatusResponseSchema.parse(await resp.json());
	const dockerRaw = json.docker;
	return {
		enabled: Boolean(json.enabled),
		available: Boolean(json.available),
		docker: {
			available: Boolean(dockerRaw?.available),
			reason: dockerRaw?.reason ?? null,
		},
	};
}

export async function enableSandbox(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<void> {
	const resp = await fetch(`${nodeUrl}/api/mcp/sandbox/enable`, {
		method: "POST",
		headers: makeHeaders(token, userJwt),
	});
	if (!resp.ok) {
		throw new Error(`sandbox enable failed: ${resp.status}`);
	}
}

export async function disableSandbox(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<void> {
	const resp = await fetch(`${nodeUrl}/api/mcp/sandbox/disable`, {
		method: "POST",
		headers: makeHeaders(token, userJwt),
	});
	if (!resp.ok) {
		throw new Error(`sandbox disable failed: ${resp.status}`);
	}
}

export async function installMissingDeps(
	nodeUrl: string,
	token: string | null,
	userJwt: string | null = null
): Promise<DependencyInstallResults> {
	const resp = await fetch(`${nodeUrl}/api/dependencies/install`, {
		method: "POST",
		headers: makeHeaders(token, userJwt),
	});
	if (!resp.ok) {
		throw new Error(`deps install failed: ${resp.status}`);
	}
	const json = dependenciesInstallResponseSchema.parse(await resp.json());
	return json.results;
}
