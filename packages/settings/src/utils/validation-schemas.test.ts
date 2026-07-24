import { describe, expect, it } from "bun:test";
import {
	emailChangeSchema,
	emailSchema,
	nameSchema,
	passwordChangeSchema,
	passwordSchema,
	profileSchema,
} from "./validation-schemas.ts";

describe("nameSchema", () => {
	it("accepts a normal name", () => {
		expect(nameSchema.safeParse("Ada Lovelace").success).toBe(true);
	});

	it("rejects an empty name with the required message", () => {
		const result = nameSchema.safeParse("");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe("Name is required");
		}
	});

	it("accepts exactly 50 characters", () => {
		expect(nameSchema.safeParse("a".repeat(50)).success).toBe(true);
	});

	it("rejects 51 characters", () => {
		const result = nameSchema.safeParse("a".repeat(51));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe(
				"Name must be 50 characters or less"
			);
		}
	});
});

describe("emailSchema", () => {
	it("accepts a valid address", () => {
		expect(emailSchema.safeParse("user@example.com").success).toBe(true);
	});

	it.each([
		"not-an-email",
		"user@",
		"@example.com",
		"user example.com",
		"",
	])("rejects %p", (bad) => {
		expect(emailSchema.safeParse(bad).success).toBe(false);
	});
});

describe("passwordSchema", () => {
	it("accepts a password meeting every rule", () => {
		expect(passwordSchema.safeParse("Passw0rd!").success).toBe(true);
	});

	it("rejects a password shorter than 8 characters", () => {
		expect(passwordSchema.safeParse("Pw0!").success).toBe(false);
	});

	it("rejects a password with no uppercase letter", () => {
		const result = passwordSchema.safeParse("password0!");
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			expect(messages).toContain(
				"Password must contain at least one uppercase letter"
			);
		}
	});

	it("rejects a password with no digit", () => {
		const result = passwordSchema.safeParse("Password!");
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			expect(messages).toContain("Password must contain at least one number");
		}
	});

	it("rejects a password with no special character", () => {
		const result = passwordSchema.safeParse("Password0");
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			expect(messages).toContain(
				"Password must contain at least one special character"
			);
		}
	});

	it("aggregates multiple failures for a weak password", () => {
		const result = passwordSchema.safeParse("abc");
		expect(result.success).toBe(false);
		if (!result.success) {
			// too short + no uppercase + no number + no special = 4 issues.
			expect(result.error.issues.length).toBe(4);
		}
	});
});

describe("emailChangeSchema", () => {
	it("accepts a valid current password and new email", () => {
		expect(
			emailChangeSchema.safeParse({
				currentPassword: "whatever",
				newEmail: "new@example.com",
			}).success
		).toBe(true);
	});

	it("rejects an empty current password", () => {
		const result = emailChangeSchema.safeParse({
			currentPassword: "",
			newEmail: "new@example.com",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			expect(messages).toContain("Current password is required");
		}
	});

	it("rejects an invalid new email", () => {
		expect(
			emailChangeSchema.safeParse({
				currentPassword: "whatever",
				newEmail: "bad",
			}).success
		).toBe(false);
	});
});

describe("passwordChangeSchema", () => {
	it("treats the current password as optional", () => {
		expect(
			passwordChangeSchema.safeParse({ newPassword: "Passw0rd!" }).success
		).toBe(true);
	});

	it("still enforces new-password strength", () => {
		expect(
			passwordChangeSchema.safeParse({
				currentPassword: "old",
				newPassword: "weak",
			}).success
		).toBe(false);
	});
});

describe("profileSchema", () => {
	it("accepts a valid name and email together", () => {
		expect(
			profileSchema.safeParse({ name: "Ada", email: "ada@example.com" }).success
		).toBe(true);
	});

	it("fails when either field is invalid", () => {
		expect(
			profileSchema.safeParse({ name: "", email: "ada@example.com" }).success
		).toBe(false);
		expect(
			profileSchema.safeParse({ name: "Ada", email: "nope" }).success
		).toBe(false);
	});
});
