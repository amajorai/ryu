import z from "zod";

/** The signup password contract shared by the UI and the Better Auth boundary. */
export interface PasswordRule {
	id: "length" | "uppercase" | "number" | "symbol";
	label: string;
	test: (value: string) => boolean;
}

export const PASSWORD_RULES = [
	{
		id: "length",
		label: "At least 8 characters",
		test: (value) => value.length >= 8,
	},
	{
		id: "uppercase",
		label: "One uppercase letter",
		test: (value) => /[A-Z]/.test(value),
	},
	{
		id: "number",
		label: "One number",
		test: (value) => /[0-9]/.test(value),
	},
	{
		id: "symbol",
		label: "One symbol",
		test: (value) => /[^A-Za-z0-9\s]/.test(value),
	},
] as const satisfies readonly PasswordRule[];

/** Server-enforced password policy. Passwords are never trimmed or normalized. */
export const passwordSchema = z
	.string()
	.min(8, "Password needs at least 8 characters")
	.max(128, "Password must be 128 characters or fewer")
	.regex(/[A-Z]/, "Password needs one uppercase letter")
	.regex(/[0-9]/, "Password needs one number")
	.regex(/[^A-Za-z0-9\s]/, "Password needs one symbol");

export function passwordStrengthScore(value: string): number {
	return PASSWORD_RULES.filter((rule) => rule.test(value)).length;
}

export function passwordStrengthLabel(score: number): string {
	const labels = ["Too weak", "Too weak", "Fair", "Good", "Strong"] as const;
	return labels[Math.min(4, Math.max(0, Math.round(score)))] ?? "Too weak";
}

/** Return the first actionable Zod error for inline signup validation. */
export function passwordValidationMessage(value: string): string | null {
	const result = passwordSchema.safeParse(value);
	return result.success
		? null
		: (result.error.issues[0]?.message ?? "Choose a stronger password");
}
