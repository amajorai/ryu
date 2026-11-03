import { writeBound } from "@ryu/db/crypto";
import { User } from "@ryu/db/models/auth.model";
import {
	StaleAccountAdminEmail,
	StaleAccountUserEmail,
	sendEmail,
} from "@ryu/email";
import {
	boundedLoginDetail,
	daysSinceLastActive,
	isStaleAccountLogin,
} from "../lib/stale-account.ts";
import { adminEmails, webOrigin } from "../lib/waitlist.ts";

// Login recording and the stale-account notice sent on sign-in.

export interface EmailUser {
	email: string;
	name?: string | null;
}

export const TURNSTILE_SECRET_KEY =
	process.env.TURNSTILE_SECRET_KEY?.trim() || null;
export const TURNSTILE_CAPTCHA_ENABLED =
	TURNSTILE_SECRET_KEY !== null || process.env.NODE_ENV === "production";

interface LoginSession {
	createdAt?: Date;
	ipAddress?: string | null;
	userAgent?: string | null;
	userId?: string;
}

/**
 * Record the successful session and, only when the previous session was dormant,
 * send the two stale-account notifications. The atomic read-before-update
 * prevents concurrent logins from sending duplicate alerts.
 */
export async function recordLoginAndNotifyStaleAccount(
	session: LoginSession
): Promise<void> {
	if (!session.userId) {
		return;
	}

	const now = new Date();
	try {
		const previous = await User.findOneAndUpdate(
			{ _id: session.userId, isAnonymous: { $ne: true } },
			{
				$set: {
					lastLoginAt: now,
					// Sealed per user once content sealing is on (nothing reads them back here).
					lastLoginDevice: writeBound(
						"user",
						"lastLoginDevice",
						session.userId,
						session.userId,
						boundedLoginDetail(session.userAgent) ?? null
					),
					lastLoginIp: writeBound(
						"user",
						"lastLoginIp",
						session.userId,
						session.userId,
						boundedLoginDetail(session.ipAddress) ?? null
					),
				},
			},
			{ new: false }
		).lean<{
			email?: string;
			lastLoginAt?: Date;
			name?: string;
		}>();

		const lastLoginAt = previous?.lastLoginAt;
		if (!(previous?.email && lastLoginAt instanceof Date)) {
			return;
		}
		if (!isStaleAccountLogin(lastLoginAt, now)) {
			return;
		}

		const loginTime = session.createdAt ?? now;
		const inactiveDays = daysSinceLastActive(lastLoginAt, now);
		const loginDevice = boundedLoginDetail(session.userAgent);
		const loginIp = boundedLoginDetail(session.ipAddress);
		const securityUrl = `${webOrigin()}/settings?tab=account`;
		const sends = [
			sendEmail({
				to: previous.email,
				subject: "Your Ryu account was accessed",
				react: StaleAccountUserEmail({
					daysSinceLastActive: inactiveDays,
					loginDevice,
					loginIp,
					loginTime,
					securityUrl,
					userEmail: previous.email,
					userName: previous.name || undefined,
				}),
			}),
		];

		for (const adminEmail of adminEmails()) {
			sends.push(
				sendEmail({
					to: adminEmail,
					subject: "Dormant Ryu account reactivated",
					react: StaleAccountAdminEmail({
						adminEmail,
						daysSinceLastActive: inactiveDays,
						loginDevice,
						loginIp,
						loginTime,
						userEmail: previous.email,
						userId: session.userId,
						userName: previous.name || undefined,
					}),
				})
			);
		}

		await Promise.allSettled(sends);
	} catch (error) {
		// A security notification must never turn a successful login into a
		// failed login. The account timestamp is still useful if mail is down.
		console.error("Failed to record stale-account login notification:", error);
	}
}
