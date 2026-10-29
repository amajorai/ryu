// Root (platform) admin authority, shared by the control-plane gate and the
// Better Auth hooks.
//
// A platform admin is a named Ryu operator, not anyone holding the mutable
// Better Auth `role: "admin"`. The gate needs all of:
//   - the email in `ADMIN_EMAILS` (the bootstrap allowlist, see waitlist.ts),
//   - the user id pinned in `RYU_PLATFORM_ADMIN_USER_IDS` (comma-separated), so
//     a recycled or re-registered email can never inherit the power,
//   - a verified email and an enrolled authenticator (the `twoFactor` plugin).
//
// The id list is read from `process.env` on every call, like `ADMIN_EMAILS`,
// so tests and operators can change it without a restart-only config path.
// An empty or unset list fails closed: no session is a platform admin.

import { isAdminEmail } from "./waitlist.ts";

/** Parsed set of pinned platform-admin user ids. */
export function platformAdminUserIds(): ReadonlySet<string> {
	const raw = process.env.RYU_PLATFORM_ADMIN_USER_IDS ?? "";
	return new Set(
		raw
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0)
	);
}

/** True when this user id is pinned as a platform admin. */
export function isPinnedPlatformAdmin(
	userId: string | null | undefined
): boolean {
	if (!userId) {
		return false;
	}
	return platformAdminUserIds().has(userId);
}

/**
 * Whether a high-impact abuse action (a permanent ban, lifting a ban, lifting
 * an S4 or upstream-warning org suspension, loosening the platform floor)
 * waits for a second platform admin.
 *
 * Two-admin approval only means something when a second admin exists. With
 * one pinned platform admin, that admin plus a fresh `platform.admin` step-up
 * is the whole authority, so a solo operator is never locked out of their own
 * console. As soon as two or more ids are pinned, every such action is stored
 * as a pending approval that a different admin must approve within 72 hours.
 */
export function requiresSecondAdminApproval(): boolean {
	return platformAdminUserIds().size >= 2;
}

/** The facts the gate needs, read from the stored user row, not the cookie. */
export interface PlatformAdminCandidate {
	email: string | null | undefined;
	emailVerified: boolean | null | undefined;
	id: string;
	/** True when the request runs on a support (impersonation) session. */
	impersonated: boolean;
	twoFactorEnabled: boolean | null | undefined;
}

export const PLATFORM_ADMIN_REFUSALS = {
	emailNotVerified: "Platform admin requires a verified email",
	impersonated: "A support session cannot act as a platform admin",
	notAllowlisted: "requires platform admin",
	notPinned: "This account is not a pinned platform admin",
	twoFactorRequired:
		"Platform admin requires two-factor authentication to be turned on",
} as const;

/**
 * Why this candidate is not a platform admin, or null when it is. Checks run
 * from the cheapest and least revealing (the allowlist) to the most specific,
 * so a non-staff caller only ever learns "requires platform admin".
 */
export function platformAdminRefusal(
	candidate: PlatformAdminCandidate
): string | null {
	if (!isAdminEmail(candidate.email)) {
		return PLATFORM_ADMIN_REFUSALS.notAllowlisted;
	}
	if (candidate.impersonated) {
		return PLATFORM_ADMIN_REFUSALS.impersonated;
	}
	if (!isPinnedPlatformAdmin(candidate.id)) {
		return PLATFORM_ADMIN_REFUSALS.notPinned;
	}
	if (candidate.emailVerified !== true) {
		return PLATFORM_ADMIN_REFUSALS.emailNotVerified;
	}
	if (candidate.twoFactorEnabled !== true) {
		return PLATFORM_ADMIN_REFUSALS.twoFactorRequired;
	}
	return null;
}
