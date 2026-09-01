import { describe, expect, it } from "bun:test";
import {
	isStepUpScope,
	STEP_UP_AUTH_PATHS,
	STEP_UP_SCOPES,
	stepUpActionLabel,
	stepUpAppliesToUser,
	stepUpMethods,
	stepUpMethodsForScope,
	stepUpRequiresEnrolled2fa,
	stepUpScopeForAuthPath,
	stepUpWindowMs,
} from "./step-up.ts";

describe("step-up scopes", () => {
	it("recognises every declared scope and nothing else", () => {
		for (const scope of STEP_UP_SCOPES) {
			expect(isStepUpScope(scope)).toBe(true);
		}
		expect(isStepUpScope("org.delete ")).toBe(false);
		expect(isStepUpScope("")).toBe(false);
		expect(isStepUpScope(null)).toBe(false);
	});

	it("gives every scope a window and a label", () => {
		for (const scope of STEP_UP_SCOPES) {
			expect(stepUpWindowMs(scope)).toBeGreaterThan(0);
			expect(stepUpActionLabel(scope).length).toBeGreaterThan(0);
		}
	});

	it("takes no emailed fallback for staff powers or billing", () => {
		expect(stepUpRequiresEnrolled2fa("platform.admin")).toBe(true);
		expect(stepUpRequiresEnrolled2fa("billing")).toBe(true);
		for (const scope of STEP_UP_SCOPES) {
			if (scope !== "platform.admin" && scope !== "billing") {
				expect(stepUpRequiresEnrolled2fa(scope)).toBe(false);
			}
		}
	});

	it("requires billing step-up and an enrolled authenticator", () => {
		expect(stepUpAppliesToUser("billing", { twoFactorEnabled: true })).toBe(
			true
		);
		expect(stepUpAppliesToUser("billing", { twoFactorEnabled: false })).toBe(
			true
		);
		expect(
			stepUpMethodsForScope({ twoFactorEnabled: true }, "billing")
		).toEqual(["totp"]);
		expect(
			stepUpMethodsForScope({ twoFactorEnabled: false }, "billing")
		).toEqual([]);
		expect(stepUpRequiresEnrolled2fa("billing")).toBe(true);
	});
});

describe("stepUpMethods", () => {
	it("offers the emailed code alone to a user with no second factor", () => {
		expect(stepUpMethods({ twoFactorEnabled: false })).toEqual(["otp"]);
		expect(stepUpMethods({})).toEqual(["otp"]);
	});

	it("leads with the authenticator app once 2FA is on", () => {
		expect(stepUpMethods({ twoFactorEnabled: true })).toEqual([
			"totp",
			"otp",
			"backup",
		]);
	});
});

describe("STEP_UP_AUTH_PATHS", () => {
	it("maps every entry to a known scope", () => {
		for (const [path, scope] of Object.entries(STEP_UP_AUTH_PATHS)) {
			expect(path.startsWith("/")).toBe(true);
			expect(isStepUpScope(scope)).toBe(true);
		}
	});

	it("leaves the already-re-authed account actions alone", () => {
		// Each of these carries its own password prompt or its own mailbox
		// confirmation; see the note above STEP_UP_SCOPES.
		expect(stepUpScopeForAuthPath("/change-password")).toBeNull();
		expect(stepUpScopeForAuthPath("/change-email")).toBeNull();
		expect(stepUpScopeForAuthPath("/two-factor/disable")).toBeNull();
	});

	it("resolves only exact paths, so a prefix cannot smuggle a gate off", () => {
		expect(stepUpScopeForAuthPath("/organization/delete")).toBe("org.delete");
		expect(stepUpScopeForAuthPath("/organization/delete-role")).toBeNull();
		expect(stepUpScopeForAuthPath("/organization/list")).toBeNull();
	});

	it("gates the endpoints that hand over or destroy an account", () => {
		// Named individually rather than snapshotted: dropping one of these is a
		// security regression, and a snapshot would happily record the drop.
		expect(stepUpScopeForAuthPath("/admin/remove-user")).toBe("platform.admin");
		expect(stepUpScopeForAuthPath("/admin/impersonate-user")).toBe(
			"platform.admin"
		);
		expect(stepUpScopeForAuthPath("/admin/set-user-password")).toBe(
			"platform.admin"
		);
		expect(stepUpScopeForAuthPath("/organization/remove-member")).toBe(
			"org.members"
		);
		expect(stepUpScopeForAuthPath("/customer/portal")).toBeNull();
	});
});
