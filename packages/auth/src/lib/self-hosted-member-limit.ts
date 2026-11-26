/**
 * Member limit of a self-hosted control plane (`RYU_DEPLOYMENT_MODE=self-hosted`).
 * Pure rules; the Mongo reads and the license lookup live in
 * `auth-options/self-hosted-seats.ts`. None of this runs on the hosted cloud.
 *
 * - Without a license an install holds {@link SELF_HOSTED_FREE_MEMBER_LIMIT}
 *   people. A valid license that states a higher seat count raises the limit.
 * - The limit is per install: distinct people across every shared
 *   organization, so creating more organizations does not raise it.
 * - A pending invitation and an in-flight join each hold one place, as they do
 *   for billed seats.
 * - People already above the limit keep access. Only new joins are refused.
 */
import type { OrganizationSeatCopy } from "./family-admission.ts";
import type { OrganizationKind } from "./organization-kind.ts";

// Type-only imports above: this module stays free of runtime imports, so the
// API route and its test load it without the database models.
const PERSONAL_ORGANIZATION_KIND: OrganizationKind = "personal";

/** People a self-hosted install may hold without a license, owner included. */
export const SELF_HOSTED_FREE_MEMBER_LIMIT = 3;

/** Stable `code` of the refusal, so clients need not match the sentence. */
export const SELF_HOSTED_MEMBER_LIMIT_CODE = "SELF_HOSTED_MEMBER_LIMIT";

export interface SelfHostedSeatAllowance {
	/** Whether a valid license's seat count set the limit. */
	readonly licensed: boolean;
	/** Distinct people the install may hold across its shared organizations. */
	readonly limit: number;
}

/**
 * The install's allowance from its verified license, or null when it has none.
 * A license raises the limit and never lowers it: a missing, malformed or
 * smaller seat count leaves the free limit in place.
 */
export function selfHostedSeatAllowance(
	license: { seats: number | null } | null
): SelfHostedSeatAllowance {
	const seats = license?.seats ?? null;
	if (
		seats !== null &&
		Number.isSafeInteger(seats) &&
		seats > SELF_HOSTED_FREE_MEMBER_LIMIT
	) {
		return { licensed: true, limit: seats };
	}
	return { licensed: false, limit: SELF_HOSTED_FREE_MEMBER_LIMIT };
}

// The sentences carry a `{limit}` placeholder that `selfHostedSeatCopy` fills.
export const SELF_HOSTED_FULL_MESSAGE =
	"All {limit} member places on this self-hosted install are taken, the most it can have without a license. Add a license or move to Ryu Cloud to add more people.";
export const SELF_HOSTED_LICENSED_FULL_MESSAGE =
	"All {limit} licensed member places on this self-hosted install are taken. Remove a member, cancel a pending invitation, or extend the license to add more people.";
export const SELF_HOSTED_LIMIT_CHANGED_MESSAGE =
	"The member limit of this self-hosted install changed while this member was being added. Try again.";

/** Refusal copy for a self-hosted install, with the stable refusal code. */
export function selfHostedSeatCopy(
	allowance: SelfHostedSeatAllowance
): OrganizationSeatCopy & { readonly code: string } {
	const full = (
		allowance.licensed
			? SELF_HOSTED_LICENSED_FULL_MESSAGE
			: SELF_HOSTED_FULL_MESSAGE
	).replace("{limit}", String(allowance.limit));
	return {
		capacityChanged: SELF_HOSTED_LIMIT_CHANGED_MESSAGE,
		code: SELF_HOSTED_MEMBER_LIMIT_CODE,
		full,
		// A self-hosted install always has a limit, so this is never the answer;
		// it says the same as `full` in case a caller reaches it.
		noCapacity: full,
	};
}

/**
 * Whether one more person may join the install. Someone who already holds a
 * place (a member of another shared organization) takes no new one, so they
 * may join a second organization even when the install is full.
 */
export function decideSelfHostedInstallAdmission(input: {
	candidateAlreadySeated: boolean;
	limit: number;
	reservedSeats: number;
	seatedPeople: number;
}): { allowed: boolean } {
	if (input.candidateAlreadySeated) {
		return { allowed: true };
	}
	const limit = Math.max(0, Math.floor(input.limit));
	const seated = Math.max(0, Math.floor(input.seatedPeople));
	const reserved = Math.max(0, Math.floor(input.reservedSeats));
	return { allowed: seated + reserved < limit };
}

/** Places still free on the install; never negative. */
export function selfHostedAvailableSeats(input: {
	limit: number;
	reservedSeats: number;
	seatedPeople: number;
}): number {
	return Math.max(
		0,
		Math.floor(input.limit) -
			Math.max(0, Math.floor(input.seatedPeople)) -
			Math.max(0, Math.floor(input.reservedSeats))
	);
}

/** One organization of the install with its durable kind. */
export interface SelfHostedOrganization {
	id: string;
	kind: OrganizationKind | null;
}

/**
 * The organizations whose members and pending claims can hold a place: every
 * one that is not a `personal` workspace.
 */
export function selfHostedSharedOrganizations<
	Organization extends SelfHostedOrganization,
>(organizations: readonly Organization[]): Organization[] {
	return organizations.filter(
		(organization) => organization.kind !== PERSONAL_ORGANIZATION_KIND
	);
}

/**
 * Who holds a place on the install: the members of every shared organization,
 * each person once however many organizations they belong to.
 *
 * - `personal` workspaces hold one person and never count.
 * - `teams` and `family` organizations count, owner included.
 * - A legacy organization without a kind counts once it has two or more
 *   members. With one member it is that person's own workspace, as the
 *   admission fallback in `auth-options/admission.ts` treats it.
 */
export function selfHostedSeatedPeople(input: {
	members: ReadonlyArray<{ organizationId: string; userId: string }>;
	organizations: readonly SelfHostedOrganization[];
}): Set<string> {
	const kinds = new Map<string, OrganizationKind | null>();
	for (const organization of selfHostedSharedOrganizations(
		input.organizations
	)) {
		kinds.set(organization.id, organization.kind);
	}
	const sizes = new Map<string, number>();
	for (const member of input.members) {
		if (kinds.has(member.organizationId)) {
			sizes.set(
				member.organizationId,
				(sizes.get(member.organizationId) ?? 0) + 1
			);
		}
	}
	const userIds = new Set<string>();
	for (const member of input.members) {
		if (!kinds.has(member.organizationId)) {
			continue;
		}
		const unmarked = kinds.get(member.organizationId) === null;
		if (unmarked && (sizes.get(member.organizationId) ?? 0) < 2) {
			continue;
		}
		userIds.add(member.userId);
	}
	return userIds;
}
