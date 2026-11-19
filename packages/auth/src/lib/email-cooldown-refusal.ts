import { emailRetryWaitPhrase } from "@ryu/email/lib/retry-wait.ts";
import { APIError } from "better-auth/api";

// The answer to an authentication email request the per-recipient cooldown
// refused (lib/email-cooldown.ts).

export const EMAIL_COOLDOWN_ERROR_CODE = "EMAIL_RATE_LIMITED";
/** The 429 a refused claim answers with: the wait in the body and the header. */
export function emailCooldownRefusal(retryAfter: number): APIError {
	const seconds = Math.max(1, Math.ceil(retryAfter));
	return new APIError(
		"TOO_MANY_REQUESTS",
		{
			code: EMAIL_COOLDOWN_ERROR_CODE,
			message: `Please wait ${emailRetryWaitPhrase(seconds)} before requesting another email.`,
			retryAfter: seconds,
		},
		{ "Retry-After": String(seconds) }
	);
}
