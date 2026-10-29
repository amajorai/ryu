import { describe, expect, it } from "bun:test";
import { passwordPolicyRefusal } from "./password-endpoints.ts";

const STRONG = "A-strong-password-1";

/** Every endpoint that stores a password a person chose, with its body field. */
const STORING_ENDPOINTS = [
	["/sign-up/email", "password"],
	["/reset-password", "newPassword"],
	["/email-otp/reset-password", "password"],
	["/change-password", "newPassword"],
] as const;

/** Passwords the sign-up rules refuse, each with the message they give. */
const WEAK_PASSWORDS = [
	["all-lowercase-password-1", "Password needs one uppercase letter"],
	["No-digits-in-this-one", "Password needs one number"],
	["NoSymbolsInThisOne1", "Password needs one symbol"],
	["short1!", "Password needs at least 8 characters"],
	[`Aa1!${"x".repeat(125)}`, "Password must be 128 characters or fewer"],
] as const;

describe("passwordPolicyRefusal", () => {
	describe.each(STORING_ENDPOINTS)("%s", (path, field) => {
		it("accepts a password that meets the sign-up rules", () => {
			expect(passwordPolicyRefusal(path, { [field]: STRONG })).toBeNull();
		});

		it.each(
			WEAK_PASSWORDS
		)("refuses %p with the shared message", (weak, message) => {
			expect(passwordPolicyRefusal(path, { [field]: weak })).toBe(message);
		});

		it("reads the password from its own body field only", () => {
			const otherField = field === "password" ? "newPassword" : "password";
			expect(
				passwordPolicyRefusal(path, { [otherField]: STRONG })
			).not.toBeNull();
		});

		it("refuses a body that carries no password", () => {
			expect(passwordPolicyRefusal(path, undefined)).not.toBeNull();
			expect(passwordPolicyRefusal(path, null)).not.toBeNull();
			expect(passwordPolicyRefusal(path, "not an object")).not.toBeNull();
			expect(passwordPolicyRefusal(path, {})).not.toBeNull();
			expect(
				passwordPolicyRefusal(path, { [field]: 12_345_678 })
			).not.toBeNull();
		});
	});

	it("never judges a password an account already has", () => {
		const weak = "all-lowercase-password-1";
		expect(
			passwordPolicyRefusal("/sign-in/email", { password: weak })
		).toBeNull();
		expect(
			passwordPolicyRefusal("/request-password-reset", { email: "a@b.test" })
		).toBeNull();
		expect(
			passwordPolicyRefusal("/email-otp/request-password-reset", {
				email: "a@b.test",
			})
		).toBeNull();
		expect(passwordPolicyRefusal("/get-session", undefined)).toBeNull();
	});
});
