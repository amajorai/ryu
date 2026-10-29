import { z } from "zod";
export const MINIMUM_ACCOUNT_AGE = 13;
export const AGE_ELIGIBILITY_SECONDS = 30 * 60;
/**
 * Version of the Terms of Service and Privacy Notice a new account accepts at
 * sign-up. Bump it (to the new effective date) whenever either document
 * changes materially; it is stamped on the user as `termsVersion`.
 */
export const CURRENT_TERMS_VERSION = "2026-10-16";

export class AgeEligibilityDeniedError extends Error {
	constructor() {
		super("You are not eligible to create a Ryu account.");
		this.name = "AgeEligibilityDeniedError";
	}
}

/** Calendar dates only; do not retain birth dates in account records. */
const birthdaySchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const birthday = new Date(`${value}T00:00:00Z`);
		return (
			Number.isFinite(birthday.getTime()) &&
			birthday.toISOString().slice(0, 10) === value
		);
	})
	.transform((value) => new Date(`${value}T00:00:00Z`))
	.nullable()
	.catch(null);

export const meetsMinimumAccountAge = z
	.function({
		input: [
			z.unknown().transform((value) => birthdaySchema.parse(value)),
			z.date().default(() => new Date()),
		],
		output: z.boolean(),
	})
	.implement((birthday, today) => {
		if (birthday === null) {
			return false;
		}
		const birthdayStillAhead =
			birthday.getUTCMonth() > today.getUTCMonth() ||
			(birthday.getUTCMonth() === today.getUTCMonth() &&
				birthday.getUTCDate() > today.getUTCDate());
		const age =
			today.getUTCFullYear() -
			birthday.getUTCFullYear() -
			(birthdayStillAhead ? 1 : 0);
		return age >= MINIMUM_ACCOUNT_AGE && age <= 120;
	});
