import { GatewayCredential } from "@ryu/db/models/control-plane.model";
import { FleetEnrollmentToken, ManagedNode } from "@ryu/db/models/fleet.model";
import type { ClientSession } from "mongoose";

/**
 * Revoke the personal node credentials an organization issued for a member
 * who left or was removed.
 *
 * A personal gateway key or Fleet node (`ownerUserId` set) authenticates as
 * that member's node: it resolves the org's gateway policy, spends the org
 * wallet and receives the org's sealed secrets. Membership was checked only
 * when it was issued, so without this sweep it would outlive the membership.
 *
 * Order matches `revokeEnrollment` in `packages/api/src/lib/fleet-enrollment.ts`:
 * enrollment journals first (the authorization boundary for enrollment-linked
 * credentials, and it stops an issued-but-unredeemed personal token from being
 * redeemed later), then the projected nodes and gateway credentials. The
 * gateway and Fleet resolvers also refuse a personal credential whose owner is
 * no longer a member, so a sweep that fails here still fails closed.
 *
 * The sweep also covers the org-wide and team nodes the member enrolled
 * (`createdBy`, no `ownerUserId`). Those are typically enrolled on the
 * enrolling admin's own machine, and a `node.vault` key resolves org values for
 * any member the node names, so an ex-admin would otherwise keep reading org
 * plaintext with no session. Cloud-provisioned servers and service-account keys
 * are org infrastructure that outlives their creator and are left alone.
 * Revoking an enrolled node takes it offline until a `nodes.manage` holder
 * re-enrolls it.
 *
 * Lives in `@ryu/auth` because Better Auth's member-exit hooks call it; the
 * Admin API removal (`org-admin-ops.removeMember`) calls it inside its
 * transaction.
 */
export async function revokeDepartedMemberNodeCredentials(input: {
	now?: Date;
	organizationId: string;
	session?: ClientSession;
	userId: string;
}): Promise<void> {
	const organizationId = input.organizationId.trim();
	const ownerUserId = input.userId.trim();
	if (!(organizationId && ownerUserId)) {
		return;
	}
	const revokedAt = input.now ?? new Date();
	const options = input.session ? { session: input.session } : {};
	const revokeJournal = {
		$set: {
			recoveryResponseExpiresAt: null,
			recoveryResponseSealed: null,
			revokedAt,
			state: "revoked",
			updatedAt: revokedAt,
		},
	};
	const revokeRow = { $set: { revokedAt, updatedAt: revokedAt } };
	await FleetEnrollmentToken.updateMany(
		{ organizationId, ownerUserId, state: { $ne: "revoked" } },
		revokeJournal,
		options
	);
	await ManagedNode.updateMany(
		{ organizationId, ownerUserId, revokedAt: null },
		revokeRow,
		options
	);
	await GatewayCredential.updateMany(
		{ organizationId, ownerUserId, revokedAt: null },
		revokeRow,
		options
	);

	// Org-wide and team nodes this member enrolled: same order, matched on the
	// enroller rather than the owner. Another member's personal node that this
	// admin issued has an `ownerUserId` and is not matched.
	const enrolledByMember = {
		createdBy: ownerUserId,
		organizationId,
		ownerUserId: null,
	};
	const journalQuery = FleetEnrollmentToken.distinct("_id", {
		...enrolledByMember,
		state: { $ne: "revoked" },
	});
	const enrollmentIds = await (input.session
		? journalQuery.session(input.session)
		: journalQuery);
	await FleetEnrollmentToken.updateMany(
		{ ...enrolledByMember, state: { $ne: "revoked" } },
		revokeJournal,
		options
	);
	if (enrollmentIds.length > 0) {
		await ManagedNode.updateMany(
			{
				enrollmentId: { $in: enrollmentIds },
				organizationId,
				revokedAt: null,
			},
			revokeRow,
			options
		);
	}
	await GatewayCredential.updateMany(
		{
			...enrolledByMember,
			provisionedServerId: null,
			revokedAt: null,
			serviceAccountId: null,
		},
		revokeRow,
		options
	);
}
