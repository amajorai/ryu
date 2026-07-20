// Queue-position math. Kept in its own module (separate from the pure helpers in
// ./waitlist) because it touches the database — the web app imports only the
// pure `isAdminEmail`, so the `@ryu/db` dependency must not be on that path.
import { User } from "@ryu/db/models/auth.model";
import { WAITLIST_ROLE } from "./waitlist.ts";

// "In the queue" = role is exactly WAITLIST_ROLE. Everything else (the normal
// "user" role, "admin", or an unset role on a legacy account) is off the queue.
const PENDING_FILTER = { role: WAITLIST_ROLE } as const;

/**
 * The 1-based queue position of a waitlisted user. The queue is ordered by
 * admin boost (waitlistPriority, higher = higher up) first, then referralCount
 * (more referrals = higher up), then sign-up time (earlier = higher up). A user's
 * position is the count of waitlisted users ranked strictly ahead of them, plus
 * one. Returns null for a user who isn't in the queue.
 *
 * `waitlistPriority` is ABSENT (not 0) for unboosted users because Better Auth
 * writes users via the raw mongo adapter and never fires the Mongoose default —
 * so the comparison normalizes missing→0 with `$ifNull` (a literal `0` equality
 * would never match an absent field and undercount the peers ahead).
 */
export async function waitlistPositionFor(
	userId: string
): Promise<number | null> {
	const me = await User.findOne({ _id: userId })
		.select("role referralCount createdAt waitlistPriority")
		.lean<{
			role?: string;
			referralCount?: number;
			createdAt?: Date;
			waitlistPriority?: number;
		}>();
	if (!me || me.role !== WAITLIST_ROLE) {
		return null;
	}
	const myPriority = me.waitlistPriority ?? 0;
	const myCount = me.referralCount ?? 0;
	const myCreatedAt = me.createdAt ?? new Date();
	const priority = { $ifNull: ["$waitlistPriority", 0] };
	const ahead = await User.countDocuments({
		...PENDING_FILTER,
		$expr: {
			$or: [
				{ $gt: [priority, myPriority] },
				{
					$and: [
						{ $eq: [priority, myPriority] },
						{
							$or: [
								{ $gt: ["$referralCount", myCount] },
								{
									$and: [
										{ $eq: ["$referralCount", myCount] },
										{ $lt: ["$createdAt", myCreatedAt] },
									],
								},
							],
						},
					],
				},
			],
		},
	});
	return ahead + 1;
}

/** Total number of users currently in the queue (role WAITLIST_ROLE). */
export async function waitlistTotalPending(): Promise<number> {
	return User.countDocuments(PENDING_FILTER);
}
