/**
 * Mandatory second-factor enrollment.
 *
 * Every signed-in account must hold a strong second factor: an authenticator
 * app (TOTP, Better Auth's `twoFactorEnabled`) or at least one passkey. Email
 * codes do not count — they share the inbox that password resets and magic
 * links already trust, so they add no independent factor.
 *
 * The decision is pure and lives here so the API context, the Better Auth
 * guards and the status endpoint all agree on one rule. The passkey lookup is
 * injected because each caller reaches storage differently (the API through
 * `auth.$context`, a Better Auth hook through `ctx.context.adapter`).
 *
 * Platform staff (see {@link isPlatformStaff}) are always under the mandate,
 * whatever `AUTH_REQUIRE_MFA` says: their sessions read and change every
 * tenant, so a phished or reused password alone must not reach those surfaces.
 */

import { isAdmin, isAdminEmail, isMarketplaceAdminEmail } from "./waitlist.ts";

/** Response code clients branch on to send the user to enrollment. */
export const MFA_ENROLLMENT_REQUIRED_CODE = "mfa_enrollment_required";

/** Refusal code for removing the account's last strong factor. */
export const MFA_LAST_FACTOR_CODE = "mfa_last_factor";

export const MFA_ENROLLMENT_REQUIRED_MESSAGE =
	"Your account needs an authenticator app or a passkey before you can continue. Set one up in your security settings.";

export const MFA_LAST_FACTOR_MESSAGE =
	"Two-factor authentication is required. Add another passkey or an authenticator app before removing this one.";

/**
 * API paths a not-yet-enrolled session may still call. The enrollment UI reads
 * whether the account has a password (TOTP setup asks for it), and the
 * waitlist hands a just-approved account to enrollment by reading its own
 * status.
 *
 * Registering a passkey (`/passkey/verify-registration`) is gated by the
 * `account.security` step-up, so the step-up prompt's routes must stay open
 * too, or a passwordless (OAuth or magic-link) account could never enroll its
 * first factor. A grant for any other scope is inert while unenrolled: every
 * endpoint that consumes one is refused here or by `mfaEnrollmentPlugin`.
 *
 * The rest of enrollment is Better Auth endpoints, which never pass through
 * this gate.
 */
const ENROLLMENT_ALLOWED_API_PATHS = new Set([
	"/api/step-up/challenge",
	"/api/step-up/status",
	"/api/step-up/verify",
	"/api/step-up/verify-link",
	"/api/user/password-status",
	"/api/waitlist/me",
	"/api/waitlist/stream",
]);

export function isMfaEnrollmentAllowedPath(path: string): boolean {
	return ENROLLMENT_ALLOWED_API_PATHS.has(path);
}

/**
 * Better Auth endpoints an unenrolled account may not call while the mandate is
 * enforced. Each mints a credential that would let the account act without
 * passing the API gate in `createContext`: a personal API key, a JWT that Core
 * verifies offline, a one-time session token, a device-flow session for the
 * desktop or CLI, an OAuth/MCP grant or client secret, or a new organization
 * or invitation. Everything else Better Auth serves (session reads, sign-out,
 * passkey and authenticator enrollment) stays open so enrollment can finish.
 *
 * Paths match exactly, like `STEP_UP_AUTH_PATHS`; re-read this list when
 * upgrading `better-auth` or adding a plugin that issues credentials.
 */
export const MFA_ENROLLMENT_BLOCKED_AUTH_PATHS: ReadonlySet<string> = new Set([
	"/api-key/create",
	"/device/approve",
	"/mcp/authorize",
	"/oauth2/authorize",
	"/oauth2/client/rotate-secret",
	"/oauth2/consent",
	"/oauth2/continue",
	"/oauth2/create-client",
	"/one-time-token/generate",
	"/organization/create",
	"/organization/invite-member",
	"/token",
]);

/**
 * Better Auth's admin plugin (`/admin/list-users`, `/admin/get-user`, …) reads
 * and changes every account. Only platform staff can call it, and staff are
 * always under the mandate, so an unenrolled caller is refused the whole
 * prefix rather than a hand-kept list of its endpoints.
 */
const MFA_ENROLLMENT_BLOCKED_AUTH_PREFIX = "/admin/";

export function isMfaEnrollmentBlockedAuthPath(path: string): boolean {
	return (
		MFA_ENROLLMENT_BLOCKED_AUTH_PATHS.has(path) ||
		path.startsWith(MFA_ENROLLMENT_BLOCKED_AUTH_PREFIX)
	);
}

/**
 * Whether the mandate is enforced for every account (platform staff are
 * always enforced; see {@link mfaEnrollmentEnforcedForUser}). On in production,
 * so every hosted account must enroll an authenticator app or a passkey; off in
 * development and tests, so local stacks and suites need no factor.
 * `AUTH_REQUIRE_MFA` overrides either way: `false`/`0` switches it off (a
 * self-hosted service that cannot enroll its users yet), `true`/`1` switches it
 * on outside production. `@ryu/env/server` validates the same value set at
 * startup, so an unrecognized value fails boot instead of silently picking a
 * default.
 */
export function mfaEnrollmentEnforced(
	env: Record<string, string | undefined> = process.env
): boolean {
	const raw = env.AUTH_REQUIRE_MFA?.trim().toLowerCase();
	if (raw === "true" || raw === "1") {
		return true;
	}
	if (raw === "false" || raw === "0") {
		return false;
	}
	return env.NODE_ENV === "production";
}

export interface MfaEnrollmentUser {
	email?: string | null;
	id: string;
	isAnonymous?: boolean | null;
	role?: string | null;
	twoFactorEnabled?: boolean | null;
}

/**
 * Platform staff: the `admin` role or the `ADMIN_EMAILS` allowlist
 * (`isAdmin`), plus the marketplace moderator allowlist. Each of them reaches
 * cross-tenant admin routes (usage and wallets of every organization, the
 * waitlist's applicants, fleet inventory, moderation queues).
 *
 * The MFA mandate deliberately reads the raw `ADMIN_EMAILS` allowlist, not the
 * verified-address form `isAdmin` uses to GRANT access: requiring a strong
 * factor of an allowlisted address before its mailbox is proven only errs on
 * the strict side.
 */
export function isPlatformStaff(
	user: Pick<MfaEnrollmentUser, "email" | "role">
): boolean {
	return (
		isAdmin(user) ||
		isAdminEmail(user.email) ||
		isMarketplaceAdminEmail(user.email)
	);
}

/**
 * Whether the mandate is enforced for this user: everyone when
 * `AUTH_REQUIRE_MFA` is on, and platform staff always. Staff must therefore
 * hold an authenticator app or a passkey (an email code does not count) before
 * any session-authenticated route answers them.
 */
export function mfaEnrollmentEnforcedForUser(
	user: Pick<MfaEnrollmentUser, "email" | "role">,
	env: Record<string, string | undefined> = process.env
): boolean {
	return mfaEnrollmentEnforced(env) || isPlatformStaff(user);
}

/**
 * Accounts the mandate does not apply to: anonymous guests (no durable
 * identity to protect) and waitlisted accounts (no product access yet). An
 * approved account enrolls as its first onboarding step. Platform staff are
 * never exempt, even with a stale `waitlist` role. Callers must pass the
 * stored role, not a cached session copy, so an approval is never missed; see
 * {@link resolveCurrentRole}.
 */
export function mfaEnrollmentAppliesToUser(user: MfaEnrollmentUser): boolean {
	if (isPlatformStaff(user)) {
		return true;
	}
	return !(user.isAnonymous === true || user.role === "waitlist");
}

/**
 * The session's cached role can still read "waitlist" for a while after an
 * approval. Only that case pays for a stored-role lookup, so the waitlist
 * exemption can never outlive the approval itself.
 */
export async function resolveCurrentRole(
	user: MfaEnrollmentUser,
	findStoredRole: (userId: string) => Promise<string | null | undefined>
): Promise<string | null | undefined> {
	if (user.role !== "waitlist") {
		return user.role;
	}
	return await findStoredRole(user.id);
}

export interface MfaFactorState {
	passkeyCount: number;
	twoFactorEnabled: boolean;
}

export function hasStrongSecondFactor(state: MfaFactorState): boolean {
	return state.twoFactorEnabled || state.passkeyCount > 0;
}

/**
 * Whether removing one factor would leave the account with none. `removing`
 * names what is about to go away.
 */
export function wouldRemoveLastFactor(
	state: MfaFactorState,
	removing: "passkey" | "two-factor"
): boolean {
	const after =
		removing === "passkey"
			? { ...state, passkeyCount: Math.max(0, state.passkeyCount - 1) }
			: { ...state, twoFactorEnabled: false };
	return !hasStrongSecondFactor(after);
}

const ENROLLED_CACHE_TTL_MS = 60_000;
const ENROLLED_CACHE_MAX = 10_000;
const enrolledUntil = new Map<string, number>();

/**
 * Only positive answers are cached: a user who just enrolled must be let in on
 * the very next request, while a stale "enrolled" can only outlive a factor
 * removal that the last-factor guard already refuses while enforced.
 */
function cachedEnrolled(userId: string, now: number): boolean {
	const until = enrolledUntil.get(userId);
	if (until === undefined) {
		return false;
	}
	if (until <= now) {
		enrolledUntil.delete(userId);
		return false;
	}
	return true;
}

function rememberEnrolled(userId: string, now: number): void {
	if (enrolledUntil.size >= ENROLLED_CACHE_MAX) {
		const oldest = enrolledUntil.keys().next().value;
		if (oldest !== undefined) {
			enrolledUntil.delete(oldest);
		}
	}
	enrolledUntil.set(userId, now + ENROLLED_CACHE_TTL_MS);
}

/** Drop a cached "enrolled" answer after a factor changes on this instance. */
export function forgetMfaEnrollment(userId: string): void {
	enrolledUntil.delete(userId);
}

/**
 * Whether this user must enroll a factor before using the account. Fails
 * closed: a passkey lookup error propagates instead of letting the user in.
 */
export async function requiresMfaEnrollment(input: {
	countPasskeys: (userId: string) => Promise<number>;
	enforced?: boolean;
	findStoredRole?: (userId: string) => Promise<string | null | undefined>;
	now?: number;
	user: MfaEnrollmentUser;
}): Promise<boolean> {
	if (!(input.enforced ?? mfaEnrollmentEnforcedForUser(input.user))) {
		return false;
	}
	if (input.user.twoFactorEnabled === true) {
		return false;
	}
	const user = input.findStoredRole
		? {
				...input.user,
				role: await resolveCurrentRole(input.user, input.findStoredRole),
			}
		: input.user;
	if (!mfaEnrollmentAppliesToUser(user)) {
		return false;
	}
	const now = input.now ?? Date.now();
	if (cachedEnrolled(user.id, now)) {
		return false;
	}
	const passkeyCount = await input.countPasskeys(user.id);
	if (hasStrongSecondFactor({ passkeyCount, twoFactorEnabled: false })) {
		rememberEnrolled(user.id, now);
		return false;
	}
	return true;
}

/**
 * Staff session assurance.
 *
 * Holding a factor is not enough for platform staff: the session itself must
 * have been signed in with one, or re-proved one since. A staff account with an
 * authenticator app can still finish a sign-in through a magic link, an emailed
 * code, or a password on a remembered device, and none of those touch the
 * enrolled factor. Such a session is refused on every staff-reachable surface
 * until it is confirmed with the authenticator app or a recovery code (the
 * step-up prompt), or replaced by a passkey sign-in.
 *
 * The proof is stamped on the Better Auth session row (`strongFactor`) when the
 * session is created by one of {@link STRONG_LOGIN_PATHS}, or when a step-up on
 * that session succeeds with a strong method. It is server-written only.
 */
export const STAFF_SESSION_FACTOR_REQUIRED_CODE =
	"staff_session_factor_required";

export const STAFF_SESSION_FACTOR_REQUIRED_MESSAGE =
	"Ryu staff sessions must be confirmed with an authenticator app, a recovery code or a passkey. Confirm with your authenticator app, or sign out and sign in again with your passkey.";

/**
 * An organization that requires two-factor refuses a session that did not
 * prove a strong factor. The org access policy (`packages/api`) answers org
 * routes with this code; the factor-provisioning guard answers it too, for a
 * member of such an organization adding or revealing a factor from that kind
 * of session.
 */
export const ORG_MFA_SESSION_REQUIRED_CODE = "org_mfa_session_required";

export const ORG_MFA_FACTOR_PROVISIONING_MESSAGE =
	"An organization you belong to requires two-factor authentication. Confirm this session with your authenticator app or a recovery code, or sign out and sign in again with your authenticator app or a passkey, before adding or viewing a sign-in method.";

/** The session field that records how a session proved a strong factor. */
export const SESSION_STRONG_FACTOR_FIELD = "strongFactor";

/**
 * `delegated` marks a device-flow session (the desktop app and CLI, or a
 * cross-device website sign-in) issued to a staff account. Approving the device (`/device/approve`) is refused to a
 * staff session that has not proved a strong factor, so the device session
 * inherits that proof. Any other account's device session is stamped only
 * when the session that approved it had proved a strong factor (a single-use
 * proof recorded at `/device/approve`), so a device approved by an email- or
 * social-signed-in session is not grandfathered in after a promotion, and does
 * not satisfy an organization that requires two-factor.
 */
export type StrongSessionFactor = "backup" | "delegated" | "passkey" | "totp";

/**
 * Endpoints that redeem an approved device code into a session: Better Auth's
 * RFC 8628 token endpoint and the website's cross-device sign-in redemption
 * (`loginApprovalSessionPlugin`). Both need a `/device/approve` first.
 */
const DEVICE_SESSION_PATHS: ReadonlySet<string> = new Set([
	"/device/session",
	"/device/token",
]);

export function isDeviceSessionPath(path: string | null | undefined): boolean {
	return DEVICE_SESSION_PATHS.has(path ?? "");
}

/**
 * Better Auth endpoints whose new session was created by proving a strong
 * factor. An email code (`/sign-in/email-otp`, `/two-factor/verify-otp`), a
 * magic link and a password alone are deliberately absent.
 */
const STRONG_LOGIN_PATHS: ReadonlyMap<string, StrongSessionFactor> = new Map([
	["/passkey/verify-authentication", "passkey"],
	["/two-factor/verify-backup-code", "backup"],
	["/two-factor/verify-totp", "totp"],
]);

export function strongFactorForLoginPath(
	path: string | null | undefined
): StrongSessionFactor | null {
	return STRONG_LOGIN_PATHS.get(path ?? "") ?? null;
}

/** Step-up methods that also prove the session holds a strong factor. */
export function strongFactorForStepUpMethod(
	method: string
): StrongSessionFactor | null {
	return method === "totp" || method === "backup" ? method : null;
}

export function isStrongSessionFactor(
	value: unknown
): value is StrongSessionFactor {
	return (
		value === "backup" ||
		value === "delegated" ||
		value === "passkey" ||
		value === "totp"
	);
}

/**
 * Better Auth endpoints that add or reveal a factor. For a staff account that
 * already holds one, or a member of an organization that requires two-factor,
 * they need a strongly signed-in session: otherwise a
 * mailbox-only session could enroll a new authenticator (or read the existing
 * one's secret or recovery codes) and then use it to confirm itself.
 */
export const STAFF_FACTOR_PROVISIONING_AUTH_PATHS: ReadonlySet<string> =
	new Set([
		"/passkey/generate-register-options",
		"/passkey/verify-registration",
		"/two-factor/enable",
		"/two-factor/generate-backup-codes",
		"/two-factor/get-totp-uri",
	]);

/**
 * Whether this session must still prove a strong factor before it may act.
 * Only platform staff are held to it. The session's own copy (cookie cache or
 * row) is trusted when it already shows a proof; otherwise the stored row is
 * read, because a step-up upgrade updates the row but not a cached cookie.
 * Fails closed: a lookup error propagates.
 */
export async function staffSessionNeedsStrongFactor(input: {
	findStoredStrongFactor: (sessionId: string) => Promise<unknown>;
	session: { id: string; strongFactor?: unknown };
	user: Pick<MfaEnrollmentUser, "email" | "role">;
}): Promise<boolean> {
	if (!isPlatformStaff(input.user)) {
		return false;
	}
	if (isStrongSessionFactor(input.session.strongFactor)) {
		return false;
	}
	return !isStrongSessionFactor(
		await input.findStoredStrongFactor(input.session.id)
	);
}
