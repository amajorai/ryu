// Resolve the Ghost cursor chip's language in the main process: the same Core
// `ui-language` preference and language packs both Island windows read, else
// the OS's preferred languages. Resolved once per overlay lifetime, so a
// language change applies the next time an agent starts driving the screen.

import { loadOfficialLiteralCatalog } from "@ryu/i18n/official-catalog";
import { app } from "electron";
import type { LanguagePacksSnapshot } from "../shared/language-selection.ts";
import {
	createGhostCursorTranslator,
	ENGLISH_GHOST_CURSOR_TRANSLATOR,
	type GhostCursorTranslator,
	ghostCursorLocaleChoice,
} from "./ghost-cursor-label.ts";
import { languagePacks } from "./services/language-packs.ts";

/** Do not hold the first cursor event back longer than this for Core. */
const LANGUAGE_READ_TIMEOUT_MS = 1500;

async function readLanguagePacks(): Promise<LanguagePacksSnapshot | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), LANGUAGE_READ_TIMEOUT_MS);
	});
	try {
		return await Promise.race([languagePacks().catch(() => null), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function systemLanguages(): string[] {
	try {
		const preferred = app.getPreferredSystemLanguages();
		return preferred.length > 0 ? preferred : [app.getLocale()];
	} catch {
		return [];
	}
}

/** The translator for the UI language the Island currently shows. */
export async function resolveGhostCursorTranslator(): Promise<GhostCursorTranslator> {
	try {
		const snapshot = await readLanguagePacks();
		const available = snapshot?.available === true;
		const choice = ghostCursorLocaleChoice(
			available ? (snapshot.selection ?? null) : null,
			available ? snapshot.packs : [],
			systemLanguages()
		);
		const catalog = await loadOfficialLiteralCatalog(choice.locale).catch(
			() => null
		);
		return createGhostCursorTranslator(choice.locale, catalog, choice.pack);
	} catch {
		return ENGLISH_GHOST_CURSOR_TRANSLATOR;
	}
}
