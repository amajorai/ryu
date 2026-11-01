// A temporary colour-theme override: while a Marketplace interface that ships
// its own colour theme (`contributes.interfaces[].colorTheme`) is the active
// interface, the shell paints that theme instead of the user's preset.
//
// The override is never written into the user's saved presets
// (`ryu_light_preset` / `ryu_dark_preset`) and never published to Core's theme
// prefs. It is persisted on its own key only so `initTheme()` can paint the
// interface's colours at boot without flashing the user's preset first; the
// interface sync hook (`interfaces/use-interface-color-theme.ts`) replaces or
// clears it as soon as the active interface is known.

import { MAX_INTERFACE_COLOR_THEME_ID_BYTES } from "@ryuhq/protocol/interfaces";
import { useSyncExternalStore } from "react";
import {
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	findVariant,
	loadPluginThemes,
	STORAGE_KEYS,
	THEME_VARIANTS,
	type ThemeVariant,
} from "@/src/lib/themes/presets.ts";

/** The colour theme an interface paints while it is active. */
export interface ThemeOverride {
	dark?: string;
	/** Shown in Settings: the interface's name. */
	label: string;
	light?: string;
	/**
	 * The plugin that owns the interface. A namespaced slot only resolves
	 * against this plugin's own themes.
	 */
	plugin: string;
	/** The interface id the override belongs to. */
	source: string;
}

type ThemeOverrideMode = "light" | "dark";

/** localStorage key of the persisted override (boot paint only). */
export const THEME_OVERRIDE_STORAGE_KEY = "ryu:interface-color-theme";
/**
 * The user's "Use interface color themes" switch, read with
 * `usePersistedToggle(INTERFACE_COLOR_THEMES_KEY, INTERFACE_COLOR_THEMES_DEFAULT)`.
 * "false" turns interface colour themes off; anything else leaves them on.
 */
export const INTERFACE_COLOR_THEMES_KEY = "ryu:interface-color-themes";
export const INTERFACE_COLOR_THEMES_DEFAULT = true;

const MAX_SOURCE_BYTES = 256;
const MAX_PLUGIN_BYTES = 256;
const MAX_LABEL_LENGTH = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const utf8 = new TextEncoder();

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function cleanText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string" || value.length === 0) {
		return;
	}
	if (CONTROL_CHARACTERS.test(value) || utf8.encode(value).length > maxBytes) {
		return;
	}
	return value;
}

/**
 * Validate an untrusted override value (persisted JSON, test input). Returns
 * null unless it names a source and at least one usable slot.
 */
export function sanitizeThemeOverride(raw: unknown): ThemeOverride | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const source = cleanText(record.source, MAX_SOURCE_BYTES);
	const plugin = cleanText(record.plugin, MAX_PLUGIN_BYTES);
	const light = cleanText(record.light, MAX_INTERFACE_COLOR_THEME_ID_BYTES);
	const dark = cleanText(record.dark, MAX_INTERFACE_COLOR_THEME_ID_BYTES);
	if (!(source && plugin && (light || dark))) {
		return null;
	}
	const label =
		typeof record.label === "string"
			? record.label.slice(0, MAX_LABEL_LENGTH)
			: "";
	return {
		source,
		plugin,
		label,
		...(light ? { light } : {}),
		...(dark ? { dark } : {}),
	};
}

/** The persisted override, sanitized; null when absent, malformed or unreadable. */
export function readStoredThemeOverride(): ThemeOverride | null {
	try {
		const raw = storage()?.getItem(THEME_OVERRIDE_STORAGE_KEY) ?? null;
		return raw === null ? null : sanitizeThemeOverride(JSON.parse(raw));
	} catch {
		return null;
	}
}

function writeStoredThemeOverride(next: ThemeOverride | null): void {
	try {
		if (next) {
			storage()?.setItem(THEME_OVERRIDE_STORAGE_KEY, JSON.stringify(next));
		} else {
			storage()?.removeItem(THEME_OVERRIDE_STORAGE_KEY);
		}
	} catch {
		// Best-effort: the in-memory override still holds for this session.
	}
}

let current: ThemeOverride | null | undefined;
const listeners = new Set<() => void>();

/** The override in effect, or null. Loads the persisted one on first read. */
export function getThemeOverride(): ThemeOverride | null {
	if (current === undefined) {
		current = readStoredThemeOverride();
	}
	return current;
}

function sameOverride(
	left: ThemeOverride | null,
	right: ThemeOverride | null
): boolean {
	if (left === null || right === null) {
		return left === right;
	}
	return (
		left.source === right.source &&
		left.plugin === right.plugin &&
		left.label === right.label &&
		left.light === right.light &&
		left.dark === right.dark
	);
}

/**
 * Replace (or clear, with null) the override and persist it. Returns whether
 * it changed; listeners are only notified on a change.
 */
export function setThemeOverride(next: ThemeOverride | null): boolean {
	const cleaned = next === null ? null : sanitizeThemeOverride(next);
	if (sameOverride(getThemeOverride(), cleaned)) {
		return false;
	}
	current = cleaned;
	writeStoredThemeOverride(cleaned);
	for (const listener of listeners) {
		listener();
	}
	return true;
}

export function subscribeThemeOverride(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The override in effect, re-rendering when it changes. */
export function useThemeOverride(): ThemeOverride | null {
	return useSyncExternalStore(
		subscribeThemeOverride,
		getThemeOverride,
		getThemeOverride
	);
}

/** Whether the user allows interfaces to paint their own colours. */
export function interfaceColorThemesEnabled(): boolean {
	try {
		return storage()?.getItem(INTERFACE_COLOR_THEMES_KEY) !== "false";
	} catch {
		return INTERFACE_COLOR_THEMES_DEFAULT;
	}
}

function modeOf(dark: boolean): ThemeOverrideMode {
	return dark ? "dark" : "light";
}

/**
 * Resolve a slot id without trusting other plugins: an un-namespaced id only
 * matches a built-in preset, and an id in the owning plugin's namespace only
 * matches a cached plugin theme. User custom themes and ids in another
 * namespace never resolve here.
 */
function resolveSlot(
	id: string,
	mode: ThemeOverrideMode,
	plugin: string
): ThemeVariant | undefined {
	const pool = id.startsWith(`${plugin}:`)
		? loadPluginThemes()
		: THEME_VARIANTS;
	return pool.find((variant) => variant.id === id && variant.mode === mode);
}

/**
 * The theme the override paints for a mode, when it is in effect: the switch
 * is on, the slot is set, and the id resolves to a theme of that mode.
 */
export function overrideVariantFor(
	dark: boolean,
	override: ThemeOverride | null = getThemeOverride()
): ThemeVariant | undefined {
	if (!(override && interfaceColorThemesEnabled())) {
		return;
	}
	const mode = modeOf(dark);
	const id = override[mode];
	return id ? resolveSlot(id, mode, override.plugin) : undefined;
}

/** The override's theme id for a mode, when it is in effect. */
export function overrideIdFor(
	dark: boolean,
	override: ThemeOverride | null = getThemeOverride()
): string | undefined {
	return overrideVariantFor(dark, override)?.id;
}

/** True while the override paints the given mode (for Settings notes). */
export function overrideCoversMode(
	dark: boolean,
	override: ThemeOverride | null = getThemeOverride()
): boolean {
	return overrideIdFor(dark, override) !== undefined;
}

/** The user's own saved preset for a mode (what Core's theme prefs carry). */
export function userPresetId(dark: boolean): string {
	const key = dark ? STORAGE_KEYS.darkPreset : STORAGE_KEYS.lightPreset;
	const fallback = dark ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID;
	try {
		return storage()?.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * The preset id the shell paints for a mode: the active interface's theme
 * when it covers that mode and resolves, else the user's own preset.
 */
export function activePresetId(
	dark: boolean,
	override: ThemeOverride | null = getThemeOverride()
): string {
	return overrideIdFor(dark, override) ?? userPresetId(dark);
}

/**
 * The variant the shell paints for a mode: the override's own theme when it
 * covers that mode, else the user's preset (resolved against built-in, custom
 * and plugin themes, as the picker offers them).
 */
export function activeVariant(
	dark: boolean,
	override: ThemeOverride | null = getThemeOverride()
): ThemeVariant | undefined {
	return overrideVariantFor(dark, override) ?? findVariant(userPresetId(dark));
}
