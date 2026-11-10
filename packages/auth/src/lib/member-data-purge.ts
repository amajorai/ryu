/**
 * The departure seam for purging a member's app data on the organization's
 * nodes.
 *
 * WHY A REGISTRY AND NOT AN IMPORT. The purge fan-out (signing a purge
 * delegation per node, calling Core's `POST /api/data/purge-user`, and
 * queueing a retry for a node that is offline) is
 * `scheduleNodeDataPurge` in `@ryu/api/lib/node-data-purge`. `@ryu/api`
 * depends on `@ryu/auth`, so it cannot be imported here, while the event
 * (`afterRemoveMember`) only exists here. The API router registers the
 * implementation when it loads (`node-data-purge-registration.ts`), the same
 * single-slot, last-wins shape as `referral-grant-hook.ts`.
 *
 * Unregistered (`@ryu/auth` loaded alone by a script or a test), scheduling is
 * a silent no-op.
 */

/** Why the member's data is purged; Core's `reason` values for a departure. */
export type MemberDataPurgeReason = "account_deleted" | "member_removed";

/**
 * A node captured before its organization is deleted (account deletion of the
 * workspace's only member), so the purge can still reach it once the node's
 * own rows are gone.
 */
export interface MemberDataPurgeNodeSnapshot {
	nodeId: string;
	/** The node's advertised URL when it was captured; null when it had none. */
	reachableUrl: string | null;
	teamId: string | null;
}

export interface MemberDataPurgeRequest {
	/**
	 * The organization's nodes, captured by the caller. Absent: the scheduler
	 * lists the organization's live nodes itself (the usual departure).
	 */
	nodes?: readonly MemberDataPurgeNodeSnapshot[];
	organizationId: string;
	reason: MemberDataPurgeReason;
	userId: string;
}

/** The implementation the API registers. */
export type MemberDataPurgeScheduler = (
	request: MemberDataPurgeRequest
) => Promise<void>;

let scheduler: MemberDataPurgeScheduler | null = null;

/** Install the purge scheduler. Last registration wins. */
export function registerMemberDataPurgeScheduler(
	implementation: MemberDataPurgeScheduler | null
): void {
	scheduler = implementation;
}

/**
 * Schedule the purge of one departed member's app data on every node of the
 * organization. NEVER REJECTS: a member removal or an account deletion must
 * never fail because a node, the queue or the signing key is unavailable. The
 * scheduler records what it could not deliver and replays it; a failure to
 * even record it is logged here. Returns whether the scheduler accepted it.
 */
export async function scheduleMemberDataPurge(
	request: MemberDataPurgeRequest
): Promise<boolean> {
	const implementation = scheduler;
	if (!implementation) {
		return false;
	}
	try {
		await implementation(request);
		return true;
	} catch (error) {
		console.error(
			"[member-data-purge] could not schedule the node data purge:",
			error instanceof Error ? error.message : error
		);
		return false;
	}
}

/** Who rejoined: their pending `member_removed` purges are cancelled. */
export interface MemberRejoinRequest {
	organizationId: string;
	userId: string;
}

/** The cancellation the API registers next to the scheduler. */
export type MemberDataPurgeCanceller = (
	request: MemberRejoinRequest
) => Promise<void>;

let canceller: MemberDataPurgeCanceller | null = null;

/** Install the rejoin cancellation. Last registration wins. */
export function registerMemberDataPurgeCanceller(
	implementation: MemberDataPurgeCanceller | null
): void {
	canceller = implementation;
}

/**
 * Cancel the still-pending `member_removed` purges of a member who is back in
 * the organization (re-added or accepted an invitation), so a node that comes
 * back online later does not delete what they created since. NEVER REJECTS:
 * joining must not fail on the queue. The delivery also re-checks membership
 * before every attempt, so a cancellation lost here is still caught there.
 * Returns whether the canceller accepted it.
 */
export async function cancelMemberDataPurgeOnRejoin(
	request: MemberRejoinRequest
): Promise<boolean> {
	const implementation = canceller;
	if (!implementation) {
		return false;
	}
	try {
		await implementation(request);
		return true;
	} catch (error) {
		console.error(
			"[member-data-purge] could not cancel pending purges on rejoin:",
			error instanceof Error ? error.message : error
		);
		return false;
	}
}
