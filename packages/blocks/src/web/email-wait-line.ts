import { type MessageValuesInput, translate } from "@ryu/i18n/core";
import { emailRetryWait } from "@ryu/step-up";
import { z } from "zod";

// "Please wait N … before requesting another email.", said in the reader's
// language: one whole catalogued ICU message per unit, because a server
// sentence with a count in it cannot match a plural catalog key. Shared by the
// step-up prompt (step-up-email-wait.ts) and every sign-in, code and
// verification screen that asks the server for an email.

export type Translate = (source: string, values?: MessageValuesInput) => string;

/** The wait before the next email, as a catalogued sentence. */
export function emailWaitSentence(
	seconds: number,
	tl: Translate = translate
): string {
	const { count, unit } = emailRetryWait(seconds);
	if (unit === "seconds") {
		return tl(
			"Please wait {count, plural, one {# second} other {# seconds}} before requesting another email.",
			{ count }
		);
	}
	if (unit === "minutes") {
		return tl(
			"Please wait {count, plural, one {# minute} other {# minutes}} before requesting another email.",
			{ count }
		);
	}
	return tl(
		"Please wait {count, plural, one {# hour} other {# hours}} before requesting another email.",
		{ count }
	);
}

/**
 * Better Auth's refusal of an email request (the auth client's `error`): a
 * 429 that carries its wait in seconds as `retryAfter`.
 */
const authEmailRefusalSchema = z.object({
	retryAfter: z.number().positive().finite(),
	status: z.literal(429),
});

/**
 * The wait line for an auth client error that refused an email, or `null`
 * for any other error (the caller keeps its own failure message).
 */
export function authEmailWaitLine(
	error: unknown,
	tl: Translate = translate
): string | null {
	const refusal = authEmailRefusalSchema.safeParse(error);
	return refusal.success
		? emailWaitSentence(Math.ceil(refusal.data.retryAfter), tl)
		: null;
}
