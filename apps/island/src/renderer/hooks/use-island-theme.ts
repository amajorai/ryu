// Applies the desktop's theme to the island, kept in sync through Core.
//
// On mount we read the shared theme blob (raw JSON) from the main process and
// subscribe to live changes. Parsing + DOM application use `@ryu/ui/theme`, the
// same module the desktop uses, so a preset id — including a user-saved custom
// one, whose definition travels inline in the blob — renders identically here.
// While the mode is "system" we also re-resolve on OS light/dark changes.

import { systemTimeZone } from "@ryu/ui/lib/timezone.ts";
import {
	applyCardSpacing,
	applyFonts,
	applyRadius,
	applyScale,
	applySpacing,
	applyVariant,
	clearCardSpacing,
} from "@ryu/ui/theme/apply.ts";
import {
	activePresetId,
	DEFAULT_CODE_FONT,
	DEFAULT_HEADING_FONT,
	DEFAULT_SCALE,
	DEFAULT_SPACING,
	DEFAULT_UI_FONT,
	normalizeThemePrefs,
	type ThemePrefs,
} from "@ryu/ui/theme/prefs.ts";
import { findVariantIn } from "@ryu/ui/theme/presets.ts";
import { useEffect } from "react";
import type { IslandThemeApi } from "../../shared/ipc.ts";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function applyFlag(
	root: HTMLElement,
	attribute: string,
	enabled: boolean,
	enabledValue = "on",
	disabledValue: string | null = null
) {
	if (enabled) {
		if (enabledValue === "") {
			root.removeAttribute(attribute);
			return;
		}
		root.setAttribute(attribute, enabledValue);
		return;
	}
	if (disabledValue === null) {
		root.removeAttribute(attribute);
	} else {
		root.setAttribute(attribute, disabledValue);
	}
}

function applyPrefs(prefs: ThemePrefs): void {
	const dark =
		prefs.mode === "dark" ||
		(prefs.mode === "system" && window.matchMedia(DARK_QUERY).matches);
	const root = document.documentElement;
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
	root.setAttribute("data-ryu-theme", dark ? "dark" : "light");
	root.style.setProperty("color-scheme", dark ? "dark" : "light");
	const variant = findVariantIn(
		activePresetId(prefs, dark),
		prefs.customThemes
	);
	if (variant) {
		applyVariant(variant, prefs.contrast);
	}
	applyRadius(prefs.radius);
	applySpacing(prefs.spacing ?? DEFAULT_SPACING);
	applyScale(prefs.scale ?? DEFAULT_SCALE);
	if (prefs.cardSpacing == null) {
		clearCardSpacing();
	} else {
		applyCardSpacing(prefs.cardSpacing);
	}
	applyFonts(
		prefs.uiFont ?? DEFAULT_UI_FONT,
		prefs.headingFont ?? DEFAULT_HEADING_FONT,
		prefs.codeFont ?? DEFAULT_CODE_FONT
	);
	root.style.setProperty(
		"--ryu-timezone",
		prefs.timezone && prefs.timezone !== "system"
			? prefs.timezone
			: systemTimeZone()
	);
	root.style.setProperty(
		"--ryu-locale",
		prefs.locale ?? navigator.language ?? "en-US"
	);
	applyFlag(root, "data-pointer-cursor", prefs.pointerCursor ?? false, "true");
	applyFlag(
		root,
		"data-chrome-shadows",
		prefs.chromeShadows ?? true,
		"",
		"off"
	);
	applyFlag(
		root,
		"data-inverted-backgrounds",
		prefs.invertedBackgrounds ?? false
	);
	applyFlag(
		root,
		"data-dialog-overlay-blur",
		prefs.dialogOverlayBlur ?? false,
		"",
		"off"
	);
	applyFlag(root, "data-popup-overlay-blur", prefs.popupOverlayBlur ?? false);
	applyFlag(
		root,
		"data-ryu-animations",
		prefs.animationsEnabled ?? true,
		"",
		"off"
	);
}

/**
 * `api` defaults to the Island's bridge; the on-screen generative UI window
 * passes its own minimal one (`window.islandSurface.theme`).
 */
export function useIslandTheme(api?: IslandThemeApi): void {
	useEffect(() => {
		const theme = api ?? window.island.theme;
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

		theme.get().then((raw) => {
			if (!cancelled) {
				fromRaw(raw);
			}
		});
		const unsubscribe = theme.onChanged(fromRaw);

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
	}, [api]);
}
