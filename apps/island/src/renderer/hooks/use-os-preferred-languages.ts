import { useEffect, useState } from "react";
import { parseSystemLanguages } from "../../shared/language-selection.ts";

/**
 * The OS's preferred languages from the Island main process, re-read when the
 * system reports a change (`languagechange`). Null until the main process
 * answers, and in a window without the bridge (the screen-surface window),
 * where the caller falls back to `navigator.languages`. Mirrors Desktop's
 * `useOsPreferredLanguages` (`apps/desktop/src/components/LanguagePackBridge.tsx`).
 */
export function useOsPreferredLanguages(): readonly string[] | null {
	const [languages, setLanguages] = useState<readonly string[] | null>(null);
	useEffect(() => {
		const read = window.islandLanguage?.systemLanguages;
		if (!read) {
			return;
		}
		let cancelled = false;
		const refresh = () => {
			read()
				.then((value) => {
					const next = parseSystemLanguages(value);
					if (cancelled || next === null) {
						return;
					}
					setLanguages((current) =>
						current?.join(",") === next.join(",") ? current : next
					);
				})
				.catch(() => undefined);
		};
		refresh();
		window.addEventListener("languagechange", refresh);
		return () => {
			cancelled = true;
			window.removeEventListener("languagechange", refresh);
		};
	}, []);
	return languages;
}
