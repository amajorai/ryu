// Waitlist + referral helpers shared by the auth hooks and the control-plane
// API. The waitlist is account-based: every new sign-up lands in the queue
// (the admin-plugin `role` set to "waitlist") and is let in either by an admin
// invite (role flipped to "user") or by being an admin / grandfathered user.
//
// Admins are designated by an env allowlist (`ADMIN_EMAILS`, comma-separated).
// This deliberately avoids a DB bootstrap problem: the very first admin can
// always get in (and reach the admin dashboard to invite others) without anyone
// having to flip a row first. The same allowlist is what bypasses the waitlist
// redirect.

/** Parsed, lower-cased set of admin emails from the `ADMIN_EMAILS` env var. */
export function adminEmails(): Set<string> {
	const raw = process.env.ADMIN_EMAILS ?? "";
	return new Set(
		raw
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter((e) => e.length > 0)
	);
}

/** True when the given email is in the admin allowlist. */
export function isAdminEmail(email: string | null | undefined): boolean {
	if (!email) {
		return false;
	}
	return adminEmails().has(email.toLowerCase());
}

// One-time-per-process flag for the bypass warning below.
let warnedWaitlistBypass = false;

/**
 * True when the waitlist gate is bypassed because `ADMIN_EMAILS` is empty.
 *
 * With no admin allowlist, no admin session can ever exist, so nobody could
 * ever approve anyone — every signup would dead-end on the waitlist forever
 * (the self-hosted bootstrap problem). In that configuration the waitlist is
 * disabled: new signups are approved immediately and accounts already stamped
 * `WAITLIST_ROLE` are treated as approved at gate time. Cloud deployments set
 * `ADMIN_EMAILS`, which keeps the fail-closed queue exactly as before.
 *
 * Warns once per process when the bypass is active so operators know why the
 * waitlist isn't gating.
 */
export function isWaitlistBypassed(): boolean {
	if (adminEmails().size > 0) {
		return false;
	}
	if (!warnedWaitlistBypass) {
		warnedWaitlistBypass = true;
		console.warn(
			"[waitlist] ADMIN_EMAILS is empty — no admin can ever approve waitlisted users, so the waitlist is bypassed: new signups are auto-approved and existing waitlisted accounts are treated as approved. Set ADMIN_EMAILS to enable the waitlist."
		);
	}
	return true;
}

const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no easily-confused chars
const REFERRAL_CODE_LENGTH = 8;

/** Generate a short, shareable, URL-safe referral code. */
export function generateReferralCode(): string {
	let code = "";
	for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
		const idx = Math.floor(Math.random() * REFERRAL_ALPHABET.length);
		code += REFERRAL_ALPHABET[idx];
	}
	return code;
}

// Waitlist lives on the Better Auth admin-plugin `role` field. A user in the
// queue has role WAITLIST_ROLE; approving them sets role APPROVED_ROLE ("user",
// the normal role). Anything that isn't exactly WAITLIST_ROLE (incl. "user",
// "admin", or an unset role on a legacy account) counts as off the waitlist.
export const WAITLIST_ROLE = "waitlist";
export const APPROVED_ROLE = "user";
// The Better Auth admin-plugin role (default member of `adminRoles`). Support
// staff (the `ADMIN_EMAILS` allowlist) get this real role so the admin plugin's
// impersonation primitive (`auth.api.impersonateUser`, used by support access,
// #545) accepts them — the plugin gates impersonation on the acting session's
// role being in `adminRoles` (default ["admin"]). Anything that isn't exactly
// WAITLIST_ROLE (incl. this) is off the waitlist.
export const ADMIN_ROLE = "admin";

/**
 * True when this user is still in the queue. Admins (env allowlist) never are,
 * and nobody is when the waitlist is bypassed (no admins configured — see
 * `isWaitlistBypassed`), which also unblocks accounts stamped `WAITLIST_ROLE`
 * before `ADMIN_EMAILS` was emptied.
 */
export function isWaitlisted(user: {
	role?: string | null;
	email?: string | null;
}): boolean {
	return (
		user.role === WAITLIST_ROLE &&
		!isAdminEmail(user.email) &&
		!isWaitlistBypassed()
	);
}

/**
 * The public web origin that serves `/login` (the Next app), NOT the auth/server
 * origin. Referral and invite links must point here. Defaults to :3001 in dev.
 */
export function webOrigin(): string {
	return (process.env.FRONTEND_URL ?? "http://localhost:3001").replace(
		/\/$/,
		""
	);
}

/**
 * A shareable referral link. Lands on the SIGN-UP view (not sign-in) with the
 * code, so a referred new user converts in one step and the referrer is credited.
 */
export function referralUrlFor(code: string): string {
	return `${webOrigin()}/login?view=signup&ref=${code}`;
}

// How many invites we send per week, used only to turn a queue position into a
// rough wait estimate. A product assumption, NOT a commitment — tune via the
// `WAITLIST_INVITES_PER_WEEK` env var without a deploy. Defaults to 50/week.
const DEFAULT_INVITES_PER_WEEK = 50;
const WEEKS_PER_MONTH = 4.345;
// Past this many weeks we phrase the estimate in months instead.
const MONTHS_THRESHOLD_WEEKS = 9;

/** Invites-per-week throughput, from env, clamped to a sane positive number. */
export function invitesPerWeek(): number {
	const raw = Number.parseInt(process.env.WAITLIST_INVITES_PER_WEEK ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INVITES_PER_WEEK;
}

/**
 * A human, deliberately-approximate wait estimate for a 1-based queue position,
 * e.g. "less than a week", "~3 weeks", "~2 months". Returns null when there is no
 * position (approved, or off the queue). This is an estimate the UI must label as
 * such, never a promise.
 */
export function waitlistEtaLabel(
	position: number | null | undefined
): string | null {
	if (!position || position <= 0) {
		return null;
	}
	const perWeek = invitesPerWeek();
	const weeks = Math.ceil(position / perWeek);
	if (weeks <= 1) {
		return "less than a week";
	}
	if (weeks < MONTHS_THRESHOLD_WEEKS) {
		return `~${weeks} weeks`;
	}
	const months = Math.max(2, Math.round(weeks / WEEKS_PER_MONTH));
	return `~${months} months`;
}
