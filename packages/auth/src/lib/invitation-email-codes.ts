/**
 * The browser-safe contract of an organization invitation whose email was not
 * sent: the stable codes, the outcomes, and the English sentences the server
 * opens its refusal with. No imports, so the auth server
 * (`invitation-email-delivery.ts`) and the website (which says the refusal in
 * the reader's language) share the same names and cannot drift.
 *
 * The refusal body is `{ code, message, retryAfter? }`; its shape is asserted
 * by the API's proof tests, so the outcome is not a field of its own. A client
 * reads it from the message with `invitationEmailOutcome`, which matches the
 * exact sentences below.
 */

/** The recipient's email limit refused the invitation email (429). */
export const INVITATION_EMAIL_RATE_LIMITED = "INVITATION_EMAIL_RATE_LIMITED";
/**
 * The invitation email failed for any other reason, such as a provider outage
 * or an unavailable email limit (503).
 */
export const INVITATION_EMAIL_NOT_SENT = "INVITATION_EMAIL_NOT_SENT";

/**
 * - `invite`: a new invitation, which is withdrawn when its email does not go
 *   out, so the owner sends it again.
 * - `resend`: an existing invitation, which stays pending.
 */
export type InvitationEmailAttempt = "invite" | "resend";

/** The sentence a cooldown refusal (429) opens with, per outcome. */
export const INVITATION_EMAIL_RATE_LIMITED_OUTCOME = {
	invite: "Invitation email not sent, so no invitation was created.",
	resend: "Invitation email not sent.",
} as const satisfies Record<InvitationEmailAttempt, string>;

/** The whole refusal when the email could not be sent at all (503), per outcome. */
export const INVITATION_EMAIL_NOT_SENT_MESSAGE = {
	invite:
		"Invitation email could not be sent, so no invitation was created. Try again in a few minutes.",
	resend:
		"Invitation email could not be sent. Try resending it in a few minutes.",
} as const satisfies Record<InvitationEmailAttempt, string>;

const OUTCOMES: readonly InvitationEmailAttempt[] = ["invite", "resend"];

/**
 * The outcome a refusal's message reports, or `undefined` when the message is
 * not one of the server's sentences. A new invitation the server could not
 * withdraw is reported as `resend`: it stays pending.
 */
export function invitationEmailOutcome(
	message: string | undefined
): InvitationEmailAttempt | undefined {
	if (message === undefined) {
		return undefined;
	}
	return OUTCOMES.find(
		(outcome) =>
			message === INVITATION_EMAIL_NOT_SENT_MESSAGE[outcome] ||
			message === INVITATION_EMAIL_RATE_LIMITED_OUTCOME[outcome] ||
			message.startsWith(`${INVITATION_EMAIL_RATE_LIMITED_OUTCOME[outcome]} `)
	);
}
