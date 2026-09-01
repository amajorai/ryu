import { describe, expect, it } from "bun:test";
import {
	GUEST_MODE_DISABLED_MESSAGE,
	GUEST_MODE_ENABLED,
	shouldRejectGuestSignIn,
} from "./guest-mode.ts";

describe("guest mode policy", () => {
	it("keeps guest access disabled while the waitlist is active", () => {
		expect(GUEST_MODE_ENABLED).toBe(false);
		expect(shouldRejectGuestSignIn("/sign-in/anonymous")).toBe(true);
		expect(GUEST_MODE_DISABLED_MESSAGE).toContain("waitlist");
	});

	it("does not intercept normal authentication endpoints", () => {
		expect(shouldRejectGuestSignIn("/sign-in/email")).toBe(false);
		expect(shouldRejectGuestSignIn("/sign-in/social")).toBe(false);
	});
});
