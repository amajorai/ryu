import { Member } from "@ryu/db/models/control-plane.model";
import { FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT } from "./family-membership-slots.ts";
import {
	familyOrganizationIdsForUser,
	familyOrganizationNamesAmong,
} from "./organization-kind.ts";
import type { PlanId } from "./plans.ts";

// biome-ignore lint/performance/noBarrelFile: the cap's public home is this module; it is defined beside the slot claim that enforces it.
export { FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT } from "./family-membership-slots.ts";

/**
 * Ryu Max family sharing: the owner's personal org promoted in place to kind
 * `family` (see `organization-kind.ts`), admitting up to
 * {@link FAMILY_SHARING_MAX_MEMBERS} people including the owner. There is no
 * family plan id; sharing rides on Max and is rolled out behind
 * `FAMILY_SHARING_FLAG` (`feature-flags.ts`).
 *
 * This module holds the pieces the auth admission hooks need without reaching
 * into `@ryu/api`: the product constants, the user-facing copy, the
 * families-per-account cap, and the capacity seam the API registers at boot.
 */

/** People in one family, owner included. Pending invitations count against it. */
export const FAMILY_SHARING_MAX_MEMBERS = 6;

/** Entitlement plans that include family sharing. */
export const FAMILY_SHARING_PLAN_IDS: readonly PlanId[] = ["max"];

/** Whether an org's entitlement plan includes family sharing. */
export function isFamilySharingPlan(
	planId: string | null | undefined
): boolean {
	return FAMILY_SHARING_PLAN_IDS.some(
		(familyPlanId) => familyPlanId === planId
	);
}

// User-facing copy. Family surfaces never say "Teams".
export const FAMILY_SHARING_FULL_MESSAGE =
	"Family sharing is full. A family can have up to 6 people, including you.";
export const FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE =
	"Family sharing needs an active Ryu Max plan on this workspace.";
export const FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE = `This person is already in ${FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT} families, the most one account can join.`;
export const FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE = `You're already in ${FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT} families, the most one account can join. Leave one first.`;
/** An admission that raced the owner turning sharing off was undone. */
export const FAMILY_SHARING_SELF_TURNED_OFF_MESSAGE =
	"Family sharing was turned off for this family, so you weren't added.";
export const FAMILY_SHARING_MEMBER_TURNED_OFF_MESSAGE =
	"Family sharing was turned off for this family, so this person wasn't added.";
export const FAMILY_SHARING_DELETE_REFUSED_MESSAGE =
	"Turn off family sharing first.";
export const FAMILY_SHARING_REMOVE_MEMBERS_FIRST_MESSAGE =
	"Remove family members first.";

/**
 * The capacity implementation `apps/server` registers: the number of people the
 * family org may hold right now ({@link FAMILY_SHARING_MAX_MEMBERS} when the org
 * is on Max and the rollout flag is on for its owner), or null when it may admit
 * no one new.
 *
 * WHY A REGISTRY: eligibility needs `resolveEntitlementForOrgId` and the flag
 * evaluator, both in `@ryu/api`, which depends on `@ryu/auth` and so cannot be
 * imported here. Same single-slot, last-wins shape as `referral-grant-hook.ts`.
 */
export type FamilySharingCapacityResolver = (
	organizationId: string
) => Promise<number | null>;

let capacityResolver: FamilySharingCapacityResolver | null = null;

/** Install the capacity implementation. Called once, from `apps/server` boot. */
export function registerFamilySharingCapacityResolver(
	resolver: FamilySharingCapacityResolver
): void {
	capacityResolver = resolver;
}

/**
 * How many people a family org may hold, or null to admit no one new. FAILS
 * CLOSED and NEVER THROWS: no registration (auth loaded alone, tests), a
 * throwing resolver, or a non-positive / non-integer answer all yield null, so
 * the seat gate refuses instead of admitting past the cap. An answer above
 * {@link FAMILY_SHARING_MAX_MEMBERS} is clamped to it.
 */
export async function familySharingCapacity(
	organizationId: string
): Promise<number | null> {
	const resolver = capacityResolver;
	if (!resolver) {
		return null;
	}
	let capacity: number | null;
	try {
		capacity = await resolver(organizationId);
	} catch (error) {
		console.error("Failed to resolve family sharing capacity:", error);
		return null;
	}
	if (capacity === null || !Number.isInteger(capacity) || capacity < 1) {
		return null;
	}
	return Math.min(capacity, FAMILY_SHARING_MAX_MEMBERS);
}

export type FamilyMembershipDecision =
	| {
			allowed: true;
			/** Families the person belongs to once admitted. */
			familyCount: number;
	  }
	| {
			allowed: false;
			/** Families the person already belongs to. */
			familyCount: number;
			limit: number;
			reason: "family_limit_reached";
	  };

/**
 * The families-per-account cap: a person may join family
 * `targetOrganizationId` unless that would put them in more than `limit`
 * families (owned and joined together). The target counts only when they are
 * not already in it, so re-admission into the same family never trips the cap.
 * Duplicate ids count once.
 */
export function decideFamilyMembership(input: {
	existingFamilyOrganizationIds: readonly string[];
	limit?: number;
	targetOrganizationId: string;
}): FamilyMembershipDecision {
	const limit = input.limit ?? FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT;
	const existing = new Set(input.existingFamilyOrganizationIds);
	if (existing.has(input.targetOrganizationId)) {
		return { allowed: true, familyCount: existing.size };
	}
	const familyCount = existing.size + 1;
	return familyCount > limit
		? {
				allowed: false,
				familyCount: existing.size,
				limit,
				reason: "family_limit_reached",
			}
		: { allowed: true, familyCount };
}

/**
 * The family orgs a user belongs to, in membership order, optionally excluding
 * one (the family they are being admitted into).
 *
 * This is a read: the families-per-account cap is enforced by the atomic place
 * claim in `family-membership-slots.ts`, which reconciles against this list.
 */
export async function userFamilyOrganizationIds(
	userId: string,
	options: { excludeOrganizationId?: string | null } = {}
): Promise<string[]> {
	return await familyOrganizationIdsForUser(userId, options);
}

/** One family a user belongs to, as `/api/family-sharing` lists it. */
export interface UserFamilyMembership {
	/** The org's display name; empty when it has none. */
	name: string;
	organizationId: string;
	/** The Better Auth role string on the user's member row. */
	role: string;
}

/**
 * Every family org a user belongs to, oldest membership first, with their role
 * and the family's name. Same read as {@link userFamilyOrganizationIds}.
 */
export async function userFamilyMemberships(
	userId: string
): Promise<UserFamilyMembership[]> {
	const memberships = await Member.find({ userId })
		.select("organizationId role")
		.sort({ createdAt: 1 })
		.lean<Array<{ organizationId: unknown; role?: string | null }>>();
	const roles = new Map<string, string>();
	for (const membership of memberships) {
		const organizationId = String(membership.organizationId);
		if (!roles.has(organizationId)) {
			roles.set(organizationId, membership.role ?? "");
		}
	}
	const families = await familyOrganizationNamesAmong([...roles.keys()]);
	return [...roles].flatMap(([organizationId, role]) => {
		const name = families.get(organizationId);
		return name === undefined ? [] : [{ name, organizationId, role }];
	});
}
