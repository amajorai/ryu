import {
	Member,
	RoleAssignment,
	TeamMember,
} from "@ryu/db/models/control-plane.model";
import { OrganizationSeatReservation } from "@ryu/db/models/organization-seat-reservation.model";
import { VaultPolicyBinding } from "@ryu/db/models/vault.model";
import {
	revokeOrganizationRoleAssignments,
	revokeTeamRoleAssignments,
} from "@ryu/db/organization-role-assignments";
import { z } from "zod";
import { revokeDepartedMemberNodeCredentials } from "../lib/departed-member-node-credentials.ts";
import { recordRoleGrantCleanupFailure } from "../lib/membership-grant-cleanup.ts";
import type { ResentInvitationSeat } from "../lib/resent-invitation-seat.ts";
import { retireBoxProofKeyOnDepartureWithRetry } from "../lib/retire-box-proof-key.ts";

import {
	directMemberClaimId,
	pendingInvitationClaimId,
} from "./seat-capacity.ts";

// Grant revocation and seat release when members leave, and the seat refresh
// for a resent invitation.

/**
 * Revoke the custom-role grants of a member who left or was removed. Better
 * Auth deletes the `member` row and its team memberships, but Ryu's
 * `roleAssignment` rows and `user:<id>` vault policy bindings would otherwise
 * come back into force if the same user were invited again. Mirrors the
 * Admin API removal (`org-admin-ops.ts`). Best effort: the removal has already
 * happened. Console removal already revoked fail-closed in
 * `beforeRemoveMember`, and `revokeStaleRoleGrantsBeforeAdmission` fails
 * closed on re-admission.
 */
export async function revokeRemovedMemberGrants(input: {
	/** The removed member row's id, so one departure bumps the epoch once. */
	memberId?: string | null;
	organizationId: string;
	/** The removed member's built-in role, when known. */
	role?: string | null;
	userId: string;
}): Promise<void> {
	const membership = {
		organizationId: input.organizationId,
		userId: input.userId,
	};
	// Retire the org's hosted Box signing key the member may have copied from
	// a node. It reads their custom grants, so it runs before they are
	// deleted; a failure is retried and then recorded for admins.
	await retireBoxProofKeyOnDepartureWithRetry(input, async (error) => {
		console.error("Failed to retire the org's Box signing key:", error);
		await recordRoleGrantCleanupFailure({
			...membership,
			grant: "box_proof_key",
			phase: "remove",
		});
	});
	try {
		await revokeOrganizationRoleAssignments(membership);
	} catch (error) {
		// The member row is already gone, so this cannot fail the request. The
		// permission resolvers ignore grants older than the current membership,
		// so a leftover row never comes back into force; record it for admins.
		console.error("Failed to revoke removed member's role grants:", error);
		await recordRoleGrantCleanupFailure({ ...membership, phase: "remove" });
	}
	// Vault policies bound directly to the user would otherwise come back into
	// force (secret reads, writes, approvals) if the same user were re-invited.
	try {
		await VaultPolicyBinding.deleteMany({
			organizationId: input.organizationId,
			subject: `user:${input.userId}`,
		});
	} catch (error) {
		// The vault principal ignores `user:<id>` bindings older than the
		// current membership, so a leftover never comes back into force on a
		// re-invite; record it for admins as for role grants.
		console.error("Failed to revoke removed member's vault bindings:", error);
		await recordRoleGrantCleanupFailure({
			...membership,
			grant: "vault_bindings",
			phase: "remove",
		});
	}
	// Personal gateway keys and Fleet nodes issued for the member would
	// otherwise keep authenticating as an org node. The gateway and Fleet
	// resolvers re-check membership, so a failure here still fails closed.
	try {
		await revokeDepartedMemberNodeCredentials(membership);
	} catch (error) {
		console.error("Failed to revoke removed member's node credentials:", error);
	}
}

/**
 * Revoke custom-role grants scoped to a team the user no longer belongs to
 * (or, without `userId`, to a deleted team). Team-scoped assignments require
 * team membership when granted; leaving them behind would silently restore the
 * role, and its gateway ACL role key, if the user were re-added to the team.
 */
export async function revokeTeamScopedGrants(input: {
	organizationId: string;
	teamId: string;
	userId?: string;
}): Promise<void> {
	try {
		await RoleAssignment.deleteMany({
			organizationId: input.organizationId,
			teamId: input.teamId,
			...(input.userId ? { userId: input.userId } : {}),
		});
	} catch (error) {
		console.error("Failed to revoke team-scoped role grants:", error);
	}
}

/**
 * Fail closed on custom-role grants an earlier membership left behind (a
 * removal path whose best-effort cleanup failed, or a writer that skipped it):
 * before admitting a user to an organization (or, with `teamId`, to a team),
 * delete their grants there so a re-admission never revives them. Skipped
 * while the user still holds that membership, so a repeated or refused
 * admission cannot strip a current member's live grants.
 */
export async function revokeStaleRoleGrantsBeforeAdmission(input: {
	organizationId: string;
	teamId?: string;
	userId: string;
}): Promise<void> {
	const { teamId } = input;
	if (teamId) {
		if (await TeamMember.exists({ teamId, userId: input.userId })) {
			return;
		}
		await revokeTeamRoleAssignments({ ...input, teamId });
		return;
	}
	if (
		await Member.exists({
			organizationId: input.organizationId,
			userId: input.userId,
		})
	) {
		return;
	}
	await revokeOrganizationRoleAssignments(input);
}

/** The member row `/organization/leave` returns, keyed for the exit cleanup. */
export const leftMemberSchema = z
	.object({
		id: z.coerce.string().min(1).optional(),
		organizationId: z.coerce.string().min(1),
		role: z.string().nullish(),
		userId: z.coerce.string().min(1),
	})
	.transform(({ id, ...member }) => ({ ...member, memberId: id ?? null }));

export async function releaseSeatClaims(input: {
	email?: string;
	invitationId?: string;
	organizationId: string;
	userId?: string;
}): Promise<void> {
	const claimIds = [
		input.invitationId,
		input.email
			? pendingInvitationClaimId(input.organizationId, input.email)
			: undefined,
		input.userId ? directMemberClaimId(input.userId) : undefined,
	].filter((claimId): claimId is string => Boolean(claimId));
	if (claimIds.length === 0) {
		return;
	}
	await OrganizationSeatReservation.deleteMany({
		invitationId: { $in: [...new Set(claimIds)] },
		organizationId: input.organizationId,
	});
}

/**
 * Better Auth handles `resend: true` as an in-place expiry update and returns
 * before running its organization invitation hooks. Extend the existing seat
 * claim as well; if an older invitation has no claim, acceptance will still
 * perform the authoritative live-capacity check before adding its member.
 */
export async function refreshResentInvitationSeat(
	input: ResentInvitationSeat
): Promise<void> {
	await OrganizationSeatReservation.updateOne(
		{
			invitationId: input.invitationId,
			organizationId: input.organizationId,
		},
		{
			$set: {
				expiresAt: input.expiresAt,
				updatedAt: new Date(),
			},
		}
	);
}
