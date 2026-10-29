import { officialCatalogLocale } from "@ryu/i18n/catalog-locale";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { replaceAgentTerms } from "@ryu/ui/hooks/use-bot-terminology.ts";

/**
 * The agent -> bot swap is an English vocabulary choice. It must only touch
 * English output: in a translated locale the DOM localizer needs the original
 * "agent" copy as its lookup key, and words such as French "agent" would be
 * rewritten into English.
 */
export function rendersEnglishOutput(
	locale: string,
	hasSelectedPack: boolean
): boolean {
	const language = locale.split("-")[0]?.toLowerCase();
	if (language === "en") {
		return true;
	}
	// A non-English locale without an official catalog or a selected pack still
	// renders the English source.
	return !hasSelectedPack && officialCatalogLocale(locale) === null;
}

/**
 * English copy is first resolved through the selected English flavor pack
 * (translate first), then the vocabulary swap applies to that output.
 */
export function createBotTerminologyRenderer(
	packMessages: Readonly<Record<string, string>> | null
): (source: string) => string {
	return (source) => {
		const trimmed = source.trim();
		if (!(packMessages && trimmed)) {
			return replaceAgentTerms(source);
		}
		const id = messageIdForLiteral(trimmed);
		const message = Object.hasOwn(packMessages, id)
			? packMessages[id]
			: undefined;
		const localized =
			message === undefined ? source : source.replace(trimmed, message);
		return replaceAgentTerms(localized);
	};
}
