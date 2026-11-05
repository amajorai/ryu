import { revokeOrganizationRoleAssignments } from "@ryu/db/organization-role-assignments";
import type { OrganizationOptions } from "better-auth/plugins";
import { rememberMemberRoleBeforeUpdate } from "../lib/control-audit-recorder.ts";
import { disableFamilyBotGrantsOnMemberExit } from "../lib/family-bot-grants.ts";
import { clearPriorMembershipGrants } from "../lib/membership-grant-cleanup.ts";
import {
	retireBoxProofKeyOnDemotion,
	retireBoxProofKeyOnDeparture,
} from "../lib/retire-box-proof-key.ts";

import {
	notifyOrganizationHookActivity,
	organizationAdmission,
} from "./admission.ts";
import {
	releaseSeatClaims,
	revokeRemovedMemberGrants,
	revokeStaleRoleGrantsBeforeAdmission,
} from "./member-grants.ts";

// Organization member add, remove and role-change hooks.

type OrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>;

export const organizationMemberHooks = {
	beforeAddMember: async (data) => {
		await revokeStaleRoleGrantsBeforeAdmission({
			organizationId: data.member.organizationId,
			userId: String(data.user.id),
		});
		await organizationAdmission.beforeAddMember(data);
	},
	afterAddMember: async ({ member, organization, user }) => {
		await clearPriorMembershipGrants({
			createdAt: member.createdAt,
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		// The direct-add lock is needed only until Better Auth has created the
		// member row. Invitation acceptance has its own invitation claim and
		// does not pass through this hook.
		await releaseSeatClaims({
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		// Confirms the family place, or undoes an add that raced sharing
		// being turned off (and fails the request).
		await organizationAdmission.afterMemberAdmitted({
			actor: "other",
			memberId: String(member.id),
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		await notifyOrganizationHookActivity({
			body: `${user.name || user.email} joined ${organization.name}.`,
			event: "member.added",
			organizationId: member.organizationId,
			sourceId: member.id,
			sourceType: "member",
			target: "member",
			title: "Organization member added",
			updatedAt: member.createdAt,
		});
	},
	beforeRemoveMember: async ({ member }) => {
		// Release any abandoned direct-add claim before the member row is
		// removed. The after hook repeats this idempotently for normal deletes.
		await releaseSeatClaims({
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		// Retire the org's hosted Box signing key while the removal can
		// still be refused, and before the custom grants that say whether
		// they could reach node root are deleted. The after hook's repeat
		// for this member row is a no-op.
		await retireBoxProofKeyOnDeparture({
			memberId: String(member.id),
			organizationId: member.organizationId,
			role: member.role,
			userId: String(member.userId),
		});
		// Revoke custom-role grants while the removal can still be
		// refused: a failure here stops the removal instead of leaving
		// grants that a later re-admission would revive. The after hook
		// repeats this for a grant written in between.
		await revokeOrganizationRoleAssignments({
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
	},
	beforeUpdateMemberRole: async (data) => {
		await organizationAdmission.beforeUpdateMemberRole(data);
		// A demotion that takes node root away retires the hosted Box signing
		// key the member may have copied; a failure refuses the change.
		await retireBoxProofKeyOnDemotion({
			nextRole: data.newRole,
			organizationId: data.member.organizationId,
			previousRole: data.member.role,
			userId: String(data.member.userId),
		});
	},
	afterUpdateMemberRole: async ({
		member,
		organization,
		previousRole,
		user,
	}) => {
		await rememberMemberRoleBeforeUpdate(member.id, previousRole);
		await notifyOrganizationHookActivity({
			body: `${user.name || user.email}'s organization role was updated in ${organization.name}.`,
			event: "member.role.updated",
			organizationId: member.organizationId,
			sourceId: member.id,
			sourceType: "member",
			target: "member",
			title: "Organization role updated",
		});
	},
	afterRemoveMember: async ({ member, organization, user }) => {
		// Leaving/removing a member releases access capacity only. The Polar
		// quantity stays exactly as purchased until billing explicitly changes it.
		await releaseSeatClaims({
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		await revokeRemovedMemberGrants({
			memberId: String(member.id),
			organizationId: member.organizationId,
			role: member.role,
			userId: String(member.userId),
		});
		await disableFamilyBotGrantsOnMemberExit({
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		await organizationAdmission.releaseMemberFamilyPlace({
			organizationId: member.organizationId,
			userId: String(member.userId),
		});
		await notifyOrganizationHookActivity({
			body: `${user.name || user.email} left ${organization.name}.`,
			event: "member.removed",
			organizationId: member.organizationId,
			sourceId: member.id,
			sourceType: "member",
			target: "member",
			title: "Organization member removed",
			updatedAt: member.updatedAt,
		});
	},
} satisfies OrganizationHooks;
