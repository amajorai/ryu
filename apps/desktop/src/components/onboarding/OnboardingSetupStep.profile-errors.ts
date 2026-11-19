import type { LiteralMessage } from "@ryu/i18n/react";
import type { ProfileJobErrorCode } from "@/src/lib/api/onboarding-profile.ts";

/**
 * Why a profile build failed, as a whole sentence in the reader's language.
 * Core's `error` text is English, so the step renders its stable `errorCode`;
 * a generic failure, an unknown code, or an older node that sends none all get
 * the general sentence.
 */
export function profileErrorMessage(
	code: ProfileJobErrorCode | string | null,
	tl: LiteralMessage
): string {
	switch (code) {
		case "expired":
			return tl(
				"The profile build took too long and was stopped. Try again to start a new build."
			);
		case "empty_draft":
			return tl("The agent finished without writing a profile draft.");
		case "context_changed":
			return tl(
				"This node's setup changed while the profile was building. Try again to build it for the current setup."
			);
		case "company_knowledge_disabled":
			return tl(
				"Shared company knowledge is turned off for this node, so the draft was not saved."
			);
		default:
			return tl("The agent could not finish the first draft.");
	}
}
