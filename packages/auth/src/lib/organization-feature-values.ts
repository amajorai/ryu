import { Team, TeamMember } from "@ryu/db/models/control-plane.model";
import {
	type EffectivePolicyScope,
	loadEffectivePolicy,
} from "@ryu/db/models/effective-policy";
import {
	OrganizationFeatureControl,
	OrganizationTeamFeatureControl,
} from "@ryu/db/models/organization-feature-control.model";
import {
	featureAllowedByPolicy,
	ORGANIZATION_FEATURES,
	type OrganizationFeatureKey,
	resolveOrganizationFeature,
} from "./organization-features.ts";

/** The ids of the teams in `organizationId` that `userId` belongs to. */
export async function memberTeamIds(
	organizationId: string,
	userId: string
): Promise<string[]> {
	const teams = await Team.find({ organizationId }).select("_id").lean();
	if (teams.length === 0) {
		return [];
	}
	const memberships = await TeamMember.find({
		teamId: { $in: teams.map((team) => team._id) },
		userId,
	})
		.select("teamId")
		.lean();
	return [...new Set(memberships.map((row) => String(row.teamId)))];
}

/**
 * The policy scopes whose `allowedFeatures` all must allow a feature when no
 * explicit scope is given: the organization plus the caller's user layer,
 * and that cascade once more through each team whose toggles apply. A team
 * layer can only tighten (the cascade narrows top-down), so a member of
 * several teams gets the strictest of them, as the team toggles do. The
 * team-less scope stays in the set so the user layer's narrowing applies on
 * its own too, whatever the cascade does when a team list and the user list
 * share no entry.
 */
function memberPolicyScopes(
	teamIds: readonly string[],
	userId: string | null
): EffectivePolicyScope[] {
	const base: EffectivePolicyScope = userId ? { userId } : {};
	return [base, ...teamIds.map((teamId) => ({ ...base, teamId }))];
}

/**
 * The effective value of each organization feature for one caller, layered
 * organization → team → member, then gated by the organization policy's
 * `allowedFeatures`.
 *
 * - `teamIds`: the teams whose overrides apply. A node passes its own team;
 *   omitted, the member's teams in the organization are used.
 * - `policyScope`: the policy layers to read `allowedFeatures` from. A node
 *   passes its credential scope plus the caller; omitted, see
 *   `memberPolicyScopes`.
 */
export async function resolveOrganizationFeatureValues(input: {
	keys?: readonly OrganizationFeatureKey[];
	organizationId: string;
	policyScope?: EffectivePolicyScope;
	teamIds?: readonly string[];
	userId?: string | null;
}): Promise<Map<OrganizationFeatureKey, boolean>> {
	const userId = input.userId?.trim() || null;
	const features = ORGANIZATION_FEATURES.filter(
		(feature) => !input.keys || input.keys.includes(feature.key)
	);
	const keys = features.map((feature) => feature.key);
	const teamIds =
		input.teamIds ??
		(userId ? await memberTeamIds(input.organizationId, userId) : []);
	const policyScopes = input.policyScope
		? [input.policyScope]
		: memberPolicyScopes(teamIds, userId);
	const [controls, teamControls, policies] = await Promise.all([
		OrganizationFeatureControl.find({
			organizationId: input.organizationId,
			key: { $in: keys },
			...(userId ? { $or: [{ userId: null }, { userId }] } : { userId: null }),
		})
			.limit(500)
			.lean(),
		teamIds.length > 0
			? OrganizationTeamFeatureControl.find({
					organizationId: input.organizationId,
					teamId: { $in: [...teamIds] },
					key: { $in: keys },
				})
					.limit(500)
					.lean()
			: Promise.resolve([]),
		Promise.all(
			policyScopes.map((scope) =>
				loadEffectivePolicy(input.organizationId, scope)
			)
		),
	]);
	const values = new Map<OrganizationFeatureKey, boolean>();
	for (const feature of features) {
		const organization = controls.find(
			(control) => control.key === feature.key && control.userId === null
		);
		const member = userId
			? controls.find(
					(control) => control.key === feature.key && control.userId === userId
				)
			: undefined;
		const teams = teamControls
			.filter((control) => control.key === feature.key)
			.map((control) => control.enabled);
		values.set(
			feature.key,
			resolveOrganizationFeature(
				feature,
				organization?.enabled,
				member?.enabled,
				teams
			) &&
				policies.every((policy) =>
					featureAllowedByPolicy(feature.key, policy.rules.allowedFeatures)
				)
		);
	}
	return values;
}
