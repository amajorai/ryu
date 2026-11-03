import { User } from "@ryu/db/models/auth.model";
import {
	configureContactIdSaver,
	configureNotificationRateLimiting,
	configureRateLimiting,
	configureSentEmailRecorder,
	type RateLimitResult,
} from "@ryu/email";
import { z } from "zod";
import { checkNotificationEmailRateLimit } from "../lib/notification-email-rate.ts";
import { recordSentEmail } from "../lib/sent-email-archive.ts";

// Per-address email cooldown and daily limits, plus the hooks the email
// package calls to save contact ids and archive sent mail.

export const retryAfterSeconds = z
	.object({ retryAfter: z.number().optional() })
	.optional()
	.transform((error) => error?.retryAfter)
	.catch(undefined).parse;

const EMAIL_COOLDOWN_MS = 60 * 1000;
const EMAIL_DAILY_LIMIT = 20;

/**
 * Start a fresh daily email count when the stored one belongs to an earlier
 * day. Also normalizes a null count (users created before the field existed),
 * which `$inc` and range filters would otherwise trip over.
 */
async function rollEmailDayOver(userId: unknown, today: Date): Promise<void> {
	await User.updateOne(
		{
			_id: userId,
			$or: [
				{ lastEmailResetDate: { $not: { $gte: today } } },
				{ dailyEmailCount: null },
			],
		},
		{ $set: { dailyEmailCount: 0, lastEmailResetDate: today } }
	);
}

/**
 * Undo one cooldown claim whose email was never delivered, restoring the
 * stamp it replaced. Only while the claim is still the latest stamp: a later
 * claim or a counted delivery has moved `lastEmailSentAt` and is kept.
 */
async function releaseEmailCooldownClaim(
	userId: unknown,
	claimedAt: Date,
	previous: Date | null
): Promise<void> {
	await User.updateOne(
		{ _id: userId, lastEmailSentAt: claimedAt },
		previous
			? { $set: { lastEmailSentAt: previous } }
			: { $unset: { lastEmailSentAt: 1 } }
	);
}

const checkEmailRateLimit = async (email: string): Promise<RateLimitResult> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return { allowed: true };
		}

		const now = new Date();
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		// Roll the daily counter over first, as its own conditional write, so the
		// claim below sees today's count rather than yesterday's in-memory value.
		await rollEmailDayOver(user._id, today);

		// Claim the cooldown slot atomically. A read-then-check let concurrent
		// requests (parallel resets, sign-up retries) all pass before the first
		// send stamped `lastEmailSentAt`, defeating the per-recipient cooldown.
		// `updateEmailStats` still counts the delivery after a successful send,
		// and a send that never delivers releases the claim, so a provider outage
		// does not start a cooldown for an email nobody received.
		const claimed = await User.findOneAndUpdate(
			{
				_id: user._id,
				dailyEmailCount: { $not: { $gte: EMAIL_DAILY_LIMIT } },
				lastEmailSentAt: {
					$not: { $gt: new Date(now.getTime() - EMAIL_COOLDOWN_MS) },
				},
			},
			{ $set: { lastEmailSentAt: now } },
			// The document as it was, so a release can restore the prior stamp.
			{ new: false }
		);
		if (claimed) {
			const previous = claimed.lastEmailSentAt ?? null;
			return {
				allowed: true,
				release: () => releaseEmailCooldownClaim(user._id, now, previous),
			};
		}

		const current = await User.findOne({ _id: user._id });
		if ((current?.dailyEmailCount ?? 0) >= EMAIL_DAILY_LIMIT) {
			const tomorrow = new Date(today);
			tomorrow.setDate(tomorrow.getDate() + 1);
			const retryAfter = Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);

			return {
				allowed: false,
				reason:
					"You have reached the daily email limit. Please try again tomorrow",
				retryAfter,
			};
		}

		const lastSentAt = current?.lastEmailSentAt?.getTime() ?? now.getTime();
		const retryAfter = Math.max(
			1,
			Math.ceil((EMAIL_COOLDOWN_MS - (now.getTime() - lastSentAt)) / 1000)
		);
		return {
			allowed: false,
			reason: "Please wait before requesting another email",
			retryAfter,
		};
	} catch (error) {
		console.error("Error checking email rate limit:", error);
		return { allowed: true };
	}
};

const updateEmailStats = async (email: string): Promise<void> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });

		if (!user) {
			return;
		}

		const now = new Date();
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		await rollEmailDayOver(user._id, today);
		// `$inc`, not read-then-`$set`: concurrent sends must each be counted.
		await User.updateOne(
			{ _id: user._id },
			{ $set: { lastEmailSentAt: now }, $inc: { dailyEmailCount: 1 } }
		);
	} catch (error) {
		console.error("Error updating user email stats:", error);
	}
};

const saveContactIdToUser = async (
	email: string,
	contactId: string
): Promise<void> => {
	try {
		const user = await User.findOne({ email: email.toLowerCase() });
		if (!user) {
			return;
		}
		if (!user.resendContactId) {
			await User.updateOne(
				{ _id: user._id },
				{ $set: { resendContactId: contactId } }
			);
		}
	} catch (error) {
		console.error("Error saving contact ID to user:", error);
	}
};

/** Installs the email package's rate limiter, contact saver and archive. */
export function configureAuthEmailDelivery(): void {
	configureRateLimiting(checkEmailRateLimit, updateEmailStats);
	configureNotificationRateLimiting(checkNotificationEmailRateLimit);
	configureContactIdSaver(saveContactIdToUser);
	configureSentEmailRecorder(recordSentEmail);
}
