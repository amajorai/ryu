import {
	emailRateLimitRefusalSchema,
	emailRetryWaitPhrase,
} from "@ryu/email/lib/retry-wait.ts";
import { APIError } from "better-auth/api";
import {
	INVITATION_EMAIL_NOT_SENT,
	INVITATION_EMAIL_NOT_SENT_MESSAGE,
	INVITATION_EMAIL_RATE_LIMITED,
	INVITATION_EMAIL_RATE_LIMITED_OUTCOME,
	type InvitationEmailAttempt,
} from "./invitation-email-codes.ts";

export {
	INVITATION_EMAIL_NOT_SENT,
	INVITATION_EMAIL_RATE_LIMITED,
	type InvitationEmailAttempt,
} from "./invitation-email-codes.ts";

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
			message: INVITATION_EMAIL_NOT_SENT_MESSAGE[attempt],
		});
	}
	const outcome = INVITATION_EMAIL_RATE_LIMITED_OUTCOME[attempt];
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
