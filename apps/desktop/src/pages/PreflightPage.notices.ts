import type { LiteralMessage } from "@ryu/i18n/react";

export interface PreflightNotice {
	message: string;
	tone: "info" | "warning";
}

/**
 * The toast after the preflight page's Restart Gateway action: a localized
 * progress note when the restart was sent, a warning when this node cannot
 * restart its Gateway from here. Each branch is one whole sentence.
 */
export function gatewayRestartNotice(
	ok: boolean,
	tl: LiteralMessage
): PreflightNotice {
	if (ok) {
		return { message: tl("Restarting Gateway…"), tone: "info" };
	}
	return {
		message: tl("Gateway can't be restarted from here"),
		tone: "warning",
	};
}
