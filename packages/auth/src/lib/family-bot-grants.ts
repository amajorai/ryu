import { ChannelUserQuotaGuard } from "@ryu/db/models/channel-user-quota-guard.model";
import { Member } from "@ryu/db/models/control-plane.model";
import { PlatformIdentity } from "@ryu/db/models/platform-identity.model";
import { isDuplicateKeyError } from "@ryu/db/native-duplicate-key";
import { FAMILY_SHARING_MAX_MEMBERS } from "./family-sharing.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	type OrganizationKind,
	readOrganizationKind,
} from "./organization-kind.ts";

/**
 * Keeps a family bot for the family (`docs/family-sharing.md`, "Bots").
 *
 * A hosted channel-bot grant (`PlatformIdentity`) linked to a Ryu account
 * (`ryuUserId`) may be enabled on a family workspace only while that account
 * is a family member. The bot-access admin router checks this when a grant is
 * enabled; the Cloud Bot Service re-checks membership for linked grants on a
 * family org on every message (`apps/cloud-bot/src/family-grant-guard.ts`),
 * which is the authority if a sweep here fails. This module turns grants of
 * non-members off whenever the family's membership or kind changes, so the
 * admin view matches and routing short-circuits on `enabled`:
 *
 * - Better Auth's `afterRemoveMember` hook and the `/organization/leave`
 *   after-hook call {@link disableFamilyBotGrantsOnMemberExit}.
 * - The family-sharing enable and disable routes call
 *   {@link disableBotGrantsOnFamilyKindChange} right after the workspace
 *   becomes a family (a legacy unmarked workspace can carry a grant linked to a
 *   non-owner who has since left) and right after it reverts to personal (so no
 *   former member's grant survives even if an earlier sweep failed).
 *
 * The same sweeps also keep the family within its channel-user limit. An
 * active family allows one enabled channel user per member, up to
 * {@link FAMILY_SHARING_MAX_MEMBERS} (`resolveHostedBotMemberLimit` in
 * `packages/api/src/lib/hosted-bot-audience.ts`), but that limit is checked
 * only when a grant is enabled, and the Cloud Bot Service does not count
 * grants when routing. So when the member count drops, or the kind changes,
 * the sweep also disables the enabled grants beyond `min(6, members)`, keeping
 * grants linked to current members first and then the oldest
 * ({@link surplusFamilyBotGrantIds}). That bound is never below the limit the
 * workspace has afterwards: a lapsed family or a personal workspace falls
 * back to its single plan's one seat (or none), and its owner is a member. A
 * lapse itself (Max or the rollout flag ending) is not an event here: like a
 * personal or Teams plan ending, it leaves enabled grants alone and only
 * refuses new enables while over the limit.
 *
 * Each sweep reads the members and grants and writes its disables in one
 * transaction that first bumps the organization's `ChannelUserQuotaGuard` row,
 * the row every enable bumps (`claimChannelUserCapacity` in
 * `packages/api/src/lib/channel-user-quota.ts`). A sweep and an enable racing
 * across a member exit therefore write-conflict there, and whichever retries
 * sees the other's commit: an enable that read the larger limit and commits
 * first is caught by the sweep's retry, and an enable after the sweep recounts
 * the members itself.
 *
 * Grants are DISABLED, not deleted: the organizer keeps the row and its routing,
 * and re-enabling it re-runs the family-member check and the limit claim, so a
 * person who rejoins can be turned back on. Admin-made grants carry no Ryu
 * account, so the member check skips them and only the limit bounds them.
 *
 * Lives in `@ryu/auth` (not `@ryu/api`) because the membership events fire
 * inside Better Auth; it needs only `@ryu/db` models, so no registry is needed.
 */

const BA_OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** An enabled channel-bot grant, as the limit sweep ranks it. */
export interface FamilyBotGrantRow {
	readonly createdAt: Date | null;
	readonly id: string;
	readonly ryuUserId: string | null;
}

/** The membership reads and grant writes one sweep makes, in one transaction. */
export interface FamilyBotGrantStore {
	/** Disables these grants on the org if they are still enabled. */
	disableGrants: (input: {
		grantIds: readonly string[];
		organizationId: string;
	}) => Promise<number>;
	/** Disables enabled grants on the org linked to an account outside `memberUserIds`. */
	disableLinkedGrantsOutside: (input: {
		memberUserIds: readonly string[];
		organizationId: string;
	}) => Promise<number>;
	/** The org's enabled grants. */
	enabledGrants: (organizationId: string) => Promise<FamilyBotGrantRow[]>;
	/** The user ids of the organization's current members. */
	memberUserIds: (organizationId: string) => Promise<string[]>;
}

export interface FamilyBotGrantDeps {
	readOrganizationKind: (
		organizationId: string
	) => Promise<OrganizationKind | null>;
	/**
	 * Runs `work` in one transaction that first bumps the organization's
	 * `ChannelUserQuotaGuard` row, so it serializes with channel-user enables.
	 * The transaction may be retried, so `work` must only use `store`.
	 */
	withChannelUserGuard: <T>(
		organizationId: string,
		work: (store: FamilyBotGrantStore) => Promise<T>
	) => Promise<T>;
}

type GuardSession = Awaited<
	ReturnType<typeof ChannelUserQuotaGuard.startSession>
>;

interface MemberUserRow {
	userId?: unknown;
}

interface GrantRow {
	_id?: unknown;
	createdAt?: unknown;
	ryuUserId?: unknown;
}

function sessionStore(session: GuardSession): FamilyBotGrantStore {
	return {
		disableGrants: async ({ grantIds, organizationId }) => {
			if (grantIds.length === 0) {
				return 0;
			}
			const result = await PlatformIdentity.updateMany(
				{ _id: { $in: grantIds }, enabled: { $ne: false }, organizationId },
				{ $set: { enabled: false, updatedAt: new Date() } },
				{ session }
			);
			return result.modifiedCount;
		},
		disableLinkedGrantsOutside: async ({ memberUserIds, organizationId }) => {
			const result = await PlatformIdentity.updateMany(
				{
					enabled: { $ne: false },
					organizationId,
					// `$nin` with null also skips grants with no linked account.
					ryuUserId: { $nin: [null, ...memberUserIds] },
				},
				{ $set: { enabled: false, updatedAt: new Date() } },
				{ session }
			);
			return result.modifiedCount;
		},
		enabledGrants: async (organizationId) => {
			const rows = await PlatformIdentity.find({
				enabled: { $ne: false },
				organizationId,
			})
				.select("_id createdAt ryuUserId")
				.session(session)
				.lean<GrantRow[]>();
			return rows.map((row) => ({
				createdAt: row.createdAt instanceof Date ? row.createdAt : null,
				id: String(row._id ?? ""),
				ryuUserId: typeof row.ryuUserId === "string" ? row.ryuUserId : null,
			}));
		},
		memberUserIds: async (organizationId) => {
			const rows = await Member.find({ organizationId })
				.select("userId")
				.session(session)
				.lean<MemberUserRow[]>();
			return rows.map((row) => String(row.userId ?? "")).filter(Boolean);
		},
	};
}

/** Creates the organization's guard row once; a racing creator already made it. */
async function ensureChannelUserQuotaGuard(
	organizationId: string
): Promise<void> {
	try {
		await ChannelUserQuotaGuard.updateOne(
			{ _id: organizationId },
			{ $setOnInsert: { revision: 0 } },
			{ upsert: true }
		);
	} catch (error) {
		if (!isDuplicateKeyError(error)) {
			throw error;
		}
	}
}

async function withChannelUserGuard<T>(
	organizationId: string,
	work: (store: FamilyBotGrantStore) => Promise<T>
): Promise<T> {
	await ensureChannelUserQuotaGuard(organizationId);
	const session = await ChannelUserQuotaGuard.startSession();
	try {
		const completion: { value?: { result: T } } = {};
		// The driver retries the whole callback on a write conflict with a
		// concurrent enable, so the retry rereads members and grants.
		await session.withTransaction(async () => {
			await ChannelUserQuotaGuard.updateOne(
				{ _id: organizationId },
				{ $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
				{ session }
			);
			completion.value = { result: await work(sessionStore(session)) };
		});
		if (!completion.value) {
			throw new Error("family bot grant sweep transaction did not complete");
		}
		return completion.value.result;
	} finally {
		await session.endSession();
	}
}

const defaultDeps: FamilyBotGrantDeps = {
	readOrganizationKind,
	withChannelUserGuard,
};

/** Enabled channel users a family with `memberCount` members may keep. */
export function familyBotGrantLimit(memberCount: number): number {
	return Math.min(FAMILY_SHARING_MAX_MEMBERS, Math.max(memberCount, 0));
}

function createdAtMs(grant: FamilyBotGrantRow): number {
	// An undated grant sorts after every dated one.
	return grant.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
}

/**
 * The enabled grants beyond `limit`, in a fixed order: grants linked to a
 * current member are kept first (each member's own channel user), then the
 * oldest, then the lowest id. The same rows always give the same result.
 */
export function surplusFamilyBotGrantIds(input: {
	grants: readonly FamilyBotGrantRow[];
	limit: number;
	memberUserIds: readonly string[];
}): string[] {
	const members = new Set(input.memberUserIds);
	const isMemberLinked = (grant: FamilyBotGrantRow) =>
		grant.ryuUserId !== null && members.has(grant.ryuUserId);
	const ranked = [...input.grants].sort((left, right) => {
		const linked = Number(isMemberLinked(right)) - Number(isMemberLinked(left));
		if (linked !== 0) {
			return linked;
		}
		const leftAt = createdAtMs(left);
		const rightAt = createdAtMs(right);
		if (leftAt !== rightAt) {
			return leftAt < rightAt ? -1 : 1;
		}
		if (left.id === right.id) {
			return 0;
		}
		return left.id < right.id ? -1 : 1;
	});
	return ranked
		.slice(Math.max(Math.floor(input.limit), 0))
		.map((grant) => grant.id);
}

/**
 * Disables every enabled grant on `organizationId` whose linked Ryu account is
 * not a current member, then every enabled grant beyond the family limit for
 * the current member count ({@link familyBotGrantLimit}), whatever the
 * workspace kind, all in one guarded transaction (see the module comment).
 * Returns how many grants it turned off. Throws on a database
 * failure; callers in hooks use {@link disableFamilyBotGrantsOnMemberExit},
 * which never throws.
 */
export async function disableLinkedBotGrantsOutsideMembership(
	organizationId: string,
	deps: FamilyBotGrantDeps = defaultDeps
): Promise<number> {
	if (!BA_OBJECT_ID_RE.test(organizationId)) {
		return 0;
	}
	return await deps.withChannelUserGuard(organizationId, async (store) => {
		const memberUserIds = await store.memberUserIds(organizationId);
		const nonMembers = await store.disableLinkedGrantsOutside({
			memberUserIds,
			organizationId,
		});
		const surplus = surplusFamilyBotGrantIds({
			grants: await store.enabledGrants(organizationId),
			limit: familyBotGrantLimit(memberUserIds.length),
			memberUserIds,
		});
		if (surplus.length === 0) {
			return nonMembers;
		}
		return (
			nonMembers +
			(await store.disableGrants({ grantIds: surplus, organizationId }))
		);
	});
}

/**
 * After someone leaves or is removed from an organization: when it is a family
 * workspace, disable the family-bot grants linked to anyone who is no longer a
 * member (the person who left, and any grant an earlier failed sweep missed),
 * then any enabled grants beyond the smaller member-based limit. Other
 * workspace kinds are untouched. NEVER THROWS: a membership change that
 * already happened must not fail on its follow-up; the failure is logged.
 */
export async function disableFamilyBotGrantsOnMemberExit(
	input: { organizationId: string; userId: string },
	deps: FamilyBotGrantDeps = defaultDeps
): Promise<number> {
	try {
		const kind = await deps.readOrganizationKind(input.organizationId);
		if (kind !== FAMILY_ORGANIZATION_KIND) {
			return 0;
		}
		return await disableLinkedBotGrantsOutsideMembership(
			input.organizationId,
			deps
		);
	} catch (error) {
		console.error(
			"Failed to disable a departed family member's bot grants:",
			error
		);
		return 0;
	}
}

/**
 * Right after a workspace becomes a family or reverts to personal (both only
 * while its owner is alone): disable the grants linked to anyone who is not a
 * member, then all but one enabled grant (the owner's own, if linked), since a
 * solo family and a single-seat personal plan both allow one. It does not
 * check the kind, since the caller just changed it. NEVER
 * THROWS: the kind change already happened; the failure is logged.
 */
export async function disableBotGrantsOnFamilyKindChange(
	organizationId: string,
	deps: FamilyBotGrantDeps = defaultDeps
): Promise<number> {
	try {
		return await disableLinkedBotGrantsOutsideMembership(organizationId, deps);
	} catch (error) {
		console.error("Failed to disable non-member family bot grants:", error);
		return 0;
	}
}
