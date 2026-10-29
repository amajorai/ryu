import { Team, TeamMember } from "@ryu/db/models/control-plane.model";
import { teamRefusal } from "./family-admission.ts";
import {
	type OrganizationKind,
	readOrganizationKind,
} from "./organization-kind.ts";

/**
 * Keeps sub-teams out of a family (`docs/family-sharing.md`, "Sub-teams block
 * enabling"). `beforeCreateTeam` refuses a family, but a team whose check read
 * the personal kind can still be written after a family enable promotes the
 * org. The two sides follow the transition rule in
 * `packages/api/src/lib/family-sharing-transitions.ts`: each writes first and
 * reads the other side after. The enable re-counts teams after its kind write
 * and restores personal if one appeared; Better Auth's `afterCreateTeam` hook
 * calls {@link removeTeamCreatedInFamily}, which re-reads the kind after the
 * team write. Whichever runs second sees the other, so no team survives in a
 * family.
 */

export interface FamilyTeamGuardDeps {
	/** Deletes the new team and any team-member rows written with it. */
	deleteTeam: (input: {
		organizationId: string;
		teamId: string;
	}) => Promise<void>;
	readOrganizationKind: (
		organizationId: string
	) => Promise<OrganizationKind | null>;
}

const BA_OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const defaultDeps: FamilyTeamGuardDeps = {
	deleteTeam: async ({ organizationId, teamId }) => {
		if (
			!(BA_OBJECT_ID_RE.test(teamId) && BA_OBJECT_ID_RE.test(organizationId))
		) {
			return;
		}
		await TeamMember.deleteMany({ teamId });
		await Team.deleteOne({ _id: teamId, organizationId });
	},
	readOrganizationKind,
};

/**
 * After a team write: when its org has become a family since the
 * `beforeCreateTeam` check, delete the new team and return the refusal to
 * throw; otherwise null. The team was created in this request, so it holds no
 * members or team-level controls to lose.
 */
export async function removeTeamCreatedInFamily(
	input: { organizationId: string; teamId: string },
	deps: FamilyTeamGuardDeps = defaultDeps
): Promise<string | null> {
	const refusal = teamRefusal(
		await deps.readOrganizationKind(input.organizationId)
	);
	if (!refusal) {
		return null;
	}
	await deps.deleteTeam(input);
	return refusal;
}
