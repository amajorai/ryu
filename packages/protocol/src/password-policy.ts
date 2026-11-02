import z from "zod";

// The password contract every surface shares: the sign-up form, the password
// dialogs on Web, Desktop, the extension and the CLI, and the server's Better
// Auth boundary. It lives in the protocol package, not in `@ryu/auth`, because
// the open-source CLI may depend on `@ryuhq/protocol` but not on the commercial
// auth server package and its database and billing dependencies. `@ryu/auth`
// re-exports it from `lib/password-policy` for the surfaces that import it there.
//
// This package stays English-only. Interfaces read the stable codes
// (`PasswordRule.id`, `PasswordIssue`, `PasswordStrength`) and translate them
// at the boundary; the English text here is for the server, logs and tests.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** The signup password contract shared by the UI and the Better Auth boundary. */
export interface PasswordRule {
	id: "length" | "uppercase" | "number" | "symbol";
	/** English label; interfaces translate `id` instead. */
	label: string;
	test: (value: string) => boolean;
}

export type PasswordRuleId = PasswordRule["id"];

/** The first rule a password breaks: a rule id, or `max_length` past 128 characters. */
export type PasswordIssue = PasswordRuleId | "max_length";

/** The strength meter's four states, from the number of rules met. */
export type PasswordStrength = "too_weak" | "fair" | "good" | "strong";

const UPPERCASE = /[A-Z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[^A-Za-z0-9\s]/;

export const PASSWORD_RULES = [
	{
		id: "length",
		label: "At least 8 characters",
		test: (value) => value.length >= PASSWORD_MIN_LENGTH,
	},
	{
		id: "uppercase",
		label: "One uppercase letter",
		test: (value) => UPPERCASE.test(value),
	},
	{
		id: "number",
		label: "One number",
		test: (value) => DIGIT.test(value),
	},
	{
		id: "symbol",
		label: "One symbol",
		test: (value) => SYMBOL.test(value),
	},
] as const satisfies readonly PasswordRule[];

/** English text for each issue: the server's error and the untranslated fallback. */
export const PASSWORD_ISSUE_MESSAGES: Readonly<Record<PasswordIssue, string>> =
	{
		length: "Password needs at least 8 characters",
		max_length: "Password must be 128 characters or fewer",
		number: "Password needs one number",
		symbol: "Password needs one symbol",
		uppercase: "Password needs one uppercase letter",
	};

/** Server-enforced password policy. Passwords are never trimmed or normalized. */
export const passwordSchema = z
	.string()
	.min(PASSWORD_MIN_LENGTH, PASSWORD_ISSUE_MESSAGES.length)
	.max(PASSWORD_MAX_LENGTH, PASSWORD_ISSUE_MESSAGES.max_length)
	.regex(UPPERCASE, PASSWORD_ISSUE_MESSAGES.uppercase)
	.regex(DIGIT, PASSWORD_ISSUE_MESSAGES.number)
	.regex(SYMBOL, PASSWORD_ISSUE_MESSAGES.symbol);

export function passwordStrengthScore(value: string): number {
	return PASSWORD_RULES.filter((rule) => rule.test(value)).length;
}

const STRENGTH_BY_SCORE = [
	"too_weak",
	"too_weak",
	"fair",
	"good",
	"strong",
] as const satisfies readonly PasswordStrength[];

/** The meter state for a score of 0 to 4 rules met. */
export function passwordStrength(score: number): PasswordStrength {
	return (
		STRENGTH_BY_SCORE[Math.min(4, Math.max(0, Math.round(score)))] ?? "too_weak"
	);
}

const STRENGTH_LABELS: Readonly<Record<PasswordStrength, string>> = {
	fair: "Fair",
	good: "Good",
	strong: "Strong",
	too_weak: "Too weak",
};

/** English label for a score; interfaces translate `passwordStrength(score)`. */
export function passwordStrengthLabel(score: number): string {
	return STRENGTH_LABELS[passwordStrength(score)];
}

/**
 * The first rule a password breaks, in the order the server checks them, or
 * `null` when it meets the policy. Interfaces turn the code into their own
 * language; `PASSWORD_ISSUE_MESSAGES` holds the English.
 */
export function passwordValidationIssue(value: string): PasswordIssue | null {
	if (value.length < PASSWORD_MIN_LENGTH) {
		return "length";
	}
	if (value.length > PASSWORD_MAX_LENGTH) {
		return "max_length";
	}
	return PASSWORD_RULES.find((rule) => !rule.test(value))?.id ?? null;
}
