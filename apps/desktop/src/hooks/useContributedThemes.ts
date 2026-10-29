// Bridge between marketplace-installed themes (`contributes.themes`, served by
// Core at `GET /api/plugins/contributions`) and the shell's theme picker.
//
// A theme is not its own catalog kind here — it is an ordinary plugin that
// contributes one, the same shape VS Code and Zed use. That means a theme
// inherits install / uninstall / enable, versioning, signing, the Store detail
// page and the trust scorecard without any of it being rebuilt for themes.
//
// This hook is the ONE side-effecting reader: it mirrors the served set into the
// localStorage cache that `findVariant` / `initTheme` resolve against. Those run
// before React mounts and before any node is reachable, so a plugin theme that
// existed only in a react-query cache would flash the wrong preset on every cold
// start and be unresolvable entirely while offline.

import { useEffect } from "react";
import { reapplyActivePreset } from "@/src/hooks/useThemePreset.ts";
import {
	type PluginTheme,
	pluginThemeResponseSchema,
} from "@/src/lib/api/plugins.ts";
import {
	loadPluginThemes,
	savePluginThemes,
	type ThemeVariant,
} from "@/src/lib/themes/presets.ts";
import { usePluginContributionsQuery } from "./usePluginContributions.ts";

/** Drop Core's `plugin` tag and keep exactly the shell's own variant shape. */
function toVariant(theme: PluginTheme): ThemeVariant {
	return {
		id: theme.id,
		label: theme.label,
		mode: theme.mode,
		preview: theme.preview,
		tokens: theme.tokens,
	};
}

/**
 * A contributed theme is only usable if it can be applied, and applying means
 * writing `tokens` into CSS custom properties. An entry missing the fields the
 * picker paints (or carrying a mode the shell has no slot for) would render as a
 * blank swatch and select into an unstyled window, so it is dropped here rather
 * than at every consumer.
 */
function isRenderable(theme: PluginTheme): boolean {
	const parsed = pluginThemeResponseSchema.safeParse(theme);
	return (
		parsed.success &&
		parsed.data.id.length > 0 &&
		Object.keys(theme.tokens).length > 0
	);
}

// Compared by full value, not by id: a plugin UPDATE ships the same theme ids with
// different tokens, and an id-only check would pin every user to the palette they
// first installed. Both sides are built by `toVariant` from the same key order, so
// the serialisation is stable.
function sameVariants(a: ThemeVariant[], b: ThemeVariant[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Keep the plugin-theme cache in step with what Core currently serves. Call ONCE
 * from a component that is always mounted (LayoutContent), alongside the other
 * contribution bridges.
 *
 * Deliberately a full REPLACE, not a merge: disabling or uninstalling the owning
 * plugin is how a user removes its themes, so a theme that stops being served
 * must leave the cache. It is a resolution table, never a second source of truth.
 */
export function usePluginThemeSync(): void {
	// The RAW query, not `usePluginContributions()`: that helper collapses "not
	// loaded yet" and "loaded, none" into the same EMPTY payload, and writing the
	// in-flight one through would evict every installed theme — taking the user's
	// selection with it — on each cold start and on every failed fetch. Only a
	// SUCCESSFUL read is authoritative enough to clear the cache.
	const { data, isSuccess } = usePluginContributionsQuery();
	const themes = data?.themes;

	useEffect(() => {
		if (!(isSuccess && themes)) {
			return;
		}
		const next = themes.filter(isRenderable).map(toVariant);
		const current = loadPluginThemes();
		if (!sameVariants(next, current)) {
			savePluginThemes(next);
			// The selected id can be stable while the palette behind it changed (a
			// theme plugin updated) or vanished (uninstalled). Re-resolving now is what
			// makes install/update/remove visible immediately instead of at next boot.
			reapplyActivePreset();
		}
	}, [isSuccess, themes]);
}
