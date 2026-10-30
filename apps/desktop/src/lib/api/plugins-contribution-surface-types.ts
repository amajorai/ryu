import type { LiveActivityContribution } from "@ryu/app-host/live-activity";
import type { RawViewContribution, ViewSource } from "@ryu/app-host/views";
import {
	type PluginDocument,
	type PluginValue,
	pluginBooleanField,
} from "./plugin-wire-values.ts";

/** A declarative-view contribution as served by Core (`contributes.views[]`), tagged
 *  with its owning `plugin`. Shape-identical to the shared `@ryu/app-host/views`
 *  {@link ViewContribution} — re-exported here so contributions consumers need only
 *  the plugins API. */
export type PluginView = RawViewContribution;

/** A live-activity contribution as served by Core (`contributes.live_activities[]`),
 *  tagged with its owning `plugin`. Shape-identical to the shared
 *  `@ryu/app-host/live-activity` {@link LiveActivityContribution} — re-exported here
 *  so contributions consumers need only the plugins API. */
export type PluginLiveActivity = Omit<
	LiveActivityContribution,
	"spec" | "http_policy"
> & { spec?: PluginValue; http_policy?: PluginValue };

/** The preferred opening region for a {@link PluginDockPanel}. Mirrors the Rust
 *  `DockPanelPlacement`; the preference never restricts later movement, while
 *  `"both"` retains the legacy bottom/right offering. */
export type PluginDockPlacement =
	| "bottom"
	| "right"
	| "left"
	| "center"
	| "both";

/** An app-registered workspace workbench tab as served by Core
 *  (`contributes.dock_panels[]`), tagged with its owning `plugin`.
 *
 *  `panel` is the render-mode discriminant (the `DockPanelKind` vocabulary — `"companion"`,
 *  `"view"`, `"native"`) and stays a bare string so a member this build predates is
 *  still delivered; the renderer must ignore what it does not know. `spec` carries the
 *  mode's payload ({@link DockPanelSpec}). */
export interface PluginFileHandler {
	companion: string;
	editable: boolean;
	extensions: string[];
	id: string;
	plugin: string;
	title: string;
}

export interface PluginDockPanel {
	icon?: string;
	id: string;
	order?: number;
	/** Render mode: `"companion"` | `"view"` | `"native"` | a newer member. */
	panel: string;
	/** Preferred opening region; the user may move the tab afterward. */
	placement: PluginDockPlacement;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: PluginValue;
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
	args?: PluginDocument;
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
	http_policy?: PluginValue;
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
	args?: PluginDocument;
	/** Capability the shell invokes when the action fires, through the owning
	 *  plugin's granted capability seam (never inline code). */
	capability?: string;
	/** Core-stamped declarative HTTP authority. */
	http_policy?: PluginValue;
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
	args?: PluginDocument;
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
	args?: PluginDocument;
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
	args?: PluginDocument;
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
	/** Whether to inject the restricted default CSP when this app has no trusted declaration. */
	defaultCspEnforced: boolean;
	/** Core-derived provenance: true only for a manifest compiled into the binary. */
	firstParty?: boolean;
	hasUi: boolean;
	icon?: string;
	id: string;
	label: string;
	/** External MCP App entrypoint, opened through Core's governed dispatcher. */
	mcpToolId?: string;
	name: string;
	/** Contextual MCP entrypoints keep a route but do not become global launch targets. */
	navigationVisible?: boolean;
	/** The owning plugin's manifest id (the PluginStore key). The UI bundle is
	 *  keyed by this, NOT by the companion id (`app__<runnable id>`). */
	pluginId: string;
	shortcut?: string;
}

/** Wire shape of a companion (snake_case from Rust serde). */
export interface PluginCompanionWire {
	approved_grants?: string[];
	csp?: {
		connect_domains?: string[];
		resource_domains?: string[];
	} | null;
	default_csp_enforced?: boolean;
	first_party?: boolean;
	has_ui?: boolean;
	icon?: string;
	id: string;
	label: string;
	mcpToolId?: string;
	name: string;
	navigationVisible?: boolean;
	plugin_id?: string;
	shortcut?: string;
}

export function toPluginCompanion(w: PluginCompanionWire): PluginCompanion {
	return {
		navigationVisible: pluginBooleanField(w.navigationVisible),
		mcpToolId:
			w.mcpToolId !== undefined && w.mcpToolId.length <= 512
				? w.mcpToolId
				: undefined,
		id: w.id,
		name: w.name,
		firstParty: w.first_party ?? false,
		label: w.label,
		icon: w.icon,
		shortcut: w.shortcut,
		pluginId: w.plugin_id ?? "",
		approvedGrants: w.approved_grants ?? [],
		hasUi: w.has_ui ?? false,
		defaultCspEnforced: pluginBooleanField(w.default_csp_enforced) ?? true,
		csp: w.csp
			? {
					connectDomains: w.csp.connect_domains ?? [],
					resourceDomains: w.csp.resource_domains ?? [],
				}
			: undefined,
	};
}
