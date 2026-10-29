import { describe, expect, it } from "bun:test";
import {
	FAMILY_ORGANIZATION_KIND,
	memberRoleIncludesOwner,
	metadataWithOrganizationKind,
	type OrganizationKind,
	organizationKindFromMetadata,
	organizationKindTransitionAllowed,
	PERSONAL_ORGANIZATION_KIND,
	parseOrganizationMetadata,
	personalOrganizationIdForEarliestMembership,
	TEAMS_ORGANIZATION_KIND,
} from "./organization-kind.ts";

describe("organization kind metadata", () => {
	it("preserves future JSON metadata and rejects malformed stored values", () => {
		const metadata = {
			organizationKind: "personal",
			future: { enabled: true, labels: ["one", null, 17] },
		};
		expect(parseOrganizationMetadata(JSON.stringify(metadata))).toEqual(
			metadata
		);
		expect(
			metadataWithOrganizationKind(metadata, TEAMS_ORGANIZATION_KIND).future
		).toEqual(metadata.future);
		for (const invalid of [undefined, null, "{broken", "[]", 17]) {
			expect(parseOrganizationMetadata(invalid)).toEqual({});
			expect(organizationKindFromMetadata(invalid)).toBeNull();
		}
	});

	it("round-trips Better Auth's serialized metadata", () => {
		const metadata = metadataWithOrganizationKind(
			JSON.stringify({ source: "signup" }),
			PERSONAL_ORGANIZATION_KIND
		);
		expect(metadata).toEqual({
			source: "signup",
			organizationKind: "personal",
		});
		expect(organizationKindFromMetadata(JSON.stringify(metadata))).toBe(
			PERSONAL_ORGANIZATION_KIND
		);
	});

	it("distinguishes a paid in-place conversion from a personal org", () => {
		const metadata = metadataWithOrganizationKind({}, TEAMS_ORGANIZATION_KIND, {
			upgradedFromPersonalAt: "2026-08-21T00:00:00.000Z",
		});
		expect(organizationKindFromMetadata(metadata)).toBe(
			TEAMS_ORGANIZATION_KIND
		);
		expect(parseOrganizationMetadata(metadata).upgradedFromPersonalAt).toBe(
			"2026-08-21T00:00:00.000Z"
		);
	});
});

describe("family organization kind", () => {
	it("parses the family marker and still rejects unknown kinds", () => {
		expect(
			organizationKindFromMetadata(
				JSON.stringify({ organizationKind: FAMILY_ORGANIZATION_KIND })
			)
		).toBe(FAMILY_ORGANIZATION_KIND);
		expect(organizationKindFromMetadata({ organizationKind: "Family" })).toBe(
			null
		);
		expect(organizationKindFromMetadata({ organizationKind: "school" })).toBe(
			null
		);
	});

	it("enters family only from personal or a legacy-unset org", () => {
		expect(
			organizationKindTransitionAllowed(
				PERSONAL_ORGANIZATION_KIND,
				FAMILY_ORGANIZATION_KIND
			)
		).toBe(true);
		expect(
			organizationKindTransitionAllowed(null, FAMILY_ORGANIZATION_KIND)
		).toBe(true);
		expect(
			organizationKindTransitionAllowed(
				TEAMS_ORGANIZATION_KIND,
				FAMILY_ORGANIZATION_KIND
			)
		).toBe(false);
	});

	it("never moves a family to Teams, but still promotes personal orgs", () => {
		expect(
			organizationKindTransitionAllowed(
				FAMILY_ORGANIZATION_KIND,
				TEAMS_ORGANIZATION_KIND
			)
		).toBe(false);
		expect(
			organizationKindTransitionAllowed(
				PERSONAL_ORGANIZATION_KIND,
				TEAMS_ORGANIZATION_KIND
			)
		).toBe(true);
		expect(
			organizationKindTransitionAllowed(null, TEAMS_ORGANIZATION_KIND)
		).toBe(true);
	});

	it("returns to personal only from family", () => {
		const from: (OrganizationKind | null)[] = [
			null,
			TEAMS_ORGANIZATION_KIND,
			FAMILY_ORGANIZATION_KIND,
		];
		expect(
			from.map((kind) =>
				organizationKindTransitionAllowed(kind, PERSONAL_ORGANIZATION_KIND)
			)
		).toEqual([false, false, true]);
		expect(
			organizationKindTransitionAllowed(
				PERSONAL_ORGANIZATION_KIND,
				PERSONAL_ORGANIZATION_KIND
			)
		).toBe(true);
	});

	it("reads the owner role out of additive role strings", () => {
		expect(memberRoleIncludesOwner("owner")).toBe(true);
		expect(memberRoleIncludesOwner("billing, owner")).toBe(true);
		expect(memberRoleIncludesOwner("admin")).toBe(false);
		expect(memberRoleIncludesOwner("co-owner")).toBe(false);
		expect(memberRoleIncludesOwner(undefined)).toBe(false);
		expect(memberRoleIncludesOwner(null)).toBe(false);
	});
});

describe("personalOrganizationIdForEarliestMembership", () => {
	const organizationId = "64b000000000000000000001";

	it("keeps personal and legacy-unset orgs personal for any role", () => {
		for (const kind of [PERSONAL_ORGANIZATION_KIND, null]) {
			expect(
				personalOrganizationIdForEarliestMembership({
					kind,
					organizationId,
					role: "member",
				})
			).toBe(organizationId);
		}
	});

	it("never treats a Teams conversion as personal, even for its owner", () => {
		expect(
			personalOrganizationIdForEarliestMembership({
				kind: TEAMS_ORGANIZATION_KIND,
				organizationId,
				role: "owner",
			})
		).toBeNull();
	});

	it("keeps a family as its owner's personal org", () => {
		// The owner's Max subscription, gifts and payouts stay on the family org.
		expect(
			personalOrganizationIdForEarliestMembership({
				kind: FAMILY_ORGANIZATION_KIND,
				organizationId,
				role: "owner,billing",
			})
		).toBe(organizationId);
	});

	it("keeps a non-owner's payouts out of the family pool", () => {
		for (const role of ["admin", "member", undefined]) {
			expect(
				personalOrganizationIdForEarliestMembership({
					kind: FAMILY_ORGANIZATION_KIND,
					organizationId,
					role,
				})
			).toBeNull();
		}
	});
});
