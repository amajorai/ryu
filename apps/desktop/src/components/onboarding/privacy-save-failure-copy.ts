// apps/desktop/src/components/onboarding/privacy-save-failure-copy.ts
//
// The toast the onboarding privacy step shows when Core rejects a consent
// change. Each title and the description are whole catalog messages, so a
// translated UI never shows an English error after the switch springs back.

import type { LiteralMessage } from "@ryu/i18n/react";

/** The four consent switches on the privacy step. */
export type PrivacySaveChoice =
	| "analytics"
	| "community"
	| "crashes"
	| "export";

/** The failure toast's translated title and description for one switch. */
export function privacySaveFailureToast(
	tl: LiteralMessage,
	choice: PrivacySaveChoice
): { description: string; title: string } {
	const titles: Record<PrivacySaveChoice, () => string> = {
		analytics: () => tl("Couldn't save your analytics choice"),
		community: () => tl("Couldn't save your community-stats choice"),
		crashes: () => tl("Couldn't save your crash-report choice"),
		export: () => tl("Couldn't save your diagnostics-export choice"),
	};
	return {
		description: tl(
			"Your previous choice is restored. Check your connection and retry saving."
		),
		title: titles[choice](),
	};
}
