import { describe, expect, it } from "bun:test";
import {
	PASSWORD_ISSUE_MESSAGES,
	PASSWORD_RULES,
	passwordSchema,
	passwordStrength,
	passwordStrengthLabel,
	passwordStrengthScore,
	passwordValidationIssue,
} from "./password-policy.ts";

describe("password policy", () => {
	it("lists the four requirements the forms show, in order", () => {
		expect(PASSWORD_RULES.map((rule) => rule.id)).toEqual([
			"length",
			"uppercase",
			"number",
			"symbol",
		]);
		expect(PASSWORD_RULES.map((rule) => rule.label)).toEqual([
			"At least 8 characters",
			"One uppercase letter",
			"One number",
			"One symbol",
		]);
	});

	it("gives the code of the first rule a password breaks", () => {
		expect(passwordValidationIssue("short1!")).toBe("length");
		expect(passwordValidationIssue("all-lowercase-1!")).toBe("uppercase");
		expect(passwordValidationIssue("No-digits-here!")).toBe("number");
		expect(passwordValidationIssue("NoSymbolsHere1")).toBe("symbol");
		expect(passwordValidationIssue("RyuLaunch!9")).toBeNull();
	});

	it("reports the same first issue as the server schema", () => {
		for (const value of [
			"",
			"short1!",
			"all-lowercase-1!",
			"No-digits-here!",
			"NoSymbolsHere1",
			`Aa1!${"x".repeat(125)}`,
		]) {
			const issue = passwordValidationIssue(value);
			const parsed = passwordSchema.safeParse(value);
			expect(issue).not.toBeNull();
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues[0]?.message).toBe(
				PASSWORD_ISSUE_MESSAGES[issue ?? "length"]
			);
		}
	});

	it("allows 128 characters and refuses 129", () => {
		const atLimit = `Aa1!${"x".repeat(124)}`;
		expect(atLimit).toHaveLength(128);
		expect(passwordSchema.safeParse(atLimit).success).toBe(true);
		expect(passwordValidationIssue(atLimit)).toBeNull();
		expect(passwordValidationIssue(`${atLimit}x`)).toBe("max_length");
	});

	it("does not count a space as a symbol, and never trims", () => {
		expect(passwordValidationIssue("Abcdefg1 ")).toBe("symbol");
		expect(passwordSchema.safeParse(" Abcdefg1!").success).toBe(true);
	});

	it("scores and labels the states the strength meter renders", () => {
		expect(passwordStrengthScore("")).toBe(0);
		expect(passwordStrengthScore("RyuLaunch!9")).toBe(4);
		expect(passwordStrength(0)).toBe("too_weak");
		expect(passwordStrength(1)).toBe("too_weak");
		expect(passwordStrength(2)).toBe("fair");
		expect(passwordStrength(3)).toBe("good");
		expect(passwordStrength(9)).toBe("strong");
		expect(passwordStrengthLabel(0)).toBe("Too weak");
		expect(passwordStrengthLabel(4)).toBe("Strong");
	});
});
