// Appearance settings registry entries.
//
// Import this module once from AppearanceTab (or app boot) so every appearance
// preference is registered before "Reset to defaults" runs. Adding a new
// Appearance control: give it a module-level setter (or use setPersistedToggle),
// then `registerSetting` in appearance-settings-theme.ts or
// appearance-settings-display.ts — do not extend a hardcoded reset checklist.
//
// Theme mode (next-themes) needs a React setter; call
// `bindAppearanceThemeMode(setTheme)` from AppearanceTab so reset can update it.

import { resetCategory } from "@/src/lib/settings-registry.ts";
import { registerAppearanceDisplaySettings } from "./appearance-settings-display.ts";
import { registerAppearanceThemeSettings } from "./appearance-settings-theme.ts";

export {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
	bindAppearanceThemeMode,
} from "./appearance-settings-defaults.ts";

function registerAppearanceSettings(): void {
	registerAppearanceThemeSettings();
	registerAppearanceDisplaySettings();
}

registerAppearanceSettings();

/** Reset every registered appearance setting to its default. */
export function resetAppearanceSettings(): void {
	resetCategory("appearance");
}
