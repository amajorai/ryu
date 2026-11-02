// The Ghost cursor chip's label in the user's language. Ghost narrates a stable
// intent kind (`click`, `typing`, …) plus the clicked element; this module turns
// that into the short label the overlay shows, using the same UI language the
// Island windows follow (Core's `ui-language` preference, else the OS).
//
// Pure (no Electron), so the overlay module and its tests share it. The English
// table lives in `src/renderer/lib/ghost-intent-copy.ts`, where the extractor
// collects it into the catalogs.

import {
	BUILT_IN_LANGUAGE_PACK_INFO,
	DEFAULT_LOCALE,
	directionForLocale,
	findLanguagePackForLocale,
	formatMessage,
	type LanguageDirection,
	type LanguagePack,
	type LiteralCatalog,
	messageIdForLiteral,
	preferredOfficialLocale,
} from "@ryu/i18n/lite";
import {
	GHOST_CLICK_TARGET_COPY,
	GHOST_INTENT_COPY,
} from "../renderer/lib/ghost-intent-copy.ts";
import type { UiLanguageSelection } from "../shared/language-selection.ts";
import type { GhostCursorEvent } from "./control-protocol.ts";

export type GhostCursorLabelInput = Pick<
	GhostCursorEvent,
	"intent" | "kind" | "target"
>;

export interface GhostCursorTranslator {
	readonly direction: LanguageDirection;
	/** The chip label for one event. */
	label(event: GhostCursorLabelInput): string;
	readonly locale: string;
}

/** Where the label's language comes from: a locale and the pack showing it. */
export interface GhostCursorLocaleChoice {
	locale: string;
	pack: Pick<LanguagePack, "messages"> | null;
}

/**
 * Pick the locale the Island windows show: a fixed choice (English, a
 * built-in pack or an installed one), else the first OS language Ryu ships.
 */
export function ghostCursorLocaleChoice(
	selection: UiLanguageSelection | null,
	packs: readonly LanguagePack[],
	systemLocales: readonly string[]
): GhostCursorLocaleChoice {
	const enabled = packs.filter((pack) => pack.enabled !== false);
	if (selection?.mode === "fixed") {
		const packId = selection.packId;
		if (packId === null) {
			return { locale: DEFAULT_LOCALE, pack: null };
		}
		const installed = enabled.find((pack) => pack.id === packId);
		if (installed) {
			return { locale: installed.locale, pack: installed };
		}
		const builtIn = BUILT_IN_LANGUAGE_PACK_INFO.find(
			(pack) => pack.id === packId
		);
		return { locale: builtIn?.locale ?? DEFAULT_LOCALE, pack: null };
	}
	const locale = preferredOfficialLocale(systemLocales, enabled);
	if (!locale) {
		return { locale: DEFAULT_LOCALE, pack: null };
	}
	return { locale, pack: findLanguagePackForLocale(enabled, locale) };
}

/**
 * Build the translator for `locale`: the selected pack's messages first, then
 * the official literal catalog (keyed by the English text), then English.
 */
export function createGhostCursorTranslator(
	locale: string,
	catalog: LiteralCatalog | null,
	pack: Pick<LanguagePack, "messages"> | null = null
): GhostCursorTranslator {
	const message = (source: string): string =>
		pack?.messages[messageIdForLiteral(source)] ?? catalog?.[source] ?? source;
	return {
		direction: directionForLocale(locale),
		locale,
		label(event) {
			if (!event.kind) {
				// Older Ghost builds send English prose with no kind.
				return event.intent || message(GHOST_INTENT_COPY.working);
			}
			if (event.kind === "click" && event.target) {
				// The target is the element's own text; it is inserted verbatim.
				return formatMessage(
					message(GHOST_CLICK_TARGET_COPY),
					{ target: event.target },
					locale
				);
			}
			return message(GHOST_INTENT_COPY[event.kind]);
		},
	};
}

/** English, used until the user's language resolves (or when it cannot). */
export const ENGLISH_GHOST_CURSOR_TRANSLATOR = createGhostCursorTranslator(
	DEFAULT_LOCALE,
	null
);
