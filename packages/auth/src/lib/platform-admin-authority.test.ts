import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	isPinnedPlatformAdmin,
	PLATFORM_ADMIN_REFUSALS,
	type PlatformAdminCandidate,
	platformAdminRefusal,
	platformAdminUserIds,
	requiresSecondAdminApproval,
} from "./platform-admin-authority.ts";

const previousEmails = process.env.ADMIN_EMAILS;
const previousIds = process.env.RYU_PLATFORM_ADMIN_USER_IDS;

function restore(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

function candidate(
	overrides: Partial<PlatformAdminCandidate> = {}
): PlatformAdminCandidate {
	return {
		email: "operator@example.com",
		emailVerified: true,
		id: "admin-1",
		impersonated: false,
		twoFactorEnabled: true,
		...overrides,
	};
}

beforeEach(() => {
	process.env.ADMIN_EMAILS = "operator@example.com";
	process.env.RYU_PLATFORM_ADMIN_USER_IDS = " admin-1 , ,admin-2";
});

afterEach(() => {
	restore("ADMIN_EMAILS", previousEmails);
	restore("RYU_PLATFORM_ADMIN_USER_IDS", previousIds);
});

describe("pinned platform admin ids", () => {
	it("parses a trimmed comma-separated list", () => {
		expect([...platformAdminUserIds()]).toEqual(["admin-1", "admin-2"]);
		expect(isPinnedPlatformAdmin("admin-1")).toBe(true);
		expect(isPinnedPlatformAdmin("admin-3")).toBe(false);
		expect(isPinnedPlatformAdmin(null)).toBe(false);
	});

	it("fails closed when the list is unset", () => {
		delete process.env.RYU_PLATFORM_ADMIN_USER_IDS;
		expect(platformAdminUserIds().size).toBe(0);
		expect(platformAdminRefusal(candidate())).toBe(
			PLATFORM_ADMIN_REFUSALS.notPinned
		);
	});
});

describe("two-admin approval", () => {
	it("is required only once two or more admins are pinned", () => {
		expect(requiresSecondAdminApproval()).toBe(true);
		process.env.RYU_PLATFORM_ADMIN_USER_IDS = "admin-1";
		expect(requiresSecondAdminApproval()).toBe(false);
		process.env.RYU_PLATFORM_ADMIN_USER_IDS = "";
		expect(requiresSecondAdminApproval()).toBe(false);
	});
});

describe("platformAdminRefusal", () => {
	it("accepts an allowlisted, pinned, verified, 2FA-enrolled operator", () => {
		expect(platformAdminRefusal(candidate())).toBeNull();
	});

	it("tells a non-staff caller only that platform admin is required", () => {
		expect(
			platformAdminRefusal(
				candidate({
					email: "someone@example.com",
					emailVerified: false,
					twoFactorEnabled: false,
				})
			)
		).toBe(PLATFORM_ADMIN_REFUSALS.notAllowlisted);
	});

	it("refuses an allowlisted email whose user id is not pinned", () => {
		expect(platformAdminRefusal(candidate({ id: "recycled" }))).toBe(
			PLATFORM_ADMIN_REFUSALS.notPinned
		);
	});

	it("refuses an unverified email", () => {
		expect(platformAdminRefusal(candidate({ emailVerified: null }))).toBe(
			PLATFORM_ADMIN_REFUSALS.emailNotVerified
		);
	});

	it("refuses an operator without two-factor authentication", () => {
		expect(platformAdminRefusal(candidate({ twoFactorEnabled: false }))).toBe(
			PLATFORM_ADMIN_REFUSALS.twoFactorRequired
		);
	});

	it("refuses a support session even for a pinned operator", () => {
		expect(platformAdminRefusal(candidate({ impersonated: true }))).toBe(
			PLATFORM_ADMIN_REFUSALS.impersonated
		);
	});
});
