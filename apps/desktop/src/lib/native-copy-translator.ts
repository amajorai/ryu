// apps/desktop/src/lib/native-copy-translator.ts
//
// Builds the translator `NativeCopyLocalizer` registers for native copy. Only
// first-party UI copy is touched: a known literal, or a dynamic sentence that
// matches a catalog ICU template (`Changed from {old} to {new}.`), the same
// matching the DOM localizer does, with its over-match guards. The template's
// captured values stay as written. The agent -> bot swap applies to that
// output. Everything else (agent names, run bodies, free-form server text) is
// user or runtime data and passes through unchanged.

import { messageIdForLiteral } from "@ryu/i18n/core";
import { EN_MESSAGES } from "@ryu/i18n/messages";
import { replaceAgentTerms } from "@ryu/ui/hooks/use-bot-terminology.ts";
import type { NativeCopyTranslator } from "./native-copy.ts";

/** The slice of the i18n context the translator reads. */
export interface NativeCopyI18n {
	availablePacks: readonly {
		messages: Readonly<Record<string, string>>;
	}[];
	hasOverlayMessage: (id: string) => boolean;
	t: (id: string, values: Record<string, never>, fallback: string) => string;
	/** `text` through the literal catalog's ICU templates, if one matches. */
	templateMessage?: (text: string) => string | undefined;
}

/**
 * `botTerminology` must already be gated to English output by the caller
 * (see `rendersEnglishOutput`), so a translated locale is never swapped.
 */
export function createNativeCopyTranslator(
	i18n: NativeCopyI18n | null,
	botTerminology: boolean
): NativeCopyTranslator {
	return (text) => {
		const id = messageIdForLiteral(text);
		const known =
			Object.hasOwn(EN_MESSAGES, id) ||
			(i18n !== null &&
				(i18n.hasOverlayMessage(id) ||
					i18n.availablePacks.some((pack) =>
						Object.hasOwn(pack.messages, id)
					)));
		const output = known
			? (i18n?.t(id, {}, text) ?? text)
			: i18n?.templateMessage?.(text);
		if (output === undefined) {
			return text;
		}
		return botTerminology ? replaceAgentTerms(output) : output;
	};
}
