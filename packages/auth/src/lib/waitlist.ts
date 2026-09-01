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

import { GUEST_MODE_ENABLED } from "./guest-mode.ts";

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

/**
 * The second, historically-separate admin allowlist:
 * `RYU_MARKETPLACE_ADMIN_EMAILS`, which gates marketplace moderation, staff
 * picks and the affiliate program.
 *
 * It exists because those routers predate the `role` field and were written
 * against their own variable. It is exported so those two routers can accept it
 * EXPLICITLY, alongside `isAdmin`, rather than each re-reading `process.env`
 * behind a private helper (which is how the variable came to be unset in
 * production while every page in front of it looked fine). It is deliberately
 * not part of `isAdmin` — see the note there. Same fail-closed shape as
 * `adminEmails()`: unset contributes nobody.
 */
export function marketplaceAdminEmails(): Set<string> {
	const raw = process.env.RYU_MARKETPLACE_ADMIN_EMAILS ?? "";
	return new Set(
		raw
			.split(/[\s,]+/)
			.map((e) => e.trim().toLowerCase())
			.filter((e) => e.length > 0)
	);
}

/** True when the given email is in the marketplace admin allowlist. */
export function isMarketplaceAdminEmail(
	email: string | null | undefined
): boolean {
	if (!email) {
		return false;
	}
	return marketplaceAdminEmails().has(email.toLowerCase());
}

// One-time-per-process flag for the bypass warning below.
let warnedWaitlistBypass = false;
// One-time-per-process flag for the "forced on, but unapprovable" warning.
let warnedWaitlistUnapprovable = false;

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

/**
 * The explicit `WAITLIST_ENABLED` switch, or null when it is unset/unparseable.
 *
 * Before this existed the waitlist had no switch of its own: it was ON exactly
 * when `ADMIN_EMAILS` was non-empty, so emptying the allowlist silently
 * auto-approved every new signup with nothing in the config saying "waitlist
 * off". This makes the intent sayable directly. Unset keeps the historical
 * derived behaviour, so nothing changes for a deployment that never sets it.
 */
export function waitlistEnabledOverride(): boolean | null {
	const raw = (process.env.WAITLIST_ENABLED ?? "").trim().toLowerCase();
	if (TRUTHY.has(raw)) {
		return true;
	}
	if (FALSY.has(raw)) {
		return false;
	}
	return null;
}

/**
 * True when the waitlist gate is bypassed — i.e. the waitlist is OFF.
 *
 * `WAITLIST_ENABLED` decides this outright when it is set. When it is not set
 * (the default), the state is derived from `ADMIN_EMAILS` as it always has
 * been: with no admin allowlist no admin session can ever exist, so nobody
 * could ever approve anyone and every signup would dead-end on the waitlist
 * forever (the self-hosted bootstrap problem). In that configuration the
 * waitlist is disabled: new signups are approved immediately and accounts
 * already stamped `WAITLIST_ROLE` are treated as approved at gate time. Cloud
 * deployments set `ADMIN_EMAILS`, which keeps the fail-closed queue as before.
 *
 * Warns once per process when the bypass is active so operators know why the
 * waitlist isn't gating, and once more in the one configuration the override
 * makes newly reachable: queue forced ON with nobody able to approve anyone.
 */
export function isWaitlistBypassed(): boolean {
	const override = waitlistEnabledOverride();
	if (override !== null) {
		if (override && adminEmails().size === 0 && !warnedWaitlistUnapprovable) {
			warnedWaitlistUnapprovable = true;
			console.warn(
				"[waitlist] WAITLIST_ENABLED forces the queue ON but ADMIN_EMAILS is empty — no admin session can exist, so nobody can approve anyone and queued signups will wait forever. Set ADMIN_EMAILS as well, or unset WAITLIST_ENABLED."
			);
		}
		return !override;
	}
	if (adminEmails().size > 0) {
		return false;
	}
	if (!warnedWaitlistBypass) {
		warnedWaitlistBypass = true;
		console.warn(
			"[waitlist] ADMIN_EMAILS is empty — no admin can ever approve waitlisted users, so the waitlist is bypassed: new signups are auto-approved and existing waitlisted accounts are treated as approved. Set ADMIN_EMAILS to enable the waitlist, or WAITLIST_ENABLED=true to force it on regardless."
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
 * True when the user is a PLATFORM admin. Two independent designations count:
 *   - the `ADMIN_EMAILS` allowlist (the bootstrap authority; the first admin,
 *     before any DB row is stamped), and
 *   - the Better Auth admin-plugin `role` of ADMIN_ROLE ("admin"), delegated by
 *     an existing admin.
 *
 * The env allowlist is server-only, so on the client this resolves to the role
 * check alone. The route guard (`requireAdminSession`) and every client-side
 * admin affordance MUST use this single predicate — otherwise a role-only admin
 * is shown an Admin entry that the guard then bounces back to /dashboard, and
 * every API route behind an admin page must use it too, or the page loads and
 * every request on it 403s. That was the bug this predicate exists to prevent.
 *
 * `role: "admin"` is a REAL, separately-writable designation: the Better Auth
 * admin plugin's `set-role` endpoint and direct DB stamps both produce accounts
 * that are on no allowlist. Do not assume role ⟺ allowlist; production has an
 * account that is one and not the other.
 *
 * NOT included, on purpose: `RYU_MARKETPLACE_ADMIN_EMAILS`. That list names
 * marketplace moderators, and this predicate also gates campaign creation, the
 * referral PAYOUT SWEEP, the certification queue that serves answer keys, and
 * waitlist approvals. Folding it in here would hand every future marketplace
 * moderator all of that silently. The marketplace and affiliate routers accept
 * it explicitly alongside this predicate — see `isMarketplaceAdminEmail` — which
 * keeps a marketplace-only admin scoped to the marketplace.
 *
 * The other gate deliberately NOT on this predicate is the fleet-global key
 * vault (`packages/api/src/routers/key-vault.ts`) — see the comment there.
 */
export function isAdmin(user: {
	role?: string | null;
	email?: string | null;
}): boolean {
	return user.role === ADMIN_ROLE || isAdminEmail(user.email);
}

/**
 * True when this user is still in the queue. Admins (env allowlist) never are,
 * and nobody is when the waitlist is bypassed (no admins configured — see
 * `isWaitlistBypassed`), which also unblocks accounts stamped `WAITLIST_ROLE`
 * before `ADMIN_EMAILS` was emptied. Anonymous sessions remain gated while
 * guest mode is disabled because they have no durable account admission to
 * check.
 */
export function isWaitlisted(user: {
	isAnonymous?: boolean | null;
	role?: string | null;
	email?: string | null;
}): boolean {
	if (user.isAnonymous && !GUEST_MODE_ENABLED) {
		return true;
	}
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
 * A shareable referral link. Short by design — `/r/CODE` rather than a
 * query-string form — because this is a link people paste to friends, and
 * `?view=signup&ref=` reads as machinery. The web app's `/r/[code]` route
 * handler stores the code and forwards to the SIGN-UP view (not sign-in), so a
 * referred new user still converts in one step and the referrer is credited.
 */
export function referralUrlFor(code: string): string {
	return `${webOrigin()}/r/${code}`;
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
/** Trailing window the observed invite rate is measured over. */
export const INVITE_RATE_WINDOW_DAYS = 28;
/**
 * Approvals needed in the window before the measurement is trusted.
 *
 * Below this, one busy afternoon dominates the average and the estimate swings
 * wildly between reads — worse than the configured constant, because it looks
 * derived. Under the threshold we fall back rather than publish noise.
 */
const MIN_APPROVALS_FOR_RATE = 5;
const DAYS_PER_WEEK = 7;

/**
 * Invites per week as actually OBSERVED, or null when there is not enough
 * history to say.
 *
 * `invitesPerWeek()` is a configured constant — what someone once intended to
 * send, not what is being sent. An estimate built on it drifts from reality the
 * moment the real pace differs, and it never self-corrects. This measures the
 * approvals that actually happened in the trailing window instead, so a queue
 * that speeds up or stalls is reflected on the next read.
 */
export function observedInvitesPerWeek(
	approvalsInWindow: number,
	windowDays: number = INVITE_RATE_WINDOW_DAYS
): number | null {
	if (
		!Number.isFinite(approvalsInWindow) ||
		approvalsInWindow < MIN_APPROVALS_FOR_RATE ||
		windowDays <= 0
	) {
		return null;
	}
	return (approvalsInWindow / windowDays) * DAYS_PER_WEEK;
}

/**
 * A wait estimate for `position`.
 *
 * `ratePerWeek` is the measured throughput from {@link observedInvitesPerWeek};
 * omit it (or pass null) to fall back to the configured {@link invitesPerWeek}.
 * The caller decides, because only the caller can count approvals.
 */
export function waitlistEtaLabel(
	position: number | null | undefined,
	ratePerWeek?: number | null
): string | null {
	if (!position || position <= 0) {
		return null;
	}
	const perWeek =
		typeof ratePerWeek === "number" && ratePerWeek > 0
			? ratePerWeek
			: invitesPerWeek();
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
