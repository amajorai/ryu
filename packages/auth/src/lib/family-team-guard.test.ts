import { describe, expect, it, mock } from "bun:test";
import { FAMILY_TEAMS_REFUSED_MESSAGE } from "./family-admission.ts";
import {
	type FamilyTeamGuardDeps,
	removeTeamCreatedInFamily,
} from "./family-team-guard.ts";
import type { OrganizationKind } from "./organization-kind.ts";

const ORG = "0000000000000000000000a1";
const TEAM = "0000000000000000000000c1";

function guardDeps(kind: OrganizationKind | null) {
	const deleteTeam = mock<FamilyTeamGuardDeps["deleteTeam"]>(async () => {
		// The team store is not under test.
	});
	return {
		deleteTeam,
		deps: {
			deleteTeam,
			readOrganizationKind: async () => kind,
		} satisfies FamilyTeamGuardDeps,
	};
}

describe("removeTeamCreatedInFamily", () => {
	it("deletes a team that landed after the org became a family", async () => {
		const { deleteTeam, deps } = guardDeps("family");
		expect(
			await removeTeamCreatedInFamily(
				{ organizationId: ORG, teamId: TEAM },
				deps
			)
		).toBe(FAMILY_TEAMS_REFUSED_MESSAGE);
		expect(deleteTeam).toHaveBeenCalledWith({
			organizationId: ORG,
			teamId: TEAM,
		});
	});

	it("keeps teams in personal, Teams and legacy orgs", async () => {
		for (const kind of ["personal", "teams", null] as const) {
			const { deleteTeam, deps } = guardDeps(kind);
			expect(
				await removeTeamCreatedInFamily(
					{ organizationId: ORG, teamId: TEAM },
					deps
				)
			).toBeNull();
			expect(deleteTeam).not.toHaveBeenCalled();
		}
	});
});
