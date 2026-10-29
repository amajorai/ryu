// apps/desktop/src/lib/native-copy-translator.ts
//
// Builds the translator `NativeCopyLocalizer` registers for native copy. Only
// known first-party UI literals are touched: they are translated first, and
// the agent -> bot swap applies to that output. Everything else (agent names,
// run bodies, server-sent notification text) is user or runtime data and
// passes through unchanged.

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
		if (!known) {
			return text;
		}
		const output = i18n ? i18n.t(id, {}, text) : text;
		return botTerminology ? replaceAgentTerms(output) : output;
	};
}
