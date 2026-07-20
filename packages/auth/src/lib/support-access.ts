// Support-access helpers (#545): the user-granted "Grant support access"
// feature fronting Better Auth's impersonation primitive.
//
// Placement (CLAUDE.md §1): control-plane ("who may act / what is allowed"),
// so this lives next to the waitlist/admin helpers and reuses the same env
// allowlist (`ADMIN_EMAILS`) to designate the support actors. There is no
// `role="admin"` in Ryu (approved users are role="user"); admins are the env
// allowlist, exactly like the marketplace moderation gate.

import {
	SUPPORT_ACCESS_MAX_DURATION_MS,
	SUPPORT_ACCESS_SCOPES,
	type SupportAccessScope,
} from "@ryu/db/models/support-access.model";
import { isAdminEmail } from "./waitlist.ts";

/** True when the given email is allowed to act as a support actor. */
export function isSupportActor(email: string | null | undefined): boolean {
	// Reuse the single admin allowlist. A dedicated SUPPORT_EMAILS allowlist
	// could be split out later; for now support staff == admins.
	return isAdminEmail(email);
}

/** Filter an arbitrary string list down to the known, valid scopes. */
export function normalizeScopes(
	input: readonly string[] | undefined | null
): SupportAccessScope[] {
	if (!input) {
		return [];
	}
	const valid = new Set<string>(SUPPORT_ACCESS_SCOPES);
	const out: SupportAccessScope[] = [];
	for (const raw of input) {
		const s = typeof raw === "string" ? raw.trim() : "";
		if (valid.has(s) && !out.includes(s as SupportAccessScope)) {
			out.push(s as SupportAccessScope);
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
		typeof durationMinutes === "number" &&
		Number.isFinite(durationMinutes) &&
		durationMinutes > 0
	) {
		minutes = Math.min(durationMinutes, maxMinutes);
	}
	return new Date(now.getTime() + minutes * 60_000);
}

/** True when a grant row is still usable (active + not past its expiry). */
export function isGrantUsable(
	grant: { status?: string; expiresAt?: Date | string | null } | null,
	now: Date = new Date()
): boolean {
	if (grant?.status !== "active" || !grant.expiresAt) {
		return false;
	}
	const expires = new Date(grant.expiresAt);
	return expires.getTime() > now.getTime();
}

export type { SupportAccessScope };
export { SUPPORT_ACCESS_SCOPES };
