// Applies the desktop's theme to the island, kept in sync through Core.
//
// On mount we read the shared theme blob (raw JSON) from the main process and
// subscribe to live changes. Parsing + DOM application use `@ryu/ui/theme`, the
// same module the desktop uses, so a preset id — including a user-saved custom
// one, whose definition travels inline in the blob — renders identically here.
// While the mode is "system" we also re-resolve on OS light/dark changes.

import { applyRadius, applyVariant } from "@ryu/ui/theme/apply";
import {
	activePresetId,
	normalizeThemePrefs,
	type ThemePrefs,
} from "@ryu/ui/theme/prefs";
import { findVariantIn } from "@ryu/ui/theme/presets";
import { useEffect } from "react";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function resolveDark(prefs: ThemePrefs): boolean {
	if (prefs.mode === "system") {
		return window.matchMedia(DARK_QUERY).matches;
	}
	return prefs.mode === "dark";
}

function applyPrefs(prefs: ThemePrefs): void {
	const dark = resolveDark(prefs);
	document.documentElement.classList.toggle("dark", dark);
	const variant = findVariantIn(
		activePresetId(prefs, dark),
		prefs.customThemes
	);
	if (variant) {
		applyVariant(variant, prefs.contrast);
	}
	applyRadius(prefs.radius);
}

export function useIslandTheme(): void {
	useEffect(() => {
		let cancelled = false;
		let last: ThemePrefs | null = null;

		const apply = (prefs: ThemePrefs): void => {
			last = prefs;
			applyPrefs(prefs);
		};

		const fromRaw = (raw: string | null): void => {
			if (!raw) {
				return;
			}
			try {
				apply(normalizeThemePrefs(JSON.parse(raw)));
			} catch {
				// Malformed blob: keep whatever is currently applied.
			}
		};

		window.island.theme.get().then((raw) => {
			if (!cancelled) {
				fromRaw(raw);
			}
		});
		const unsubscribe = window.island.theme.onChanged(fromRaw);

		// Re-resolve light/dark when the OS scheme flips while mode is "system".
		const media = window.matchMedia(DARK_QUERY);
		const onSchemeChange = (): void => {
			if (last) {
				applyPrefs(last);
			}
		};
		media.addEventListener("change", onSchemeChange);

		return () => {
			cancelled = true;
			unsubscribe();
			media.removeEventListener("change", onSchemeChange);
		};
	}, []);
}
