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

import type {
	SidebarSectionSpec,
	ViewContribution,
} from "@ryu/app-host/views";
import {
	type ApiTarget,
	apiUrl,
	identityHeaders,
	makeHeaders,
	request,
} from "./client.ts";

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

/** An {@link AppRecord} plus the "the change did not reach the gateway" truth Core
 *  attaches when a gateway-policy plugin is toggled against a remote/unmanaged
 *  gateway. `externallyManaged` true means the record flipped but the running
 *  gateway was NOT reconfigured — surface `notice` rather than implying success. */
export interface AppToggleResult extends AppRecord {
	externallyManaged?: boolean;
	notice?: string;
}

/** Result of `POST /api/plugins/:id/uninstall`. The success body carries NO `app`
 *  record (unlike enable/disable) — it reports the removed id, any plugins disabled
 *  as part of the uninstall (the target, plus its dependents under `?cascade=true`),
 *  and the same `externallyManaged`/`notice` gateway truth. */
export interface AppUninstallResult {
	disabled: string[];
	externallyManaged?: boolean;
	notice?: string;
	removed: string;
	success: boolean;
}

// ── Error shape returned by lifecycle endpoints ───────────────────────────────

/** A typed dependency-graph failure, mirrored from Core's `DependencyError`
 *  (`apps/core/src/plugins/graph.rs`). Serde-tagged on `code` (snake_case), so the
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
	/** The typed dependency failure (HTTP 409), or `null` for other failures. */
	dependencyError: DependencyError | null;
	/** True when the Gateway was unreachable (fail-closed). */
	gatewayUnreachable: boolean;
	/** True when the Gateway denied one or more grants. */
	grantsDenied: boolean;
	/** Human-readable reason suitable for display in a UI primitive. */
	message: string;
}

/** Render a {@link DependencyError} as an ACTIONABLE sentence.
 *
 *  `displayName` maps a plugin id to its human name when the caller has the app
 *  list in scope (`useApps` passes one; the id is the fallback). The blocked-disable
 *  case is the one a user hits most: Core refuses by default rather than silently
 *  cascading, so the message must name exactly which plugins to disable first. */
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
	// 409 = the dependency graph refused (an enabled dependent blocks a disable, a
	// dependency is missing/too old, or the graph cycles). Core flipped nothing, and
	// the typed payload names the ids involved.
	const dependencyError =
		status === 409 ? toDependencyError(body.dependency_error) : null;

	let message = rawMessage;
	if (dependencyError) {
		// Id-only sentence here; `useApps` re-renders it with display NAMES once the
		// app list is in scope ("Disable Meetings, Whiteboard first").
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

	return { message, grantsDenied, gatewayUnreachable, dependencyError };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** `GET /api/plugins` — list all app manifests merged with their lifecycle state.
 *  Sends `identityHeaders()` (which carries `X-Ryu-Surface: desktop`) so Core
 *  filters the list to plugins that target this surface — the direct-fetch path
 *  otherwise omits it, leaving `targets` inert. */
export async function fetchApps(target: ApiTarget): Promise<AppInfo[]> {
	const resp = await fetch(apiUrl(target, "/api/plugins"), {
		method: "GET",
		headers: { ...makeHeaders(target.token), ...identityHeaders() },
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins failed: ${resp.status}`);
	}
	const json = (await resp.json()) as { apps?: AppManifestWire[] };
	return (json.apps ?? []).map(toAppInfo);
}

/**
 * Declarative UI contributions of every enabled plugin (composer controls,
 * settings tabs, slash commands) + its turn hooks. Each entry is tagged with its
 * owning `plugin` id. Lets the desktop render plugin-contributed widgets (e.g. the
 * double-check composer toggle) without hardcoding them. Opaque records — the
 * renderer interprets the widget `type`.
 */
export interface PluginContributions {
	/** Messaging-channel adapters an enabled plugin makes available. */
	channels: PluginChannel[];
	/** Companion surfaces (overlay/sidebar panels) an enabled plugin declares. */
	companions: PluginCompanion[];
	composer_controls: PluginComposerControl[];
	settings_tabs: Record<string, unknown>[];
	slash_commands: Record<string, unknown>[];
	turn_hooks: Record<string, unknown>[];
	/** Declarative views (the Raycast tier) contributed by enabled plugins. Each is a
	 *  {@link ViewContribution} the desktop/island renderer maps to native components,
	 *  tagged server-side with its owning `plugin` id. */
	views: PluginView[];
	/** App-registered sidebar sections (header + live list), tagged with `plugin`. */
	sidebar_sections: PluginSidebarSection[];
	/** App-registered sidebar buttons (single nav rows), tagged with `plugin`. */
	sidebar_buttons: PluginSidebarButton[];
}

/** An app-registered sidebar SECTION as served by Core (`contributes.sidebar_sections[]`),
 *  tagged with its owning `plugin`. The `spec` is the shared {@link SidebarSectionSpec}. */
export interface PluginSidebarSection {
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: SidebarSectionSpec;
	title: string;
}

/** An app-registered sidebar BUTTON as served by Core (`contributes.sidebar_buttons[]`),
 *  tagged with its owning `plugin`. A single nav row that opens `target`. */
export interface PluginSidebarButton {
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	/** Client route the button opens (e.g. "/library/memory"). */
	target: string;
	title: string;
}

/** A declarative-view contribution as served by Core (`contributes.views[]`), tagged
 *  with its owning `plugin`. Shape-identical to the shared `@ryu/app-host/views`
 *  {@link ViewContribution} — re-exported here so contributions consumers need only
 *  the plugins API. */
export type PluginView = ViewContribution;

/** A composer "+"-menu control an enabled plugin contributes
 *  (`contributes.composer_controls`, tagged server-side with its owning `plugin`).
 *  Today only `type: "toggle"` is rendered: flipping it sets `flag` in the
 *  per-request `plugin_flags` map the plugin turn-hook runtime reads. */
export interface PluginComposerControl {
	description?: string;
	flag: string;
	id: string;
	label: string;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	type: string;
}

/** A messaging-channel adapter contributed by an enabled plugin
 *  (`RunnableKind::Channel`). Mirrors Core's `AppChannel`. */
export interface PluginChannel {
	id: string;
	name: string;
	platform: string;
}

/** A companion-surface descriptor contributed by an enabled plugin
 *  (`RunnableKind::Companion`). Mirrors Core's `AppCompanion`. `icon`/`shortcut`
 *  are omitted by serde when null, so they are optional here.
 *
 *  `approvedGrants` is the GATEWAY-VALIDATED grant subset for the owning plugin
 *  (from `enable_app`), the ONLY correct source for building the host capability
 *  set (never the manifest's `permissionGrants` CLAIM). `hasUi` is true when the
 *  plugin carries a bundled UI (a `ui-bundle` is fetchable) — the third-party
 *  code-execution path only engages when this is true AND the experimental flag
 *  is on. */
/** A per-app CSP allowlist (the OpenAI-Apps-SDK `_meta.ui.csp` model). Declared in
 *  the companion manifest; the Path-B host widens the frame CSP for exactly these
 *  hosts. Only trusted/built-in manifests should carry it. */
export interface PluginCompanionCsp {
	/** Hosts added to `connect-src` (the frame may fetch these directly). */
	connectDomains: string[];
	/** Hosts added to `img-src`/`media-src` (remote asset loads). */
	resourceDomains: string[];
}

export interface PluginCompanion {
	approvedGrants: string[];
	/** Per-app CSP allowlist from the manifest (undefined = the default locked CSP). */
	csp?: PluginCompanionCsp;
	hasUi: boolean;
	icon?: string;
	id: string;
	label: string;
	name: string;
	/** The owning plugin's manifest id (the PluginStore key). The UI bundle is
	 *  keyed by this, NOT by the companion id (`app__<runnable id>`). */
	pluginId: string;
	shortcut?: string;
}

/** Wire shape of a companion (snake_case from Rust serde). */
interface PluginCompanionWire {
	approved_grants?: string[];
	csp?: {
		connect_domains?: string[];
		resource_domains?: string[];
	} | null;
	has_ui?: boolean;
	icon?: string;
	id: string;
	label: string;
	name: string;
	plugin_id?: string;
	shortcut?: string;
}

function toPluginCompanion(w: PluginCompanionWire): PluginCompanion {
	return {
		id: w.id,
		name: w.name,
		label: w.label,
		icon: w.icon,
		shortcut: w.shortcut,
		pluginId: w.plugin_id ?? "",
		approvedGrants: w.approved_grants ?? [],
		hasUi: w.has_ui ?? false,
		csp: w.csp
			? {
					connectDomains: w.csp.connect_domains ?? [],
					resourceDomains: w.csp.resource_domains ?? [],
				}
			: undefined,
	};
}

export async function getPluginContributions(
	target: ApiTarget
): Promise<PluginContributions> {
	const resp = await fetch(apiUrl(target, "/api/plugins/contributions"), {
		method: "GET",
		headers: { ...makeHeaders(target.token), ...identityHeaders() },
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins/contributions failed: ${resp.status}`);
	}
	const json = (await resp.json()) as Partial<
		Omit<PluginContributions, "companions">
	> & { companions?: PluginCompanionWire[] };
	return {
		composer_controls: json.composer_controls ?? [],
		settings_tabs: json.settings_tabs ?? [],
		slash_commands: json.slash_commands ?? [],
		turn_hooks: json.turn_hooks ?? [],
		views: json.views ?? [],
		sidebar_sections: json.sidebar_sections ?? [],
		sidebar_buttons: json.sidebar_buttons ?? [],
		channels: json.channels ?? [],
		companions: (json.companions ?? []).map(toPluginCompanion),
	};
}

/**
 * `GET /api/plugins/:id/ui-bundle` — fetch the bundled UI code of an ENABLED
 * plugin over the TRUSTED Core API (the host holds the node token; the plugin
 * never does). Returns the module source string, or `null` when the plugin has
 * no bundle / is not enabled (Core answers 404). The host base64-encodes this
 * into the sandboxed `srcdoc`; it is NEVER handed to the plugin frame directly.
 */
export async function fetchPluginUiBundle(
	target: ApiTarget,
	id: string
): Promise<string | null> {
	const resp = await fetch(
		apiUrl(target, `/api/plugins/${encodeURIComponent(id)}/ui-bundle`),
		{ method: "GET", headers: makeHeaders(target.token) }
	);
	if (resp.status === 404) {
		return null;
	}
	if (!resp.ok) {
		throw new Error(`/api/plugins/${id}/ui-bundle failed: ${resp.status}`);
	}
	const json = (await resp.json()) as { code?: string };
	return typeof json.code === "string" ? json.code : null;
}

/** A closed error code the app host-bridge surfaces to a companion frame. Mirrors
 *  the host `WidgetRpcErrorCode` so `toRpcError` (host rpc) forwards `code` intact. */
export type PluginHostErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

/** Carries a {@link PluginHostErrorCode} so the host RPC layer relays a structured
 *  `{ code, message }` (not a bare string) back to the sandboxed app. */
export class PluginHostError extends Error {
	code: PluginHostErrorCode;
	constructor(code: PluginHostErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "PluginHostError";
	}
}

/** Map an HTTP status to the closed error code (the endpoint already returns a code
 *  in its body; this is the fallback when the body is missing/unparseable). */
function codeForStatus(status: number): PluginHostErrorCode {
	switch (status) {
		case 403:
			return "denied";
		case 404:
			return "not_found";
		case 429:
			return "over_budget";
		case 400:
		case 422:
			return "invalid_args";
		default:
			return "server_error";
	}
}

/**
 * `POST /api/plugins/:id/host` — invoke ONE app host-bridge method (`model.complete`
 * / `agent.run` / `storage.*`) for an enabled, grant-approved app. The desktop host
 * calls this on the frame's behalf: it holds the node token; the null-origin iframe
 * (CSP `connect-src 'none'`) has NO network path and reaches here only via the
 * capability-gated MessagePort RPC. `method` is the DOTTED wire name Core maps to the
 * bridge (`model.complete`/`agent.run`/`storage.get`/…, see `bridge_path_for`); `args`
 * is the already-validated, snake-keyed object forwarded verbatim. Throws
 * {@link PluginHostError} on non-2xx so the host relays a structured code to the app.
 */
export async function pluginHostInvoke(
	target: ApiTarget,
	pluginId: string,
	method: string,
	args: unknown
): Promise<unknown> {
	let resp: Response;
	try {
		resp = await fetch(
			apiUrl(target, `/api/plugins/${encodeURIComponent(pluginId)}/host`),
			{
				method: "POST",
				headers: makeHeaders(target.token),
				body: JSON.stringify({ method, args }),
			}
		);
	} catch (e) {
		throw new PluginHostError(
			"server_error",
			e instanceof Error ? e.message : "host bridge unreachable"
		);
	}
	if (!resp.ok) {
		let code = codeForStatus(resp.status);
		let message = `host bridge ${method} failed: ${resp.status}`;
		try {
			const body = (await resp.json()) as {
				error?: { code?: string; message?: string };
			};
			if (body.error) {
				if (typeof body.error.message === "string") {
					message = body.error.message;
				}
				if (typeof body.error.code === "string") {
					code = body.error.code as PluginHostErrorCode;
				}
			}
		} catch {
			// Non-JSON error body: keep the status-derived code + message.
		}
		throw new PluginHostError(code, message);
	}
	const json = (await resp.json()) as { result?: unknown };
	return json.result;
}

/**
 * `POST /api/plugins/:id/host/stream` — stream a tool-using `agent.run` for a
 * full-page app. The desktop host holds the token and reads the governance-filtered
 * SSE, delivering each reply token to `onChunk`. Resolves at the terminal `[DONE]`;
 * throws {@link PluginHostError} on an `error` frame or a non-2xx status. `signal`
 * aborts the fetch (the frame cancels), and Core lets the detached turn finish
 * server-side, exactly like a normal chat client disconnect.
 */
export async function pluginHostInvokeStream(
	target: ApiTarget,
	pluginId: string,
	input: unknown,
	opts: { onChunk: (delta: string) => void; signal?: AbortSignal }
): Promise<void> {
	let resp: Response;
	try {
		resp = await fetch(
			apiUrl(
				target,
				`/api/plugins/${encodeURIComponent(pluginId)}/host/stream`
			),
			{
				method: "POST",
				headers: makeHeaders(target.token),
				body: JSON.stringify({ method: "agent.run", args: input }),
				signal: opts.signal,
			}
		);
	} catch (e) {
		throw new PluginHostError(
			"server_error",
			e instanceof Error ? e.message : "host stream unreachable"
		);
	}
	if (!(resp.ok && resp.body)) {
		throw new PluginHostError(
			codeForStatus(resp.status),
			`host stream ${pluginId} failed: ${resp.status}`
		);
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let chunk = await reader.read();
	while (!chunk.done) {
		buf += decoder.decode(chunk.value, { stream: true });
		let boundary = buf.indexOf("\n\n");
		while (boundary !== -1) {
			const frame = buf.slice(0, boundary);
			buf = buf.slice(boundary + 2);
			const data = frame.startsWith("data:")
				? frame.slice("data:".length).trim()
				: null;
			if (data === "[DONE]") {
				return;
			}
			if (data !== null && data.length > 0) {
				let parsed: { type?: string; delta?: string; errorText?: string };
				try {
					parsed = JSON.parse(data);
				} catch {
					parsed = {};
				}
				if (parsed.type === "text-delta" && typeof parsed.delta === "string") {
					opts.onChunk(parsed.delta);
				} else if (parsed.type === "error") {
					throw new PluginHostError(
						"server_error",
						parsed.errorText ?? "agent stream error"
					);
				}
			}
			boundary = buf.indexOf("\n\n");
		}
		chunk = await reader.read();
	}
}

/**
 * `POST /api/plugins/:id/host/stream` (method `finetune.stream`) — subscribe to a
 * fine-tune run's live progress SSE for the `com.ryu.finetune` app. Unlike
 * {@link pluginHostInvokeStream} (which parses the chat reply stream), this forwards
 * each raw SSE `data:` payload VERBATIM to `onFrame` — the sidecar's progress frames
 * (`snapshot`/`progress`/`state`/`end`, each a JSON object with step/loss/state). The
 * app parses them. Resolves when the stream closes; `signal` aborts the fetch.
 */
export async function pluginFinetuneStream(
	target: ApiTarget,
	pluginId: string,
	jobId: string,
	opts: { onFrame: (data: string) => void; signal?: AbortSignal }
): Promise<void> {
	let resp: Response;
	try {
		resp = await fetch(
			apiUrl(
				target,
				`/api/plugins/${encodeURIComponent(pluginId)}/host/stream`
			),
			{
				method: "POST",
				headers: makeHeaders(target.token),
				body: JSON.stringify({
					method: "finetune.stream",
					args: { id: jobId },
				}),
				signal: opts.signal,
			}
		);
	} catch (e) {
		throw new PluginHostError(
			"server_error",
			e instanceof Error ? e.message : "finetune stream unreachable"
		);
	}
	if (!(resp.ok && resp.body)) {
		throw new PluginHostError(
			codeForStatus(resp.status),
			`finetune stream ${jobId} failed: ${resp.status}`
		);
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let chunk = await reader.read();
	while (!chunk.done) {
		buf += decoder.decode(chunk.value, { stream: true });
		let boundary = buf.indexOf("\n\n");
		while (boundary !== -1) {
			const frame = buf.slice(0, boundary);
			buf = buf.slice(boundary + 2);
			// A frame may carry `event: <name>` and `data: <json>` lines; forward the
			// data payload(s) verbatim. The app reads `state`/`step`/`loss` from the JSON.
			for (const line of frame.split("\n")) {
				if (line.startsWith("data:")) {
					const data = line.slice("data:".length).trim();
					if (data.length > 0) {
						opts.onFrame(data);
					}
				}
			}
			boundary = buf.indexOf("\n\n");
		}
		chunk = await reader.read();
	}
}

/**
 * `POST /api/plugins/activation-event` — fire an `onCommand:<id>` activation
 * event so command-gated plugins wake when the desktop command palette runs one
 * of their contributed commands. Best-effort: Core only validates the
 * `onCommand:` prefix, so an unknown id is a harmless no-op. Callers should not
 * block the command UX on this — swallow failures.
 */
export async function fireActivationEvent(
	target: ApiTarget,
	commandId: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/plugins/activation-event"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify({ event: `onCommand:${commandId}` }),
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins/activation-event failed: ${resp.status}`);
	}
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

/** `POST /api/plugins/:id/update` — reinstall an installed plugin at the newest
 *  manifest version from its catalog source. Used by the download center's
 *  "Available updates" section when the installed version trails the catalog. */
export async function updateInstalledPlugin(
	target: ApiTarget,
	id: string
): Promise<AppRecord> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/update`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/update`);
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
): Promise<AppToggleResult> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/enable`), {
		method: "POST",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/enable`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as {
		app: AppRecordWire;
		externally_managed?: boolean;
		notice?: string;
	};
	return {
		...toAppRecord(json.app),
		externallyManaged: json.externally_managed,
		notice: json.notice,
	};
}

/** `POST /api/plugins/:id/grants` — set an ENABLED app's approved grants to an
 *  explicit subset (per-grant revocation / restore). Escalation-guarded + Gateway-
 *  re-validated Core-side; fails closed if the Gateway is unreachable. Returns the
 *  new approved-grant set. */
export async function setPluginGrants(
	target: ApiTarget,
	id: string,
	grants: string[]
): Promise<string[]> {
	const resp = await fetch(apiUrl(target, `/api/plugins/${id}/grants`), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify({ grants }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/grants`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { approved_grants?: string[] };
	return json.approved_grants ?? [];
}

/** `POST /api/plugins/:id/disable` — disable app and clear approved grants.
 *
 *  REFUSED with 409 + a `blocked_by_dependents` {@link DependencyError} when other
 *  ENABLED plugins depend on this one; the error names them so the UI can say
 *  "Disable Meetings, Whiteboard first". Pass `{ cascade: true }` to opt into
 *  disabling the whole dependent chain (reverse-topological order) instead. */
export async function disableApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean }
): Promise<AppToggleResult> {
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
	const json = (await resp.json()) as {
		app: AppRecordWire;
		externally_managed?: boolean;
		notice?: string;
	};
	return {
		...toAppRecord(json.app),
		externallyManaged: json.externally_managed,
		notice: json.notice,
	};
}

/** `POST /api/plugins/:id/uninstall` — disable the plugin and remove its record.
 *
 *  REFUSED with 409 when it is a built-in (`code:"built_in"` — built-ins can only
 *  be disabled) or has ENABLED dependents (a `blocked_by_dependents`
 *  {@link DependencyError}); pass `{ cascade: true }` to disable the whole dependent
 *  chain first, then remove. The refusal is a typed {@link AppLifecycleError}
 *  (`Object.assign`ed onto the thrown Error), so callers branch on `dependencyError`
 *  vs a plain message exactly as the disable path does. */
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
	return {
		success: json.success ?? true,
		removed: json.removed ?? id,
		disabled: json.disabled ?? [],
		externallyManaged: json.externally_managed,
		notice: json.notice,
	};
}

// ── App catalog (browse remote registry + install-from-URL) ───────────────────

/** Presentational banner descriptor for an app's hero region. */
export interface CatalogBanner {
	colors: string[];
	seed?: number;
	style?: "gradient" | "dither";
}

/** A single installable-app entry from Core's remote registry
 *  (`GET /api/plugins/catalog`). Pure discovery metadata — lifecycle state
 *  (installed/enabled) lives on {@link AppInfo} and is joined by `id`. */
export interface CatalogEntry {
	/** Hex accent color used for chrome tinting / banner fallback. */
	accent_color?: string | null;
	/** Hero-banner descriptor (colors + gradient/dither style). */
	banner?: CatalogBanner | null;
	built_in: boolean;
	/** Ids of separate plugins this app ships as a logical bundle. */
	bundles?: string[] | null;
	/** Store category label (e.g. "Productivity"). */
	category?: string | null;
	description: string;
	/** When true, this row is a browse-only integration descriptor (integrations.sh). */
	descriptor_only?: boolean;
	/** Publisher / developer name shown on the card + detail. */
	developer?: string | null;
	/** Optional CSS background for the icon square (e.g. a gradient). */
	icon_background?: string | null;
	/** Remote icon URL when provided by the catalog source. */
	icon_url?: string | null;
	id: string;
	/** MCP / OpenAPI / GraphQL / CLI when sourced from integrations.sh. */
	integration_kind?: string | null;
	/** Link to the integration docs, spec, or MCP endpoint. */
	integration_url?: string | null;
	kinds: string[];
	name: string;
	permission_grants: string[];
	/** The bundled sub-items this item ships (the manifest runnables). */
	runnables?: { id: string; kind: string; name?: string }[];
	source: string;
	/** Short one-line pitch shown under the name. */
	tagline?: string | null;
	tags: string[];
	/** Explicit app-vs-plugin discriminator (preferred over the kinds derivation). */
	type?: "app" | "plugin";
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

// ── Plugin catalog sources + federated browse (integrations.sh, …) ────────────

/** Default merged catalog: Ryu Marketplace + built-ins + legacy registry. */
export const PLUGIN_MARKETPLACE_SOURCE_ID = "ryu-marketplace";

export interface PluginCatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

export interface PluginCatalogSources {
	active: string;
	sources: PluginCatalogSource[];
}

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

function toPluginSource(w: SourceWire): PluginCatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List plugin catalog sources and which one is active. */
export async function fetchPluginSources(
	target: ApiTarget
): Promise<PluginCatalogSources> {
	const json = await request<{
		active?: string;
		sources?: SourceWire[];
	}>(target, "/api/catalog/sources?kind=plugin");
	return {
		active: json.active ?? "",
		sources: (json.sources ?? []).map(toPluginSource),
	};
}

/** Select the active plugin catalog source by id. */
export async function selectPluginSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(target, "/api/catalog/sources/select", {
		method: "POST",
		body: { kind: "plugin", id },
	});
}

/** Parameters for adding a custom Claude plugin marketplace as a plugin source. */
export interface AddMarketplaceParams {
	baseUrl: string;
	displayName: string;
	id: string;
}

/** Add a custom Claude plugin marketplace (repo/URL with marketplace.json). */
export async function addMarketplaceSource(
	target: ApiTarget,
	params: AddMarketplaceParams
): Promise<void> {
	const json = await request<{ ok?: boolean; error?: string }>(
		target,
		"/api/catalog/sources",
		{
			method: "POST",
			body: {
				kind: "plugin",
				id: params.id,
				display_name: params.displayName,
				base_url: params.baseUrl,
			},
		}
	);
	if (json.ok === false) {
		throw new Error(json.error ?? "Failed to add marketplace");
	}
}

export interface PluginSearchParams {
	cursor?: string;
	limit?: number;
	query?: string;
}

export interface PluginCatalogPage {
	entries: CatalogEntry[];
	nextCursor: string | null;
	note: string | null;
}

/** Browse the active plugin catalog source (paginated for federated sources). */
export async function searchPluginCatalog(
	target: ApiTarget,
	params: PluginSearchParams = {}
): Promise<PluginCatalogPage> {
	const q = new URLSearchParams();
	if (params.query) {
		q.set("query", params.query);
	}
	if (params.limit) {
		q.set("limit", String(params.limit));
	}
	if (params.cursor) {
		q.set("cursor", params.cursor);
	}
	const json = await request<{
		entries?: CatalogEntry[];
		next_cursor?: string | null;
		note?: string | null;
	}>(target, `/api/plugins/catalog/browse?${q.toString()}`);
	return {
		entries: json.entries ?? [],
		nextCursor: json.next_cursor ?? null,
		note: typeof json.note === "string" ? json.note : null,
	};
}

/** Detail payload for a federated catalog entry (integrations.sh descriptor). */
export interface PluginCatalogDetail {
	accentColor?: string | null;
	banner?: CatalogBanner | null;
	categories?: string[];
	description?: string | null;
	descriptor?: {
		integration_kind?: string;
		kind?: string;
		url?: string | null;
		domain?: string | null;
	};
	domain?: string | null;
	feeds?: string[];
	iconBackground?: string | null;
	iconUrl?: string | null;
	id: string;
	integration_kind?: string | null;
	kind?: string | null;
	name?: string;
	source?: string;
	sourceUrl?: string | null;
	url?: string | null;
}

/** Fetch detail for the selected entry from the active plugin catalog source. */
export async function fetchPluginCatalogDetail(
	target: ApiTarget,
	id: string
): Promise<PluginCatalogDetail> {
	return request<PluginCatalogDetail>(
		target,
		`/api/plugins/catalog/detail?id=${encodeURIComponent(id)}`
	);
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

/**
 * `POST /api/plugins/catalog/install { id }` — install a PLUGIN-kind item from the
 * active marketplace catalog (the CODE CARRIAGE sink). Core resolves the item's
 * descriptor, VERIFIES the ed25519 manifest signature, and recomputes
 * `sha256(ui_code)` against the signed `ui_code_sha256` — rejecting a tampered
 * bundle fail-closed. Only VERIFIED code is stored; once the plugin is enabled the
 * existing `GET /api/plugins/:id/ui-bundle` + `PluginHostPanel` path renders it.
 *
 * `buyerToken` (the control-plane session bearer) is forwarded as
 * `x-ryu-buyer-token` so a PAID plugin's entitlement check can resolve the buyer
 * org + its license; omit it for free plugins (anonymous install is fine).
 */
export async function installPluginFromCatalog(
	target: ApiTarget,
	id: string,
	buyerToken?: string | null
): Promise<void> {
	const headers = makeHeaders(target.token);
	if (buyerToken) {
		headers["x-ryu-buyer-token"] = buyerToken;
	}
	const resp = await fetch(apiUrl(target, "/api/plugins/catalog/install"), {
		method: "POST",
		headers,
		body: JSON.stringify({ id }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/catalog/install");
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

/** Per-sidecar running state plus the resource sample Core attributes to its
 *  resident process. `pid`/`memoryBytes`/`cpuPercent` are absent for engines
 *  with no owned process to sample (adopt-mode / serverless / in-process). */
export interface SidecarDetail {
	cpuPercent: number | null;
	memoryBytes: number | null;
	pid: number | null;
	running: boolean;
}

/** `GET /api/sidecar/status`, but keeping the per-engine resource fields the
 *  node selector renders (memory/CPU). Same endpoint + poll as
 *  {@link fetchSidecarStatus}; that one stays a plain running-state map for the
 *  many call sites that only need the boolean. */
export async function fetchSidecarDetails(
	target: ApiTarget
): Promise<Record<string, SidecarDetail>> {
	const resp = await fetch(apiUrl(target, "/api/sidecar/status"), {
		method: "GET",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/status failed: ${resp.status}`);
	}
	const json = (await resp.json()) as {
		sidecars?: Array<{
			name: string;
			running: boolean;
			pid?: number;
			memory_bytes?: number;
			cpu_percent?: number;
		}>;
	};
	const map: Record<string, SidecarDetail> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = {
			running: s.running,
			pid: s.pid ?? null,
			memoryBytes: s.memory_bytes ?? null,
			cpuPercent: s.cpu_percent ?? null,
		};
	}
	return map;
}

/** Live admission-queue + slot depth for the resident local engine. */
export interface EngineConcurrency {
	/** Engine-reported busy slots (llama.cpp `/slots`), when available. */
	engineBusy: number | null;
	engineTotal: number | null;
	/** Requests currently occupying an engine slot (gateway-gated). */
	inFlight: number;
	/** Max concurrent slots the gateway admits (the engine's batch width). */
	maxInFlight: number;
	/** Requests waiting for a slot. */
	queued: number;
	/** Of those waiting, how many are interactive (vs background fan-out). */
	queuedInteractive: number;
}

/** `GET /api/engine/concurrency` — local-engine admission queue + slot depth.
 *  Returns `null` when the gateway/engine reports nothing usable, so callers
 *  can simply hide the caption. */
export async function fetchEngineConcurrency(
	target: ApiTarget
): Promise<EngineConcurrency | null> {
	const resp = await fetch(apiUrl(target, "/api/engine/concurrency"), {
		method: "GET",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		return null;
	}
	const json = (await resp.json()) as {
		admission?: {
			gates?: Array<{
				in_flight: number;
				max_in_flight: number;
				queued: number;
				queued_interactive: number;
			}>;
		};
		engine_busy_slots?: number | null;
		engine_total_slots?: number | null;
	};
	const gate = json.admission?.gates?.[0];
	if (!gate && json.engine_busy_slots == null) {
		return null;
	}
	return {
		inFlight: gate?.in_flight ?? 0,
		maxInFlight: gate?.max_in_flight ?? 0,
		queued: gate?.queued ?? 0,
		queuedInteractive: gate?.queued_interactive ?? 0,
		engineBusy: json.engine_busy_slots ?? null,
		engineTotal: json.engine_total_slots ?? null,
	};
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
