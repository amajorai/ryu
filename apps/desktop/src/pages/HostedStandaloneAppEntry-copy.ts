import type { LiteralMessage } from "@ryu/i18n/react";

/** Why a standalone app window has nothing to show. */
export type StandaloneUnavailableReason = "load-failed" | "missing";

/**
 * The unavailable window's description, one whole sentence pair per reason so
 * the catalog translates it, rather than an English reason inserted into a
 * translated sentence.
 */
export function standaloneUnavailableDescription(
	reason: StandaloneUnavailableReason,
	tl: LiteralMessage
): string {
	return reason === "load-failed"
		? tl(
				"Ryu could not load this app from the active node. The app and its data remain safe in Ryu."
			)
		: tl(
				"This app is disabled or no longer installed on the active node. The app and its data remain safe in Ryu."
			);
}
