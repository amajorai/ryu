import { expect, test } from "bun:test";
import { describeFlowFailure } from "../tabs/account-data.ts";

test("a device-limit refusal recorded by Core reads as a friendly sentence", () => {
	const message = describeFlowFailure("device_limit_reached");
	expect(message).toStartWith("Device limit reached:");
	expect(message).not.toContain("device_limit_reached");
	expect(message).not.toStartWith("Sign-in failed");
});

test("the CLI uses the desktop and extension generic refusal sentence", () => {
	// Mirrors DEVICE_LIMIT_GENERIC_MESSAGE in apps/desktop/lib/device-limit-error.ts
	// so every client shares one i18n key.
	expect(describeFlowFailure("device_limit_reached")).toBe(
		"Device limit reached: this account is already signed in on as many devices of this kind as it allows. Sign out of one you no longer use, then try again."
	);
});

test("other flow outcomes keep their existing copy", () => {
	expect(describeFlowFailure("access_denied")).toBe("Sign-in was denied");
	expect(describeFlowFailure("timeout")).toBe("Sign-in code expired");
	expect(describeFlowFailure("cancelled")).toBe("Sign-in was cancelled");
	expect(describeFlowFailure("server_error")).toBe(
		"Sign-in failed: server_error"
	);
});
