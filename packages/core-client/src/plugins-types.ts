// packages/core-client/src/plugins-types.ts
//
// Client-side (camelCase) plugin types consumed by React and the TUI.
// Re-exported through `./plugins.ts`.

/** Safe catalog projection of one manifest surface. `inheritedFrom` is the
 * shared-shell relationship for Web, Mobile, and the Browser extension. */
export interface SurfaceSupportSummary {
	inheritedFrom?: string | null;
	support?: string | null;
	surface: string;
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
	/** Per-surface support levels from Core's catalog projection. */
	surfaceSupport: SurfaceSupportSummary[];
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
