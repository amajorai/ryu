// Desktop settings registry.
//
// Every user preference that belongs in a settings tab should register here with
// a category and a `reset` that restores its default. Tab "Reset to defaults"
// and a future desktop-wide reset both call `resetCategory` / `resetAll` — so
// adding a setting means registering it, not updating a hardcoded checklist.
//
// Reset functions must be callable outside React (write storage, notify
// listeners, apply CSS). Local useState mirrors in a settings tab may still
// need a remount or an explicit sync after reset.

import type { SettingsLevel } from "./settings-levels.ts";

/** Settings surface / tab a preference belongs to. */
export type SettingsCategory =
	| "appearance"
	| "shortcuts"
	| "voice"
	| "island"
	| "general"
	| "desktop";

export interface SettingEntry {
	category: SettingsCategory;
	/** Stable id, e.g. `"appearance.sidebar-variant"`. */
	id: string;
	/** Optional human label for diagnostics / future UI. */
	label?: string;
	/**
	 * The level the setting belongs to (see `settings-levels.ts`). Leave it unset
	 * to take the level of its category from {@link SETTINGS_CATEGORY_LEVELS}.
	 */
	level?: SettingsLevel;
	/** Restore this setting to its default. Must work outside React. */
	reset: () => void;
}

/**
 * The level of each category. Every registered setting today writes local app
 * storage (localStorage or the Tauri shell) and its reset runs outside React,
 * so every category is app level. A setting stored in Core sets its own level.
 */
export const SETTINGS_CATEGORY_LEVELS: Record<SettingsCategory, SettingsLevel> =
	{
		appearance: "app",
		shortcuts: "app",
		voice: "app",
		island: "app",
		general: "app",
		desktop: "app",
	};

/** The level of one registered setting: its own, or its category's. */
export function settingLevel(entry: SettingEntry): SettingsLevel {
	return entry.level ?? SETTINGS_CATEGORY_LEVELS[entry.category];
}

const registry = new Map<string, SettingEntry>();

/** Register (or replace) one setting. Call at module load from the owning file. */
export function registerSetting(entry: SettingEntry): void {
	registry.set(entry.id, entry);
}

/** All registered settings (snapshot). */
export function listSettings(): SettingEntry[] {
	return [...registry.values()];
}

/** Settings in one category. */
export function listSettingsByCategory(
	category: SettingsCategory
): SettingEntry[] {
	return [...registry.values()].filter((e) => e.category === category);
}

/** Settings of one level. */
export function listSettingsByLevel(level: SettingsLevel): SettingEntry[] {
	return [...registry.values()].filter((e) => settingLevel(e) === level);
}

/** Restore every setting in a category to its default. */
export function resetCategory(category: SettingsCategory): void {
	for (const entry of registry.values()) {
		if (entry.category === category) {
			entry.reset();
		}
	}
}

/** Restore every registered desktop setting to its default. */
export function resetAllSettings(): void {
	for (const entry of registry.values()) {
		entry.reset();
	}
}
