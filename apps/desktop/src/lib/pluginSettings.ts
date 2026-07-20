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

/** The control a plugin settings field renders as. Unknown types render as text. */
export type PluginFieldType =
	| "model_picker"
	| "text"
	| "textarea"
	| "toggle"
	| "select"
	| "number";

/** One selectable option for a `select` field. */
export interface PluginSelectOption {
	label: string;
	value: string;
}

/** A single configurable field, bound to one preference key. */
export interface PluginSettingsField {
	/** Optional helper text shown under the field. */
	description?: string;
	/** The display label for the field (falls back to the pref key). */
	label: string;
	/** Options for a `select` field (ignored otherwise). */
	options: PluginSelectOption[];
	/** Placeholder for text/model inputs. */
	placeholder?: string;
	/** The preference key this field reads/writes (`/api/preferences/:key`). */
	prefKey: string;
	/** The control kind; unrecognized values render as a text input. */
	type: PluginFieldType | string;
}

/** A named group of fields a plugin contributes to the settings surface. */
export interface PluginSettingsTab {
	fields: PluginSettingsField[];
	id: string;
	/** The owning plugin id (manifest id), tagged by Core. */
	plugin: string;
	title: string;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseOptions(value: unknown): PluginSelectOption[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: PluginSelectOption[] = [];
	for (const raw of value) {
		if (typeof raw === "string") {
			out.push({ value: raw, label: raw });
			continue;
		}
		if (raw && typeof raw === "object") {
			const obj = raw as Record<string, unknown>;
			const value_ = asString(obj.value);
			if (value_ !== undefined) {
				out.push({ value: value_, label: asString(obj.label) ?? value_ });
			}
		}
	}
	return out;
}

function parseField(raw: unknown): PluginSettingsField | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const obj = raw as Record<string, unknown>;
	// `pref_key` is the load-bearing binding; a field without one has nothing to
	// persist, so drop it rather than render an inert control.
	const prefKey = asString(obj.pref_key) ?? asString(obj.prefKey);
	if (!prefKey) {
		return null;
	}
	const type = asString(obj.type) ?? "text";
	return {
		type,
		prefKey,
		label: asString(obj.label) ?? prefKey,
		description: asString(obj.description),
		placeholder: asString(obj.placeholder),
		options: parseOptions(obj.options),
	};
}

/**
 * Parse the raw `settings_tabs` feed (opaque records tagged with a `plugin`
 * id) into typed tabs. Entries missing a plugin id, a title, or any renderable
 * field are dropped.
 */
export function parseSettingsTabs(
	raw: Record<string, unknown>[]
): PluginSettingsTab[] {
	const tabs: PluginSettingsTab[] = [];
	for (const entry of raw) {
		const plugin = asString(entry.plugin);
		if (!plugin) {
			continue;
		}
		const fields = Array.isArray(entry.fields)
			? (entry.fields.map(parseField).filter(Boolean) as PluginSettingsField[])
			: [];
		if (fields.length === 0) {
			continue;
		}
		tabs.push({
			plugin,
			id: asString(entry.id) ?? `${plugin}.settings`,
			title: asString(entry.title) ?? "Settings",
			fields,
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

/** Coerce a stored bare-string preference into a boolean (for `toggle` fields). */
export function prefToBool(raw: string | null): boolean {
	if (raw === null) {
		return false;
	}
	const value = raw.trim().toLowerCase();
	return value === "true" || value === "1" || value === "on" || value === "yes";
}
