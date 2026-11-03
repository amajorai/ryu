// The UI language the proactive-suggestion prompt asks the model to write in:
// the same Core `ui-language` preference and language packs both Island windows
// read, else the OS's preferred languages. Resolved per suggestion request
// (requests are debounced and cooled down, so this is rare) so a language change
// applies to the next suggestion. Any failure answers English, which leaves the
// prompt exactly as it was.

import { DEFAULT_LOCALE } from "@ryu/i18n/lite";
import { app } from "electron";
import type { LanguagePacksSnapshot } from "../shared/language-selection.ts";
import { ghostCursorLocaleChoice } from "./ghost-cursor-label.ts";
import { languagePacks } from "./services/language-packs.ts";

/** Do not hold a suggestion back longer than this for Core's answer. */
const LANGUAGE_READ_TIMEOUT_MS = 1500;

/** Where the locale comes from; injected so the resolver stays testable. */
export interface UiLocaleSources {
	languagePacks(): Promise<LanguagePacksSnapshot>;
	systemLanguages(): string[];
}

async function readWithTimeout(
	read: () => Promise<LanguagePacksSnapshot>,
	timeoutMs: number
): Promise<LanguagePacksSnapshot | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([read().catch(() => null), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The locale the Island shows, read from `sources`; English on any failure. */
export async function resolveUiLocale(
	sources: UiLocaleSources,
	timeoutMs = LANGUAGE_READ_TIMEOUT_MS
): Promise<string> {
	try {
		const snapshot = await readWithTimeout(sources.languagePacks, timeoutMs);
		const available = snapshot?.available === true;
		return ghostCursorLocaleChoice(
			available ? (snapshot.selection ?? null) : null,
			available ? snapshot.packs : [],
			sources.systemLanguages()
		).locale;
	} catch {
		return DEFAULT_LOCALE;
	}
}

function electronSystemLanguages(): string[] {
	try {
		const preferred = app.getPreferredSystemLanguages();
		return preferred.length > 0 ? preferred : [app.getLocale()];
	} catch {
		return [];
	}
}

/** The Island's current UI language, for the suggestion engine's `uiLocale`. */
export function suggestionUiLocale(): Promise<string> {
	return resolveUiLocale({
		languagePacks,
		systemLanguages: electronSystemLanguages,
	});
}
