// apps/desktop/src/lib/api/plugins.ts
//
// Typed client for Core's Plugin lifecycle endpoints (`/api/plugins`). A Plugin
// is a manifest.json bundle descriptor (manifest) with a persisted lifecycle
// record (installed/enabled state). Consumed by the Extensions page via the
// `useApps` hook.
//
// Wire shapes use snake_case as serialised by Rust/serde; camelCase types are
// the client-side view exposed to React components. The internal symbol names
// (App*, fetchApps, etc.) are kept stable to limit churn across importers.

import type { LiveActivityContribution } from "@ryu/app-host/live-activity";
import type { StandaloneAppBundle } from "@ryu/app-host/standalone";
import type {
	DockPanelSpec,
	SidebarSectionSpec,
	StoreTabSpec,
	ViewContribution,
	ViewSource,
} from "@ryu/app-host/views";
import type {
	CardDither,
	CardThemePreview,
	CatalogBanner,
	CatalogExtensionSummary,
	CatalogImplementationSummary,
	CatalogLayer,
	CatalogSurfaceSupport,
} from "@ryu/marketplace/catalog/types";
import {
	type ApiTarget,
	authenticatedFetch,
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
	/** Publisher identity mark from the control plane. */
	publisher_trust?: "gold" | "blue" | "dotted" | null;
	publisher_trust_source?: "ryu_staff" | "stripe_connect" | "none" | null;
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
	/** Primary brand accent from the manifest (`accentColor`). */
	accentColor?: string | null;
	/** Grants approved on the last successful enable, injected by `list_apps` from
	 *  the lifecycle RECORD (absent on a node predating that, hence optional). */
	approved_grants?: string[];
	// System app fields injected by list_apps for Ghost/Shadow
	built_in: boolean;
	/** Free-text store category (`category`), e.g. "Productivity". */
	category?: string | null;
	// Injected by list_apps handler
	/** The release train this install follows; null when not installed. */
	channel?: string | null;
	companion?: {
		label: string;
		icon?: string | null;
		shortcut?: string | null;
	} | null;
	/** Long plaintext/markdown description. */
	description?: string | null;
	developer?: string | null;
	enabled: boolean;
	external?: boolean;
	/** Icon-primitive id / `svgl:<slug>` (contract key `icon`). */
	icon?: string | null;
	/** CSS background for the icon square (contract key `iconBackground`). */
	iconBackground?: string | null;
	/** Dithered-gradient background for the icon square (`iconDither`). */
	iconDither?: CardDither | null;
	/** Inset and letterbox treatment for the icon art (`iconPadding`). */
	iconPadding?: string | null;
	/** Raster logo (contract key `iconUrl`). */
	iconUrl?: string | null;
	id: string;
	installed: boolean;
	installed_version: string | null;
	layers?: CatalogLayer[];
	local_only: boolean;
	/** Required for Core — Disable/Uninstall are refused (403, no force). */
	mandatory?: boolean;
	mcp_servers?: Record<
		string,
		{
			auth?: { type?: string; client_id?: string | null } | null;
			url?: string | null;
		}
	>;
	name: string;
	permission_grants: string[];
	/** Plugin-to-plugin dependencies. Absent (`skip_serializing_if`) = none. */
	requires?: RequiresWire | null;
	runnables: RunnableEntryWire[];
	sidecar_name: string | null;
	/** How finished this listing is ("alpha", "beta", …). Absent/"stable" = no badge. */
	stability?: string | null;
	/** True when the user has this ENABLED but Safe Mode is holding it back this
	 *  boot. `enabled` stays the user's own choice — Safe Mode is a read mask, not
	 *  a write — so without this the card would show "enabled" beside a panel that
	 *  is gone. Absent on a node predating Safe Mode. */
	suppressed_by_safe_mode?: boolean;
	/** Display-only per-surface support levels from Core. */
	surface_support?: CatalogSurfaceSupport[];
	/** Short one-line pitch shown under the name. */
	tagline?: string | null;
	/** Host surfaces the plugin runs on. Absent/empty = EVERY surface. */
	targets?: Surface[];
	/** Core-derived provenance tier. Never infer this from the manifest id. */
	tier?: AppTier | null;
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

/** Server-derived plugin provenance. The id namespace is not a trust signal. */
export type AppTier = "core" | "community";

/** First-party UI is admitted only when Core explicitly derives the Core tier. */
export function isCoreAppTier(
	tier: AppTier | null | undefined
): tier is "core" {
	return tier === "core";
}

/** Parse Core's provenance field without ever treating an unknown value as Core. */
export function appTierFromWire(value: unknown): AppTier | null {
	return value === "core" || value === "community" ? value : null;
}

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

/** The manifest's PRESENTATIONAL fields — what makes an installed app look like
 *  itself rather than like a grey glyph.
 *
 *  Core's `list_apps` serialises the whole manifest, so every one of these has
 *  always been on the wire; the client simply dropped them, which is why the
 *  sidebar and the Installed tab fell back to a placeholder tile while the Store's
 *  catalog tabs — reading the same fields off `CatalogEntry` — showed real art.
 *  Same names, same meanings, so `AppIcon`/`StoreCatalogCard` take them unchanged
 *  and one app looks identical on every surface. */
export interface AppPresentation {
	/** Primary brand accent colour used by compact app-owned tokens. */
	accentColor?: string | null;
	/** Free-text store category ("Productivity", …). */
	category: string | null;
	/** Long plaintext/markdown description — the detail body, not the card line. */
	description: string | null;
	external: boolean;
	/** Icon-primitive id, or an `svgl:<slug>` brand mark. */
	icon: string | null;
	/** Flat CSS background for the icon square. */
	iconBackground: string | null;
	/** Dithered-gradient background for the icon square. */
	iconDither: CardDither | null;
	/** Inset and letterbox treatment for icon art (`iconPadding`). */
	iconPadding: string | null;
	/** Raster logo URL. */
	iconUrl: string | null;
	layers: CatalogLayer[];
	/** "alpha" / "beta" / … — null or "stable" renders no badge. */
	stability: string | null;
	/** Short one-line pitch — the CARD line. Prefer this over `description`, which
	 *  is a paragraph and would be truncated to nothing useful in a one-line slot. */
	tagline: string | null;
}

export interface AppInfo extends AppPresentation {
	/** The grants currently IN FORCE — the subset of {@link permissionGrants} the
	 *  last successful enable approved. Empty for a plugin that was never enabled.
	 *  The permissions editor checks its switches against this, never against the
	 *  manifest's declaration, which is only what the app asked for. */
	approvedGrants: string[];
	/** Whether the package is embedded/owned by the Ryu distribution. This is
	 *  provenance, not an installation or enabled-state flag. */
	builtIn: boolean;
	/** The release train this install FOLLOWS — `stable`, `beta`, `nightly`, … —
	 *  which is what the next update resolves on. Not derivable from the version:
	 *  a plugin pinned to `canary` whose canary train has no build yet still sits
	 *  on a stable version. `null` when the plugin is not installed. */
	channel: string | null;
	companion: {
		label: string;
		icon: string | null;
		shortcut: string | null;
	} | null;
	enabled: boolean;
	id: string;
	installed: boolean;
	/** The version the lifecycle record actually holds — what is ON THIS MACHINE.
	 *  `null` for an uninstalled app, including an install-on-demand built-in;
	 *  pre-installed built-ins have a seeded lifecycle record. `version` is the
	 *  MANIFEST's version, which for an out-of-date install is the newer one.
	 *  Render `installedVersion ?? version`, never `version` alone. */
	installedVersion: string | null;
	localOnly: boolean;
	/** Required for Core: never render a Disable switch or an Uninstall button.
	 *  Core refuses both with a 403 and no force override, so the control could only
	 *  ever produce an error. Stamped by Core from its own `MANDATORY_PLUGINS`
	 *  constant, never from the manifest's claim of it. */
	mandatory: boolean;
	/** Remote MCP servers whose OAuth lifecycle is owned by Core. */
	mcpOAuthServers: McpOAuthServerDeclaration[];
	name: string;
	permissionGrants: string[];
	/** Declared dependencies. `null` = none (the common case). */
	requires: AppRequires | null;
	runnables: RunnableEntry[];
	sidecarName: string | null;
	/** Enabled by the user, but not loaded this boot because the node is in Safe
	 *  Mode. Render it as "Disabled by Safe Mode" rather than letting the card
	 *  claim the app is running — that mismatch (enabled switch, missing panel) is
	 *  the confusing state Safe Mode has to explain, not create. */
	suppressedBySafeMode: boolean;
	/** Per-surface support levels from Core's catalog projection. */
	surfaceSupport: CatalogSurfaceSupport[];
	/** Host surfaces this plugin runs on. **Empty = every surface**, never "none". */
	targets: Surface[];
	/** Core-derived provenance. Missing/unknown values are not first-party. */
	tier: AppTier | null;
	version: string;
	windowsFirst: boolean;
}

export interface McpOAuthServerDeclaration {
	clientId: string | null;
	name: string;
	resource: string;
}

export interface AppRecord {
	approvedGrants: string[];
	createdAt: string | null;
	enabled: boolean;
	id: string;
	updatedAt: string | null;
	version: string;
}

export const APP_LIFECYCLE_PERMISSIONS = [
	"app.install",
	"app.update",
	"app.enable",
	"app.disable",
	"app.uninstall",
] as const;

export type AppLifecyclePermission = (typeof APP_LIFECYCLE_PERMISSIONS)[number];

export interface AppLifecycleCapabilities {
	node: {
		id: string;
		orgId: string | null;
		ownerUserId: string | null;
		scope: "org" | "team" | "personal";
		teamId: string | null;
	} | null;
	permissions: Record<AppLifecyclePermission, boolean>;
	reasons?: Partial<Record<AppLifecyclePermission, string>>;
}

export interface PluginDoctorFinding {
	canAutoFix: boolean;
	category: string;
	checkId: string;
	detail: string;
	evidence?: unknown;
	pluginId: string;
	recommendedAction: string;
	severity: "error" | "warning" | "info" | string;
	source: string;
	summary: string;
}

export interface PluginDoctorInventoryItem {
	findingCount: number;
	id: string;
	name: string;
	status: "healthy" | "warning" | "error" | string;
}

export interface PluginDoctorReport {
	counts: {
		errors: number;
		info: number;
		plugins: number;
		warnings: number;
	};
	findings: PluginDoctorFinding[];
	generatedAt: string;
	plugins: PluginDoctorInventoryItem[];
	profile: "lint" | string;
	readOnly: boolean;
	rulesetVersion: string;
	schemaVersion: string;
	scope: string;
	score: number;
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
	| { code: "blocked_by_dependents"; plugin: string; dependents: string[] }
	| {
			/** An UPDATE was refused because it would break an installed dependent.
			 *  The reverse of `version_mismatch`: the offending version is NOT
			 *  installed yet, so it is reported as `incoming`, never `installed`. */
			code: "dependent_version_mismatch";
			/** The installed dependent that would be left broken. */
			plugin: string;
			/** The plugin being updated. */
			dependency: string;
			/** The requirement `plugin` declares, as written. */
			required: string;
			/** The version `dependency` would be moved to. */
			incoming: string;
	  };

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
	/** HTTP status from Core, used for narrow built-in-vs-bundle fallback. */
	status: number;
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
		case "dependent_version_mismatch":
			return `Updating ${displayName(err.dependency)} to ${err.incoming} would break ${displayName(err.plugin)}, which needs ${err.required}. Update ${displayName(err.plugin)} first, or force the update.`;
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
		approvedGrants: w.approved_grants ?? [],
		builtIn: w.built_in ?? false,
		tier: appTierFromWire(w.tier),
		category: w.category ?? null,
		companion: w.companion
			? {
					label: w.companion.label,
					icon: w.companion.icon ?? null,
					shortcut: w.companion.shortcut ?? null,
				}
			: null,
		description: w.description ?? null,
		enabled: w.enabled,
		external: w.external ?? false,
		accentColor: w.accentColor ?? null,
		icon: w.icon ?? null,
		iconBackground: w.iconBackground ?? null,
		iconDither: w.iconDither ?? null,
		iconPadding: w.iconPadding ?? null,
		iconUrl: w.iconUrl ?? null,
		id: w.id,
		channel: w.channel ?? null,
		installed: w.installed,
		installedVersion: w.installed_version,
		localOnly: w.local_only ?? false,
		mandatory: w.mandatory ?? false,
		mcpOAuthServers: Object.entries(w.mcp_servers ?? {}).flatMap(
			([name, server]) =>
				server.auth?.type === "oauth" && server.url
					? [
							{
								clientId: server.auth.client_id ?? null,
								name,
								resource: server.url,
							},
						]
					: []
		),
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
		stability: w.stability ?? null,
		surfaceSupport: w.surface_support ?? [],
		suppressedBySafeMode: w.suppressed_by_safe_mode ?? false,
		tagline: w.tagline ?? null,
		layers: w.layers ?? [],
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

	return { message, grantsDenied, gatewayUnreachable, dependencyError, status };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** `GET /api/plugins` — list all app manifests merged with their lifecycle state.
 *  Sends `identityHeaders()` (which carries `X-Ryu-Surface: desktop`) so Core
 *  filters the list to plugins that target this surface — the direct-fetch path
 *  otherwise omits it, leaving `targets` inert. */
export async function fetchApps(
	target: ApiTarget,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppInfo[]> {
	const resp = await authenticatedFetch(target, "/api/plugins", {
		method: "GET",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...identityHeaders(),
		},
		skipUserJwt: options.skipUserJwt,
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins failed: ${resp.status}`);
	}
	const json = (await resp.json()) as { apps?: AppManifestWire[] };
	return (json.apps ?? []).map(toAppInfo);
}

/** `GET /api/plugins/lifecycle-capabilities` — advisory node-scoped lifecycle
 *  projection for desktop controls. Mutating calls still re-check the server
 *  permission immediately before touching the installed package. */
export async function fetchAppLifecycleCapabilities(
	target: ApiTarget
): Promise<AppLifecycleCapabilities> {
	return request<AppLifecycleCapabilities>(
		target,
		"/api/plugins/lifecycle-capabilities"
	);
}

/** Run the read-only Core loader/lifecycle doctor for installed apps/plugins. */
export async function fetchPluginDoctor(
	target: ApiTarget,
	id?: string
): Promise<PluginDoctorReport> {
	const suffix = id ? `?id=${encodeURIComponent(id)}` : "";
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/doctor${suffix}`,
		{
			method: "GET",
			headers: {
				...makeHeaders(target.token, target.userJwt),
				...identityHeaders(),
			},
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/plugins/doctor failed: ${resp.status}`);
	}
	return (await resp.json()) as PluginDoctorReport;
}

/**
 * Declarative UI contributions of every enabled plugin (composer controls,
 * settings tabs, slash commands) + its turn hooks. Each entry is tagged with its
 * owning `plugin` id. Lets the desktop render plugin-contributed widgets (e.g. the
 * double-check composer toggle) without hardcoding them. Opaque records — the
 * renderer interprets the widget `type`.
 */
/**
 * An enabled app that declares inline chat widgets, and whether it may actually
 * render them.
 *
 * `granted: false` means the app declares widgets but its record lacks
 * `widget:render`, so Core refuses the promotion and every widget silently
 * arrives as plain text. Worth surfacing: nothing else in the UI reports it.
 */
export interface PluginWidgetApp {
	granted: boolean;
	name: string;
	plugin_id: string;
	widget_count: number;
}

/** Metadata-only chat widget template. Core forwards identifiers and copy; the
 * desktop host owns the renderer and never executes manifest-provided UI. */
export interface PluginChatWidgetTemplate {
	availability?: string;
	backing: { tool_id?: string; view_id?: string };
	description?: string;
	display_mode: string;
	examples: string[];
	id: string;
	plugin?: string;
	safe_action_ids: string[];
	title: string;
	triggers: string[];
}

/** One app event an enabled app declares it emits, as served (and tagged with its
 *  owning `plugin` id) by `GET /api/plugins/contributions`. */
export interface PluginHookEvent {
	description?: string;
	/** Fully-qualified event id: `<owning plugin id>#<event name>`. This exact string
	 *  is what a workflow's `event` trigger or a hook's `on` must name. */
	id: string;
	payload_example?: Record<string, unknown>;
	/** The owning plugin id, stamped server-side. */
	plugin?: string;
	title: string;
}

/** Opaque host-rendered chat feature declaration from an enabled plugin. Core
 * stamps `plugin`; the remaining vocabulary belongs to the desktop surface. */
export interface PluginChatFeature {
	plugin?: string;
	[key: string]: unknown;
}

export interface PluginContributions {
	/** Agent Edit panels supplied by enabled plugins. Panels are interpreted by
	 * the desktop shell only by their declared type; the owning plugin id is
	 * provenance, never a routing switch. */
	agent_edit_panels: PluginAgentEditPanel[];
	/** Messaging-channel adapters an enabled plugin makes available. */
	channels: PluginChannel[];
	/** Host-rendered chat feature declarations, tagged with their owning plugin. */
	chat_features: PluginChatFeature[];
	chat_widget_templates?: PluginChatWidgetTemplate[];
	/** Companion surfaces (overlay/sidebar panels) an enabled plugin declares. */
	companions: PluginCompanion[];
	composer_controls: PluginComposerControl[];
	/** Context-menu rows enabled plugins contribute (`contributes.context_menu_items`),
	 *  tagged with `plugin`. The declarative replacement for hardcoded shell menu
	 *  rows like "Make a skill from this chat". */
	context_menu_items: PluginContextMenuItem[];
	/** "New X" rows enabled plugins contribute to the create menu
	 *  (`contributes.create_actions`), tagged with `plugin`. The declarative
	 *  replacement for create rows the shell used to hardcode for apps that may
	 *  not even be installed. */
	create_actions: PluginCreateAction[];
	/** App-registered workspace dock panels (bottom/right dock tabs), tagged with
	 *  `plugin`. The declarative replacement for the shell's closed `TabKind` union. */
	dock_panels: PluginDockPanel[];
	/** App events enabled apps EMIT (`contributes.hook_events`), tagged with the
	 *  owning `plugin` id. The provider half of the hook system, whose consumer half
	 *  is {@link PluginContributions.turn_hooks}: this is the catalog a user picks
	 *  from when subscribing a workflow or a hook to "when X happens". */
	hook_events: PluginHookEvent[];
	/** Live activities contributed by enabled plugins (`contributes.live_activities`),
	 *  tagged with `plugin`. Each is a {@link LiveActivityContribution} the desktop's
	 *  "Dynamic Island" dock renders from a declared safe Core-relative path. */
	live_activities: PluginLiveActivity[];
	/** Per-message toolbar actions enabled plugins contribute
	 *  (`contributes.message_actions`), tagged with `plugin`. */
	message_actions: PluginMessageAction[];
	/** Output styles contributed by enabled plugins (`contributes.output_styles`),
	 *  tagged with `plugin`. See {@link PluginOutputStyle} — the desktop reads styles
	 *  from `GET /api/output-styles`, so this family is provenance, not the picker's
	 *  data source. */
	output_styles: PluginOutputStyle[];
	/** Floating text-selection toolbar actions enabled plugins contribute
	 *  (`contributes.selection_actions`), tagged with `plugin`. */
	selection_actions: PluginSelectionAction[];
	settings_tabs: Record<string, unknown>[];
	/** App-registered sidebar buttons (single nav rows), tagged with `plugin`. */
	sidebar_buttons: PluginSidebarButton[];
	/** App-registered sidebar MODES (named arrangements of the whole sidebar),
	 *  tagged with `plugin`. See {@link PluginSidebarMode}. */
	sidebar_modes: PluginSidebarMode[];
	/** App-registered sidebar sections (header + live list), tagged with `plugin`. */
	sidebar_sections: PluginSidebarSection[];
	slash_commands: Record<string, unknown>[];
	/** App-registered marketplace tabs, tagged with `plugin` + the app's
	 *  install/enable state. The ONE family Core serves for disabled and
	 *  not-installed apps too — see {@link PluginStoreTab}. */
	store_tabs: PluginStoreTab[];
	/** Colour themes contributed by enabled plugins (`contributes.themes`), tagged
	 *  with `plugin`. Shape-identical to the shell's own `ThemeVariant`, so an
	 *  installed theme and a built-in one are the same object by the time the
	 *  Appearance picker renders them. */
	themes: PluginTheme[];
	turn_hooks: Record<string, unknown>[];
	/** Declarative views (the Raycast tier) contributed by enabled plugins. Each is a
	 *  {@link ViewContribution} the desktop/island renderer maps to native components,
	 *  tagged server-side with its owning `plugin` id. */
	views: PluginView[];
	/** Enabled apps that render interactive cards inline in chat (status only —
	 *  the widget bindings themselves are Core-interpreted and not served here). */
	widget_apps: PluginWidgetApp[];
}

/** A panel contributed to the per-agent editor. */
export interface PluginAgentEditPanel {
	description?: string;
	id: string;
	plugin: string;
	pref_key_prefix?: string;
	title: string;
	type: string;
}

/** An app-registered sidebar SECTION as served by Core (`contributes.sidebar_sections[]`),
 *  tagged with its owning `plugin`. The `spec` is the shared {@link SidebarSectionSpec}. */
export interface PluginSidebarSection {
	/** Gateway-approved grants for the owning enabled app, added by Core. */
	approved_grants?: string[];
	/** Core-stamped declarative HTTP authority. */
	http_policy?: unknown;
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: SidebarSectionSpec;
	title: string;
}

/** An app-registered sidebar MODE as served by Core (`contributes.sidebar_modes[]`),
 *  tagged with its owning `plugin`.
 *
 *  A mode names sections, it does not render anything: `sections` holds the shell's
 *  own section keys (`agents`, `chats`, …) or another contributed section's
 *  namespaced `plugin:<pluginId>:<sectionId>`. The shell drops names it cannot
 *  resolve rather than dropping the mode, so naming a section from a sibling app the
 *  user has not installed costs a tab, not the arrangement. */
export interface PluginSidebarMode {
	default_section?: string;
	description?: string;
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	sections: string[];
	title: string;
}

/** A colour theme served by Core from an enabled plugin's `contributes.themes[]`,
 *  tagged with its owning `plugin`.
 *
 *  This is the marketplace half of the theme story: rather than a `CatalogKind`, a
 *  theme rides in on an ordinary plugin, so it inherits install/uninstall/enable,
 *  versioning, signing and the Store detail page unchanged — the same trade VS Code
 *  and Zed make. `tokens` is left open (CSS custom property → value) because the
 *  design system grows independently of this contract, and the shell only ever
 *  assigns these to CSS variables, never evaluates them. */
export interface PluginTheme {
	id: string;
	label: string;
	mode: "light" | "dark";
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	preview: { bg: string; surface: string; primary: string; text: string };
	tokens: Record<string, string>;
}

/** An output style served by Core from an enabled plugin's `contributes.output_styles[]`,
 *  tagged with its owning `plugin`.
 *
 *  A style reshapes HOW an agent answers by editing the system prompt for the turn
 *  (`docs/output-styles.md`). Like {@link PluginTheme} it rides in on an ordinary
 *  plugin rather than being its own catalog kind, so it inherits install/enable,
 *  versioning, signing and the Store detail page unchanged.
 *
 *  This family is **metadata + provenance, never the style body**. Core parses the
 *  contributed Markdown once (`parse_output_style_md`, design §4's one-parser rule)
 *  and serves only the frontmatter it read; neither the pre-hydration `file` path nor
 *  the inlined `source` reaches a client. That is deliberate rather than incidental —
 *  a body is up to 64 KB and this endpoint is polled by every shell on boot, and the
 *  body's only consumer is Core's own registry, which already got it at the enable
 *  seam. A surface that wants the text asks `GET /api/output-styles/{id}/source`.
 *
 *  So this is what a surface uses to answer "which plugin shipped this style" and to
 *  explain a style it cannot offer (a `force_for_plugin` row is pinned while its
 *  plugin is enabled). The profile selector's data source is `GET /api/output-styles`,
 *  which merges these with the user's, the project's and managed styles. */
export interface PluginOutputStyle {
	/** Frontmatter `description`; `null` when the style file omits it. */
	description: string | null;
	/** Frontmatter `force-for-plugin` — this style overrides per-turn and per-agent
	 *  selection while its plugin is enabled (design §5). */
	force_for_plugin: boolean;
	id: string;
	/** Frontmatter `keep-coding-instructions` — whether the body is appended after the
	 *  agent's base instructions (`true`) or replaces them (`false`, the default).
	 *  See `docs/output-styles.md` §2. */
	keep_coding_instructions: boolean;
	/** Frontmatter `name`, falling back to the file stem. */
	name: string;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
}

/** An app-registered marketplace TAB as served by Core (`contributes.store_tabs[]`),
 *  tagged with its owning `plugin` plus that app's install/enable state.
 *
 *  Unlike every sibling family here, store tabs are served for apps that are NOT
 *  installed or NOT enabled — the Store is where an app gets installed, and
 *  install-on-demand feature apps have no fresh-install record, so an enabled-gated tab would be
 *  missing exactly when it is needed. `app_installed` / `app_enabled` are what the
 *  renderer switches on to show an enable prompt instead of an empty catalog. */
export interface PluginStoreTab {
	/** Whether the owning app is currently enabled on this node. */
	app_enabled: boolean;
	/** Whether the owning app has a store record on this node at all. */
	app_installed: boolean;
	/** Nav cluster key (`discover` | `catalog` | `community` | `manage` | `account`). */
	group?: string;
	/** Core-stamped declarative HTTP authority. */
	http_policy?: unknown;
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: StoreTabSpec;
	subtitle?: string;
	title: string;
	/** Named first-party renderer; gated by plugin id, never by this string. */
	view?: string;
}

/** An app-registered sidebar BUTTON as served by Core (`contributes.sidebar_buttons[]`),
 *  tagged with its owning `plugin`. A single nav row that opens `target`. */
export interface PluginSidebarButton {
	/** Optional app context passed when the button opens the owning Companion. */
	context?: Record<string, unknown>;
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

/** A live-activity contribution as served by Core (`contributes.live_activities[]`),
 *  tagged with its owning `plugin`. Shape-identical to the shared
 *  `@ryu/app-host/live-activity` {@link LiveActivityContribution} — re-exported here
 *  so contributions consumers need only the plugins API. */
export type PluginLiveActivity = LiveActivityContribution;

/** Which dock a {@link PluginDockPanel} opens in. Mirrors the Rust
 *  `DockPanelPlacement`; `"both"` offers the panel in each dock's new-tab menu. */
export type PluginDockPlacement = "bottom" | "right" | "both";

/** An app-registered workspace dock panel as served by Core
 *  (`contributes.dock_panels[]`), tagged with its owning `plugin`.
 *
 *  `panel` is the render-mode discriminant (the `DockPanelKind` vocabulary — `"companion"`,
 *  `"view"`, `"native"`) and stays a bare string so a member this build predates is
 *  still delivered; the renderer must ignore what it does not know. `spec` carries the
 *  mode's payload ({@link DockPanelSpec}). */
export interface PluginDockPanel {
	icon?: string;
	id: string;
	order?: number;
	/** Render mode: `"companion"` | `"view"` | `"native"` | a newer member. */
	panel: string;
	placement: PluginDockPlacement;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: DockPanelSpec;
	title: string;
}

/** One option of a `select` composer control. */
export interface PluginComposerControlOption {
	description?: string;
	icon?: string;
	label: string;
	value: string;
}

/**
 * A composer control an enabled plugin contributes (`contributes.composer_controls`,
 * tagged server-side with its owning `plugin`).
 *
 * `type` is the render discriminant and stays a bare string on purpose — Core forwards
 * every entry verbatim, so a control type newer than this build still arrives and must
 * simply be skipped rather than break the composer. The vocabulary (kept in lockstep
 * with the Rust `Contributes::composer_controls` doc comment):
 *
 * - `"toggle"` — switch row in the "+" menu. Sets `plugin_flags[flag] = true|false`.
 * - `"select"` — menu/segmented picker over `options`; the chosen `value` (a string)
 *   lands in `plugin_flags[flag]`, with `default` used until the user picks.
 * - `"chip"` — inline pill in the composer bar showing a LIVE value polled from
 *   `source` (the same {@link ViewSource} a declarative view uses) rather than a menu
 *   row; `flag` is where it exposes (and clears) that value.
 * - `"action"` — button that dispatches `capability` (with optional `args`) through the
 *   owning plugin's granted capability seam instead of storing state.
 *
 * Every field beyond `id`/`type`/`label`/`plugin` is therefore optional: which ones are
 * meaningful depends on `type`, and the renderer narrows before reading them.
 */
export interface PluginComposerControl {
	/** Arguments passed alongside `capability` by an `action` control. */
	args?: Record<string, unknown>;
	/** Capability an `action` control dispatches through the owning plugin's granted
	 *  capability seam. Never inline code, and never a capability it wasn't granted. */
	capability?: string;
	/** Initial `select` value, used until the user picks one. */
	default?: string;
	description?: string;
	/** The `plugin_flags` key this control binds to. Required for EVERY type, because
	 *  `plugin_flags` is the composer's only channel to the turn: a `toggle` writes a
	 *  bool, a `select` writes the chosen option `value`, a `chip` exposes (and clears)
	 *  its live value, and an `action` marks its dispatch so the turn hook sees it. */
	flag: string;
	/** Core-stamped declarative HTTP authority. */
	http_policy?: unknown;
	icon?: string;
	id: string;
	label: string;
	/** The options a `select` control offers. */
	options?: PluginComposerControlOption[];
	order?: number;
	/** Where the control is drawn: the "+" menu (default) or the composer bar itself. */
	placement?: "menu" | "bar";
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	/** Live value source polled by a `chip` control. */
	source?: ViewSource;
	type: string;
}

/** A messaging-channel adapter contributed by an enabled plugin
 *  (`RunnableKind::Channel`). Mirrors Core's `AppChannel`. */
export interface PluginChannel {
	id: string;
	name: string;
	platform: string;
}

/** A per-message toolbar action an enabled plugin contributes
 *  (`contributes.message_actions`), tagged with its owning `plugin`.
 *
 *  `kind` is the render discriminant and stays a bare string on purpose — a kind
 *  this build predates still arrives and must be skipped, not break the toolbar.
 *  The vocabulary today: `"button"` (fire-and-forget dispatch), `"toggle-group"`
 *  (mutually-exclusive states, what thumbs is), `"menu"`. `target` narrows which
 *  messages the action attaches to (`"assistant"` | `"user"` | `"any"`).
 */
export interface PluginMessageAction {
	args?: Record<string, unknown>;
	/** Capability the shell invokes when the action fires, through the owning
	 *  plugin's granted capability seam (never inline code). */
	capability?: string;
	/** Core-stamped declarative HTTP authority. */
	http_policy?: unknown;
	icon?: string;
	id: string;
	kind: string;
	label: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	/** Optional ViewSource polled to hydrate current state (what lights the thumb
	 *  on reload). */
	state_source?: ViewSource;
	/** For `toggle-group`: `{ value, label, icon?, active_icon? }[]`. */
	states?: {
		active_icon?: string;
		icon?: string;
		label: string;
		value: string;
	}[];
	target: string;
}

/** A text-selection toolbar action an enabled plugin contributes
 * (`contributes.selection_actions`), tagged with its owning `plugin`. */
export interface PluginSelectionAction {
	args?: Record<string, unknown>;
	/** Optional capability for plugin-owned dispatch. Host-owned actions may use
	 * an opaque `args.dispatch` bridge instead. */
	capability?: string;
	icon?: string;
	id: string;
	kind: string;
	label: string;
	order?: number;
	plugin: string;
}

/** A context-menu row an enabled plugin contributes
 *  (`contributes.context_menu_items`), tagged with its owning `plugin`.
 *
 *  `anchor` names the shell menu the row lands in (`"conversation"` |
 *  `"message"` | `"space"` | `"agent"` | `"project"` | `"workflow"` |
 *  `"skill"`). `feedback` carries the shell's toast copy: `{ loading, success,
 *  error }`.
 */
export interface PluginContextMenuItem {
	anchor: string;
	args?: Record<string, unknown>;
	/** Capability the shell invokes when the row is clicked, through the owning
	 *  plugin's granted capability seam. */
	capability?: string;
	feedback?: { error?: string; loading?: string; success?: string };
	icon?: string;
	id: string;
	label: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
}

/** A create-menu row an enabled plugin contributes
 *  (`contributes.create_actions`), tagged with its owning `plugin`.
 *
 *  Exactly one of `target` (an in-app route to open) or `capability` (a granted
 *  host capability to invoke) drives the row; Core rejects a manifest that
 *  declares neither.
 */
export interface PluginCreateAction {
	args?: Record<string, unknown>;
	/** Capability invoked when the row is clicked, through the owning plugin's
	 *  granted capability seam. */
	capability?: string;
	icon?: string;
	id: string;
	label: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	/** In-app route the shell opens (e.g. `/workflows/new`). */
	target?: string;
	/** Title for the opened tab. Defaults to `label`. */
	title?: string;
}

/** A companion-surface descriptor contributed by an enabled plugin
 *  (`RunnableKind::Companion`). Mirrors Core's `AppCompanion`. `icon`/`shortcut`
 *  are omitted by serde when null, so they are optional here.
 *
 *  `approvedGrants` is the GATEWAY-VALIDATED grant subset for the owning plugin
 *  (from `enable_app`), the ONLY correct source for building the host capability
 *  set (never the manifest's `permissionGrants` CLAIM). `hasUi` is true when the
 *  plugin carries a bundled UI (a `ui-bundle` is fetchable) — the third-party
 *  code-execution path only engages when this is true. */
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
	const resp = await authenticatedFetch(target, "/api/plugins/contributions", {
		method: "GET",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...identityHeaders(),
		},
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins/contributions failed: ${resp.status}`);
	}
	const json = (await resp.json()) as Partial<
		Omit<PluginContributions, "companions">
	> & { companions?: PluginCompanionWire[] };
	return {
		agent_edit_panels: json.agent_edit_panels ?? [],
		composer_controls: json.composer_controls ?? [],
		chat_features: json.chat_features ?? [],
		chat_widget_templates: json.chat_widget_templates ?? [],
		settings_tabs: json.settings_tabs ?? [],
		message_actions: json.message_actions ?? [],
		selection_actions: json.selection_actions ?? [],
		output_styles: json.output_styles ?? [],
		context_menu_items: json.context_menu_items ?? [],
		create_actions: json.create_actions ?? [],
		slash_commands: json.slash_commands ?? [],
		turn_hooks: json.turn_hooks ?? [],
		hook_events: json.hook_events ?? [],
		views: json.views ?? [],
		sidebar_sections: json.sidebar_sections ?? [],
		sidebar_modes: json.sidebar_modes ?? [],
		sidebar_buttons: json.sidebar_buttons ?? [],
		themes: json.themes ?? [],
		dock_panels: json.dock_panels ?? [],
		live_activities: json.live_activities ?? [],
		store_tabs: json.store_tabs ?? [],
		channels: json.channels ?? [],
		companions: (json.companions ?? []).map(toPluginCompanion),
		// `widget_apps` is declared non-optional on PluginContributions but was never
		// carried across this boundary, so every reader saw `undefined` behind an
		// array type. Defaulted here for the same reason as its siblings.
		widget_apps: json.widget_apps ?? [],
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
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodeURIComponent(id)}/ui-bundle`,
		{ method: "GET", headers: makeHeaders(target.token, target.userJwt) }
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
		resp = await authenticatedFetch(
			target,
			`/api/plugins/${encodeURIComponent(pluginId)}/host`,
			{
				method: "POST",
				headers: makeHeaders(target.token, target.userJwt),
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
		resp = await authenticatedFetch(
			target,
			`/api/plugins/${encodeURIComponent(pluginId)}/host/stream`,
			{
				method: "POST",
				headers: makeHeaders(target.token, target.userJwt),
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
 * fine-tune run's live progress SSE for the `@ryu/finetune` app. Unlike
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
		resp = await authenticatedFetch(
			target,
			`/api/plugins/${encodeURIComponent(pluginId)}/host/stream`,
			{
				method: "POST",
				headers: makeHeaders(target.token, target.userJwt),
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
	const resp = await authenticatedFetch(
		target,
		"/api/plugins/activation-event",
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ event: `onCommand:${commandId}` }),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/plugins/activation-event failed: ${resp.status}`);
	}
}

/** `POST /api/plugins/:id/install` — record the app as installed (disabled). */
export async function installApp(
	target: ApiTarget,
	id: string,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppRecord> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/install`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			skipUserJwt: options.skipUserJwt,
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/install`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { app: AppRecordWire };
	return toAppRecord(json.app);
}

/** Install a standalone app's local manifest/UI carriage through Core's
 * validated install-bundle sink. The app id and UI hash are still validated by
 * Core; the host never writes plugin files directly. */
export async function installStandaloneAppBundle(
	target: ApiTarget,
	bundle: StandaloneAppBundle,
	options: { skipUserJwt?: boolean } = {}
): Promise<void> {
	const manifest = {
		...bundle.manifest,
		...(bundle.uiCode === null ? {} : { ui_code: bundle.uiCode }),
	};
	const resp = await authenticatedFetch(target, "/api/plugins/install-bundle", {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify(manifest),
		skipUserJwt: options.skipUserJwt,
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/install-bundle");
		throw Object.assign(new Error(err.message), err);
	}
}

/** Install a standalone app through Core's trusted built-in path when available.
 * Built-in manifests retain Core-tier sidecar/MCP authority and their compiled UI
 * seed. A genuinely external app falls back to the local bundle sink instead. */
export async function installStandaloneApp(
	target: ApiTarget,
	id: string,
	bundle: StandaloneAppBundle,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppInfo> {
	try {
		await installApp(target, id, options);
		const installed = (await fetchApps(target, options)).find(
			(app) => app.id === id
		);
		if (installed) {
			return installed;
		}
		throw new Error(`Ryu Core did not register ${id} after built-in install.`);
	} catch (cause) {
		const status =
			cause instanceof Error && "status" in cause
				? (cause as Error & { status?: unknown }).status
				: undefined;
		if (status !== 404) {
			throw cause;
		}
	}

	await installStandaloneAppBundle(target, bundle, options);
	const installed = (await fetchApps(target, options)).find(
		(app) => app.id === id
	);
	if (!installed) {
		throw new Error(`Ryu Core did not register ${id} after bundle install.`);
	}
	return installed;
}

/** `POST /api/plugins/:id/update` — reinstall an installed plugin at the newest
 *  manifest version from its catalog source. Used by the download center's
 *  "Available updates" section when the installed version trails the catalog. */
export async function updateInstalledPlugin(
	target: ApiTarget,
	id: string,
	/** Switch the install onto another release train and move it to that train's
	 *  current build. Omit to update along the channel the plugin already follows.
	 *
	 *  A switch does not need `force`, even though every prerelease sorts BELOW its
	 *  stable release: Core treats an explicit switch as its own authority and
	 *  reports the version delta back on `channel_switch`. */
	channel?: string | null
): Promise<AppRecord> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/update`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify(channel ? { channel } : {}),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/update`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = (await resp.json()) as { app: AppRecordWire };
	return toAppRecord(json.app);
}

/** Reinstall one exact historical Marketplace version. The explicit `force`
 *  authority is scoped to this user-selected version so Core can safely allow a
 *  downgrade without changing ordinary update semantics. */
export async function updateInstalledPluginAtVersion(
	target: ApiTarget,
	id: string,
	version: string
): Promise<AppRecord> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/update`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ force: true, version }),
		}
	);
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
	id: string,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppToggleResult> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/enable`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			skipUserJwt: options.skipUserJwt,
		}
	);
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
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/grants`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ grants }),
		}
	);
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
	const encodedId = encodeURIComponent(id);
	const path = options?.cascade
		? `/api/plugins/${encodedId}/disable?cascade=true`
		: `/api/plugins/${encodedId}/disable`;
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
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
	const encodedId = encodeURIComponent(id);
	const path = options?.cascade
		? `/api/plugins/${encodedId}/uninstall?cascade=true`
		: `/api/plugins/${encodedId}/uninstall`;
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
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

/** Presentational banner descriptor for an app's hero region.
 *
 *  Re-exported rather than re-declared: this file used to carry its own copy with a
 *  REQUIRED `colors`, so the two drifted the moment the render layer learned
 *  `background`/`imageUrl` — the wire carried those keys through fine (the entry is
 *  verbatim JSON) while the desktop type could not express them. */
export type { CatalogBanner };

/** A single installable-app entry from Core's remote registry
 *  (`GET /api/plugins/catalog`). Pure discovery metadata — lifecycle state
 *  (installed/enabled) lives on {@link AppInfo} and is joined by `id`. */
export interface CatalogEntry {
	/** Hex accent color used for chrome tinting / banner fallback. */
	accent_color?: string | null;
	author?: string | null;
	/** Hero-banner descriptor (colors + gradient/dither style). */
	banner?: CatalogBanner | null;
	built_in: boolean;
	/** Ids of separate plugins this app ships as a logical bundle. */
	bundles?: string[] | null;
	capabilities?: string[];
	/** Store category label (e.g. "Productivity"). */
	category?: string | null;
	description: string;
	/** When true, this row is a browse-only integration descriptor (integrations.sh). */
	descriptor_only?: boolean;
	/** Publisher / developer name shown on the card + detail. */
	developer?: string | null;
	/** Relative Ryu proxy route for the signed release asset. */
	download_url?: string | null;
	/** Public release-asset downloads, summed across release payloads only. */
	downloads?: number | null;
	example_prompts?: string[];
	external?: boolean;
	/** Redacted GitHub repository/release provenance. */
	github_source?: Record<string, unknown> | null;
	homepage?: string | null;
	/** Icon-primitive glyph id painted inside the tile. Declared here as well as on
	 *  `@ryu/marketplace`'s `CatalogEntry` because it is on the same wire and the
	 *  Store's Home rows read it — without it those rows fell back to the
	 *  generative placeholder and Home was the one tab whose icons were wrong. */
	icon?: string | null;
	/** Optional CSS background for the icon square (e.g. a gradient). */
	icon_background?: string | null;
	/** The listing's dithered icon wash, when it declares one. */
	icon_dither?: CardDither | null;
	/** Remote icon URL when provided by the catalog source. */
	icon_url?: string | null;
	id: string;
	/** MCP / OpenAPI / GraphQL / CLI when sourced from integrations.sh. */
	integration_kind?: string | null;
	/** Link to the integration docs, spec, or MCP endpoint. */
	integration_url?: string | null;
	keywords?: string[];
	kinds: string[];
	layers?: CatalogLayer[];
	/** SPDX licence id, when the source reports one. */
	license?: string | null;
	/** Server-derived A Major Pass inclusion marker for catalog presentation. */
	membership_included?: boolean;
	name: string;
	/** Who listed this and how vetted it is. `"community"` = discovered
	 *  automatically from a public GitHub topic and NOT reviewed by Ryu; absent
	 *  = first-party. MUST stay snake_case — this is the exact key Core's
	 *  `plugin_marketplace_item_to_entry` emits, and a camelCase spelling would
	 *  read as undefined, i.e. an unreviewed listing rendered with no notice. */
	origin?: "community" | "first_party" | null;
	/** SHA-256 of the immutable package release asset. */
	package_checksum?: string | null;
	/** Canonical portable package kind for GitHub-backed marketplace entries. */
	package_kind?: string | null;
	permission_grants: string[];
	/** Commerce disclosure for a PAID listing; absent/null = free. Present on cards
	 *  in the unified first-party view, where free (git catalog) and paid (hosted)
	 *  listings sit in one list — without it a paid item is indistinguishable from a
	 *  free one until checkout. Display only; it does not gate the install handoff. */
	pricing?: {
		amountMinor?: number;
		currency?: string;
		kind?: string;
	} | null;
	privacy_policy_url?: string | null;
	/** Which discovery source produced this listing (e.g. `"github-topic"`). */
	provenance?: string | null;
	/** Denormalized rating aggregate (0–5 mean + count), so a card and the detail
	 *  header show stars without loading the review list. Absent = unrated. */
	rating_average?: number | null;
	rating_count?: number | null;
	/** Repository a community listing was discovered from. */
	repo_url?: string | null;
	repository_url?: string | null;
	/** Plugin-to-plugin dependencies that must be enabled first (the manifest's
	 *  `requires`). Emitted by Core's catalog source when non-empty; absent = none.
	 *  Kept in sync with `@ryu/marketplace/catalog/types`' `CatalogEntry`, which is
	 *  the shape the shared catalog sections consume. */
	requires?: {
		apps?: { id: string; min_version?: string | null }[];
		grants?: string[];
	} | null;
	/** False when nobody at Ryu vetted this listing. Absent ≠ reviewed. */
	reviewed?: boolean;
	/** The bundled sub-items this item ships (the manifest runnables). */
	runnables?: { id: string; kind: string; name?: string }[];
	screenshots?: string[];
	source: string;
	/** Upstream popularity signal (GitHub stars) for unmoderated listings. */
	stars?: number | null;
	/** Per-surface support levels, preserved for shared Marketplace detail. */
	surface_support?: CatalogSurfaceSupport[];
	/** Short one-line pitch shown under the name. */
	tagline?: string | null;
	tags: string[];
	terms_of_service_url?: string | null;
	/** A theme listing's own palette (manifest `contributes.themes[0].preview`).
	 *  The Store paints this as its icon square instead of a dither avatar or a
	 *  generic glyph. Absent on everything that is not a theme. */
	theme_preview?: CardThemePreview | null;
	/** Explicit app-vs-plugin discriminator (preferred over the kinds derivation). */
	type?: "app" | "plugin";
	version: string;
	website?: string | null;
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
	/** Browse a non-default catalog slice without changing the active-source
	 *  preference. `"community"` routes to Core's GitHub topic-discovery source
	 *  (`?origin=community`), so the Community store section coexists with
	 *  Apps/Plugins instead of replacing them. */
	origin?: "community";
	query?: string;
	/** Browse a specific catalog source WITHOUT writing the node's active-source
	 *  preference. The preference is one global setting, so selecting a source used
	 *  to reassign every other open store tab (and every other client on the node);
	 *  passing the id per request keeps the choice local to the view that made it.
	 *  Omitted ⇒ Core falls back to the stored preference. */
	source?: string;
}

export interface PluginCatalogPage {
	appTotal?: number | null;
	entries: CatalogEntry[];
	nextCursor: string | null;
	note: string | null;
	pluginTotal?: number | null;
	total?: number | null;
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
	if (params.origin) {
		q.set("origin", params.origin);
	}
	if (params.source) {
		q.set("source", params.source);
	}
	const json = await request<{
		app_total?: number | null;
		entries?: CatalogEntry[];
		next_cursor?: string | null;
		note?: string | null;
		plugin_total?: number | null;
		total?: number | null;
		total_count?: number | null;
	}>(target, `/api/plugins/catalog/browse?${q.toString()}`);
	return {
		appTotal: json.app_total ?? null,
		entries: json.entries ?? [],
		nextCursor: json.next_cursor ?? null,
		note: typeof json.note === "string" ? json.note : null,
		pluginTotal: json.plugin_total ?? null,
		total: json.total ?? json.total_count ?? null,
	};
}

/** Detail payload for a federated catalog entry (integrations.sh descriptor). */
export type { VersionSnapshot } from "@ryu/marketplace/catalog/types";

export interface PluginCatalogDetail {
	accentColor?: string | null;
	author?: string | null;
	banner?: CatalogBanner | null;
	capabilities?: string[];
	categories?: string[];
	category?: string | null;
	description?: string | null;
	descriptor?: {
		integration_kind?: string;
		kind?: string;
		url?: string | null;
		domain?: string | null;
	};
	domain?: string | null;
	downloads?: number | null;
	examplePrompts?: string[];
	extensions?: CatalogExtensionSummary[];
	external?: boolean;
	feeds?: string[];
	iconBackground?: string | null;
	iconUrl?: string | null;
	id: string;
	implementation?: CatalogImplementationSummary[];
	integration_kind?: string | null;
	keywords?: string[];
	kind?: string | null;
	layers?: CatalogLayer[];
	license?: string | null;
	name?: string;
	privacyPolicyUrl?: string | null;
	repositoryUrl?: string | null;
	screenshots?: string[];
	source?: string;
	sourceUrl?: string | null;
	surfaceSupport?: CatalogSurfaceSupport[];
	tagline?: string | null;
	tags?: string[];
	termsOfServiceUrl?: string | null;
	updatedAt?: string | null;
	url?: string | null;
	version?: string | null;
	website?: string | null;
}

/** Fetch detail for the selected entry from the active plugin catalog source. */
export async function fetchPluginCatalogDetail(
	target: ApiTarget,
	id: string,
	origin?: "community",
	/** The source the list was browsed from — see {@link PluginSearchParams.source}.
	 *  Must match the browse call, so a detail request resolves against the same
	 *  catalog the card came from. */
	source?: string
): Promise<PluginCatalogDetail> {
	const q = new URLSearchParams({ id });
	if (origin) {
		q.set("origin", origin);
	}
	if (source) {
		q.set("source", source);
	}
	const detail = await request<
		Omit<PluginCatalogDetail, "author"> & { author?: unknown }
	>(target, `/api/plugins/catalog/detail?${q.toString()}`);
	const rawAuthor = detail.author;
	const author =
		typeof rawAuthor === "string"
			? rawAuthor
			: rawAuthor &&
					typeof rawAuthor === "object" &&
					!Array.isArray(rawAuthor) &&
					typeof (rawAuthor as { name?: unknown }).name === "string"
				? (rawAuthor as { name: string }).name
				: null;
	return { ...detail, author };
}

/** `GET /api/plugins/catalog/version-detail` — the listing as it stood at one
 *  published version's tag.
 *
 *  `tag` is the Versions tab's `version` field, which IS the raw git tag_name
 *  (`v1.2.0`, not `1.2.0`), so it passes straight through with no normalisation.
 *
 *  Resolves to `null` rather than throwing when the tag has no readable manifest —
 *  the normal case for tags predating the listing being packaged, which the UI
 *  renders as "not published at this tag", not as a failure. */
export async function fetchPluginVersionDetail(
	target: ApiTarget,
	repo: string,
	tag: string
): Promise<import("@ryu/marketplace/catalog/types").VersionSnapshot | null> {
	const q = new URLSearchParams({ repo, tag });
	try {
		return await request<
			import("@ryu/marketplace/catalog/types").VersionSnapshot
		>(target, `/api/plugins/catalog/version-detail?${q.toString()}`);
	} catch {
		return null;
	}
}

/** `GET /api/plugins/catalog/channels` — the release trains a listing publishes,
 *  each with the version it currently resolves to.
 *
 *  Both lookups in one call: `id` asks the marketplace (trains that can actually
 *  be installed), `repo` derives them from the repository's release tags (what an
 *  author tagged — browse-only). Core prefers the marketplace answer when it has
 *  one, and flags each row with `installable` so a picker never offers a
 *  selection it cannot act on.
 *
 *  Resolves to `[]` on any failure. That is "no trains known", NOT "stable only":
 *  the caller renders no picker rather than inventing one. */
export async function fetchPluginChannels(
	target: ApiTarget,
	id: string,
	repo?: string | null
): Promise<import("@ryu/marketplace/catalog/types").CatalogChannel[]> {
	const q = new URLSearchParams({ id });
	if (repo) {
		q.set("repo", repo);
	}
	try {
		const body = await request<{
			channels?: import("@ryu/marketplace/catalog/types").CatalogChannel[];
		}>(target, `/api/plugins/catalog/channels?${q.toString()}`);
		return body.channels ?? [];
	} catch {
		return [];
	}
}

/** `POST /api/plugins/install` — install a plugin from an `https://` manifest.json URL.
 *  Core records it installed+disabled (enable is a separate, grant-gated step). */
export async function installAppFromUrl(
	target: ApiTarget,
	url: string
): Promise<void> {
	const resp = await authenticatedFetch(target, "/api/plugins/install", {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
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
 * `x-ryu-buyer-token` for optional account-aware Marketplace operations; it is
 * not required for a paid or free plugin install.
 */
export async function installPluginFromCatalog(
	target: ApiTarget,
	id: string,
	buyerToken?: string | null,
	/** The release train to install from — omit (or pass `stable`) for the ordinary
	 *  published version. Core PERSISTS the choice, so the plugin keeps following
	 *  this train on every later update instead of being pulled back to stable. */
	channel?: string | null
): Promise<void> {
	const headers = makeHeaders(target.token, target.userJwt);
	if (buyerToken) {
		headers["x-ryu-buyer-token"] = buyerToken;
	}
	const resp = await authenticatedFetch(
		target,
		"/api/plugins/catalog/install",
		{
			method: "POST",
			headers,
			body: JSON.stringify(channel ? { id, channel } : { id }),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/catalog/install");
		throw Object.assign(new Error(err.message), err);
	}
}

/** Install one exact historical Marketplace version through Core's signed
 * catalog resolver. This intentionally has a separate name so ordinary channel
 * installs cannot accidentally start carrying a one-off version pin. */
export async function installPluginFromCatalogAtVersion(
	target: ApiTarget,
	id: string,
	version: string,
	buyerToken?: string | null
): Promise<void> {
	const headers = makeHeaders(target.token, target.userJwt);
	if (buyerToken) {
		headers["x-ryu-buyer-token"] = buyerToken;
	}
	const resp = await authenticatedFetch(
		target,
		"/api/plugins/catalog/install",
		{
			method: "POST",
			headers,
			body: JSON.stringify({ id, version }),
		}
	);
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
	const resp = await authenticatedFetch(target, "/api/sidecar/status", {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
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
	const resp = await authenticatedFetch(target, "/api/sidecar/status", {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
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
	const resp = await authenticatedFetch(target, "/api/engine/concurrency", {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
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
	const resp = await authenticatedFetch(target, `/api/setup/${name}/install`, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
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
	const resp = await authenticatedFetch(target, `/api/sidecar/${name}/start`, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
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
	const resp = await authenticatedFetch(target, `/api/sidecar/${name}/stop`, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/stop failed: ${resp.status}`);
	}
}
