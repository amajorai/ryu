import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

/**
 * The persisted kind transitions, against an in-memory stand-in for the
 * control-plane models. What is under test is which stored kinds each writer
 * may overwrite: a family must never be flipped to Teams by a business-email
 * change or a stray Teams event, a Teams org must never become a family, and a
 * family returns to personal only once its owner is the last member.
 */

const ORG_ID = "64b000000000000000000001";
const USER_ID = "64b0000000000000000000aa";

const organizations = new Map<
	string,
	{ metadata?: string; organizationKind?: string }
>();
let members: Array<{
	createdAt: Date;
	organizationId: string;
	role: string;
	userId: string;
}> = [];
const metadataWrites: Array<{ id: string; metadata: string }> = [];
/** Runs once between a writer's read and its write: a concurrent writer. */
let interleavedWrite: (() => void) | null = null;
/** The family-place store stand-in: what was claimed, confirmed, released. */
const placeCalls: string[] = [];
let placeClaimWins = true;
/** Makes the next confirm or release of a family place reject. */
let placeSettleFails = false;

function chain<T>(value: T) {
	const query = Object.assign(Promise.resolve(value), {
		lean: () => Promise.resolve(value),
		select: () => query,
		sort: () => query,
	});
	return query;
}

let kindModule: typeof import("./organization-kind.ts");

beforeAll(async () => {
	mock.module("@ryu/db/models/control-plane.model", () => ({
		Member: {
			countDocuments: (filter: { organizationId: string }) =>
				Promise.resolve(
					members.filter(
						(member) => member.organizationId === filter.organizationId
					).length
				),
			findOne: (filter: { organizationId?: string; userId?: string }) =>
				chain(
					members
						.filter((member) =>
							filter.userId
								? member.userId === filter.userId
								: member.organizationId === filter.organizationId
						)
						.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
						.at(0) ?? null
				),
		},
		Organization: {
			findById: (id: string) => chain(organizations.get(id) ?? null),
			updateOne: (
				filter: {
					_id: string;
					metadata?: string | null;
					organizationKind?: string | null;
				},
				update: { $set: { metadata: string; organizationKind?: string } }
			) => {
				const concurrent = interleavedWrite;
				interleavedWrite = null;
				concurrent?.();
				// Mongo's `{ field: null }` also matches a missing field.
				const stored = organizations.get(filter._id);
				if (
					("metadata" in filter &&
						(stored?.metadata ?? null) !== filter.metadata) ||
					("organizationKind" in filter &&
						(stored?.organizationKind ?? null) !== filter.organizationKind)
				) {
					return Promise.resolve({ modifiedCount: 0 });
				}
				metadataWrites.push({ id: filter._id, metadata: update.$set.metadata });
				organizations.set(filter._id, { ...stored, ...update.$set });
				return Promise.resolve({ modifiedCount: 1 });
			},
		},
	}));
	mock.module("./family-membership-slots.ts", () => ({
		claimFamilyMembershipSlot: (input: {
			organizationId: string;
			userId: string;
		}) => {
			placeCalls.push(`claim:${input.userId}:${input.organizationId}`);
			return Promise.resolve(placeClaimWins);
		},
		confirmFamilyMembershipSlot: (input: { userId: string }) => {
			placeCalls.push(`confirm:${input.userId}`);
			return placeSettleFails
				? Promise.reject(new Error("place store unavailable"))
				: Promise.resolve();
		},
		releaseFamilyMembershipSlot: (input: {
			reservedOnly?: boolean;
			userId: string;
		}) => {
			placeCalls.push(
				`release:${input.userId}${input.reservedOnly ? ":reserved" : ""}`
			);
			return placeSettleFails
				? Promise.reject(new Error("place store unavailable"))
				: Promise.resolve();
		},
		releaseFamilyMembershipSlotsForOrganization: (
			organizationId: string,
			options: { confirmedOnly?: boolean }
		) => {
			placeCalls.push(
				`release-org:${organizationId}${options.confirmedOnly ? ":confirmed" : ""}`
			);
			return Promise.resolve();
		},
	}));
	kindModule = await import("./organization-kind.ts");
});

function storeOrganization(kind?: string): void {
	organizations.set(ORG_ID, {
		metadata: JSON.stringify(
			kind ? { organizationKind: kind, source: "signup" } : { source: "signup" }
		),
	});
}

function addMember(userId: string, role: string): void {
	members.push({
		createdAt: new Date(Date.UTC(2026, 0, members.length + 1)),
		organizationId: ORG_ID,
		role,
		userId,
	});
}

function storedKind(): string | null {
	return kindModule.organizationKindFromMetadata(
		organizations.get(ORG_ID)?.metadata
	);
}

beforeEach(() => {
	organizations.clear();
	members = [];
	metadataWrites.length = 0;
	interleavedWrite = null;
	placeCalls.length = 0;
	placeClaimWins = true;
	placeSettleFails = false;
});

describe("readOrganizationKind", () => {
	it("reads the stored kind and treats missing or malformed ids as unknown", async () => {
		storeOrganization("family");
		expect(await kindModule.readOrganizationKind(ORG_ID)).toBe("family");
		expect(
			await kindModule.readOrganizationKind("64b000000000000000000002")
		).toBeNull();
		expect(await kindModule.readOrganizationKind("org_symbolic")).toBeNull();
	});
});

describe("promoteOrganizationToFamily", () => {
	it("promotes a personal org in place and keeps its other metadata", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(true);
		expect(storedKind()).toBe("family");
		const metadata = kindModule.parseOrganizationMetadata(
			organizations.get(ORG_ID)?.metadata
		);
		expect(metadata.source).toBe("signup");
		expect(typeof metadata.familySharingEnabledAt).toBe("string");
	});

	it("promotes a legacy org with no kind marker", async () => {
		storeOrganization();
		addMember(USER_ID, "owner");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(true);
		expect(storedKind()).toBe("family");
	});

	it("refuses an org that already holds other people or no one at all", async () => {
		storeOrganization();
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		addMember(USER_ID, "owner");
		addMember("64b0000000000000000000bb", "viewer");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		expect(storedKind()).toBeNull();
		expect(metadataWrites).toEqual([]);
	});

	it("loses to a concurrent Teams promotion instead of overwriting it", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		interleavedWrite = () => storeOrganization("teams");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		expect(storedKind()).toBe("teams");
		expect(metadataWrites).toEqual([]);
	});

	it("is idempotent for a family without rewriting it", async () => {
		storeOrganization("family");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(true);
		expect(metadataWrites).toEqual([]);
	});

	it("never turns a Teams org into a family", async () => {
		storeOrganization("teams");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		expect(storedKind()).toBe("teams");
		expect(metadataWrites).toEqual([]);
	});

	it("reports a completed promotion even when confirming the owner's place fails", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		placeSettleFails = true;
		const consoleError = spyOn(console, "error").mockImplementation(() => {
			// Expected: the failed confirmation is logged, not thrown.
		});
		try {
			// The kind write happened, so the caller must see the enable and run
			// its post-enable work; the claimed place still holds the cap and the
			// owner's next claim confirms it from their real membership.
			expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(true);
			expect(consoleError).toHaveBeenCalledTimes(1);
		} finally {
			consoleError.mockRestore();
		}
		expect(storedKind()).toBe("family");
		expect(placeCalls).toEqual([
			`claim:${USER_ID}:${ORG_ID}`,
			`confirm:${USER_ID}`,
		]);
	});

	it("still refuses when releasing a refused enable's place fails", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		interleavedWrite = () => storeOrganization("teams");
		placeSettleFails = true;
		const consoleError = spyOn(console, "error").mockImplementation(() => {
			// Expected: the claim expires on its own.
		});
		try {
			expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
		expect(storedKind()).toBe("teams");
		expect(placeCalls).toEqual([
			`claim:${USER_ID}:${ORG_ID}`,
			`release:${USER_ID}:reserved`,
		]);
	});

	it("refuses unknown and symbolic organization ids", async () => {
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		expect(await kindModule.promoteOrganizationToFamily("org_symbolic")).toBe(
			false
		);
	});
});

describe("revertFamilyOrganizationToPersonal", () => {
	it("restores personal once the owner is the only member", async () => {
		storeOrganization("family");
		addMember(USER_ID, "owner");
		expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
			true
		);
		expect(storedKind()).toBe("personal");
	});

	it("refuses while other family members remain", async () => {
		storeOrganization("family");
		addMember(USER_ID, "owner");
		addMember("64b0000000000000000000bb", "member");
		expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
			false
		);
		expect(storedKind()).toBe("family");
	});

	it("refuses an org with no members at all", async () => {
		storeOrganization("family");
		expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
			false
		);
	});

	it("refuses an org that is not a family", async () => {
		for (const kind of ["teams", "personal", undefined]) {
			storeOrganization(kind);
			members = [];
			addMember(USER_ID, "owner");
			expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
				false
			);
		}
		expect(metadataWrites).toEqual([]);
	});
});

describe("Teams promotion around a family", () => {
	it("leaves a family org alone on a business-email change", async () => {
		storeOrganization("family");
		addMember(USER_ID, "owner");
		expect(
			await kindModule.promotePersonalOrganizationForBusinessEmail(
				USER_ID,
				"owner@acme-industries.example"
			)
		).toBe(false);
		expect(storedKind()).toBe("family");
	});

	it("still promotes a personal org on a business-email change", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		expect(
			await kindModule.promotePersonalOrganizationForBusinessEmail(
				USER_ID,
				"owner@acme-industries.example"
			)
		).toBe(true);
		expect(storedKind()).toBe("teams");
	});

	it("never overwrites a family that landed after the Teams writer read", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		interleavedWrite = () => storeOrganization("family");
		expect(
			await kindModule.promotePersonalOrganizationForBusinessEmail(
				USER_ID,
				"owner@acme-industries.example"
			)
		).toBe(false);
		expect(storedKind()).toBe("family");
	});

	it("ignores a stray Teams subscription event for a family org", async () => {
		storeOrganization("family");
		expect(await kindModule.promoteOrganizationToTeams(ORG_ID)).toBe(false);
		expect(storedKind()).toBe("family");
	});
});

describe("the authoritative kind field", () => {
	it("is written with the metadata kind and wins over stale metadata", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(true);
		expect(organizations.get(ORG_ID)?.organizationKind).toBe("family");

		// A Better Auth organization update that read metadata before the enable
		// writes it back afterwards: the metadata kind regresses, the field not.
		const stale = JSON.stringify({ organizationKind: "personal", note: "x" });
		organizations.set(ORG_ID, {
			...organizations.get(ORG_ID),
			metadata: stale,
		});
		expect(storedKind()).toBe("personal");
		expect(await kindModule.readOrganizationKind(ORG_ID)).toBe("family");

		expect(await kindModule.reconcileOrganizationKindMetadata(ORG_ID)).toBe(
			true
		);
		expect(storedKind()).toBe("family");
		expect(
			kindModule.parseOrganizationMetadata(organizations.get(ORG_ID)?.metadata)
				.note
		).toBe("x");
		expect(await kindModule.reconcileOrganizationKindMetadata(ORG_ID)).toBe(
			false
		);
	});

	it("lets a disable win over metadata a stale update wrote back as family", async () => {
		storeOrganization("family");
		addMember(USER_ID, "owner");
		organizations.set(ORG_ID, {
			...organizations.get(ORG_ID),
			organizationKind: "family",
		});
		expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
			true
		);
		organizations.set(ORG_ID, {
			...organizations.get(ORG_ID),
			metadata: JSON.stringify({ organizationKind: "family" }),
		});
		expect(await kindModule.readOrganizationKind(ORG_ID)).toBe("personal");
		// The disable path's own re-check reads the field, not the stale metadata.
		expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
			false
		);
		expect(await kindModule.reconcileOrganizationKindMetadata(ORG_ID)).toBe(
			true
		);
		expect(storedKind()).toBe("personal");
	});

	it("does not overwrite an update that lands during the repair", async () => {
		storeOrganization("personal");
		organizations.set(ORG_ID, {
			metadata: JSON.stringify({ organizationKind: "personal" }),
			organizationKind: "family",
		});
		let concurrentWrites = 0;
		const concurrent = () => {
			concurrentWrites += 1;
			organizations.set(ORG_ID, {
				metadata: JSON.stringify({
					organizationKind: "personal",
					rename: concurrentWrites,
				}),
				organizationKind: "family",
			});
		};
		interleavedWrite = concurrent;
		expect(await kindModule.reconcileOrganizationKindMetadata(ORG_ID)).toBe(
			true
		);
		const metadata = kindModule.parseOrganizationMetadata(
			organizations.get(ORG_ID)?.metadata
		);
		expect(metadata.organizationKind).toBe("family");
		expect(metadata.rename).toBe(1);
	});

	it("prefers the field over metadata when reading a record", () => {
		expect(
			kindModule.organizationKindFromRecord({
				metadata: JSON.stringify({ organizationKind: "personal" }),
				organizationKind: "family",
			})
		).toBe("family");
		expect(
			kindModule.organizationKindFromRecord({
				metadata: JSON.stringify({ organizationKind: "teams" }),
				organizationKind: "bogus",
			})
		).toBe("teams");
		expect(kindModule.organizationKindFromRecord(null)).toBeNull();
	});
});

describe("the owner's family place", () => {
	it("is claimed before the enable and confirmed after it", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(true);
		expect(placeCalls).toEqual([
			`claim:${USER_ID}:${ORG_ID}`,
			`confirm:${USER_ID}`,
		]);
	});

	it("refuses the enable without writing when the owner has no place left", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		placeClaimWins = false;
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		expect(storedKind()).toBe("personal");
		expect(metadataWrites).toEqual([]);
	});

	it("is given back when the enable loses its compare-and-set", async () => {
		storeOrganization("personal");
		addMember(USER_ID, "owner");
		interleavedWrite = () => storeOrganization("teams");
		expect(await kindModule.promoteOrganizationToFamily(ORG_ID)).toBe(false);
		expect(placeCalls).toEqual([
			`claim:${USER_ID}:${ORG_ID}`,
			`release:${USER_ID}:reserved`,
		]);
	});

	it("is released with the family, keeping in-flight claims", async () => {
		storeOrganization("family");
		addMember(USER_ID, "owner");
		expect(await kindModule.revertFamilyOrganizationToPersonal(ORG_ID)).toBe(
			true
		);
		expect(placeCalls).toEqual([`release-org:${ORG_ID}:confirmed`]);
	});
});
