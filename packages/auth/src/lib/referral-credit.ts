import { User } from "@ryu/db/models/auth.model";

/**
 * Credit a referrer's `referralCount` only for a referee who proved a real
 * mailbox.
 *
 * The waitlist ranks the queue by `referralCount`, so the count is a reward.
 * Crediting it at raw sign-up let scripted sign-ups with throwaway, never
 * verified addresses move their referrer up the queue. A referee who signs up
 * already verified (social, email OTP, magic link) is credited at once; anyone
 * else is marked `referralCreditPending` and credited exactly once when the
 * mailbox is verified. Users created before this rule carry no marker: they
 * were counted at sign-up and are never counted again.
 *
 * Both entry points are best-effort and swallow their own failures, so a
 * referral write can never fail a sign-up or a verification.
 */
export async function creditReferrerAtSignup(user: {
	emailVerified?: boolean;
	id: string;
	referredBy?: string;
}): Promise<void> {
	if (!user.referredBy) {
		return;
	}
	try {
		if (user.emailVerified) {
			await incrementReferrer(user.referredBy);
			return;
		}
		await User.updateOne(
			{ _id: user.id },
			{ $set: { referralCreditPending: true } }
		);
	} catch (error) {
		console.error("Failed to credit referrer:", error);
	}
}

/**
 * Settle a pending referral credit once the referee's email is verified.
 * Claiming the marker with one atomic update makes this idempotent: repeated
 * verification hooks, a later email change, or two racing requests credit the
 * referrer at most once.
 */
export async function creditPendingReferral(userId: string): Promise<void> {
	try {
		const claimed = await User.findOneAndUpdate(
			{ _id: userId, emailVerified: true, referralCreditPending: true },
			{ $unset: { referralCreditPending: 1 } },
			{ projection: { referredBy: 1 } }
		).lean<{ referredBy?: string | null }>();
		if (claimed?.referredBy) {
			await incrementReferrer(claimed.referredBy);
		}
	} catch (error) {
		console.error("Failed to credit referrer after verification:", error);
	}
}

async function incrementReferrer(referralCode: string): Promise<void> {
	// An unknown code matches nothing: no credit, no error.
	await User.updateOne({ referralCode }, { $inc: { referralCount: 1 } });
}
