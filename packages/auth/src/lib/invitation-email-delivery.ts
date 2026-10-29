import {
	emailRateLimitRefusalSchema,
	emailRetryWaitPhrase,
} from "@ryu/email/lib/retry-wait.ts";
import { APIError } from "better-auth/api";

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

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;

/**
 * The wait an owner is told, rounded up so it does not reveal when another
 * organization or feature last emailed the address: the one-minute
 * per-recipient cooldown is always a whole minute, and the daily cap whole
 * hours until the limit resets.
 */
export function invitationEmailWaitSeconds(retryAfter: number): number {
	if (retryAfter <= MINUTE_SECONDS) {
		return MINUTE_SECONDS;
	}
	return Math.ceil(retryAfter / HOUR_SECONDS) * HOUR_SECONDS;
}

/**
 * The refusal an owner gets when an organization invitation email was not sent.
 *
 * A recipient cooldown or daily cap answers 429 with `Retry-After` and the wait
 * in words, the convention the step-up confirmation email uses. Anything else,
 * including a limit that refused without a delay because its store is
 * unavailable, answers 503: there is no wait to give. Both carry a stable
 * `code` for clients to branch on and a message the members page shows as is.
 */
export function invitationEmailNotSentError(
	error: unknown,
	attempt: InvitationEmailAttempt
): APIError {
	const refusal = emailRateLimitRefusalSchema.safeParse(error);
	const retryAfter = refusal.success ? refusal.data.retryAfter : undefined;
	if (retryAfter === undefined) {
		return new APIError("SERVICE_UNAVAILABLE", {
			code: INVITATION_EMAIL_NOT_SENT,
			message:
				attempt === "invite"
					? "Invitation email could not be sent, so no invitation was created. Try again in a few minutes."
					: "Invitation email could not be sent. Try resending it in a few minutes.",
		});
	}
	const outcome =
		attempt === "invite"
			? "Invitation email not sent, so no invitation was created."
			: "Invitation email not sent.";
	const retry = attempt === "invite" ? "sending it again" : "resending it";
	const seconds = invitationEmailWaitSeconds(retryAfter);
	return new APIError(
		"TOO_MANY_REQUESTS",
		{
			code: INVITATION_EMAIL_RATE_LIMITED,
			message: `${outcome} Please wait ${emailRetryWaitPhrase(seconds)} before ${retry}.`,
			retryAfter: seconds,
		},
		{ "Retry-After": String(seconds) }
	);
}
