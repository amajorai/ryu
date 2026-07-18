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

/** One plugin-to-plugin dependency edge. Mirrors Core's `AppDependency`
 *  (`apps/core/src/plugin_manifest/mod.rs`). `min_version` is snake_case on the
 *  wire (Core declares no serde rename) and is a MINIMUM: `"1.2.0"` = `">=1.2.0"`. */
interface AppDependencyWire {
	id: string;
	min_version?: string | null;
}

/** The `requires` block. Mirrors Core's `Requires`. Absent = no dependencies. */
interface RequiresWire {
	apps?: AppDependencyWire[];
	grants?: string[];
}

/** One `surfaces.cli.commands[]` entry. Mirrors Core's `CliCommandSpec`
 *  (`crates/ryu-kernel-contracts/src/manifest.rs`). `method`/`summary` are
 *  `Option` in Rust (`skip_serializing_if`) so they may be absent/null. */
interface CliCommandWire {
	method?: string | null;
	name: string;
	path: string;
	summary?: string | null;
}

/** One `surfaces` map entry. Mirrors Core's `SurfaceEntry`. Only `commands` is
 *  consumed client-side today (the TUI `ryu <app> <cmd>` dispatcher); `support`
 *  and `ui` are carried opaquely for forward-compat. */
interface SurfaceEntryWire {
	commands?: CliCommandWire[];
	support?: string;
	ui?: unknown;
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
	/** Plugin-to-plugin dependencies. Absent (`skip_serializing_if`) = none. */
	requires?: RequiresWire | null;
	runnables: RunnableEntryWire[];
	sidecar_name: string | null;
	/** Per-surface support + UI + contributed commands. Absent = legacy `targets`
	 *  semantics; the `cli` entry's `commands` feed the TUI dispatcher. */
	surfaces?: Record<string, SurfaceEntryWire> | null;
	/** Host surfaces the plugin runs on. Absent/empty = EVERY surface. */
	targets?: Surface[];
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

/** The eight host surfaces a plugin may target. These are Core's `Surface` enum
 *  tokens verbatim (`#[serde(rename_all = "kebab-case")]`) — also the vocabulary
 *  of the `x-ryu-surface` request header Core filters `GET /api/plugins` on. */
export type Surface =
	| "gateway"
	| "core"
	| "desktop"
	| "island"
	| "mobile"
	| "extension"
	| "web"
	| "cli";

/** One plugin-to-plugin dependency, client-side view. `minVersion` is a MINIMUM
 *  (a bare `"1.2.0"` means `">=1.2.0"`), null when the plugin pinned no floor. */
export interface AppDependency {
	id: string;
	minVersion: string | null;
}

/** A plugin's declared dependencies, client-side view. */
export interface AppRequires {
	/** Plugins that must be enabled first (Core auto-enables them in order). */
	apps: AppDependency[];
	/** Grants implied by those dependencies (declaration only). */
	grants: string[];
}

/** One terminal subcommand an app contributes to the `cli` surface (the TUI's
 *  `ryu <app> <cmd>` dispatcher), client-side view. `method` is normalized to an
 *  uppercase verb (default `"POST"`); `summary` is `null` when the app omitted it.
 *  The dispatcher routes the call to `<method> /api/ext/<appId><path>`. */
export interface AppCommand {
	method: string;
	name: string;
	path: string;
	summary: string | null;
}

export interface AppInfo {
	builtIn: boolean;
	/** Terminal subcommands this app contributes to the `cli` surface (TUI).
	 *  Empty = none. Sourced from the manifest's `surfaces.cli.commands`. */
	commands: AppCommand[];
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
	/** Declared dependencies. `null` = none (the common case). */
	requires: AppRequires | null;
	runnables: RunnableEntry[];
	sidecarName: string | null;
	/** Host surfaces this plugin runs on. **Empty = every surface**, never "none". */
	targets: Surface[];
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

/** A typed dependency-graph failure, mirrored from Core's `DependencyError`
 *  (`apps/core/src/plugins/graph.rs`). Serde-tagged on `code` (snake_case), so a
 *  UI renders "Disable Meetings, Whiteboard first" from the ids — never by
 *  string-parsing a prose message. Returned as `dependency_error` in the 409 body
 *  of `POST /api/plugins/:id/{enable,disable}`. */
export type DependencyError =
	| { code: "not_installed"; plugin: string }
	| { code: "self_dependency"; plugin: string }
	| {
			code: "missing_dependency";
			plugin: string;
			dependency: string;
			required: string | null;
	  }
	| {
			code: "version_mismatch";
			plugin: string;
			dependency: string;
			required: string;
			installed: string;
	  }
	| {
			code: "invalid_version_req";
			plugin: string;
			dependency: string;
			requirement: string;
			reason: string;
	  }
	| { code: "cycle"; cycle: string[] }
	| { code: "blocked_by_dependents"; plugin: string; dependents: string[] };

/** Structured error from enable/disable — used to surface Gateway denial,
 *  unreachability, or an unsatisfiable dependency graph via the UI without
 *  leaking raw status codes. */
export interface AppLifecycleError {
	/** True when Core refused because the target is a compiled-in built-in /
	 *  default-on plugin that can only be DISABLED, not uninstalled (409 with
	 *  `code:"built_in"`). The UI branches on this to offer "Disable instead". */
	builtIn: boolean;
	/** The typed dependency failure (HTTP 409), or `null` for other failures. */
	dependencyError: DependencyError | null;
	/** True when the Gateway was unreachable (fail-closed). */
	gatewayUnreachable: boolean;
	/** True when the Gateway denied one or more grants. */
	grantsDenied: boolean;
	/** Core's actionable `hint`, when present (e.g. "disable it instead",
	 *  "pass force=true to override"), else `null`. */
	hint: string | null;
	/** Human-readable reason suitable for display in a UI primitive. */
	message: string;
}

/** Render a {@link DependencyError} as an ACTIONABLE sentence.
 *
 *  `displayName` maps a plugin id to its human name when the caller has the app
 *  list in scope (`(id) => id` is a fine default). The blocked-disable case is the
 *  one a user hits most: Core refuses by default rather than silently cascading, so
 *  the message must name exactly which plugins to disable first. */
export function describeDependencyError(
	err: DependencyError,
	displayName: (id: string) => string = (id) => id
): string {
	switch (err.code) {
		case "blocked_by_dependents": {
			const names = err.dependents.map(displayName).join(", ");
			return `${displayName(err.plugin)} is needed by ${names}. Disable ${names} first.`;
		}
		case "missing_dependency": {
			const version = err.required ? ` (${err.required} or newer)` : "";
			return `${displayName(err.plugin)} needs ${displayName(err.dependency)}${version}. Install it first.`;
		}
		case "version_mismatch":
			return `${displayName(err.plugin)} needs ${displayName(err.dependency)} ${err.required} or newer, but ${err.installed} is installed. Update it first.`;
		case "invalid_version_req":
			return `${displayName(err.plugin)} declares an invalid version requirement for ${displayName(err.dependency)} ("${err.requirement}"): ${err.reason}.`;
		case "cycle":
			return `Circular dependency: ${err.cycle.map(displayName).join(" → ")}.`;
		case "self_dependency":
			return `${displayName(err.plugin)} declares itself as a dependency.`;
		case "not_installed":
			return `${displayName(err.plugin)} is not installed.`;
		default:
			// A `code` this client does not know yet (Core added a variant). Never
			// crash — fall back to a generic sentence.
			return "This change conflicts with the current plugin dependencies.";
	}
}

/** Narrow an unknown JSON value to a {@link DependencyError}. Anything without a
 *  string `code` is not one. */
function toDependencyError(value: unknown): DependencyError | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" ? (value as DependencyError) : null;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

/** Whether a contributed CLI command `path` is a safe `ext_proxy` sub-path.
 *
 *  A command path is concatenated onto `/api/ext/<appId>` and fetched, and a WHATWG
 *  URL parser resolves `..` segments — including their percent-encoded (`%2e`) and
 *  backslash-separated forms (`\` is a path separator for http URLs) — BEFORE the
 *  request is sent. A traversal path therefore escapes the plugin's proxy scope and
 *  hits an arbitrary internal Core/Gateway route with the full node bearer. Core's
 *  manifest loader rejects such paths at load ({@link validateCliCommandPath} in
 *  `crates/ryu-kernel-contracts`); this mirrors that check client-side so a rogue
 *  manifest that slipped past (or a compromised transport) is still never routed.
 *
 *  Accepts only an absolute, single-origin sub-path: leading `/`, no backslash, no
 *  literal or percent-encoded `..`, and no percent-encoded path separators. */
export function isSafeCommandPath(path: string): boolean {
	if (!path.startsWith("/")) {
		return false;
	}
	if (path.includes("\\")) {
		return false;
	}
	const lower = path.toLowerCase();
	if (path.includes("..") || lower.includes("%2e")) {
		return false;
	}
	if (lower.includes("%2f") || lower.includes("%5c")) {
		return false;
	}
	return true;
}

/** Parse the manifest's `surfaces.cli.commands` into the client-side
 *  {@link AppCommand}[]. Defensive: an entry missing `name`/`path` is skipped
 *  (never a partial command the dispatcher can't route); an entry whose `path`
 *  fails {@link isSafeCommandPath} (a path-traversal / SSRF attempt) is dropped so
 *  it can never be dispatched; `method` is uppercased with a `POST` default;
 *  `summary` normalizes to `null`. */
function toAppCommands(surfaces: AppManifestWire["surfaces"]): AppCommand[] {
	const raw = surfaces?.cli?.commands ?? [];
	const commands: AppCommand[] = [];
	for (const c of raw) {
		if (typeof c?.name !== "string" || typeof c?.path !== "string") {
			continue;
		}
		if (!isSafeCommandPath(c.path)) {
			continue;
		}
		commands.push({
			name: c.name,
			path: c.path,
			method: (c.method ?? "POST").toUpperCase(),
			summary: c.summary ?? null,
		});
	}
	return commands;
}

function toAppInfo(w: AppManifestWire): AppInfo {
	return {
		builtIn: w.built_in ?? false,
		commands: toAppCommands(w.surfaces),
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
		requires: w.requires
			? {
					apps: (w.requires.apps ?? []).map((d) => ({
						id: d.id,
						minVersion: d.min_version ?? null,
					})),
					grants: w.requires.grants ?? [],
				}
			: null,
		runnables: w.runnables.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			config: r.config ?? null,
		})),
		sidecarName: w.sidecar_name ?? null,
		// Absent/empty targets = every surface. Never invent a default surface here:
		// treating "" as "none" would hide every plugin that predates the field.
		targets: w.targets ?? [],
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
			: typeof body.error === "string"
				? body.error
				: `${path} failed: ${status}`;

	const grantsDenied = status === 403;
	const gatewayUnreachable = status === 503;
	// 409 = the dependency graph refused (an enabled dependent blocks a
	// disable/uninstall, a dependency is missing/too old, or the graph cycles).
	// Core nothing-flipped, and the typed payload names the ids involved.
	const dependencyError =
		status === 409 ? toDependencyError(body.dependency_error) : null;
	// 409 `code:"built_in"` = uninstall refused because the target is compiled into
	// the binary (only disable is possible). Distinct from the dependency refusal.
	const builtIn = status === 409 && body.code === "built_in";
	const hint = typeof body.hint === "string" ? body.hint : null;

	let message = rawMessage;
	if (dependencyError) {
		message = describeDependencyError(dependencyError);
	} else if (grantsDenied) {
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

	return {
		message,
		grantsDenied,
		gatewayUnreachable,
		dependencyError,
		builtIn,
		hint,
	};
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
 *  Any plugin listed in the manifest's `requires.apps` is auto-enabled first (in
 *  dependency order). Fails closed when the Gateway is unreachable (never silently
 *  falls back) and with a 409 {@link DependencyError} when the graph is
 *  unsatisfiable — nothing is enabled in that case. */
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

/** `POST /api/plugins/:id/disable` — disable app and clear approved grants.
 *
 *  REFUSED with 409 + a `blocked_by_dependents` {@link DependencyError} when other
 *  ENABLED plugins depend on this one; the error names them so the caller can say
 *  "Disable Meetings, Whiteboard first". Pass `{ cascade: true }` to opt into
 *  disabling the whole dependent chain (reverse-topological order) instead. */
export async function disableApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean }
): Promise<AppRecord> {
	const path = options?.cascade
		? `/api/plugins/${id}/disable?cascade=true`
		: `/api/plugins/${id}/disable`;
	const resp = await fetch(apiUrl(target, path), {
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

/** The result of a successful `POST /api/plugins/:id/uninstall`. Mirrors Core's
 *  handler body: `{ success, removed, disabled, externally_managed?, notice? }`. */
export interface AppUninstallResult {
	/** Plugins DISABLED as part of the uninstall: the target itself plus, under
	 *  `{ cascade: true }`, its dependents. Cascaded dependents stay
	 *  installed-but-disabled; only the target's lifecycle record is removed. */
	disabled: string[];
	/** Present only when a gateway-enforced policy plugin was toggled against a
	 *  remote/unmanaged gateway: `true` means the change did NOT reach the running
	 *  gateway (a manual restart is required — see {@link notice}). */
	externallyManaged?: boolean;
	/** The restart-the-gateway notice, present only alongside
	 *  `externallyManaged: true`. Show it rather than implying full success. */
	notice?: string;
	/** Id of the plugin whose lifecycle record was removed (the uninstall target). */
	removed: string;
	/** Always `true` on the 2xx path. */
	success: boolean;
}

/** `POST /api/plugins/:id/uninstall` — disable the plugin (and, with
 *  `{ cascade: true }`, its enabled dependents), tear down its runtime
 *  contributions, then remove its lifecycle record.
 *
 *  REFUSED with 409 when other ENABLED plugins depend on this one (a
 *  `blocked_by_dependents` {@link DependencyError}, `dependencyError` set — retry
 *  with `{ cascade: true }`) or when the target is a compiled-in built-in /
 *  default-on plugin (`builtIn: true` on the thrown {@link AppLifecycleError} —
 *  only disable is possible). Both are thrown as a typed, discriminable error. */
export async function uninstallApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean }
): Promise<AppUninstallResult> {
	const path = options?.cascade
		? `/api/plugins/${id}/uninstall?cascade=true`
		: `/api/plugins/${id}/uninstall`;
	const resp = await fetch(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/uninstall`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as {
		disabled?: string[];
		externally_managed?: boolean;
		notice?: string;
		removed?: string;
		success?: boolean;
	};
	const result: AppUninstallResult = {
		success: json.success ?? true,
		removed: json.removed ?? id,
		disabled: json.disabled ?? [],
	};
	if (json.externally_managed !== undefined) {
		result.externallyManaged = json.externally_managed;
	}
	if (json.notice !== undefined) {
		result.notice = json.notice;
	}
	return result;
}

/** `POST /api/plugins/:id/update` — update the installed plugin to the manifest
 *  version and return the refreshed lifecycle record.
 *
 *  A DOWNGRADE (the manifest version is older than what is installed) is refused
 *  with 409 unless `{ force: true }` is passed; the thrown
 *  {@link AppLifecycleError} carries Core's `hint` ("pass force=true to override"). */
export async function updateApp(
	target: ApiTarget,
	id: string,
	options?: { force?: boolean }
): Promise<AppRecord> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/update`), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify({ force: options?.force ?? false }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/update`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { app: AppRecordWire };
	return toAppRecord(json.app);
}

// ── App-disabled (503) detection for gated feature endpoints ──────────────────

/** A parsed `503 { error:"app_disabled", app, message }` body. Feature endpoints
 *  whose owning plugin is disabled (`/api/meetings/*`, `/api/spaces/*`, …) return
 *  this so a client can offer a one-click ENABLE instead of surfacing a raw 503. */
export interface AppDisabledError {
	/** The plugin id to enable (e.g. `"meetings"`, `"spaces"`). */
	app: string;
	/** Core's human-readable prompt (e.g. "Enable the Meetings app"). */
	message: string;
}

/** Detect the `503 app_disabled` contract on a failed response and read the
 *  owning plugin id. Returns `null` for any other failure (including a 503 that is
 *  NOT `app_disabled`). Clones the response first, so the caller can still read the
 *  original body when this returns `null`. One definition for native AND tui. */
export async function parseAppDisabled(
	resp: Response
): Promise<AppDisabledError | null> {
	if (resp.status !== 503) {
		return null;
	}
	try {
		const text = await resp.clone().text();
		if (!text) {
			return null;
		}
		const body = JSON.parse(text) as {
			app?: unknown;
			error?: unknown;
			message?: unknown;
		};
		if (body.error === "app_disabled" && typeof body.app === "string") {
			return {
				app: body.app,
				message:
					typeof body.message === "string"
						? body.message
						: `Enable the ${body.app} app`,
			};
		}
	} catch {
		// Not JSON, or body already consumed — treat as "not the app_disabled case".
	}
	return null;
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
