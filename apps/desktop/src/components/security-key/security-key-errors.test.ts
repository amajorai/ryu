import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	securityKeyErrorMessage,
	securityKeyPinMessage,
} from "./security-key-errors.ts";

/** English pass-through with ICU `{name}` substitution, like the runtime. */
const tl: LiteralMessage = (source, values = {}) =>
	source.replaceAll(/\{(\w+)\}/gu, (_whole, name: string) =>
		String((values as Record<string, unknown>)[name] ?? `{${name}}`)
	);

describe("securityKeyErrorMessage", () => {
	test("picks the sentence from the native code, not the English detail", () => {
		expect(securityKeyErrorMessage("timeout: no touch in 30s", tl)).toBe(
			"No security key answered in time. Make sure it is plugged in, then try again."
		);
		expect(securityKeyErrorMessage("pin_blocked", tl)).toContain(
			"PIN is blocked"
		);
		expect(
			securityKeyErrorMessage("credential_excluded: already there", tl)
		).toBe("This key is already registered with this site.");
		expect(securityKeyErrorMessage("no_credentials", tl)).toBe(
			"This key has no sign-in saved for this site."
		);
		expect(securityKeyErrorMessage("invalid: rp mismatch", tl)).toBe(
			"This request can't be completed with a security key."
		);
	});

	test("an unknown or unshaped error falls back to a generic line", () => {
		expect(securityKeyErrorMessage(new Error("USB stall"), tl)).toBe(
			"The security key reported an error. Try again."
		);
		expect(securityKeyErrorMessage({ weird: true }, tl)).toBe(
			"The security key reported an error. Try again."
		);
	});
});

describe("securityKeyPinMessage", () => {
	test("the first PIN ask shows no message", () => {
		expect(securityKeyPinMessage("pin_required", tl)).toBeNull();
	});

	test("a wrong PIN keeps the attempts left", () => {
		expect(
			securityKeyPinMessage("pin_required: wrong PIN (2 attempts left)", tl)
		).toBe("Wrong PIN. 2 attempts left.");
		expect(
			securityKeyPinMessage("pin_required: wrong PIN (1 attempt left)", tl)
		).toBe("Wrong PIN. 1 attempt left before the key locks.");
		expect(securityKeyPinMessage("pin_required: wrong PIN", tl)).toBe(
			"Wrong PIN. Try again."
		);
	});

	test("a malformed PIN explains the minimum length", () => {
		expect(securityKeyPinMessage("pin_required: PIN too short", tl)).toBe(
			"That PIN can't be used. Security key PINs have at least 4 characters."
		);
	});
});
