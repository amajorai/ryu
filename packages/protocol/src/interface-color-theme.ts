/**
 * Interface colour themes: a Marketplace interface contribution may name a
 * colour theme for each light/dark mode (`contributes.interfaces[].colorTheme`).
 *
 * The field is data-only. A slot names either a theme the same plugin
 * contributes in `contributes.themes[]` (`<plugin-id>:<rest>`) or a built-in
 * preset id (un-namespaced, e.g. `ryu-dark`). Ids in another plugin's namespace
 * are dropped. The host applies the theme only while the interface is active
 * and never writes it into the user's saved presets.
 */

/** Theme ids an interface wants painted per mode. At least one slot is set. */
export interface InterfaceColorTheme {
	dark?: string;
	light?: string;
}

/** Longest colour-theme id the host accepts, in UTF-8 bytes. */
export const MAX_INTERFACE_COLOR_THEME_ID_BYTES = 128;

type InterfaceColorThemeMode = "light" | "dark";

const COLOR_THEME_MODES: readonly InterfaceColorThemeMode[] = ["light", "dark"];
const BUILTIN_PRESET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The same rule as the Rust manifest boundary (`char::is_control`): C0, DEL
// and C1 control characters are rejected; any other character is allowed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSlot(
	raw: Record<string, unknown>,
	mode: InterfaceColorThemeMode
): unknown {
	try {
		return raw[mode];
	} catch {
		// A hostile getter must not break parsing; treat the slot as absent.
		return undefined;
	}
}

function isColorThemeId(value: unknown, pluginId: string): value is string {
	if (typeof value !== "string" || value.length === 0) {
		return false;
	}
	if (utf8.encode(value).length > MAX_INTERFACE_COLOR_THEME_ID_BYTES) {
		return false;
	}
	if (BUILTIN_PRESET_ID.test(value)) {
		return true;
	}
	if (CONTROL_CHARACTERS.test(value) || pluginId.length === 0) {
		return false;
	}
	const prefix = `${pluginId}:`;
	return value.startsWith(prefix) && value.length > prefix.length;
}

/**
 * Validate a raw `colorTheme` value for the interface owned by `pluginId`.
 * Fail-soft: invalid or foreign slots are dropped, and the result is
 * undefined when no slot survives. Never throws.
 */
export function parseInterfaceColorTheme(
	raw: unknown,
	pluginId: string
): InterfaceColorTheme | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const theme: InterfaceColorTheme = {};
	let hasSlot = false;
	for (const mode of COLOR_THEME_MODES) {
		const value = readSlot(raw, mode);
		if (isColorThemeId(value, pluginId)) {
			theme[mode] = value;
			hasSlot = true;
		}
	}
	return hasSlot ? theme : undefined;
}

/** The theme id an interface names for `mode`, if any. */
export function interfaceColorThemeId(
	theme: InterfaceColorTheme | undefined,
	mode: InterfaceColorThemeMode
): string | undefined {
	return theme?.[mode];
}
