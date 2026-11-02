import type { LiteralMessage } from "@ryu/i18n/react";

/** What `POST /api/node/token/rotate` reports. */
export interface RotatedTokenResult {
	message?: string;
	restart_required: boolean;
}

/**
 * The success toast's description after an owner-token rotation. Core's
 * `message` is English prose with no message id, so it is never shown; the
 * sentence is worded here from `restart_required` alone.
 */
export function rotatedTokenDescription(
	result: RotatedTokenResult,
	tl: LiteralMessage
): string {
	return result.restart_required
		? tl("The new owner token is saved. Restart Core to finish.")
		: tl("The new owner token is active. Paired clients are unaffected.");
}
