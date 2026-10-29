import { describe, expect, it, mock } from "bun:test";
import {
	disableBotGrantsOnFamilyKindChange,
	disableFamilyBotGrantsOnMemberExit,
	disableLinkedBotGrantsOutsideMembership,
	type FamilyBotGrantDeps,
	type FamilyBotGrantRow,
	type FamilyBotGrantStore,
	familyBotGrantLimit,
	surplusFamilyBotGrantIds,
} from "./family-bot-grants.ts";
import type { OrganizationKind } from "./organization-kind.ts";

const FAMILY = "0000000000000000000000f1";
const OWNER = "0000000000000000000000b1";
const KID = "0000000000000000000000b2";
const SPOUSE = "0000000000000000000000b5";

interface Grant {
	createdAt?: Date | null;
	enabled: boolean;
	id?: string;
	organizationId: string;
	ryuUserId: string | null;
}

function grantId(grant: Grant, index: number): string {
	return grant.id ?? `grant-${index}`;
}

/** In-memory members and grants behind the module's injected seams. */
function fixture(input: {
	grants: Grant[];
	kind: OrganizationKind | null;
	members: string[];
}) {
	const disableLinkedGrantsOutside = mock<
		FamilyBotGrantStore["disableLinkedGrantsOutside"]
	>(async ({ memberUserIds, organizationId }) => {
		let changed = 0;
		for (const grant of input.grants) {
			if (
				grant.enabled &&
				grant.organizationId === organizationId &&
				grant.ryuUserId !== null &&
				!memberUserIds.includes(grant.ryuUserId)
			) {
				grant.enabled = false;
				changed += 1;
			}
		}
		return changed;
	});
	const disableGrants = mock<FamilyBotGrantStore["disableGrants"]>(
		async ({ grantIds, organizationId }) => {
			let changed = 0;
			for (const [index, grant] of input.grants.entries()) {
				if (
					grant.enabled &&
					grant.organizationId === organizationId &&
					grantIds.includes(grantId(grant, index))
				) {
					grant.enabled = false;
					changed += 1;
				}
			}
			return changed;
		}
	);
	const store: FamilyBotGrantStore = {
		disableGrants,
		disableLinkedGrantsOutside,
		enabledGrants: async (organizationId) =>
			input.grants.flatMap((grant, index) =>
				grant.enabled && grant.organizationId === organizationId
					? [
							{
								createdAt: grant.createdAt ?? null,
								id: grantId(grant, index),
								ryuUserId: grant.ryuUserId,
							},
						]
					: []
			),
		memberUserIds: async () => [...input.members],
	};
	const guardedOrganizations: string[] = [];
	const deps: FamilyBotGrantDeps = {
		readOrganizationKind: async () => input.kind,
		withChannelUserGuard: async (organizationId, work) => {
			guardedOrganizations.push(organizationId);
			return await work(store);
		},
	};
	return {
		deps,
		guardedOrganizations,
		store,
		disableGrants,
		disableLinkedGrantsOutside,
		grants: input.grants,
	};
}

describe("disableFamilyBotGrantsOnMemberExit", () => {
	it("disables the departed member's linked grant on a family bot", async () => {
		const { deps, grants, guardedOrganizations } = fixture({
			grants: [
				{ enabled: true, organizationId: FAMILY, ryuUserId: KID },
				{ enabled: true, organizationId: FAMILY, ryuUserId: OWNER },
				// Admin-made grants carry no Ryu account and stay on.
				{ enabled: true, organizationId: FAMILY, ryuUserId: null },
			],
			kind: "family",
			// The kid already left: the owner and spouse remain.
			members: [OWNER, SPOUSE],
		});
		const changed = await disableFamilyBotGrantsOnMemberExit(
			{ organizationId: FAMILY, userId: KID },
			deps
		);
		expect(changed).toBe(1);
		expect(grants.map((grant) => grant.enabled)).toEqual([false, true, true]);
		// The sweep runs under the org's channel-user guard, like an enable.
		expect(guardedOrganizations).toEqual([FAMILY]);
	});

	it("also catches a grant an earlier failed sweep left enabled", async () => {
		const formerMember = "0000000000000000000000b3";
		const { deps, grants } = fixture({
			grants: [
				{ enabled: true, organizationId: FAMILY, ryuUserId: formerMember },
				{ enabled: true, organizationId: FAMILY, ryuUserId: KID },
			],
			kind: "family",
			members: [OWNER, KID],
		});
		await disableFamilyBotGrantsOnMemberExit(
			{ organizationId: FAMILY, userId: "0000000000000000000000b4" },
			deps
		);
		expect(grants.map((grant) => grant.enabled)).toEqual([false, true]);
	});

	it("disables enabled grants beyond the smaller member-based limit", async () => {
		// Five admin-made grants while five people were in the family; four
		// left, so the solo owner's family allows one channel user.
		const { deps, grants } = fixture({
			grants: [1, 2, 3, 4, 5].map((day) => ({
				createdAt: new Date(Date.UTC(2026, 0, day)),
				enabled: true,
				organizationId: FAMILY,
				ryuUserId: null,
			})),
			kind: "family",
			members: [OWNER],
		});
		expect(
			await disableFamilyBotGrantsOnMemberExit(
				{ organizationId: FAMILY, userId: KID },
				deps
			)
		).toBe(4);
		// The oldest grant keeps routing.
		expect(grants.map((grant) => grant.enabled)).toEqual([
			true,
			false,
			false,
			false,
			false,
		]);
	});

	it("keeps a current member's own grant ahead of older admin-made grants", async () => {
		const { deps, grants } = fixture({
			grants: [
				{
					createdAt: new Date(Date.UTC(2026, 0, 1)),
					enabled: true,
					organizationId: FAMILY,
					ryuUserId: null,
				},
				{
					createdAt: new Date(Date.UTC(2026, 0, 2)),
					enabled: true,
					organizationId: FAMILY,
					ryuUserId: null,
				},
				{
					createdAt: new Date(Date.UTC(2026, 0, 3)),
					enabled: true,
					organizationId: FAMILY,
					ryuUserId: OWNER,
				},
			],
			kind: "family",
			members: [OWNER, SPOUSE],
		});
		expect(
			await disableFamilyBotGrantsOnMemberExit(
				{ organizationId: FAMILY, userId: KID },
				deps
			)
		).toBe(1);
		expect(grants.map((grant) => grant.enabled)).toEqual([true, false, true]);
	});

	it("changes nothing while the family is within its limit", async () => {
		const { deps, disableGrants, grants } = fixture({
			grants: [
				{ enabled: true, organizationId: FAMILY, ryuUserId: null },
				{ enabled: true, organizationId: FAMILY, ryuUserId: SPOUSE },
			],
			kind: "family",
			members: [OWNER, SPOUSE, KID],
		});
		expect(
			await disableFamilyBotGrantsOnMemberExit(
				{ organizationId: FAMILY, userId: "0000000000000000000000b4" },
				deps
			)
		).toBe(0);
		expect(disableGrants).not.toHaveBeenCalled();
		expect(grants.every((grant) => grant.enabled)).toBe(true);
	});

	it("leaves personal and team bots alone", async () => {
		for (const kind of ["personal", "teams", null] as const) {
			const {
				deps,
				disableGrants,
				disableLinkedGrantsOutside,
				grants,
				guardedOrganizations,
			} = fixture({
				grants: [
					{ enabled: true, organizationId: FAMILY, ryuUserId: KID },
					{ enabled: true, organizationId: FAMILY, ryuUserId: null },
				],
				kind,
				members: [OWNER],
			});
			expect(
				await disableFamilyBotGrantsOnMemberExit(
					{ organizationId: FAMILY, userId: KID },
					deps
				)
			).toBe(0);
			expect(disableLinkedGrantsOutside).not.toHaveBeenCalled();
			expect(disableGrants).not.toHaveBeenCalled();
			expect(guardedOrganizations).toEqual([]);
			expect(grants.every((grant) => grant.enabled)).toBe(true);
		}
	});

	it("never throws when the database fails", async () => {
		const consoleError = mock(() => undefined);
		const originalError = console.error;
		console.error = consoleError;
		try {
			const { deps, store } = fixture({
				grants: [],
				kind: "family",
				members: [],
			});
			const failing: FamilyBotGrantDeps = {
				...deps,
				withChannelUserGuard: async (_organizationId, work) =>
					await work({
						...store,
						memberUserIds: () => Promise.reject(new Error("mongo down")),
					}),
			};
			expect(
				await disableFamilyBotGrantsOnMemberExit(
					{ organizationId: FAMILY, userId: KID },
					failing
				)
			).toBe(0);
			expect(consoleError).toHaveBeenCalledTimes(1);
		} finally {
			console.error = originalError;
		}
	});
});

describe("disableBotGrantsOnFamilyKindChange", () => {
	it("disables every non-owner's linked grant once the workspace is personal", async () => {
		const { deps, grants } = fixture({
			grants: [
				{ enabled: true, organizationId: FAMILY, ryuUserId: KID },
				{ enabled: true, organizationId: FAMILY, ryuUserId: OWNER },
			],
			// Reverted already: the kind is personal and only the owner remains.
			kind: "personal",
			members: [OWNER],
		});
		expect(await disableBotGrantsOnFamilyKindChange(FAMILY, deps)).toBe(1);
		expect(grants.map((grant) => grant.enabled)).toEqual([false, true]);
	});

	it("keeps one enabled grant once the solo owner's workspace is personal", async () => {
		const { deps, grants } = fixture({
			grants: [
				{
					createdAt: new Date(Date.UTC(2026, 0, 1)),
					enabled: true,
					organizationId: FAMILY,
					ryuUserId: null,
				},
				{
					createdAt: new Date(Date.UTC(2026, 0, 2)),
					enabled: true,
					organizationId: FAMILY,
					ryuUserId: null,
				},
				{
					createdAt: new Date(Date.UTC(2026, 0, 3)),
					enabled: true,
					organizationId: FAMILY,
					ryuUserId: null,
				},
			],
			kind: "personal",
			members: [OWNER],
		});
		expect(await disableBotGrantsOnFamilyKindChange(FAMILY, deps)).toBe(2);
		expect(grants.map((grant) => grant.enabled)).toEqual([true, false, false]);
	});

	it("never throws when the database fails", async () => {
		const originalError = console.error;
		console.error = mock(() => undefined);
		try {
			const { deps, store } = fixture({
				grants: [],
				kind: "personal",
				members: [],
			});
			const failing: FamilyBotGrantDeps = {
				...deps,
				withChannelUserGuard: async (_organizationId, work) =>
					await work({
						...store,
						disableLinkedGrantsOutside: () =>
							Promise.reject(new Error("mongo down")),
					}),
			};
			expect(await disableBotGrantsOnFamilyKindChange(FAMILY, failing)).toBe(0);
		} finally {
			console.error = originalError;
		}
	});
});

describe("disableLinkedBotGrantsOutsideMembership", () => {
	it("ignores an id that cannot be a Better Auth organization", async () => {
		const { deps, disableLinkedGrantsOutside } = fixture({
			grants: [],
			kind: "family",
			members: [],
		});
		expect(
			await disableLinkedBotGrantsOutsideMembership("not-an-org", deps)
		).toBe(0);
		expect(disableLinkedGrantsOutside).not.toHaveBeenCalled();
	});
});

describe("familyBotGrantLimit", () => {
	it("is one per member up to the family capacity", () => {
		expect(familyBotGrantLimit(0)).toBe(0);
		expect(familyBotGrantLimit(1)).toBe(1);
		expect(familyBotGrantLimit(4)).toBe(4);
		expect(familyBotGrantLimit(6)).toBe(6);
		expect(familyBotGrantLimit(9)).toBe(6);
	});
});

describe("surplusFamilyBotGrantIds", () => {
	const at = (day: number) => new Date(Date.UTC(2026, 0, day));
	const rows: FamilyBotGrantRow[] = [
		{ createdAt: null, id: "e", ryuUserId: null },
		{ createdAt: at(3), id: "d", ryuUserId: null },
		{ createdAt: at(2), id: "c", ryuUserId: null },
		{ createdAt: at(2), id: "b", ryuUserId: null },
		{ createdAt: at(9), id: "a", ryuUserId: KID },
		// Linked to someone outside the family: no member priority.
		{ createdAt: at(1), id: "f", ryuUserId: "0000000000000000000000b9" },
	];

	it("keeps member-linked, then oldest, then lowest-id grants", () => {
		expect(
			surplusFamilyBotGrantIds({
				grants: rows,
				limit: 3,
				memberUserIds: [OWNER, KID],
			})
		).toEqual(["c", "d", "e"]);
	});

	it("gives the same answer whatever order the rows arrive in", () => {
		const forward = surplusFamilyBotGrantIds({
			grants: rows,
			limit: 2,
			memberUserIds: [KID],
		});
		const backward = surplusFamilyBotGrantIds({
			grants: [...rows].reverse(),
			limit: 2,
			memberUserIds: [KID],
		});
		expect(forward).toEqual(["b", "c", "d", "e"]);
		expect(backward).toEqual(forward);
	});

	it("returns nothing within the limit and everything at zero", () => {
		expect(
			surplusFamilyBotGrantIds({ grants: rows, limit: 6, memberUserIds: [] })
		).toEqual([]);
		expect(
			surplusFamilyBotGrantIds({ grants: rows, limit: 0, memberUserIds: [] })
		).toHaveLength(rows.length);
	});
});
