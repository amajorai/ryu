// apps/desktop/src/lib/pluginSettings.ts
//
// Parse the opaque `settings_tabs` a plugin declares in its manifest
// (`contributes.settings_tabs`, served verbatim by
// `GET /api/plugins/contributions`) into a typed shape the desktop can render.
//
// Core stores each field as an untyped `serde_json::Value` and never validates
// its inner shape — so this parser is deliberately defensive: unknown field
// `type`s fall back to a plain text input, missing labels fall back to the pref
// key, and malformed entries are dropped rather than throwing. Each tab record
// arrives tagged with a `plugin` id (added by the contributions handler) so we
// can group tabs back under the plugin that owns them.
//
// Every field binds to a single preference key (`pref_key`), read/written
// through Core's generic KV store (`GET/PUT /api/preferences/:key`) — the same
// substrate the advisor/double-check/goal built-ins already use. Values are
// stored as bare strings (booleans as `"true"`/`"false"`), matching the
// existing preference conventions in `lib/api/preferences.ts`.

import { z } from "zod";

/** The control a plugin settings field renders as. Unknown types render as text. */
export type PluginFieldType =
	| "model_picker"
	| "agent_picker"
	| "text"
	| "textarea"
	| "toggle"
	| "select"
	| "number"
	| "secret";

/** One selectable option for a `select` field. */
export interface PluginSelectOption {
	label: string;
	value: string;
}

/** A single configurable field, bound to one preference key. */
export interface PluginSettingsField {
	/** Optional default when the preference is unset (bool/number/string). */
	default?: boolean | number | string;
	/** Optional helper text shown under the field. */
	description?: string;
	/** The display label for the field (falls back to the pref key). */
	label: string;
	/** Inclusive upper bound for a `number` field (ignored otherwise). */
	max?: number;
	/** Inclusive lower bound for a `number` field (ignored otherwise). */
	min?: number;
	/** Options for a `select` field (ignored otherwise). */
	options: PluginSelectOption[];
	/** Placeholder for text/model inputs. */
	placeholder?: string;
	/** The preference key this field reads/writes (`/api/preferences/:key`). */
	prefKey: string;
	/**
	 * Granularity for a `number` field's stepper. NOT declared in the Rust
	 * `SettingsFieldContribution` — it survives only because `settings_tabs`
	 * forwards the manifest's verbatim JSON, so a manifest that carries one is
	 * honoured and one that doesn't falls back to the browser's default step.
	 */
	step?: number;
	/** The control kind; unrecognized values render as a text input. */
	type: PluginFieldType | string;
}

/**
 * Which settings dialog a tab belongs in.
 * - `"node"` — affects the whole node/gateway (shared by every user on it); rendered
 *   in the Gateway (node) settings dialog. This is the default for a tab that does
 *   not declare a scope, matching the historical behaviour (tabs always wrote
 *   node-scoped preferences via the active node).
 * - `"user"` — per-user / desktop-client-local (like appearance); rendered in the
 *   App Settings dialog and does not affect other users on the same node.
 */
export type SettingsScope = "node" | "user";

/** A named group of fields a plugin contributes to the settings surface. */
export interface PluginSettingsTab {
	/** An owned companion mounted with a settings-specific context. */
	companion?: string;
	/**
	 * Whether the owning plugin is currently ENABLED (Core's `app_enabled`).
	 *
	 * Settings tabs are served for every INSTALLED plugin, enabled or not — you
	 * configure a plugin in order to make it worth enabling, so gating the tab on
	 * enablement hid it exactly when it was wanted. False means the values still
	 * save (they are plain preferences) but nothing reads them until the plugin is
	 * turned on, and the UI has to say so.
	 *
	 * Defaults to `true` when Core doesn't send the bit: an older Core served
	 * enabled plugins only, so every tab it sends is from one.
	 */
	enabled: boolean;
	fields: PluginSettingsField[];
	id: string;
	mcpSettings?: { readTool: string; updateTool: string; serverId?: string };
	/** The owning plugin id (manifest id), tagged by Core. */
	plugin: string;
	/** The dialog this tab renders in (node = Gateway, user = App Settings). */
	scope: SettingsScope;
	title: string;
	/**
	 * A rich settings view an app ships instead of declarative `fields`. When set,
	 * the desktop resolves it to a component (first-party built-in apps) or a
	 * sandboxed UI (through an explicit companion reference) rather than rendering `fields`. This is how
	 * an app whose settings can't be expressed as simple fields (a full custom UI)
	 * still registers through its manifest. Opaque here — the settings renderer owns
	 * the vocabulary.
	 */
	view?: string;
}

const optionalString = z.string().optional().catch(undefined);
const selectOptionSchema = z
	.union([
		z.string().transform((value) => ({ value, label: value })),
		z
			.object({ value: z.string(), label: optionalString })
			.transform((option) => ({
				value: option.value,
				label: option.label ?? option.value,
			})),
	])
	.optional()
	.catch(undefined);
const settingsFieldSchema = z
	.object({
		pref_key: optionalString,
		prefKey: optionalString,
		type: optionalString,
		label: optionalString,
		description: optionalString,
		placeholder: optionalString,
		options: z.array(selectOptionSchema).catch([]),
		default: z
			.union([z.boolean(), z.number(), z.string()])
			.optional()
			.catch(undefined),
		min: z.number().optional().catch(undefined),
		max: z.number().optional().catch(undefined),
		step: z.number().optional().catch(undefined),
	})
	.transform((field): PluginSettingsField | undefined => {
		const prefKey = field.pref_key ?? field.prefKey;
		if (!prefKey) {
			return undefined;
		}
		return {
			prefKey,
			type: field.type ?? "text",
			label: field.label ?? prefKey,
			description: field.description,
			placeholder: field.placeholder,
			options: field.options.filter((option) => option !== undefined),
			default: field.default,
			min: field.min,
			max: field.max,
			step: field.step,
		};
	})
	.optional()
	.catch(undefined);
const mcpSettingsDescriptorSchema = z
	.object({
		serverId: optionalString,
		readTool: z.string(),
		updateTool: z.string(),
	})
	.optional()
	.catch(undefined);
const settingsTabSchema = z.object({
	plugin: optionalString,
	id: optionalString,
	title: optionalString,
	fields: z.array(settingsFieldSchema).catch([]),
	view: optionalString,
	companion: optionalString,
	scope: z.enum(["user", "node"]).catch("node"),
	app_enabled: z.literal(false).optional().catch(undefined),
	mcpSettings: mcpSettingsDescriptorSchema,
});
export type PluginSettingsTabInput = Parameters<
	typeof settingsTabSchema.parse
>[0];

/** Parse Core's manifest contribution records, dropping entries without a renderable surface. */
export function parseSettingsTabs(
	raw: PluginSettingsTabInput[]
): PluginSettingsTab[] {
	const tabs: PluginSettingsTab[] = [];
	for (const entry of raw) {
		const parsed = settingsTabSchema.safeParse(entry);
		if (!(parsed.success && parsed.data.plugin)) {
			continue;
		}
		const tab = parsed.data;
		const plugin = parsed.data.plugin;
		const fields = tab.fields.filter((field) => field !== undefined);
		const settings = tab.mcpSettings;
		const serverId = settings?.serverId ?? plugin;
		const mcpSettings =
			settings?.readTool.startsWith(`${serverId}.`) &&
			settings.updateTool.startsWith(`${serverId}.`)
				? {
						readTool: settings.readTool,
						updateTool: settings.updateTool,
						serverId,
					}
				: undefined;
		if (fields.length === 0 && !tab.view && !tab.companion && !mcpSettings) {
			continue;
		}
		tabs.push({
			plugin,
			id: tab.id ?? `${plugin}.settings`,
			title: tab.title ?? "Settings",
			scope: tab.scope,
			enabled: tab.app_enabled !== false,
			fields,
			view: tab.view,
			companion: tab.companion,
			mcpSettings,
		});
	}
	return tabs;
}

/** Group parsed tabs by their owning plugin id, preserving order. */
export function groupTabsByPlugin(
	tabs: PluginSettingsTab[]
): Map<string, PluginSettingsTab[]> {
	const byPlugin = new Map<string, PluginSettingsTab[]>();
	for (const tab of tabs) {
		const existing = byPlugin.get(tab.plugin);
		if (existing) {
			existing.push(tab);
		} else {
			byPlugin.set(tab.plugin, [tab]);
		}
	}
	return byPlugin;
}

/** Tabs grouped by owning entity, split into the two settings headers. */
export interface ScopedEntityTabs {
	/** Entities that contribute a companion surface (Ryu Apps), by id → tabs. */
	apps: Map<string, PluginSettingsTab[]>;
	/** Everything else (plain plugins), by id → tabs. */
	plugins: Map<string, PluginSettingsTab[]>;
}

/**
 * Filter tabs to one {@link SettingsScope} and split them across the two nav
 * headers a settings dialog renders — **Apps** (entities with a companion) and
 * **Plugins** (the rest) — grouped by owning entity id, preserving order.
 *
 * `isApp` decides the header: an *app* is a plugin that contributes a companion
 * surface (`AppInfo.companion != null`); a *plugin* is one that does not. The
 * caller supplies the predicate (it holds the `useApps()` list); this stays a
 * pure function so both dialogs share it.
 */
export function splitScopedTabs(
	tabs: PluginSettingsTab[],
	scope: SettingsScope,
	isApp: (pluginId: string) => boolean
): ScopedEntityTabs {
	const apps = new Map<string, PluginSettingsTab[]>();
	const plugins = new Map<string, PluginSettingsTab[]>();
	for (const tab of tabs) {
		if (tab.scope !== scope) {
			continue;
		}
		const bucket = isApp(tab.plugin) ? apps : plugins;
		const existing = bucket.get(tab.plugin);
		if (existing) {
			existing.push(tab);
		} else {
			bucket.set(tab.plugin, [tab]);
		}
	}
	return { apps, plugins };
}

/** Prefix marking a dynamic Apps-header nav section value (`app:<pluginId>`). */
export const APP_SECTION_PREFIX = "app:";
/** Prefix marking a dynamic Plugins-header nav section value (`plugin:<pluginId>`). */
export const PLUGIN_SECTION_PREFIX = "plugin:";

/** True if a section value addresses a dynamic app/plugin entity tab. */
export function isEntitySection(value: string): boolean {
	return (
		value.startsWith(APP_SECTION_PREFIX) ||
		value.startsWith(PLUGIN_SECTION_PREFIX)
	);
}

/** Which dialog holds an entity's settings, and the section value that selects it. */
export interface SettingsDestination {
	/** `"gateway"` = the node dialog, `"app"` = the App Settings dialog. */
	dialog: "app" | "gateway";
	/** `app:<id>` / `plugin:<id>` — must match what the nav would have built. */
	section: string;
}

/**
 * Resolve where one plugin's settings live, for a surface that wants to send the
 * user straight there (the Store's per-listing Settings action).
 *
 * The returned `section` must be a value {@link splitScopedTabs} +
 * `buildEntityNavGroups` would also have produced for this plugin, because the
 * dialogs look it up in exactly that map and fall back to their default section
 * when it misses — a wrong prefix or scope is a silent no-op, not an error. Both
 * are derived here from the same tabs and the same `isApp` predicate the nav
 * uses, so the two cannot drift.
 *
 * A plugin with tabs at BOTH scopes resolves to the node one: `scope` defaults to
 * `"node"`, so that is where a plugin's ordinary fields (an API key among them)
 * land, and it is the tab someone hunting for credentials wants.
 *
 * Returns `null` when the plugin contributes no settings tab at all — the caller
 * should then render no affordance rather than one that opens a default page.
 */
export function resolveSettingsDestination(
	tabs: PluginSettingsTab[],
	isApp: (pluginId: string) => boolean,
	pluginId: string
): SettingsDestination | null {
	const prefix = isApp(pluginId) ? APP_SECTION_PREFIX : PLUGIN_SECTION_PREFIX;
	const section = `${prefix}${pluginId}`;
	const scopes = new Set(
		tabs.filter((t) => t.plugin === pluginId).map((t) => t.scope)
	);
	if (scopes.has("node")) {
		return { dialog: "gateway", section };
	}
	if (scopes.has("user")) {
		return { dialog: "app", section };
	}
	return null;
}

/** Coerce a stored bare-string preference into a boolean (for `toggle` fields). */
export function prefToBool(raw: string | null, fallback = false): boolean {
	if (raw === null) {
		return fallback;
	}
	const value = raw.trim().toLowerCase();
	return value === "true" || value === "1" || value === "on" || value === "yes";
}
