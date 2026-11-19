import { User } from "@ryu/db/models/auth.model";
import { authApi } from "../auth-options/auth-instance.ts";
import { deferredReplayHeaders } from "./deferred-replay-marker.ts";
import { runDetached } from "./detached-delivery.ts";
import { claimEmailCooldown } from "./email-cooldown.ts";
import { prepaidSend } from "./email-send-budget.ts";

// The signed-out "resend my verification email" request (the API's
// `POST /api/user/resend-verification`, which the CLI uses). It must not tell a
// caller whether the address holds an account, or whether that account is
// verified: every address spends the same request-budget claim before any
// lookup, the caller gets the same answer, and the lookup and the send run
// after it, detached (lib/detached-delivery.ts).

/**
 * A per-address ceiling inside the detached work, best-effort and per replica:
 * three verification resends in 15 minutes for one unverified account. The
 * fleet-wide limit is the cooldown claim the request already made.
 */
const RESEND_WINDOW_MS = 15 * 60 * 1000;
const RESEND_MAX_PER_WINDOW = 3;
const RESEND_MAX_TRACKED = 10_000;
const resendWindows = new Map<string, { count: number; resetAt: number }>();

export function admitVerificationResend(
	email: string,
	now = Date.now()
): boolean {
	const existing = resendWindows.get(email);
	if (existing && now < existing.resetAt) {
		if (existing.count >= RESEND_MAX_PER_WINDOW) {
			return false;
		}
		existing.count += 1;
		return true;
	}
	if (!existing && resendWindows.size >= RESEND_MAX_TRACKED) {
		for (const [tracked, window] of resendWindows) {
			if (now >= window.resetAt) {
				resendWindows.delete(tracked);
			}
		}
		if (resendWindows.size >= RESEND_MAX_TRACKED) {
			return false;
		}
	}
	resendWindows.set(email, { count: 1, resetAt: now + RESEND_WINDOW_MS });
	return true;
}

/** Look the address up and, for an unverified account, send the email. */
async function sendIfUnverified(email: string): Promise<void> {
	const user = await User.findOne({ email })
		.select("emailVerified")
		.lean<{ emailVerified?: boolean }>();
	if (!user || user.emailVerified || !admitVerificationResend(email)) {
		return;
	}
	// No session headers: Better Auth takes its signed-out branch. The replay
	// marker keeps the cooldown hook from claiming a second time; the send
	// uses the claim made below.
	await authApi().sendVerificationEmail({
		body: { callbackURL: "/", email },
		headers: deferredReplayHeaders(),
	});
}

/**
 * Claim the address's request budget and queue the account-dependent work.
 * Resolves the same way for every address; a cooldown refusal and a claim
 * store outage are absorbed here too, so the answer never varies.
 */
export async function requestVerificationResend(email: string): Promise<void> {
	let allowed = false;
	try {
		allowed = (await claimEmailCooldown(email, "request")).allowed;
	} catch (error) {
		console.error(
			`Verification resend claim failed: ${error instanceof Error ? error.name : typeof error}`
		);
	}
	if (!allowed) {
		return;
	}
	runDetached(
		"verification resend",
		() => sendIfUnverified(email),
		prepaidSend("request", email)
	);
}
