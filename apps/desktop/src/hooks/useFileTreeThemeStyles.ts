// apps/desktop/src/hooks/useFileTreeThemeStyles.ts
//
// Turns the file-tree theme prefs into the inline `--trees-theme-*` CSS
// variables `@pierre/trees` reads off its host element.
//
// Unlike `@pierre/diffs` — which takes a light/dark theme PAIR and lets
// `light-dark()` pick — `@pierre/trees` has no notion of modes: it consumes one
// already-resolved theme. So the active mode is resolved here from next-themes'
// `resolvedTheme` (the same signal that drives `color-scheme` on <html>, which
// is what the diff viewer's "Auto" follows — the two panels can't disagree).
//
// Theme resolution is async on first use (Shiki lazily imports the theme JSON)
// and cached afterwards, so `getResolvedOrResolveTheme` returns synchronously on
// every later mount — no flash of unthemed tree once a theme has been loaded.

import { getResolvedOrResolveTheme } from "@pierre/diffs";
import { themeToTreeStyles } from "@pierre/trees";
import { useTheme } from "next-themes";
import type { CSSProperties } from "react";
import { useLayoutEffect, useState } from "react";
import type { FileTreePrefs } from "@/src/hooks/useFileTreePrefs.ts";
import { TREE_THEME_INHERIT } from "@/src/lib/pierre-themes.ts";

// Preserve the complete native tree-theme operation and its raw style map.
function toStyle(styles: ReturnType<typeof themeToTreeStyles>): CSSProperties {
	return styles;
}

/**
 * Inline styles for the `<FileTree>` host (pass them as its `style`: the
 * library merges them onto the host). The host's shadow `:host` declares
 * `color-scheme: light dark`, which follows the OS, so every state pins a
 * scheme: inherit, a theme still loading, and an unknown theme use the app's
 * mode; a resolved theme brings its own scheme with its `--trees-theme-*`.
 */
export function useFileTreeThemeStyles(
	prefs: FileTreePrefs
): CSSProperties | undefined {
	const { resolvedTheme } = useTheme();
	const themeName =
		resolvedTheme === "dark" ? prefs.darkTheme : prefs.lightTheme;
	const [styles, setStyles] = useState<CSSProperties | undefined>(undefined);
	const appColorScheme = resolvedTheme === "dark" ? "dark" : "light";

	useLayoutEffect(() => {
		const inherit: CSSProperties = { colorScheme: appColorScheme };
		if (themeName === TREE_THEME_INHERIT) {
			setStyles(inherit);
			return;
		}
		const resolved = getResolvedOrResolveTheme(themeName);
		if (!(resolved instanceof Promise)) {
			setStyles(toStyle(themeToTreeStyles(resolved)));
			return;
		}
		// Async path: drop the result if the pref changed (or we unmounted)
		// while the theme JSON was loading, and fall back to inheriting if the
		// name turns out to be unknown to Shiki.
		let cancelled = false;
		setStyles(inherit);
		resolved
			.then((theme) => {
				if (!cancelled) {
					setStyles(toStyle(themeToTreeStyles(theme)));
				}
			})
			.catch(() => {
				if (!cancelled) {
					setStyles(inherit);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [themeName, appColorScheme]);

	return styles;
}
