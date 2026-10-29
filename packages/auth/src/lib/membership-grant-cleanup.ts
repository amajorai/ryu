import { RoleAssignment } from "@ryu/db/models/control-plane.model";
import { VaultPolicyBinding } from "@ryu/db/models/vault.model";
import { recordOrganizationControlAudit } from "./control-audit-recorder.ts";

/**
 * Append a control audit row when a member's grant cleanup failed, so the
 * leftover `roleAssignment` rows (or, with `grant: "vault_bindings"`, the
 * `user:<id>` vault policy bindings) are visible to organization admins.
 * Never throws: the membership change has already happened.
 */
export async function recordRoleGrantCleanupFailure(input: {
	grant?: "vault_bindings";
	organizationId: string;
	phase: "add" | "remove";
	userId: string;
}): Promise<void> {
	try {
		await recordOrganizationControlAudit({
			action: "member.grants.revoke",
			actorId: null,
			actorType: "system",
			details: {
				...(input.grant ? { grant: input.grant } : {}),
				phase: input.phase,
				status: "failure",
				userId: input.userId,
			},
			organizationId: input.organizationId,
			target: "member",
			targetId: input.userId,
		});
	} catch (error) {
		console.error("Failed to append role grant cleanup audit:", error);
	}
}

/**
 * Drop custom-role grants left over from an earlier membership of a user who
 * just joined. Grants are only ever written for a current member, so anything
 * older than the new member row belongs to a previous membership whose removal
 * cleanup failed. The permission readers already ignore such rows
 * (`membership-grant-filter.ts`); this removes them so every reader starts
 * from no custom grants. Never throws: the member row already exists.
 */
export async function clearPriorMembershipGrants(input: {
	createdAt?: Date | null;
	organizationId: string;
	userId: string;
}): Promise<void> {
	try {
		await RoleAssignment.deleteMany({
			organizationId: input.organizationId,
			userId: input.userId,
			...(input.createdAt ? { createdAt: { $lt: input.createdAt } } : {}),
		});
	} catch (error) {
		console.error("Failed to clear a new member's prior role grants:", error);
		await recordRoleGrantCleanupFailure({
			organizationId: input.organizationId,
			phase: "add",
			userId: input.userId,
		});
	}
	// `user:<id>` vault policy bindings follow the same rule: the vault
	// principal ignores ones older than the membership, and they are dropped
	// here so the policy listing does not show them as bound.
	if (!input.createdAt) {
		return;
	}
	try {
		await VaultPolicyBinding.deleteMany({
			createdAt: { $lt: input.createdAt },
			organizationId: input.organizationId,
			subject: `user:${input.userId}`,
		});
	} catch (error) {
		console.error(
			"Failed to clear a new member's prior vault bindings:",
			error
		);
		await recordRoleGrantCleanupFailure({
			grant: "vault_bindings",
			organizationId: input.organizationId,
			phase: "add",
			userId: input.userId,
		});
	}
}
