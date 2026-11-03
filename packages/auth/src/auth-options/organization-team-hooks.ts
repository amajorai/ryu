import { APIError } from "better-auth/api";
import type { OrganizationOptions } from "better-auth/plugins";
import { removeTeamCreatedInFamily } from "../lib/family-team-guard.ts";

import {
	notifyOrganizationHookActivity,
	organizationAdmission,
} from "./admission.ts";
import {
	revokeStaleRoleGrantsBeforeAdmission,
	revokeTeamScopedGrants,
} from "./member-grants.ts";

// Team and team-member hooks.

type OrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>;

export const organizationTeamHooks = {
	beforeCreateTeam: async ({ team, organization }) =>
		await organizationAdmission.beforeCreateTeam({ organization, team }),
	afterCreateTeam: async ({ team, organization }) => {
		// A team whose before-hook read the personal kind can land after a
		// family enable promoted the org; re-read the kind after the write.
		const familyRefusal = await removeTeamCreatedInFamily({
			organizationId: organization.id,
			teamId: team.id,
		});
		if (familyRefusal) {
			throw new APIError("BAD_REQUEST", { message: familyRefusal });
		}
		await notifyOrganizationHookActivity({
			body: `${team.name} was created in ${organization.name}.`,
			event: "team.created",
			organizationId: organization.id,
			sourceId: team.id,
			sourceType: "team",
			target: "team",
			title: "Organization team created",
			updatedAt: team.createdAt,
		});
	},
	beforeUpdateTeam: async ({ updates }) => {
		if (updates.name === undefined) {
			return;
		}
		const name = updates.name.trim();
		if (!name) {
			throw new APIError("BAD_REQUEST", {
				message: "Team name is required.",
			});
		}
		return { data: { ...updates, name } };
	},
	afterUpdateTeam: async ({ team, organization }) => {
		if (!team) {
			return;
		}
		await notifyOrganizationHookActivity({
			body: `${team.name} was updated in ${organization.name}.`,
			event: "team.updated",
			organizationId: organization.id,
			sourceId: team.id,
			sourceType: "team",
			target: "team",
			title: "Organization team updated",
			updatedAt: team.updatedAt,
		});
	},
	beforeDeleteTeam: async ({ team, organization }) => {
		if (team.organizationId !== organization.id) {
			throw new APIError("BAD_REQUEST", {
				message: "Team does not belong to this organization.",
			});
		}
	},
	afterDeleteTeam: async ({ team, organization }) => {
		await revokeTeamScopedGrants({
			organizationId: organization.id,
			teamId: String(team.id),
		});
		await notifyOrganizationHookActivity({
			body: `${team.name} was deleted from ${organization.name}.`,
			event: "team.deleted",
			organizationId: organization.id,
			sourceId: team.id,
			sourceType: "team",
			target: "team",
			title: "Organization team deleted",
		});
	},
	beforeAddTeamMember: async ({ organization, team, user }) => {
		await revokeStaleRoleGrantsBeforeAdmission({
			organizationId: organization.id,
			teamId: team.id,
			userId: String(user.id),
		});
		await organizationAdmission.beforeAddTeamMember({
			organization,
			user,
		});
	},
	afterAddTeamMember: async ({ team, teamMember, organization, user }) => {
		await notifyOrganizationHookActivity({
			body: `${user.name || user.email} joined ${team.name}.`,
			event: "team.member.added",
			organizationId: organization.id,
			sourceId: teamMember.id,
			sourceType: "team-member",
			target: "team-member",
			title: "Team member added",
			updatedAt: teamMember.createdAt,
		});
	},
	beforeRemoveTeamMember: async ({ team, teamMember }) => {
		if (teamMember.teamId !== team.id) {
			throw new APIError("BAD_REQUEST", {
				message: "Team member does not belong to this team.",
			});
		}
	},
	afterRemoveTeamMember: async ({ team, teamMember, organization, user }) => {
		await revokeTeamScopedGrants({
			organizationId: organization.id,
			teamId: String(team.id),
			userId: String(teamMember.userId),
		});
		await notifyOrganizationHookActivity({
			body: `${user.name || user.email} left ${team.name}.`,
			event: "team.member.removed",
			organizationId: organization.id,
			sourceId: teamMember.id,
			sourceType: "team-member",
			target: "team-member",
			title: "Team member removed",
			updatedAt: teamMember.createdAt,
		});
	},
} satisfies OrganizationHooks;
