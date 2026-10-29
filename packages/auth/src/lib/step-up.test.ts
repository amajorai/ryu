import { describe, expect, it } from "bun:test";
import {
	isClientNativeApiKeyCreate,
	isClientNativeOrgApiKeyMutation,
	isStepUpScope,
	STEP_UP_AUTH_PATHS,
	STEP_UP_SCOPES,
	stepUpActionLabel,
	stepUpAppliesToUser,
	stepUpMethods,
	stepUpMethodsForScope,
	stepUpRequiresEnrolled2fa,
	stepUpScopeForApiKeyConfig,
	stepUpScopeForAuthPath,
	stepUpScopeForInvitedRole,
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

	it("takes no emailed fallback for staff powers, billing or session confirmation", () => {
		const strictScopes = ["platform.admin", "billing", "session.confirm"];
		for (const scope of STEP_UP_SCOPES) {
			expect(stepUpRequiresEnrolled2fa(scope)).toBe(
				strictScopes.includes(scope)
			);
		}
		for (const scope of [
			"platform.admin",
			"billing",
			"session.confirm",
		] as const) {
			expect(
				stepUpMethodsForScope({ twoFactorEnabled: true }, scope)
			).not.toContain("otp");
			expect(
				stepUpMethodsForScope({ twoFactorEnabled: true }, scope)
			).not.toContain("magic-link");
		}
		expect(
			stepUpMethodsForScope({ twoFactorEnabled: true }, "platform.admin")
		).toEqual(["totp", "backup"]);
		// Confirming a session for an org that requires two-factor accepts only
		// the factors that stamp it (`strongFactorForStepUpMethod`).
		expect(
			stepUpMethodsForScope({ twoFactorEnabled: true }, "session.confirm")
		).toEqual(["totp", "backup"]);
		expect(
			stepUpMethodsForScope({ twoFactorEnabled: false }, "session.confirm")
		).toEqual([]);
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

	it("offers password or a mailbox link for account security without 2FA", () => {
		expect(
			stepUpMethodsForScope(
				{ hasPassword: true, twoFactorEnabled: false },
				"account.security"
			)
		).toEqual(["password", "magic-link"]);
		expect(
			stepUpMethodsForScope(
				{ hasPassword: false, twoFactorEnabled: false },
				"account.security"
			)
		).toEqual(["magic-link"]);
	});

	it("keeps account security on an enrolled second factor once 2FA is enabled", () => {
		expect(
			stepUpMethodsForScope(
				{ hasPassword: true, twoFactorEnabled: true },
				"account.security"
			)
		).toEqual(["totp", "otp", "backup"]);
	});
});

describe("STEP_UP_AUTH_PATHS", () => {
	it("maps every entry to a known scope", () => {
		for (const [path, scope] of Object.entries(STEP_UP_AUTH_PATHS)) {
			expect(path.startsWith("/")).toBe(true);
			expect(isStepUpScope(scope)).toBe(true);
		}
	});

	it("gates native password changes while leaving separately confirmed actions alone", () => {
		// Each of these carries its own password prompt or its own mailbox
		// confirmation. A current password is defense in depth for password changes,
		// but does not replace an enrolled second factor.
		expect(stepUpScopeForAuthPath("/change-password")).toBe("account.security");
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
		for (const path of [
			"/admin/ban-user",
			"/admin/unban-user",
			"/admin/set-role",
			"/admin/revoke-user-session",
			"/admin/revoke-user-sessions",
			"/admin/create-user",
			"/admin/update-user",
		]) {
			expect(stepUpScopeForAuthPath(path)).toBe("platform.admin");
		}
		expect(stepUpScopeForAuthPath("/organization/remove-member")).toBe(
			"org.members"
		);
		expect(stepUpScopeForAuthPath("/organization/cancel-invitation")).toBe(
			"org.members"
		);
		expect(stepUpScopeForAuthPath("/unlink-account")).toBe("account.security");
		expect(stepUpScopeForAuthPath("/passkey/delete-passkey")).toBe(
			"account.security"
		);
		expect(stepUpScopeForAuthPath("/passkey/verify-registration")).toBe(
			"account.security"
		);
		expect(stepUpScopeForAuthPath("/customer/portal")).toBeNull();
	});

	it("gates every Better Auth admin endpoint that acts on another account", () => {
		// The full list, pinned: each can hand over, rewrite or mint an account,
		// so each needs a fresh platform.admin step-up even where the admin role's
		// access control (`platformAdminRoles` in step-up.ts) does not grant it
		// today. step-up-admin-access.test.ts pins those grants.
		const gated = Object.entries(STEP_UP_AUTH_PATHS)
			.filter(([path]) => path.startsWith("/admin/"))
			.map(([path, scope]) => `${path} ${scope}`)
			.sort();
		expect(gated).toEqual([
			"/admin/ban-user platform.admin",
			"/admin/create-user platform.admin",
			"/admin/impersonate-user platform.admin",
			"/admin/list-user-sessions platform.admin",
			"/admin/remove-user platform.admin",
			"/admin/revoke-user-session platform.admin",
			"/admin/revoke-user-sessions platform.admin",
			"/admin/set-role platform.admin",
			"/admin/set-user-password platform.admin",
			"/admin/unban-user platform.admin",
			"/admin/update-user platform.admin",
		]);
	});

	it("gates an invitation that would grant more than a plain member", () => {
		// An invitation carries its role, so an owner/admin/billing invite is a
		// promotion the invitee accepts later.
		for (const role of [
			"owner",
			"admin",
			"billing",
			"member,admin",
			["admin"],
		]) {
			expect(stepUpScopeForInvitedRole(role)).toBe("org.members");
		}
		expect(stepUpScopeForInvitedRole(["member", "billing"])).toBe(
			"org.members"
		);
		// Malformed roles fail closed; the native endpoint rejects them anyway.
		expect(stepUpScopeForInvitedRole(undefined)).toBe("org.members");
		expect(stepUpScopeForInvitedRole(42)).toBe("org.members");
		for (const role of ["member", "viewer", ["member"], ""]) {
			expect(stepUpScopeForInvitedRole(role)).toBeNull();
		}
	});

	it("resolves credential protection from Better Auth's stored config", () => {
		expect(stepUpScopeForApiKeyConfig("organization")).toBe("org.credentials");
		expect(stepUpScopeForApiKeyConfig("default")).toBeNull();
		expect(stepUpScopeForApiKeyConfig(undefined)).toBeNull();
	});

	it("refuses client calls to /api-key/create but not server calls", () => {
		const request = new Request("http://localhost/api/auth/api-key/create");
		expect(
			isClientNativeApiKeyCreate({ path: "/api-key/create", request })
		).toBe(true);
		expect(
			isClientNativeApiKeyCreate({
				path: "/api-key/create",
				headers: new Headers(),
			})
		).toBe(true);
		expect(isClientNativeApiKeyCreate({ path: "/api-key/create" })).toBe(false);
		expect(
			isClientNativeApiKeyCreate({ path: "/api-key/update", request })
		).toBe(false);
	});

	it("refuses client mutations of stored org keys but not personal or server ones", () => {
		const request = new Request("http://localhost/api/auth/api-key/delete");
		for (const path of ["/api-key/delete", "/api-key/update"]) {
			expect(
				isClientNativeOrgApiKeyMutation({ path, request }, "organization")
			).toBe(true);
			expect(
				isClientNativeOrgApiKeyMutation(
					{ path, headers: new Headers() },
					"organization"
				)
			).toBe(true);
			expect(isClientNativeOrgApiKeyMutation({ path }, "organization")).toBe(
				false
			);
			expect(
				isClientNativeOrgApiKeyMutation({ path, request }, "default")
			).toBe(false);
			expect(isClientNativeOrgApiKeyMutation({ path, request }, null)).toBe(
				false
			);
		}
		expect(
			isClientNativeOrgApiKeyMutation(
				{ path: "/api-key/create", request },
				"organization"
			)
		).toBe(false);
	});
});
