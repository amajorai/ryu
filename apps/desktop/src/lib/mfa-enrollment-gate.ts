import type { MfaEnrollmentAccess } from "@ryuhq/core-client/mfa-enrollment.ts";

// The second-factor half of the root gate. The waitlist decides whether an
// account may use the app at all; once it has, the control plane still refuses
// every request from an account with neither an authenticator app nor a
// passkey. This module holds the decisions; `MfaEnrollmentGate` reads them.

/** Same cadence as the waitlist gate's poll, while the account is not clear. */
export const MFA_ENROLLMENT_POLL_MS = 20_000;

/** A status read that has not answered by then counts as `unknown`: the app
 *  opens and the next poll asks again, instead of a spinner on a hung socket. */
export const MFA_ENROLLMENT_CHECK_TIMEOUT_MS = 8000;

export type MfaEnrollmentSurface = "loading" | "enroll" | "app";

/** Per-account marker that this account's last status read was `clear`. Scoped
 *  by user id so a second, unenrolled account on the same machine never
 *  inherits another account's answer. */
export function mfaEnrollmentClearKeyForUser(userId: string): string {
	return `ryu_mfa_enrollment_clear:${userId}`;
}

/** Whether this account's last status read was `clear`. */
export function readMfaEnrollmentClear(userId: string | null): boolean {
	if (!userId) {
		return false;
	}
	try {
		return localStorage.getItem(mfaEnrollmentClearKeyForUser(userId)) === "1";
	} catch {
		return false;
	}
}

/** Keep the marker in step with a definite answer. Only `clear` writes it:
 *  `exempt` can flip to `required` later (an admin approves a waitlisted
 *  account), so it must not open the app ahead of a live read. `unknown`
 *  leaves the marker as it was: one failed read says nothing about the account. */
export function rememberMfaEnrollmentAccess(
	userId: string | null,
	access: MfaEnrollmentAccess
): void {
	if (!userId || access === "unknown") {
		return;
	}
	try {
		const key = mfaEnrollmentClearKeyForUser(userId);
		if (access === "clear") {
			localStorage.setItem(key, "1");
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Storage unavailable; the next launch simply waits for a live read.
	}
}

/** Resolve what the root gate shows for the second-factor mandate.
 *
 *  - Disabled (anonymous, signed out, or still behind the waitlist): the app,
 *    because there is no control-plane account to enroll.
 *  - `required`: the enrollment screen, whatever an older read said.
 *  - `clear`, `exempt` or `unknown`: the app. `unknown` never blocks; the control plane
 *    still enforces the mandate on every request.
 *  - No answer yet: the app when this account was clear last time, so a
 *    returning account opens without waiting on a round trip; otherwise hold
 *    the app back so an unenrolled account never sees it flash and fail. */
export function resolveMfaEnrollmentSurface(input: {
	access: MfaEnrollmentAccess | null;
	cachedClear: boolean;
	enabled: boolean;
}): MfaEnrollmentSurface {
	if (!input.enabled) {
		return "app";
	}
	if (input.access === "required") {
		return "enroll";
	}
	if (input.access === null) {
		return input.cachedClear ? "app" : "loading";
	}
	return "app";
}
