import "@ryu/i18n/official-catalog";
import {
	LANGUAGE_PACK_STORAGE_KEY,
	type LanguagePack,
	systemLocales,
} from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { useEffect, useState } from "react";
import {
	languageSelectionKey,
	selectionFromLanguagePacks,
	type UiLanguageSelection,
} from "../../shared/language-selection.ts";
import { useOsPreferredLanguages } from "../hooks/use-os-preferred-languages.ts";
import {
	type LanguagePacksSource,
	watchLanguagePacks,
} from "../hooks/watch-language-packs.ts";

/**
 * Cache the choice locally so the next launch starts in it before the main
 * process answers, and hand it to the main process, which owns the selection
 * for every Island window. Only the Island window has the save bridge.
 *
 * Accepted edge case: the runtime also persists `null` when `setLocale()` finds
 * no pack for a locale, which is saved here as a fixed English choice. The
 * Island never calls `setLocale()` after startup, so in practice `null` only
 * comes from picking English.
 */
function persistIslandLanguage(packId: string | null): void {
	try {
		if (packId) {
			localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, packId);
		} else {
			localStorage.removeItem(LANGUAGE_PACK_STORAGE_KEY);
		}
	} catch {
		// Restricted storage only loses the startup cache.
	}
	window.islandLanguage?.select(packId).catch(() => undefined);
}

function sameSelection(
	left: UiLanguageSelection | null,
	right: UiLanguageSelection | null
): boolean {
	return languageSelectionKey(left) === languageSelectionKey(right);
}

/** The Island is a separate Electron renderer, so it needs its own provider
 * and a main-process catalog read rather than inheriting Desktop's context.
 * The main process also serves the saved UI language (Core's `ui-language`
 * preference, shared with Desktop: the Island picker and Desktop both write
 * it and Desktop adopts an Island choice, so the last writer wins), so both
 * Island windows follow one choice. Without a fixed choice the provider
 * follows the OS's preferred languages as the main process reads them (the
 * list its Ghost cursor label and suggestions use), re-read on
 * `languagechange`, else `navigator.languages`. The on-screen
 * generative UI window passes its own `languagePacks` bridge. */
export function IslandI18nProvider({
	children,
	languagePacks,
}: {
	children: React.ReactNode;
	languagePacks?: LanguagePacksSource;
}) {
	const [packs, setPacks] = useState<LanguagePack[]>([]);
	const [selection, setSelection] = useState<UiLanguageSelection | null>(null);
	const osLanguages = useOsPreferredLanguages();

	useEffect(
		() =>
			watchLanguagePacks((next, result) => {
				setPacks(next);
				const saved = selectionFromLanguagePacks(result);
				setSelection((current) =>
					sameSelection(current, saved) ? current : saved
				);
			}, languagePacks),
		[languagePacks]
	);

	const fixed = selection?.mode === "fixed";
	let initialPackId: string | null | undefined;
	if (selection) {
		initialPackId = fixed ? selection.packId : null;
	}
	// A new OS list rebuilds the runtime, as a new selection does.
	const osKey = !fixed && osLanguages ? `-${osLanguages.join(",")}` : "";

	return (
		<I18nProvider
			// Automatic mode walks every OS preference (`nl-NL, de` answers `de`)
			// and follows a later OS language change without a relaunch: through
			// the main process's list when it answered, else `navigator.languages`.
			followSystemLocale={!fixed && osLanguages === null}
			initialLocale={fixed ? null : (osLanguages ?? systemLocales())}
			// Until the main process answers, the local cache restores the last
			// choice; afterwards its selection wins and a change rebuilds the runtime.
			initialPackId={initialPackId}
			packs={packs}
			persistPackId={persistIslandLanguage}
			selectionKey={`${languageSelectionKey(selection)}${osKey}`}
		>
			<I18nDirectionProvider>{children}</I18nDirectionProvider>
		</I18nProvider>
	);
}
