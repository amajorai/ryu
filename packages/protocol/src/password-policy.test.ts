import { describe, expect, it } from "bun:test";
import {
	PASSWORD_RULES,
	passwordSchema,
	passwordStrengthLabel,
	passwordStrengthScore,
	passwordValidationMessage,
} from "./password-policy.ts";

describe("password policy", () => {
	it("lists the four requirements the forms show, in order", () => {
		expect(PASSWORD_RULES.map((rule) => rule.label)).toEqual([
			"At least 8 characters",
			"One uppercase letter",
			"One number",
			"One symbol",
		]);
	});

	it("gives the message for the first rule a password breaks", () => {
		expect(passwordValidationMessage("short1!")).toBe(
			"Password needs at least 8 characters"
		);
		expect(passwordValidationMessage("all-lowercase-1!")).toBe(
			"Password needs one uppercase letter"
		);
		expect(passwordValidationMessage("No-digits-here!")).toBe(
			"Password needs one number"
		);
		expect(passwordValidationMessage("NoSymbolsHere1")).toBe(
			"Password needs one symbol"
		);
		expect(passwordValidationMessage("RyuLaunch!9")).toBeNull();
	});

	it("allows 128 characters and refuses 129", () => {
		const atLimit = `Aa1!${"x".repeat(124)}`;
		expect(atLimit).toHaveLength(128);
		expect(passwordSchema.safeParse(atLimit).success).toBe(true);
		expect(passwordValidationMessage(`${atLimit}x`)).toBe(
			"Password must be 128 characters or fewer"
		);
	});

	it("does not count a space as a symbol, and never trims", () => {
		expect(passwordValidationMessage("Abcdefg1 ")).toBe(
			"Password needs one symbol"
		);
		expect(passwordSchema.safeParse(" Abcdefg1!").success).toBe(true);
	});

	it("scores and labels the states the strength meter renders", () => {
		expect(passwordStrengthScore("")).toBe(0);
		expect(passwordStrengthScore("RyuLaunch!9")).toBe(4);
		expect(passwordStrengthLabel(0)).toBe("Too weak");
		expect(passwordStrengthLabel(2)).toBe("Fair");
		expect(passwordStrengthLabel(3)).toBe("Good");
		expect(passwordStrengthLabel(4)).toBe("Strong");
	});
});
