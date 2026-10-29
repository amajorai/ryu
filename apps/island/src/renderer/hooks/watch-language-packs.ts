import type { LanguagePack } from "@ryu/i18n/core";
import type { IslandApi, LanguagePacksResult } from "../../shared/ipc.ts";

/** The catalog read; the on-screen generative UI window passes its own bridge. */
export type LanguagePacksSource = IslandApi["languagePacks"];

/**
 * Refresh the catalog only while visible, with one IPC read at a time. `source`
 * defaults to the Island's bridge (`window.island.languagePacks`).
 */
export function watchLanguagePacks(
	receive: (packs: LanguagePack[], result: LanguagePacksResult) => void,
	source?: LanguagePacksSource
): () => void {
	let alive = true;
	let pending = false;
	const refresh = async () => {
		if (!alive || pending || document.hidden) {
			return;
		}
		pending = true;
		try {
			const result = await (source ?? window.island.languagePacks).get();
			if (alive && !document.hidden && result.available) {
				receive(result.packs, result);
			}
		} catch {
			/* Retain the current catalog until a later successful refresh. */
		} finally {
			pending = false;
		}
	};
	const automatic = () => {
		void refresh();
	};
	automatic();
	window.addEventListener("focus", automatic);
	document.addEventListener("visibilitychange", automatic);
	const timer = window.setInterval(automatic, 30_000);
	return () => {
		alive = false;
		window.removeEventListener("focus", automatic);
		document.removeEventListener("visibilitychange", automatic);
		window.clearInterval(timer);
	};
}
