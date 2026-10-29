import { z } from "zod";
// Support-access helpers (#545): the user-granted "Grant support access"
// feature fronting Better Auth's impersonation primitive.
//
// Placement (CLAUDE.md §1): control-plane ("who may act / what is allowed"),
// so this lives next to the waitlist/admin helpers and reuses the same env
// allowlist (`ADMIN_EMAILS`) to designate support actors. Better Auth's native
// admin role is also required by the support issuer; the allowlist remains the
// server-owned designation that is rechecked while a session is live.

import {
	SUPPORT_ACCESS_MAX_DURATION_MS,
	SUPPORT_ACCESS_SCOPES,
	SupportAccessAudit,
	SupportAccessGrant,
	type SupportAccessScope,
} from "@ryu/db/models/support-access.model";
import { isAdminEmail } from "./waitlist.ts";

/** Machine-readable refusal for a request that is not the support flow. */
export const SUPPORT_ACCESS_REQUIRED = "SUPPORT_ACCESS_REQUIRED";
/** Machine-readable refusal for a support request outside its grant. */
export const SUPPORT_ACCESS_SCOPE_REQUIRED = "SUPPORT_ACCESS_SCOPE_REQUIRED";

/** The only raw-auth operations a support session may use for cleanup/identity. */
export const SUPPORT_ACCESS_RAW_SAFE_PATHS = new Set([
	"/admin/stop-impersonating",
	"/get-session",
	"/sign-out",
]);

/** True when the given email is allowed to act as a support actor. */
export function isSupportActor(email: string | null | undefined): boolean {
	// Reuse the single admin allowlist. A dedicated SUPPORT_EMAILS allowlist
	// could be split out later; for now support staff == admins.
	return isAdminEmail(email);
}

/**
 * True when this signed-in user may ACT as a support actor: the allowlist
 * names the address and the address is verified. An unverified address (an
 * SSO- or SCIM-asserted one, or a sign-up before the mailbox link) proves
 * nothing about who holds it, so it never starts or stops support sessions.
 * `isSupportActor` alone stays the broader check for refusing TARGETS.
 */
export function isVerifiedSupportActor(user: {
	email?: string | null;
	emailVerified?: boolean | null;
}): boolean {
	return user.emailVerified === true && isSupportActor(user.email);
}

/** Filter an arbitrary string list down to the known, valid scopes. */
export function normalizeScopes(
	input: readonly string[] | undefined | null
): SupportAccessScope[] {
	if (!input) {
		return [];
	}
	const out: SupportAccessScope[] = [];
	for (const raw of input) {
		const parsed = z
			.string()
			.trim()
			.pipe(z.enum(SUPPORT_ACCESS_SCOPES))
			.safeParse(raw);
		if (parsed.success && !out.includes(parsed.data)) {
			out.push(parsed.data);
		}
	}
	return out;
}

/**
 * Resolve a grant's expiry instant from a requested duration (minutes),
 * clamped to (0, 60min]. The AC requires auto-expiry <= 1 hour; a missing or
 * out-of-range request defaults to the 60-minute ceiling.
 */
export function resolveGrantExpiry(
	durationMinutes: number | undefined | null,
	now: Date = new Date()
): Date {
	const maxMinutes = SUPPORT_ACCESS_MAX_DURATION_MS / 60_000;
	let minutes = maxMinutes;
	if (
		durationMinutes != null &&
		Number.isFinite(durationMinutes) &&
		durationMinutes > 0
	) {
		minutes = Math.min(durationMinutes, maxMinutes);
	}
	return new Date(now.getTime() + minutes * 60_000);
}

/** True when a grant row is still usable (active + not past its expiry). */
export function isGrantUsable(
	grant: { status?: string | null; expiresAt?: Date | string | null } | null,
	now: Date = new Date()
): boolean {
	if (grant?.status !== "active" || !grant.expiresAt) {
		return false;
	}
	const expires = new Date(grant.expiresAt);
	return expires.getTime() > now.getTime();
}

/**
 * The exact control-plane reads a hosted support session may perform.
 *
 * This is deliberately an exact table. A route that is added later is denied
 * for support sessions until it is reviewed and assigned one of the six
 * diagnostic scopes. In particular, `/channels` and `/channels/:id` are not
 * listed because their response includes a system-prompt field, even though
 * their credential values are masked.
 */
const SUPPORT_ACCESS_ROUTE_SCOPES: ReadonlyMap<
	string,
	readonly SupportAccessScope[]
> = new Map([
	["GET /support-access/diagnostics/billing", ["billing"]],
	["GET /support-access/diagnostics/subscription", ["subscription"]],
	["GET /support-access/diagnostics/organization", ["organization"]],
	["GET /support-access/diagnostics/sync-status", ["sync-status"]],
	["GET /support-access/diagnostics/channels", ["channels"]],
	["GET /support-access/diagnostics/marketplace", ["marketplace"]],
	// These existing reads are intentionally narrow and read-only. Every other
	// API route stays closed to an impersonated support session.
	["GET /billing/invoices", ["billing"]],
	["GET /billing/subscription-status", ["subscription", "billing"]],
	["GET /channels/status", ["channels"]],
	["GET /marketplace/catalog", ["marketplace"]],
	["GET /marketplace/featured", ["marketplace"]],
	["GET /marketplace/organizations", ["marketplace"]],
]);

function normalizeRequestPath(path: string): string {
	const withoutQuery = path.split("?", 1)[0] ?? path;
	let pathname = withoutQuery;
	try {
		pathname = new URL(withoutQuery, "http://support-access.invalid").pathname;
	} catch {
		// The caller supplies a path, not an untrusted redirect URL. Keep the
		// lexical fallback for Hono's path value if it is not URL-shaped.
	}
	if (pathname.length > 1 && pathname.endsWith("/")) {
		pathname = pathname.slice(0, -1);
	}
	if (pathname === "/api") {
		return "/";
	}
	return pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
}

/** Return every scope that authorizes this exact method/path pair. */
export function supportAccessScopesForRequest(
	path: string,
	method = "GET"
): SupportAccessScope[] {
	return [
		...(SUPPORT_ACCESS_ROUTE_SCOPES.get(
			`${method.toUpperCase()} ${normalizeRequestPath(path)}`
		) ?? []),
	];
}

/** Return the primary scope for an exact support diagnostic route. */
export function supportAccessScopeForRequest(
	path: string,
	method = "GET"
): SupportAccessScope | null {
	return supportAccessScopesForRequest(path, method)[0] ?? null;
}

/** Whether a live grant authorizes the exact API method/path pair. */
export function isSupportAccessRequestAllowed(
	path: string,
	method: string,
	scopes: readonly string[]
): boolean {
	const allowed = supportAccessScopesForRequest(path, method);
	return allowed.some((scope) => scopes.includes(scope));
}

/**
 * A validated binding between one Better Auth impersonation session, one
 * append-only audit row, and the exact user grant that authorized it.
 */
export interface SupportAccessSession {
	actorId: string;
	auditId: string;
	expiresAt: Date;
	grantExpiresAt: Date;
	grantId: string;
	reason: string;
	scopes: SupportAccessScope[];
}

interface SupportSessionLike {
	session: {
		expiresAt?: Date | string | null;
		id?: string | null;
		impersonatedBy?: string | null;
		userId?: string | null;
	};
	user: { id?: string | null };
}

interface SupportAuditLike {
	_id?: unknown;
	actorEmail?: string | null;
	actorId?: string | null;
	endedAt?: Date | string | null;
	grantId?: string | null;
	reason?: string | null;
	scopes?: string[] | null;
	startedAt?: Date | string | null;
	userId?: string | null;
}

interface SupportGrantLike {
	_id?: unknown;
	expiresAt?: Date | string | null;
	scopes?: string[] | null;
	status?: string | null;
	userId?: string | null;
}

function validDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Validate an impersonated session against live, server-owned support state.
 *
 * A null result means the session must not be treated as an authenticated Ryu
 * session. Database failures are intentionally allowed to reject the caller;
 * the API context catches them and fails closed rather than treating a stale
 * cookie as a normal account session.
 */
export async function resolveSupportAccessSession(
	session: SupportSessionLike,
	now = new Date()
): Promise<SupportAccessSession | null> {
	const sessionId = session.session.id?.trim();
	const userId = session.user.id?.trim() || session.session.userId?.trim();
	const actorId = session.session.impersonatedBy?.trim();
	if (!(sessionId && userId && actorId)) {
		return null;
	}
	if (session.session.userId && session.session.userId.trim() !== userId) {
		return null;
	}

	const sessionExpiresAt = validDate(session.session.expiresAt);
	if (!(sessionExpiresAt && sessionExpiresAt.getTime() > now.getTime())) {
		return null;
	}

	const audit = await SupportAccessAudit.findOne({
		actorId,
		endedAt: null,
		sessionId,
		userId,
	}).lean<SupportAuditLike | null>();
	if (!audit) {
		return null;
	}
	const auditId = String(audit._id ?? "").trim();
	if (!auditId) {
		return null;
	}

	const auditGrantId = audit.grantId?.trim();
	if (!(auditGrantId && audit.userId === userId && audit.actorId === actorId)) {
		return null;
	}
	const startedAt = validDate(audit.startedAt);
	if (!startedAt || startedAt.getTime() > now.getTime()) {
		return null;
	}
	if (!z.string().trim().min(1).safeParse(audit.reason).success) {
		return null;
	}

	const grant = await SupportAccessGrant.findOne({
		_id: auditGrantId,
		status: "active",
		userId,
	}).lean<SupportGrantLike | null>();
	if (!(grant && isGrantUsable(grant, now))) {
		return null;
	}

	const grantScopes = normalizeScopes(grant.scopes);
	const rawGrantScopes = Array.isArray(grant.scopes) ? grant.scopes : [];
	const normalizedRawGrantScopes = rawGrantScopes
		.filter((value) => z.string().safeParse(value).success)
		.map((value) => value.trim());
	// Grant rows are authorization state. Treat an unknown, duplicate, or
	// malformed persisted scope as invalid instead of silently shrinking it to a
	// smaller boundary during validation.
	if (
		grantScopes.length === 0 ||
		grantScopes.length !== normalizedRawGrantScopes.length ||
		new Set(normalizedRawGrantScopes).size !== grantScopes.length
	) {
		return null;
	}

	const auditScopes = normalizeScopes(audit.scopes);
	// An audit row is security state, so malformed/unknown scopes fail closed
	// instead of silently shrinking the reviewer's requested boundary.
	const rawAuditScopes = Array.isArray(audit.scopes) ? audit.scopes : [];
	const normalizedRawAuditScopes = rawAuditScopes
		.filter((value) => z.string().safeParse(value).success)
		.map((value) => value.trim());
	if (
		auditScopes.length === 0 ||
		auditScopes.length !== normalizedRawAuditScopes.length ||
		new Set(normalizedRawAuditScopes).size !== auditScopes.length ||
		!auditScopes.every((scope) => grantScopes.includes(scope))
	) {
		return null;
	}

	if (
		audit.actorEmail == null ||
		!audit.actorEmail.trim() ||
		!isSupportActor(audit.actorEmail)
	) {
		return null;
	}

	return {
		actorId,
		auditId,
		expiresAt: sessionExpiresAt,
		grantExpiresAt: z
			.union([
				z.date(),
				z
					.string()
					.transform((value) => new Date(value))
					.pipe(z.date()),
			])
			.parse(grant.expiresAt),
		grantId: auditGrantId,
		reason: audit.reason ?? "",
		scopes: auditScopes,
	};
}

export type { SupportAccessScope };
export { SUPPORT_ACCESS_SCOPES };
