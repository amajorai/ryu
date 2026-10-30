import {
	COMPANION_THEME_MUTATION_ATTRIBUTES,
	readCompanionThemeTokens,
} from "@ryu/app-host/companion-theme";
import { useEffect, useState } from "react";

/** Read the host's LIVE resolved theme tokens (the desktop's active light/dark/
 *  custom theme) so the theme-token bridge can inject them into the sandboxed
 *  companion at mount — one mechanism that makes every companion render native to
 *  the surface's current theme. Returns only the tokens the host actually resolves
 *  (a blank value is skipped, so the companion falls back to its own default for
 *  that token). Runs in the trusted webview (getComputedStyle on the host root). */
export function readHostThemeTokens(): ReturnType<
	typeof readCompanionThemeTokens
> {
	return readCompanionThemeTokens(undefined, {
		includeStoredPreferences: true,
	});
}

export function usePluginHostThemeTokens() {
	// The theme-token bridge (W7): seed the companion's first paint from the
	// desktop's resolved theme, then push subsequent changes into the already
	// mounted null-origin frame. Keeping the initial snapshot separate avoids
	// remounting a running app when the user changes appearance.
	const [initialThemeTokens] = useState(readHostThemeTokens);
	const [themeTokens, setThemeTokens] = useState(initialThemeTokens);
	useEffect(() => {
		if (globalThis.MutationObserver === undefined) {
			return;
		}
		const observer = new MutationObserver(() => {
			setThemeTokens(readHostThemeTokens());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
		});
		return () => observer.disconnect();
	}, []);
	return { initialThemeTokens, themeTokens };
}
