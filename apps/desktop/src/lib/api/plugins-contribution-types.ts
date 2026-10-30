import type {
	AvatarAccessory,
	AvatarStyle,
} from "@ryu/ui/components/avatar-parts.ts";
import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import type { PluginBackground } from "./plugin-contribution-boundary.ts";
import type { PluginDocument, PluginValue } from "./plugin-wire-values.ts";
import type {
	PluginChannel,
	PluginCompanion,
	PluginComposerControl,
	PluginContextMenuItem,
	PluginCreateAction,
	PluginDockPanel,
	PluginFileHandler,
	PluginLiveActivity,
	PluginMessageAction,
	PluginSelectionAction,
	PluginView,
} from "./plugins-contribution-surface-types.ts";

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
	payload_example?: PluginDocument;
	/** The owning plugin id, stamped server-side. */
	plugin?: string;
	title: string;
}

/** Opaque host-rendered chat feature declaration from an enabled plugin. Core
 * stamps `plugin`; the remaining vocabulary belongs to the desktop surface. */
export interface PluginChatFeature {
	plugin?: string;
	[key: string]: PluginValue | undefined;
}

/** A local planner model advertised by an enabled plugin. */
export interface PluginComputerUsePlanner {
	description?: string;
	id: string;
	label: string;
	model_id: string;
	plugin: string;
}

export interface PluginContributions {
	/** Agent Edit panels supplied by enabled plugins. Panels are interpreted by
	 * the desktop shell only by their declared type; the owning plugin id is
	 * provenance, never a routing switch. */
	agent_edit_panels: PluginAgentEditPanel[];
	/** Agent profile tabs supplied by enabled plugins; each embeds one of the
	 * owning plugin's companions scoped to the profiled agent. */
	agent_profile_tabs?: PluginAgentProfileTab[];
	/** Data-only avatar accessories enabled plugins contribute for the Ryu ghost
	 *  or for an avatar style (`contributes.avatar_accessories`). */
	avatar_accessories: AvatarAccessory[];
	/** Data-only avatar styles enabled plugins contribute (`contributes.avatar_styles`). */
	avatar_styles: AvatarStyle[];
	/** Data-only desktop wallpaper variants contributed by enabled plugins. */
	backgrounds: PluginBackground[];
	/** Messaging-channel adapters an enabled plugin makes available. */
	channels: PluginChannel[];
	/** Host-rendered chat feature declarations, tagged with their owning plugin. */
	chat_features: PluginChatFeature[];
	chat_widget_templates?: PluginChatWidgetTemplate[];
	/** Companion surfaces (overlay/sidebar panels) an enabled plugin declares. */
	companions: PluginCompanion[];
	composer_controls: PluginComposerControl[];
	/** Local model adapters for Shadow's computer-use planner. */
	computer_use_planners: PluginComputerUsePlanner[];
	/** Context-menu rows enabled plugins contribute (`contributes.context_menu_items`),
	 *  tagged with `plugin`. The declarative replacement for hardcoded shell menu
	 *  rows like "Make a skill from this chat". */
	context_menu_items: PluginContextMenuItem[];
	/** "New X" rows enabled plugins contribute to the create menu
	 *  (`contributes.create_actions`), tagged with `plugin`. The declarative
	 *  replacement for create rows the shell used to hardcode for apps that may
	 *  not even be installed. */
	create_actions: PluginCreateAction[];
	/** App-registered workbench tabs with preferred opening regions, tagged with
	 *  `plugin`. The declarative replacement for the shell's closed `TabKind` union. */
	dock_panels: PluginDockPanel[];
	file_handlers?: PluginFileHandler[];
	/** App events enabled apps EMIT (`contributes.hook_events`), tagged with the
	 *  owning `plugin` id. The provider half of the hook system, whose consumer half
	 *  is {@link PluginContributions.turn_hooks}: this is the catalog a user picks
	 *  from when subscribing a workflow or a hook to "when X happens". */
	hook_events: PluginHookEvent[];
	/** Data-only Marketplace interfaces (`contributes.interfaces`) from enabled
	 *  plugins, validated into {@link InterfaceDescriptor}s at this boundary. Each
	 *  names a host-owned workspace renderer plus bounded params; none ships code. */
	interfaces: InterfaceDescriptor[];
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
	settings_tabs: PluginDocument[];
	/** App-registered sidebar buttons (single nav rows), tagged with `plugin`. */
	sidebar_buttons: PluginSidebarButton[];
	/** App-registered sidebar MODES (named arrangements of the whole sidebar),
	 *  tagged with `plugin`. See {@link PluginSidebarMode}. */
	sidebar_modes: PluginSidebarMode[];
	/** App-registered sidebar sections (header + live list), tagged with `plugin`. */
	sidebar_sections: PluginSidebarSection[];
	slash_commands: PluginDocument[];
	/** App-registered marketplace tabs, tagged with `plugin` + the app's
	 *  install/enable state. The ONE family Core serves for disabled and
	 *  not-installed apps too — see {@link PluginStoreTab}. */
	store_tabs: PluginStoreTab[];
	/** Colour themes contributed by enabled plugins (`contributes.themes`), tagged
	 *  with `plugin`. Shape-identical to the shell's own `ThemeVariant`, so an
	 *  installed theme and a built-in one are the same object by the time the
	 *  Appearance picker renders them. */
	themes: PluginTheme[];
	turn_hooks: PluginDocument[];
	/** Declarative views (the Raycast tier) contributed by enabled plugins. Each is a
	 *  {@link ViewContribution} the desktop/island renderer maps to native components,
	 *  tagged server-side with its owning `plugin` id. */
	views: PluginView[];
	/** Enabled apps that render interactive cards inline in chat (status only —
	 *  the widget bindings themselves are Core-interpreted and not served here). */
	widget_apps: PluginWidgetApp[];
}

/** A tab contributed to the agent profile panel (`contributes.agent_profile_tabs[]`).
 *  The host mounts `companion` with `{ surface: "agent-profile", agentId }`. */
export interface PluginAgentProfileTab {
	companion: string;
	icon?: string;
	id: string;
	order?: number;
	plugin: string;
	title: string;
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
	http_policy?: PluginValue;
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: PluginValue;
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
	http_policy?: PluginValue;
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	spec?: PluginValue;
	subtitle?: string;
	title: string;
	/** Named first-party renderer; gated by plugin id, never by this string. */
	view?: string;
}

/** An app-registered sidebar BUTTON as served by Core (`contributes.sidebar_buttons[]`),
 *  tagged with its owning `plugin`. A single nav row that opens `target`. */
export interface PluginSidebarButton {
	/** Optional app context passed when the button opens the owning Companion. */
	context?: PluginDocument;
	icon?: string;
	id: string;
	order?: number;
	/** The owning plugin's manifest id (added by Core's contributions endpoint). */
	plugin: string;
	/** Client route the button opens (e.g. "/library/memory"). */
	target: string;
	title: string;
}
