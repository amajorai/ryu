import {
	Member,
	Organization,
	OrgRoleModel,
	RoleAssignment,
} from "@ryu/db/models/control-plane.model";
import { ProvisionedServer } from "@ryu/db/models/provisioned-server.model";
import type { ClientSession } from "mongoose";

/**
 * Retire an organization's hosted Box signing key when a member who could
 * have copied it leaves or loses node access.
 *
 * Every managed node of an org holds the key Core signs hosted `gwb1` Box
 * inference keys with, and whoever can reach a node's root SSH key (a
 * `nodes.manage` holder: admin or owner by default, or a custom role granting
 * it) can read it. The key was once a pure function of the fleet master and
 * the org id, so a removed or demoted admin could keep minting `gwb1` keys
 * billed to the org. It is now derived at the org's `boxProofKeyEpoch`
 * (`packages/api/src/lib/core-proof-key.ts`), which the Gateway checks on
 * every hosted `gwb1` against the org budget view. Bumping it refuses any key
 * signed at an older epoch, whichever member that key names. The same epoch
 * is the org's node-root epoch for its Core relay key
 * (`packages/api/src/lib/core-relay-key.ts`), which the same root holder could
 * read, so a bump also retires that trusted-forwarder key.
 *
 * Bumped only when the org has ever had a cloud-provisioned server (otherwise
 * the key never left the control plane) and the member could have held node
 * root: a built-in role other than `member`, `viewer` or `billing` (an unknown
 * role counts as privileged), a custom role granting `nodes.manage`, or being
 * the creator of one of the org's servers. Custom grants are read here, so
 * callers run this before deleting them. Nodes provisioned before a bump keep
 * signing at the old epoch: every credential on such a node was readable by
 * the same root holder, so no live channel can re-deliver the new key to it
 * without also handing it to them. Those nodes' Box inference is refused
 * until they are provisioned again.
 */

/**
 * Built-in organization roles whose permissions exclude `nodes.manage`
 * (`BUILTIN_ROLE_PERMISSIONS` and the additive `billing` role), so they cannot
 * reach a node's root SSH key.
 */
const UNPRIVILEGED_ROLES = new Set(["member", "viewer", "billing"]);

/** The permission that reaches a managed node's root SSH key. */
export const NODE_ROOT_PERMISSION = "nodes.manage";

/** Attempts a best-effort exit path makes before recording a failed bump. */
const RETIRE_ATTEMPTS = 3;

/** Whether a built-in organization role could reach node root. */
export function roleCouldHoldNodeRoot(
	role: string | null | undefined
): boolean {
	if (role === null || role === undefined) {
		return true;
	}
	const roles = role
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return roles.length === 0 || roles.some((r) => !UNPRIVILEGED_ROLES.has(r));
}

function sessionOptions(session: ClientSession | undefined) {
	return session ? { session } : {};
}

/** The users among `userIds` whose custom roles grant `nodes.manage`. */
export async function customNodeRootHolders(input: {
	organizationId: string;
	session?: ClientSession;
	userIds: string[];
}): Promise<Set<string>> {
	if (input.userIds.length === 0) {
		return new Set();
	}
	const assignments = await RoleAssignment.find(
		{ organizationId: input.organizationId, userId: { $in: input.userIds } },
		{ roleKey: 1, userId: 1 },
		sessionOptions(input.session)
	).lean();
	if (assignments.length === 0) {
		return new Set();
	}
	// Deleted roles keep no permissions, so only live ones can grant it.
	const granting = await OrgRoleModel.find(
		{
			key: { $in: [...new Set(assignments.map((row) => row.roleKey))] },
			organizationId: input.organizationId,
			permissions: NODE_ROOT_PERMISSION,
		},
		{ key: 1 },
		sessionOptions(input.session)
	).lean();
	const keys = new Set(granting.map((role) => role.key));
	return new Set(
		assignments
			.filter((row) => keys.has(row.roleKey))
			.map((row) => String(row.userId))
	);
}

/** The users among `userIds` who can reach node root in the org right now. */
export async function nodeRootHolders(input: {
	organizationId: string;
	session?: ClientSession;
	userIds: string[];
}): Promise<Set<string>> {
	const custom = await customNodeRootHolders(input);
	const members = await Member.find(
		{ organizationId: input.organizationId, userId: { $in: input.userIds } },
		{ role: 1, userId: 1 },
		sessionOptions(input.session)
	).lean();
	for (const member of members) {
		if (roleCouldHoldNodeRoot(member.role)) {
			custom.add(String(member.userId));
		}
	}
	return custom;
}

async function orgHadServer(
	organizationId: string,
	session: ClientSession | undefined
): Promise<boolean> {
	const found = await ProvisionedServer.exists({ organizationId }).session(
		session ?? null
	);
	return Boolean(found);
}

/**
 * Bump the epoch when the org ever had a server. With `retiredFor`, a repeat
 * call for the same departure (the before- and after-removal hooks) is a
 * no-op.
 */
async function bumpBoxProofKeyEpoch(input: {
	organizationId: string;
	retiredFor?: string;
	session?: ClientSession;
}): Promise<boolean> {
	if (!(await orgHadServer(input.organizationId, input.session))) {
		return false;
	}
	const retiredFor = input.retiredFor ?? null;
	await Organization.updateOne(
		retiredFor
			? {
					_id: input.organizationId,
					boxProofKeyRetiredFor: { $ne: retiredFor },
				}
			: { _id: input.organizationId },
		{
			$inc: { boxProofKeyEpoch: 1 },
			$set: { boxProofKeyRetiredFor: retiredFor },
		},
		sessionOptions(input.session)
	);
	return true;
}

/**
 * Bump the org's Box proof-key epoch for a departing member who could have
 * held node root; true when a bump was due. Run it before the member's custom
 * grants are deleted. `memberId` makes repeat calls for one departure bump
 * once.
 */
export async function retireBoxProofKeyOnDeparture(input: {
	memberId?: string | null;
	organizationId: string;
	role?: string | null;
	session?: ClientSession;
	userId: string;
}): Promise<boolean> {
	const createdServer = await ProvisionedServer.exists({
		createdBy: input.userId,
		organizationId: input.organizationId,
	}).session(input.session ?? null);
	const couldHoldRoot =
		Boolean(createdServer) ||
		roleCouldHoldNodeRoot(input.role) ||
		(
			await customNodeRootHolders({
				organizationId: input.organizationId,
				session: input.session,
				userIds: [input.userId],
			})
		).has(input.userId);
	if (!couldHoldRoot) {
		return false;
	}
	return await bumpBoxProofKeyEpoch({
		organizationId: input.organizationId,
		retiredFor: input.memberId ? `member:${input.memberId}` : undefined,
		session: input.session,
	});
}

/**
 * Bump the epoch when a member's built-in role change takes away the node
 * root they could reach (an admin or owner demoted to `member`). A custom
 * `nodes.manage` grant keeps that access, so it never bumps on its own.
 */
export async function retireBoxProofKeyOnDemotion(input: {
	nextRole: string;
	organizationId: string;
	previousRole: string | null | undefined;
	session?: ClientSession;
	userId: string;
}): Promise<boolean> {
	if (
		!roleCouldHoldNodeRoot(input.previousRole) ||
		roleCouldHoldNodeRoot(input.nextRole)
	) {
		return false;
	}
	const custom = await customNodeRootHolders({
		organizationId: input.organizationId,
		session: input.session,
		userIds: [input.userId],
	});
	if (custom.has(input.userId)) {
		return false;
	}
	return await bumpBoxProofKeyEpoch(input);
}

/** The users holding custom role `roleKey` in the org. */
export async function customRoleHolderIds(
	organizationId: string,
	roleKey: string
): Promise<string[]> {
	const userIds = await RoleAssignment.distinct("userId", {
		organizationId,
		roleKey,
	});
	return userIds.map(String);
}

/**
 * Run a custom-grant change (a member's assignments replaced, a role edited
 * or deleted) and bump the epoch when it took node root away from any of
 * `userIds` who still remain in the org with no other path to it. `when`
 * skips the reads for a change that removes no `nodes.manage` grant.
 */
export async function withBoxProofKeyRetiredOnNodeRootLoss<T>(
	input: {
		organizationId: string;
		userIds: string[] | (() => Promise<string[]>);
		when?: boolean;
	},
	change: () => Promise<T>
): Promise<T> {
	if (input.when === false) {
		return await change();
	}
	const userIds =
		typeof input.userIds === "function" ? await input.userIds() : input.userIds;
	const before = await nodeRootHolders({
		organizationId: input.organizationId,
		userIds,
	});
	const result = await change();
	if (before.size === 0) {
		return result;
	}
	const after = await nodeRootHolders({
		organizationId: input.organizationId,
		userIds: [...before],
	});
	if ([...before].some((userId) => !after.has(userId))) {
		await bumpBoxProofKeyEpoch({ organizationId: input.organizationId });
	}
	return result;
}

/**
 * The departure bump for an exit path that can no longer refuse the removal
 * (the member row is already gone): retried, and on a final failure reported
 * through `onFailure` so it is recorded rather than lost.
 */
export async function retireBoxProofKeyOnDepartureWithRetry(
	input: Parameters<typeof retireBoxProofKeyOnDeparture>[0],
	onFailure: (error: unknown) => Promise<void>
): Promise<boolean> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < RETIRE_ATTEMPTS; attempt += 1) {
		try {
			return await retireBoxProofKeyOnDeparture(input);
		} catch (error) {
			lastError = error;
		}
	}
	await onFailure(lastError);
	return false;
}
