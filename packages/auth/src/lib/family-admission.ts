/**
 * Pure admission rules for Ryu Max family sharing, shared by the Better Auth
 * organization hooks (`organization-admission.ts`) and their tests.
 *
 * A family org is the owner's personal org promoted in place (see
 * `organization-kind.ts`). Unlike Teams it admits consumer mailboxes, holds at
 * most {@link FAMILY_SHARING_MAX_MEMBERS} people, uses no sub-teams, custom or
 * billing roles, and a person may belong to at most
 * {@link FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT} families. The database and
 * capacity lookups stay outside these functions.
 */
import {
	decideFamilyMembership,
	FAMILY_SHARING_FULL_MESSAGE,
	FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT,
	FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
	FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE,
} from "./family-sharing.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	type OrganizationKind,
} from "./organization-kind.ts";

/**
 * Roles a family invitation, direct add or role change may assign. `owner`
 * stays with the Max subscriber whose personal org this is; `admin` is a
 * co-organizer. Custom roles, `viewer` and the additive `billing` role are not
 * part of a family.
 */
export const FAMILY_ASSIGNABLE_ROLES = ["admin", "member"] as const;

// User-facing copy. Family surfaces never say "Teams".
export const FAMILY_ROLE_REFUSED_MESSAGE =
	"Family members can be organizers or members. Owner, billing and custom roles aren't available in a family.";
export const FAMILY_OWNER_FIXED_MESSAGE =
	"The family owner is the Ryu Max subscriber and stays the owner. Family ownership can't be changed or transferred.";
export const FAMILY_OWNER_LEAVE_MESSAGE =
	"The family owner can't leave the family. Remove the other members, then turn off family sharing.";
export const FAMILY_TEAMS_REFUSED_MESSAGE =
	"Family workspaces don't use teams.";
export const FAMILY_CUSTOM_ROLES_REFUSED_MESSAGE =
	"Family workspaces don't support custom roles.";
export const FAMILY_MEMBER_EMAIL_UNVERIFIED_MESSAGE =
	"Verify your email before joining a family.";
export const FAMILY_INVITER_EMAIL_UNVERIFIED_MESSAGE =
	"Verify your email before inviting family members.";
export const FAMILY_ORGANIZER_EMAIL_UNVERIFIED_MESSAGE =
	"This person needs to verify their email before becoming a family organizer.";

/**
 * Better Auth dynamic-access-control endpoints that write a custom role. Reads
 * and deletes stay open so a role made before the org became a family can
 * still be listed and removed.
 */
const CUSTOM_ROLE_WRITE_PATHS: ReadonlySet<string> = new Set([
	"/organization/create-role",
	"/organization/update-role",
]);

/** Whether a Better Auth request path writes a custom organization role. */
export function isCustomRoleWritePath(
	path: string | null | undefined
): boolean {
	return CUSTOM_ROLE_WRITE_PATHS.has(path ?? "");
}

export interface OrganizationAdmissionPolicy {
	/** Roles a new member or role change may carry; null admits any configured role. */
	readonly assignableRoles: readonly string[] | null;
	/** Shared membership needs a verified company-domain mailbox (Teams). */
	readonly businessEmail: boolean;
	/** Dynamic access control may create or update custom roles. */
	readonly customRoles: boolean;
	/**
	 * Orgs of this kind one person may belong to (owned and joined together),
	 * or null for no cap.
	 */
	readonly maxPerPerson: number | null;
	/**
	 * The first owner row of an empty org is admitted without a seat. Teams needs
	 * it for signup bootstrap and new shared orgs; a family is never created, so
	 * an owner row for an empty family is not a bootstrap and must not skip the
	 * families-per-account check or the seat gate.
	 */
	readonly ownerBootstrap: boolean;
	/** Sub-teams may be created and joined. */
	readonly teams: boolean;
}

const FAMILY_ADMISSION_POLICY: OrganizationAdmissionPolicy = {
	assignableRoles: FAMILY_ASSIGNABLE_ROLES,
	businessEmail: false,
	customRoles: false,
	maxPerPerson: FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT,
	ownerBootstrap: false,
	teams: false,
};

const SHARED_ADMISSION_POLICY: OrganizationAdmissionPolicy = {
	assignableRoles: null,
	businessEmail: true,
	customRoles: true,
	maxPerPerson: null,
	ownerBootstrap: true,
	teams: true,
};

/**
 * The admission rules for a shared (non-personal) org of `kind`. A legacy org
 * without a durable kind keeps the Teams rules, as before family sharing.
 * Personal orgs refuse every second member before this policy applies.
 */
export function organizationAdmissionPolicy(
	kind: OrganizationKind | null
): OrganizationAdmissionPolicy {
	return kind === FAMILY_ORGANIZATION_KIND
		? FAMILY_ADMISSION_POLICY
		: SHARED_ADMISSION_POLICY;
}

/**
 * The refusal for assigning `role` (a Better Auth role string, comma-separated
 * for additive roles) under `policy`, or null when every part is assignable.
 * An empty role is refused when the policy restricts roles: Better Auth fills
 * its default before the hooks run, so an empty value here is not a default.
 */
export function assignedRoleRefusal(
	policy: OrganizationAdmissionPolicy,
	role: string | null | undefined
): string | null {
	const assignable = policy.assignableRoles;
	if (assignable === null) {
		return null;
	}
	const parts = (role ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const admitted =
		parts.length > 0 && parts.every((part) => assignable.includes(part));
	return admitted ? null : FAMILY_ROLE_REFUSED_MESSAGE;
}

/** The sub-team refusal for an org of `kind`, or null when teams are allowed. */
export function teamRefusal(kind: OrganizationKind | null): string | null {
	return organizationAdmissionPolicy(kind).teams
		? null
		: FAMILY_TEAMS_REFUSED_MESSAGE;
}

/** The custom-role write refusal for an org of `kind`, or null when allowed. */
export function customRoleRefusal(
	kind: OrganizationKind | null
): string | null {
	return organizationAdmissionPolicy(kind).customRoles
		? null
		: FAMILY_CUSTOM_ROLES_REFUSED_MESSAGE;
}

/**
 * Whether an invitation names a sub-team. Better Auth passes the first team as
 * `teamId` and every requested team as `teamIds`; either one counts.
 */
export function invitationNamesTeam(invitation: {
	teamId?: unknown;
	teamIds?: unknown;
}): boolean {
	if (typeof invitation.teamId === "string" && invitation.teamId.trim()) {
		return true;
	}
	return Array.isArray(invitation.teamIds) && invitation.teamIds.length > 0;
}

/**
 * Family admission keeps a verified mailbox without the business-domain rule:
 * Gmail and iCloud are welcome, an unverified address is not. `context` picks
 * the copy for the person joining, the person inviting, or the member being
 * promoted to organizer.
 */
export function familyVerifiedEmailRefusal(
	user: { emailVerified?: boolean | null },
	context: "inviter" | "member" | "organizer"
): string | null {
	if (user.emailVerified) {
		return null;
	}
	if (context === "inviter") {
		return FAMILY_INVITER_EMAIL_UNVERIFIED_MESSAGE;
	}
	return context === "organizer"
		? FAMILY_ORGANIZER_EMAIL_UNVERIFIED_MESSAGE
		: FAMILY_MEMBER_EMAIL_UNVERIFIED_MESSAGE;
}

/**
 * The families-per-account refusal for admitting a person into
 * `targetOrganizationId`, or null when joining keeps them within `limit`
 * families (default {@link FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT}).
 * `actor: "self"` is the person accepting their own invitation; `"other"` is
 * an organizer adding or inviting someone.
 */
export function familyMembershipRefusal(input: {
	actor: "other" | "self";
	existingFamilyOrganizationIds: readonly string[];
	limit?: number;
	targetOrganizationId: string;
}): string | null {
	const decision = decideFamilyMembership(input);
	if (decision.allowed) {
		return null;
	}
	return input.actor === "self"
		? FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE
		: FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE;
}

/** Seat-gate refusal copy for one org kind. */
export interface OrganizationSeatCopy {
	/** A claim's seat fell outside a capacity that shrank mid-admission. */
	readonly capacityChanged: string;
	/** Members plus pending reservations already fill the capacity. */
	readonly full: string;
	/** The org has no admitting capacity (no active plan, or not eligible). */
	readonly noCapacity: string;
}

export const TEAMS_SEAT_COPY: OrganizationSeatCopy = {
	capacityChanged:
		"Organization seat capacity changed while this member was being added. Ask an organization owner or admin to add a seat and try again.",
	full: "No unassigned organization seat is available. Buy another seat or remove a member first.",
	noCapacity:
		"An active Teams or Business subscription is required before this organization can add members. Buy seats first.",
};

export const FAMILY_SEAT_COPY: OrganizationSeatCopy = {
	capacityChanged: FAMILY_SHARING_FULL_MESSAGE,
	full: FAMILY_SHARING_FULL_MESSAGE,
	noCapacity: FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
};

/** The seat-gate copy for an org of `kind`; family copy never says "Teams". */
export function organizationSeatCopy(
	kind: OrganizationKind | null
): OrganizationSeatCopy {
	return kind === FAMILY_ORGANIZATION_KIND ? FAMILY_SEAT_COPY : TEAMS_SEAT_COPY;
}
