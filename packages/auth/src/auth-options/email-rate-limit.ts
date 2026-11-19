import { User } from "@ryu/db/models/auth.model";
import {
	configureContactIdSaver,
	configureNotificationRateLimiting,
	configureRateLimiting,
	configureSentEmailRecorder,
	type RateLimitResult,
} from "@ryu/email";
import { z } from "zod";
import { claimEmailCooldown } from "../lib/email-cooldown.ts";
import {
	currentEmailBudget,
	takePrepaidSend,
} from "../lib/email-send-budget.ts";
import { checkNotificationEmailRateLimit } from "../lib/notification-email-rate.ts";
import { recordSentEmail } from "../lib/sent-email-archive.ts";

// The email package's per-address cooldown check and delivery stats, plus the
// hooks it calls to save contact ids and archive sent mail.

export const retryAfterSeconds = z
	.object({ retryAfter: z.number().optional() })
	.optional()
	.transform((error) => error?.retryAfter)
	.catch(undefined).parse;

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
 * The cooldown `sendEmail` applies to authentication mail
 * (lib/email-cooldown.ts, keyed by the hashed address, never by the user).
 * The one send the request in scope already paid for goes through; any other
 * claims from the budget in scope (lib/email-send-budget.ts) and is given
 * back if the delivery fails.
 */
const checkEmailRateLimit = async (email: string): Promise<RateLimitResult> => {
	try {
		if (takePrepaidSend(email)) {
			return { allowed: true };
		}
		const claim = await claimEmailCooldown(email, currentEmailBudget());
		if (claim.allowed) {
			return claim;
		}
		return {
			allowed: false,
			reason:
				claim.reason === "daily-limit"
					? "You have reached the daily email limit. Please try again tomorrow"
					: "Please wait before requesting another email",
			retryAfter: claim.retryAfter,
		};
	} catch (error) {
		console.error("Error checking email rate limit:", error);
		return { allowed: true };
	}
};

/**
 * Record a delivered authentication email on the recipient's user row, whose
 * counters the session exposes as user fields. The cooldown itself lives in
 * lib/email-cooldown.ts and does not read them.
 */
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
