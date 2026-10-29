import { describe, expect, it } from "bun:test";
import {
	forgetMfaEnrollment,
	hasStrongSecondFactor,
	isDeviceSessionPath,
	isMfaEnrollmentAllowedPath,
	isMfaEnrollmentBlockedAuthPath,
	isStrongSessionFactor,
	mfaEnrollmentAppliesToUser,
	mfaEnrollmentEnforced,
	mfaEnrollmentEnforcedForUser,
	requiresMfaEnrollment,
	STAFF_FACTOR_PROVISIONING_AUTH_PATHS,
	staffSessionNeedsStrongFactor,
	strongFactorForLoginPath,
	strongFactorForStepUpMethod,
	wouldRemoveLastFactor,
} from "./mfa-enrollment.ts";

describe("mfaEnrollmentEnforced", () => {
	it("is on by default in production and off in development and tests", () => {
		expect(mfaEnrollmentEnforced({ NODE_ENV: "production" })).toBe(true);
		expect(mfaEnrollmentEnforced({ NODE_ENV: "development" })).toBe(false);
		expect(mfaEnrollmentEnforced({ NODE_ENV: "test" })).toBe(false);
		expect(mfaEnrollmentEnforced({})).toBe(false);
	});

	it("treats an empty AUTH_REQUIRE_MFA as unset", () => {
		expect(
			mfaEnrollmentEnforced({ AUTH_REQUIRE_MFA: "", NODE_ENV: "production" })
		).toBe(true);
		expect(
			mfaEnrollmentEnforced({ AUTH_REQUIRE_MFA: " ", NODE_ENV: "test" })
		).toBe(false);
	});

	it("honors an explicit AUTH_REQUIRE_MFA either way", () => {
		expect(
			mfaEnrollmentEnforced({ AUTH_REQUIRE_MFA: "true", NODE_ENV: "test" })
		).toBe(true);
		expect(
			mfaEnrollmentEnforced({ AUTH_REQUIRE_MFA: "0", NODE_ENV: "production" })
		).toBe(false);
		expect(
			mfaEnrollmentEnforced({
				AUTH_REQUIRE_MFA: "False",
				NODE_ENV: "production",
			})
		).toBe(false);
		expect(
			mfaEnrollmentEnforced({ AUTH_REQUIRE_MFA: " TRUE ", NODE_ENV: "test" })
		).toBe(true);
	});
});

describe("factor rules", () => {
	it("counts an authenticator app or a passkey, never neither", () => {
		expect(
			hasStrongSecondFactor({ passkeyCount: 0, twoFactorEnabled: true })
		).toBe(true);
		expect(
			hasStrongSecondFactor({ passkeyCount: 1, twoFactorEnabled: false })
		).toBe(true);
		expect(
			hasStrongSecondFactor({ passkeyCount: 0, twoFactorEnabled: false })
		).toBe(false);
	});

	it("refuses removing the only remaining factor", () => {
		expect(
			wouldRemoveLastFactor(
				{ passkeyCount: 0, twoFactorEnabled: true },
				"two-factor"
			)
		).toBe(true);
		expect(
			wouldRemoveLastFactor(
				{ passkeyCount: 1, twoFactorEnabled: false },
				"passkey"
			)
		).toBe(true);
		expect(
			wouldRemoveLastFactor(
				{ passkeyCount: 1, twoFactorEnabled: true },
				"two-factor"
			)
		).toBe(false);
		expect(
			wouldRemoveLastFactor(
				{ passkeyCount: 2, twoFactorEnabled: false },
				"passkey"
			)
		).toBe(false);
	});

	it("exempts guests and waitlisted accounts only", () => {
		expect(mfaEnrollmentAppliesToUser({ id: "u", isAnonymous: true })).toBe(
			false
		);
		expect(mfaEnrollmentAppliesToUser({ id: "u", role: "waitlist" })).toBe(
			false
		);
		expect(mfaEnrollmentAppliesToUser({ id: "u", role: "admin" })).toBe(true);
	});

	it("keeps the enrollment UI's password check reachable", () => {
		expect(isMfaEnrollmentAllowedPath("/api/user/password-status")).toBe(true);
		expect(isMfaEnrollmentAllowedPath("/api/waitlist/me")).toBe(true);
		expect(isMfaEnrollmentAllowedPath("/api/waitlist/stream")).toBe(true);
		// Passkey registration needs an account.security step-up first.
		for (const path of [
			"/api/step-up/status",
			"/api/step-up/challenge",
			"/api/step-up/verify",
			"/api/step-up/verify-link",
		]) {
			expect(isMfaEnrollmentAllowedPath(path)).toBe(true);
		}
		expect(isMfaEnrollmentAllowedPath("/api/user/profile")).toBe(false);
		expect(isMfaEnrollmentAllowedPath("/api/step-up/other")).toBe(false);
	});
});

describe("requiresMfaEnrollment", () => {
	const noPasskeys = () => Promise.resolve(0);

	it("does nothing while the mandate is off", async () => {
		expect(
			await requiresMfaEnrollment({
				countPasskeys: () => Promise.reject(new Error("must not be called")),
				enforced: false,
				user: { id: "off" },
			})
		).toBe(false);
	});

	it("lets TOTP users through without a passkey lookup", async () => {
		expect(
			await requiresMfaEnrollment({
				countPasskeys: () => Promise.reject(new Error("must not be called")),
				enforced: true,
				user: { id: "totp", twoFactorEnabled: true },
			})
		).toBe(false);
	});

	it("requires enrollment for an account with no factor", async () => {
		expect(
			await requiresMfaEnrollment({
				countPasskeys: noPasskeys,
				enforced: true,
				user: { id: "bare" },
			})
		).toBe(true);
	});

	it("caches passkey enrollment but re-checks once forgotten", async () => {
		let lookups = 0;
		const countPasskeys = () => {
			lookups += 1;
			return Promise.resolve(lookups === 1 ? 1 : 0);
		};
		const input = {
			countPasskeys,
			enforced: true,
			now: 1000,
			user: { id: "passkey-user" },
		};
		expect(await requiresMfaEnrollment(input)).toBe(false);
		expect(await requiresMfaEnrollment(input)).toBe(false);
		expect(lookups).toBe(1);
		forgetMfaEnrollment("passkey-user");
		expect(await requiresMfaEnrollment(input)).toBe(true);
		expect(lookups).toBe(2);
	});

	it("exempts waitlisted accounts until the stored role is approved", async () => {
		const waitlisted = { id: "queued-user", role: "waitlist" };
		expect(
			await requiresMfaEnrollment({
				countPasskeys: noPasskeys,
				enforced: true,
				findStoredRole: () => Promise.resolve("waitlist"),
				user: waitlisted,
			})
		).toBe(false);
		// The session still caches "waitlist" right after approval.
		expect(
			await requiresMfaEnrollment({
				countPasskeys: noPasskeys,
				enforced: true,
				findStoredRole: () => Promise.resolve("user"),
				user: waitlisted,
			})
		).toBe(true);
	});

	it("only looks up the stored role for waitlist sessions", async () => {
		expect(
			await requiresMfaEnrollment({
				countPasskeys: noPasskeys,
				enforced: true,
				findStoredRole: () => Promise.reject(new Error("must not be called")),
				user: { id: "member", role: "user" },
			})
		).toBe(true);
	});

	it("propagates lookup failures so callers fail closed", async () => {
		await expect(
			requiresMfaEnrollment({
				countPasskeys: () => Promise.reject(new Error("db down")),
				enforced: true,
				user: { id: "unknown" },
			})
		).rejects.toThrow("db down");
	});
});

describe("platform staff mandate", () => {
	const staffEnv = {
		ADMIN_EMAILS: "operator@staff.example.test",
		RYU_MARKETPLACE_ADMIN_EMAILS: "moderator@staff.example.test",
	};
	const withStaffEnv = async <T>(run: () => Promise<T> | T): Promise<T> => {
		const previous = {
			ADMIN_EMAILS: process.env.ADMIN_EMAILS,
			AUTH_REQUIRE_MFA: process.env.AUTH_REQUIRE_MFA,
			RYU_MARKETPLACE_ADMIN_EMAILS: process.env.RYU_MARKETPLACE_ADMIN_EMAILS,
		};
		Object.assign(process.env, staffEnv);
		delete process.env.AUTH_REQUIRE_MFA;
		try {
			return await run();
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	};

	it("enforces the mandate for staff even when AUTH_REQUIRE_MFA is off", async () => {
		await withStaffEnv(() => {
			expect(mfaEnrollmentEnforcedForUser({ role: "admin" }, {})).toBe(true);
			expect(
				mfaEnrollmentEnforcedForUser(
					{ email: "Operator@Staff.example.test", role: "user" },
					{}
				)
			).toBe(true);
			expect(
				mfaEnrollmentEnforcedForUser(
					{ email: "moderator@staff.example.test" },
					{}
				)
			).toBe(true);
			expect(
				mfaEnrollmentEnforcedForUser(
					{ email: "member@tenant.example.test", role: "user" },
					{}
				)
			).toBe(false);
			expect(
				mfaEnrollmentEnforcedForUser(
					{ email: "member@tenant.example.test", role: "user" },
					{ AUTH_REQUIRE_MFA: "true" }
				)
			).toBe(true);
		});
	});

	it("never exempts staff as waitlisted", async () => {
		await withStaffEnv(() => {
			expect(
				mfaEnrollmentAppliesToUser({
					email: "operator@staff.example.test",
					id: "operator",
					role: "waitlist",
				})
			).toBe(true);
		});
	});

	it("requires a strong factor for staff by default and accepts one", async () => {
		await withStaffEnv(async () => {
			expect(
				await requiresMfaEnrollment({
					countPasskeys: () => Promise.resolve(0),
					user: { id: "bare-admin", role: "admin" },
				})
			).toBe(true);
			expect(
				await requiresMfaEnrollment({
					countPasskeys: () => Promise.reject(new Error("must not be called")),
					user: { id: "totp-admin", role: "admin", twoFactorEnabled: true },
				})
			).toBe(false);
			expect(
				await requiresMfaEnrollment({
					countPasskeys: () => Promise.reject(new Error("must not be called")),
					user: { id: "member", role: "user" },
				})
			).toBe(false);
		});
	});

	it("refuses Better Auth's admin plugin surface to unenrolled callers", () => {
		expect(isMfaEnrollmentBlockedAuthPath("/admin/list-users")).toBe(true);
		expect(isMfaEnrollmentBlockedAuthPath("/admin/get-user")).toBe(true);
		expect(isMfaEnrollmentBlockedAuthPath("/get-session")).toBe(false);
		expect(isMfaEnrollmentBlockedAuthPath("/administrator")).toBe(false);
	});
});

describe("staff session assurance", () => {
	const staff = { email: "ops@example.com", role: "admin" };
	const member = { email: "member@example.com", role: "user" };

	it("counts only authenticator, recovery-code and passkey sign-ins", () => {
		expect(strongFactorForLoginPath("/passkey/verify-authentication")).toBe(
			"passkey"
		);
		expect(strongFactorForLoginPath("/two-factor/verify-totp")).toBe("totp");
		expect(strongFactorForLoginPath("/two-factor/verify-backup-code")).toBe(
			"backup"
		);
		for (const weak of [
			"/sign-in/email",
			"/sign-in/username",
			"/sign-in/email-otp",
			"/magic-link/verify",
			"/two-factor/verify-otp",
			"/callback/google",
			undefined,
		]) {
			expect(strongFactorForLoginPath(weak)).toBeNull();
		}
	});

	it("upgrades a session only from an authenticator or recovery code step-up", () => {
		expect(strongFactorForStepUpMethod("totp")).toBe("totp");
		expect(strongFactorForStepUpMethod("backup")).toBe("backup");
		for (const weak of ["otp", "password", "magic-link"]) {
			expect(strongFactorForStepUpMethod(weak)).toBeNull();
		}
	});

	it("refuses a staff session signed in by email even with a factor on file", async () => {
		let lookups = 0;
		const needs = await staffSessionNeedsStrongFactor({
			findStoredStrongFactor: () => {
				lookups += 1;
				return Promise.resolve(null);
			},
			session: { id: "sess" },
			user: staff,
		});
		expect(needs).toBe(true);
		expect(lookups).toBe(1);
	});

	it("admits a staff session stamped on its copy or its stored row", async () => {
		expect(
			await staffSessionNeedsStrongFactor({
				findStoredStrongFactor: () => Promise.reject(new Error("unused")),
				session: { id: "sess", strongFactor: "passkey" },
				user: staff,
			})
		).toBe(false);
		expect(
			await staffSessionNeedsStrongFactor({
				findStoredStrongFactor: () => Promise.resolve("totp"),
				session: { id: "sess" },
				user: staff,
			})
		).toBe(false);
	});

	it("ignores unknown stamp values", async () => {
		expect(
			await staffSessionNeedsStrongFactor({
				findStoredStrongFactor: () => Promise.resolve("otp"),
				session: { id: "sess", strongFactor: "magic-link" },
				user: staff,
			})
		).toBe(true);
	});

	it("does not hold ordinary members to it", async () => {
		expect(
			await staffSessionNeedsStrongFactor({
				findStoredStrongFactor: () => Promise.reject(new Error("unused")),
				session: { id: "sess" },
				user: member,
			})
		).toBe(false);
	});

	it("propagates a lookup failure so callers fail closed", async () => {
		await expect(
			staffSessionNeedsStrongFactor({
				findStoredStrongFactor: () => Promise.reject(new Error("down")),
				session: { id: "sess" },
				user: staff,
			})
		).rejects.toThrow("down");
	});

	it("recognizes device-code redemptions and the delegated stamp", () => {
		expect(isDeviceSessionPath("/device/token")).toBe(true);
		expect(isDeviceSessionPath("/device/session")).toBe(true);
		expect(isDeviceSessionPath("/device/approve")).toBe(false);
		expect(isStrongSessionFactor("delegated")).toBe(true);
		expect(isStrongSessionFactor("otp")).toBe(false);
	});

	it("pins the factor-provisioning paths", () => {
		expect([...STAFF_FACTOR_PROVISIONING_AUTH_PATHS].sort()).toEqual([
			"/passkey/generate-register-options",
			"/passkey/verify-registration",
			"/two-factor/enable",
			"/two-factor/generate-backup-codes",
			"/two-factor/get-totp-uri",
		]);
	});
});
