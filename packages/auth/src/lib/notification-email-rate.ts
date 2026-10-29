import { createHash } from "node:crypto";
import { NotificationEmailRate } from "@ryu/db/models/notification-email-rate.model";
import type { RateLimitResult } from "@ryu/email";
import { z } from "zod";

const MAX_DAILY_ATTEMPTS = 20;
const COOLDOWN_MS = 60_000;
const DAY_MS = 86_400_000;
const COOLDOWN_SECONDS = COOLDOWN_MS / 1000;

const storedClaimSchema = z.object({
	attempts: z.number(),
	lastReservedAt: z.date(),
});

/**
 * Seconds until the recipient's next notification email can be reserved: the
 * rest of the one-minute cooldown, or, once the day's allowance is spent, the
 * time to the next UTC day (the claim key's day). Falls back to the full
 * cooldown when the claim cannot be read.
 */
async function secondsUntilNextReservation(
	claimId: string,
	now: Date
): Promise<number> {
	try {
		const claim = storedClaimSchema.safeParse(
			await NotificationEmailRate.findById(claimId)
				.select("attempts lastReservedAt")
				.lean()
		);
		if (!claim.success) {
			return COOLDOWN_SECONDS;
		}
		const nextDay = Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate() + 1
		);
		const waitMs =
			claim.data.attempts >= MAX_DAILY_ATTEMPTS
				? nextDay - now.getTime()
				: claim.data.lastReservedAt.getTime() + COOLDOWN_MS - now.getTime();
		return Math.max(1, Math.ceil(waitMs / 1000));
	} catch {
		return COOLDOWN_SECONDS;
	}
}

/** Atomically reserve notification delivery, including recipients without accounts. */
export async function checkNotificationEmailRateLimit(
	email: string
): Promise<RateLimitResult> {
	const recipient = email.trim().toLowerCase();
	if (!recipient || recipient.length > 320) {
		return { allowed: false, reason: "Invalid notification recipient" };
	}
	const now = new Date(Date.now());
	const day = now.toISOString().slice(0, 10);
	const recipientHash = createHash("sha256").update(recipient).digest("hex");
	const claimId = `${recipientHash}:${day}`;
	let claimed: boolean;
	try {
		const claim = await NotificationEmailRate.findOneAndUpdate(
			{
				_id: claimId,
				attempts: { $lt: MAX_DAILY_ATTEMPTS },
				lastReservedAt: { $lte: new Date(now.getTime() - COOLDOWN_MS) },
			},
			{
				$inc: { attempts: 1 },
				$set: { lastReservedAt: now },
				$setOnInsert: { expiresAt: new Date(now.getTime() + 2 * DAY_MS) },
			},
			{ upsert: true, new: true }
		);
		claimed = Boolean(claim);
	} catch (error) {
		if (!z.object({ code: z.literal(11_000) }).safeParse(error).success) {
			// A quota-store outage cannot turn into unbounded recipient delivery.
			return {
				allowed: false,
				reason: "Notification delivery is temporarily unavailable",
			};
		}
		claimed = false;
	}
	if (claimed) {
		return { allowed: true };
	}
	return {
		allowed: false,
		reason: "Notification email limit exceeded",
		retryAfter: await secondsUntilNextReservation(claimId, now),
	};
}
