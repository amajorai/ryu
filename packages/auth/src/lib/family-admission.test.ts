import { describe, expect, it } from "bun:test";
import {
	assignedRoleRefusal,
	customRoleRefusal,
	FAMILY_ASSIGNABLE_ROLES,
	FAMILY_CUSTOM_ROLES_REFUSED_MESSAGE,
	FAMILY_INVITER_EMAIL_UNVERIFIED_MESSAGE,
	FAMILY_MEMBER_EMAIL_UNVERIFIED_MESSAGE,
	FAMILY_ORGANIZER_EMAIL_UNVERIFIED_MESSAGE,
	FAMILY_ROLE_REFUSED_MESSAGE,
	FAMILY_SEAT_COPY,
	FAMILY_TEAMS_REFUSED_MESSAGE,
	familyMembershipRefusal,
	familyVerifiedEmailRefusal,
	invitationNamesTeam,
	isCustomRoleWritePath,
	organizationAdmissionPolicy,
	organizationSeatCopy,
	TEAMS_SEAT_COPY,
	teamRefusal,
} from "./family-admission.ts";
import {
	FAMILY_SHARING_FULL_MESSAGE,
	FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT,
	FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE,
	FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
	FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE,
} from "./family-sharing.ts";
import { decideSeatAdmission } from "./organization-seat-gate.ts";

const FAMILY_ID = "64b000000000000000000001";
const OTHER_FAMILY_IDS = [
	"64b000000000000000000002",
	"64b000000000000000000003",
	"64b000000000000000000004",
	"64b000000000000000000005",
	"64b000000000000000000006",
];

describe("organization admission policy by kind", () => {
	it("admits any verified mailbox into a family, five families per person, without a bootstrap", () => {
		expect(organizationAdmissionPolicy("family")).toEqual({
			assignableRoles: FAMILY_ASSIGNABLE_ROLES,
			businessEmail: false,
			customRoles: false,
			maxPerPerson: FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT,
			ownerBootstrap: false,
			teams: false,
		});
	});

	it("keeps the Teams rules for teams and for legacy shared orgs without a kind", () => {
		const shared = {
			assignableRoles: null,
			businessEmail: true,
			customRoles: true,
			maxPerPerson: null,
			ownerBootstrap: true,
			teams: true,
		};
		expect(organizationAdmissionPolicy("teams")).toEqual(shared);
		expect(organizationAdmissionPolicy(null)).toEqual(shared);
	});
});

describe("assigned roles", () => {
	const family = organizationAdmissionPolicy("family");

	it("admits organizer and member roles in a family", () => {
		expect(assignedRoleRefusal(family, "admin")).toBeNull();
		expect(assignedRoleRefusal(family, "member")).toBeNull();
		expect(assignedRoleRefusal(family, " member ")).toBeNull();
	});

	it("refuses owner, viewer, billing, custom and empty roles in a family", () => {
		for (const role of ["owner", "viewer", "billing", "parent", "", null]) {
			expect(assignedRoleRefusal(family, role)).toBe(
				FAMILY_ROLE_REFUSED_MESSAGE
			);
		}
	});

	it("refuses an additive role string when any part is not assignable", () => {
		expect(assignedRoleRefusal(family, "member,billing")).toBe(
			FAMILY_ROLE_REFUSED_MESSAGE
		);
		expect(assignedRoleRefusal(family, "admin,member")).toBeNull();
	});

	it("leaves Teams roles to Better Auth's configured role catalog", () => {
		const teams = organizationAdmissionPolicy("teams");
		expect(assignedRoleRefusal(teams, "owner,billing")).toBeNull();
		expect(assignedRoleRefusal(teams, "custom-role")).toBeNull();
	});
});

describe("sub-teams and custom roles", () => {
	it("refuses sub-teams and custom-role writes only for a family", () => {
		expect(teamRefusal("family")).toBe(FAMILY_TEAMS_REFUSED_MESSAGE);
		expect(customRoleRefusal("family")).toBe(
			FAMILY_CUSTOM_ROLES_REFUSED_MESSAGE
		);
		for (const kind of ["teams", "personal", null] as const) {
			expect(teamRefusal(kind)).toBeNull();
			expect(customRoleRefusal(kind)).toBeNull();
		}
	});

	it("matches only the dynamic-access-control role writes", () => {
		expect(isCustomRoleWritePath("/organization/create-role")).toBe(true);
		expect(isCustomRoleWritePath("/organization/update-role")).toBe(true);
		expect(isCustomRoleWritePath("/organization/delete-role")).toBe(false);
		expect(isCustomRoleWritePath("/organization/list-roles")).toBe(false);
		expect(isCustomRoleWritePath("/organization/update-member-role")).toBe(
			false
		);
		expect(isCustomRoleWritePath(undefined)).toBe(false);
	});

	it("detects a team on an invitation through either Better Auth field", () => {
		expect(invitationNamesTeam({ teamId: "team-1" })).toBe(true);
		expect(invitationNamesTeam({ teamIds: ["team-1"] })).toBe(true);
		expect(invitationNamesTeam({ teamId: "  ", teamIds: [] })).toBe(false);
		expect(invitationNamesTeam({})).toBe(false);
	});
});

describe("family email verification", () => {
	it("admits a verified consumer mailbox", () => {
		for (const context of ["inviter", "member", "organizer"] as const) {
			expect(
				familyVerifiedEmailRefusal({ emailVerified: true }, context)
			).toBeNull();
		}
	});

	it("refuses an unverified mailbox with copy for each actor", () => {
		expect(familyVerifiedEmailRefusal({ emailVerified: false }, "member")).toBe(
			FAMILY_MEMBER_EMAIL_UNVERIFIED_MESSAGE
		);
		expect(familyVerifiedEmailRefusal({ emailVerified: null }, "inviter")).toBe(
			FAMILY_INVITER_EMAIL_UNVERIFIED_MESSAGE
		);
		expect(familyVerifiedEmailRefusal({}, "organizer")).toBe(
			FAMILY_ORGANIZER_EMAIL_UNVERIFIED_MESSAGE
		);
	});
});

describe("families per account", () => {
	it("admits someone in no other family, including a re-admission", () => {
		expect(
			familyMembershipRefusal({
				actor: "other",
				existingFamilyOrganizationIds: [],
				targetOrganizationId: FAMILY_ID,
			})
		).toBeNull();
		expect(
			familyMembershipRefusal({
				actor: "self",
				existingFamilyOrganizationIds: [FAMILY_ID],
				targetOrganizationId: FAMILY_ID,
			})
		).toBeNull();
	});

	it("admits a fifth family for someone in four others", () => {
		expect(
			familyMembershipRefusal({
				actor: "other",
				existingFamilyOrganizationIds: OTHER_FAMILY_IDS.slice(0, 4),
				targetOrganizationId: FAMILY_ID,
			})
		).toBeNull();
	});

	it("refuses a sixth family with actor-specific copy", () => {
		const input = {
			existingFamilyOrganizationIds: OTHER_FAMILY_IDS,
			targetOrganizationId: FAMILY_ID,
		};
		expect(familyMembershipRefusal({ ...input, actor: "other" })).toBe(
			FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE
		);
		expect(familyMembershipRefusal({ ...input, actor: "self" })).toBe(
			FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE
		);
		expect(FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE).toBe(
			"This person is already in 5 families, the most one account can join."
		);
		expect(FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE).toBe(
			"You're already in 5 families, the most one account can join. Leave one first."
		);
	});

	it("honours an explicit limit", () => {
		expect(
			familyMembershipRefusal({
				actor: "self",
				existingFamilyOrganizationIds: OTHER_FAMILY_IDS.slice(0, 1),
				limit: 1,
				targetOrganizationId: FAMILY_ID,
			})
		).toBe(FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE);
	});
});

describe("seat-gate copy", () => {
	it("uses family copy that never mentions Teams", () => {
		expect(organizationSeatCopy("family")).toBe(FAMILY_SEAT_COPY);
		expect(FAMILY_SEAT_COPY).toEqual({
			capacityChanged: FAMILY_SHARING_FULL_MESSAGE,
			full: FAMILY_SHARING_FULL_MESSAGE,
			noCapacity: FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
		});
		for (const message of Object.values(FAMILY_SEAT_COPY)) {
			expect(message).not.toContain("Teams");
		}
	});

	it("keeps the Teams copy, matching the shared seat gate", () => {
		for (const kind of ["teams", "personal", null] as const) {
			expect(organizationSeatCopy(kind)).toBe(TEAMS_SEAT_COPY);
		}
		expect(
			decideSeatAdmission({
				billedSeats: 1,
				memberCount: 1,
				reservedSeatCount: 0,
			}).reason
		).toBe(TEAMS_SEAT_COPY.full);
	});

	it("counts pending invitations against six people, owner included", () => {
		expect(
			decideSeatAdmission({
				billedSeats: 6,
				memberCount: 4,
				reservedSeatCount: 1,
			}).allowed
		).toBe(true);
		expect(
			decideSeatAdmission({
				billedSeats: 6,
				memberCount: 4,
				reservedSeatCount: 2,
			}).allowed
		).toBe(false);
	});
});
