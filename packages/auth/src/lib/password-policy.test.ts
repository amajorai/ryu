import { describe, expect, it } from "bun:test";
import {
	PASSWORD_RULES,
	passwordSchema,
	passwordStrengthLabel,
	passwordStrengthScore,
	passwordValidationMessage,
} from "./password-policy.ts";

describe("signup password policy", () => {
	it("keeps the four visible requirements in order", () => {
		expect(PASSWORD_RULES.map((rule) => rule.label)).toEqual([
			"At least 8 characters",
			"One uppercase letter",
			"One number",
			"One symbol",
		]);
	});

	it("accepts a password only when every rule passes", () => {
		expect(passwordSchema.safeParse("RyuLaunch!9").success).toBe(true);
		expect(passwordSchema.safeParse("lowercase9!").success).toBe(false);
		expect(passwordSchema.safeParse("RyuLaunch").success).toBe(false);
		expect(passwordSchema.safeParse("Ryu!9").success).toBe(false);
	});

	it("scores and labels the same states the meter renders", () => {
		expect(passwordStrengthScore("")).toBe(0);
		expect(passwordStrengthScore("RyuLaunch!9")).toBe(4);
		expect(passwordStrengthLabel(0)).toBe("Too weak");
		expect(passwordStrengthLabel(2)).toBe("Fair");
		expect(passwordStrengthLabel(3)).toBe("Good");
		expect(passwordStrengthLabel(4)).toBe("Strong");
	});

	it("returns an inline message without changing the entered password", () => {
		expect(passwordValidationMessage("RyuLaunch9")).toBe(
			"Password needs one symbol"
		);
		expect(passwordValidationMessage("RyuLaunch!9")).toBeNull();
	});
});
