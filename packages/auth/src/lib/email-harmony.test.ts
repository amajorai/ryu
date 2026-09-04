import { describe, expect, it } from "bun:test";
import { validateEmail } from "better-auth-harmony/email";
import { ryuEmailHarmony } from "./email-harmony.ts";

describe("Ryu email Harmony integration", () => {
	it("registers the internal normalized email field", () => {
		const field = ryuEmailHarmony.schema?.user?.fields?.normalizedEmail;

		expect(field).toMatchObject({
			input: false,
			required: false,
			returned: false,
			type: "string",
			unique: true,
		});
	});

	it("recognizes normalized email sign-in routes without changing signup policy", () => {
		const hooks = ryuEmailHarmony.hooks?.before ?? [];
		const normalizedSignInHook = hooks[1];

		expect(
			normalizedSignInHook?.matcher({ path: "/sign-in/email" } as never)
		).toBe(true);
		expect(
			normalizedSignInHook?.matcher({ path: "/sign-up/email" } as never)
		).toBe(false);
	});

	it("rejects disposable email addresses through Harmony's validator", () => {
		expect(validateEmail("person@mailinator.com")).toBe(false);
		expect(validateEmail("person@example.org")).toBe(true);
	});
});
