/**
 * Limits custom-role grants (`roleAssignment` rows) to a member's current
 * membership. Grant cleanup on removal is best effort, so a row written before
 * the current `member` row was created belongs to an earlier membership and
 * must never apply again if the same user is re-invited. Better Auth always
 * stamps `member.createdAt`; a legacy member row without it keeps its grants.
 *
 * Kept free of the session/auth graph so every permission reader (and test
 * that mocks `org-authorization.ts`) can share it.
 */

interface MembershipStamp {
	createdAt?: Date | null;
}

/** Mongo filter fragment for `RoleAssignment.find` under one membership. */
export function currentMembershipGrantFilter(member: MembershipStamp): {
	createdAt?: { $gte: Date };
} {
	return member.createdAt ? { createdAt: { $gte: member.createdAt } } : {};
}

/** In-memory form of `currentMembershipGrantFilter` for batched reads. */
export function grantedInCurrentMembership(
	assignment: MembershipStamp,
	member: MembershipStamp
): boolean {
	if (!member.createdAt) {
		return true;
	}
	return Boolean(
		assignment.createdAt && assignment.createdAt >= member.createdAt
	);
}
