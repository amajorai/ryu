import { describe, expect, it } from "bun:test";
import {
	FAMILY_OWNER_FIXED_MESSAGE,
	FAMILY_OWNER_LEAVE_MESSAGE,
	FAMILY_ROLE_REFUSED_MESSAGE,
} from "./family-admission.ts";
import {
	PRIMARY_OWNER_GUARD_NO_SESSION_MESSAGE,
	type PrimaryOwnerLookups,
	primaryOwnerHookDecision,
	primaryOwnerRefusalForRequest,
} from "./primary-owner-guard.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";

const ORG = "org-1";

interface GuardBody {
	email?: string;
	memberId?: string;
	memberIdOrEmail?: string;
	organizationId?: string;
	role?: string | string[];
}
const members = [
	{ id: "m-primary", userId: "primary", role: "owner" },
	{ id: "m-owner", userId: "co-owner", role: "owner" },
	{ id: "m-admin", userId: "admin", role: "admin" },
	{ id: "m-member", userId: "member", role: "member" },
	{ id: "m-billing", userId: "biller", role: "member,billing" },
];

const lookups: PrimaryOwnerLookups = {
	findMemberById: async (memberId) => {
		const row = members.find((member) => member.id === memberId);
		return row ? { ...row, organizationId: ORG } : null;
	},
	findMemberByEmail: async (_org, email) => {
		const row = members.find((member) => `${member.userId}@x.test` === email);
		return row ? { ...row, organizationId: ORG } : null;
	},
	findMemberByUser: async (_org, userId) => {
		const row = members.find((member) => member.userId === userId);
		return row ? { ...row, organizationId: ORG } : null;
	},
	primaryOwnerUserId: async () => "primary",
};

function check(actorUserId: string, path: string, body: GuardBody) {
	return primaryOwnerRefusalForRequest(
		{ activeOrganizationId: ORG, actorUserId, body, path },
		lookups
	);
}

describe("organization role-ladder guard", () => {
	it("ignores unrelated routes", async () => {
		expect(await check("member", "/organization/update", {})).toBeNull();
	});

	it("protects the primary owner from other owners", async () => {
		expect(
			await check("co-owner", "/organization/update-member-role", {
				memberId: "m-primary",
				role: "admin",
			})
		).toContain("primary owner");
		expect(
			await check("co-owner", "/organization/remove-member", {
				memberIdOrEmail: "primary@x.test",
			})
		).toContain("primary owner");
		expect(
			await check("co-owner", "/organization/delete", { organizationId: ORG })
		).toContain("primary owner");
		expect(
			await check("primary", "/organization/leave", { organizationId: ORG })
		).toContain("Transfer");
	});

	it("reserves granting the owner role to the primary owner", async () => {
		expect(
			await check("co-owner", "/organization/update-member-role", {
				memberId: "m-admin",
				role: ["owner"],
			})
		).not.toBeNull();
		expect(
			await check("primary", "/organization/update-member-role", {
				memberId: "m-admin",
				role: ["owner"],
			})
		).toBeNull();
		expect(
			await check("co-owner", "/organization/invite-member", {
				email: "new@x.test",
				role: "owner",
			})
		).not.toBeNull();
	});

	it("only billing managers grant the billing role", async () => {
		// Admins do not manage billing, so they cannot hand it out either.
		expect(
			await check("admin", "/organization/invite-member", {
				email: "new@x.test",
				role: "billing",
			})
		).toContain("billing");
		expect(
			await check("admin", "/organization/update-member-role", {
				memberId: "m-member",
				role: "member,billing",
			})
		).toContain("billing");
		// A member (e.g. holding a Better Auth dynamic role) cannot hand it out.
		expect(
			await check("member", "/organization/update-member-role", {
				memberId: "m-member",
				role: "member,billing",
			})
		).toContain("billing");
		expect(
			await check("member", "/organization/invite-member", {
				email: "new@x.test",
				role: "billing",
			})
		).toContain("billing");
		expect(
			await check("biller", "/organization/update-member-role", {
				memberId: "m-member",
				role: "member,billing",
			})
		).toBeNull();
		expect(
			await check("co-owner", "/organization/update-member-role", {
				memberId: "m-member",
				role: "billing",
			})
		).toBeNull();
		// Keeping an existing billing role is not a new grant.
		expect(
			await check("admin", "/organization/update-member-role", {
				memberId: "m-billing",
				role: "viewer,billing",
			})
		).toBeNull();
	});

	describe("in a family workspace", () => {
		// The family owner is the primary owner; the family has one owner.
		const familyMembers = [
			{ id: "f-owner", userId: "family-owner", role: "owner" },
			{ id: "f-organizer", userId: "organizer", role: "admin" },
			{ id: "f-kid", userId: "kid", role: "member" },
		];
		const findFamily = (
			predicate: (row: (typeof familyMembers)[number]) => boolean
		) => {
			const row = familyMembers.find(predicate);
			return row ? { ...row, organizationId: ORG } : null;
		};
		const familyLookups: PrimaryOwnerLookups = {
			findMemberById: async (memberId) =>
				findFamily((row) => row.id === memberId),
			findMemberByEmail: async (_org, email) =>
				findFamily((row) => `${row.userId}@x.test` === email),
			findMemberByUser: async (_org, userId) =>
				findFamily((row) => row.userId === userId),
			isFamilyOrganization: async () => true,
			primaryOwnerUserId: async () => "family-owner",
		};
		const checkFamily = (actorUserId: string, path: string, body: GuardBody) =>
			primaryOwnerRefusalForRequest(
				{ activeOrganizationId: ORG, actorUserId, body, path },
				familyLookups
			);

		it("keeps the family owner fixed, in family copy", async () => {
			expect(
				await checkFamily("organizer", "/organization/remove-member", {
					memberIdOrEmail: "family-owner@x.test",
				})
			).toBe(FAMILY_OWNER_FIXED_MESSAGE);
			expect(
				await checkFamily("family-owner", "/organization/update-member-role", {
					memberId: "f-owner",
					role: "admin",
				})
			).toBe(FAMILY_OWNER_FIXED_MESSAGE);
			expect(
				await checkFamily("family-owner", "/organization/leave", {
					organizationId: ORG,
				})
			).toBe(FAMILY_OWNER_LEAVE_MESSAGE);
		});

		it("answers owner and billing grants with the family role copy", async () => {
			expect(
				await checkFamily("organizer", "/organization/update-member-role", {
					memberId: "f-kid",
					role: "owner",
				})
			).toBe(FAMILY_ROLE_REFUSED_MESSAGE);
			expect(
				await checkFamily("organizer", "/organization/invite-member", {
					email: "new@x.test",
					role: "owner",
				})
			).toBe(FAMILY_ROLE_REFUSED_MESSAGE);
			expect(
				await checkFamily("organizer", "/organization/invite-member", {
					email: "new@x.test",
					role: "billing",
				})
			).toBe(FAMILY_ROLE_REFUSED_MESSAGE);
		});

		it("leaves allowed family changes to the family admission hooks", async () => {
			expect(
				await checkFamily("organizer", "/organization/update-member-role", {
					memberId: "f-kid",
					role: "admin",
				})
			).toBeNull();
			expect(
				await checkFamily("organizer", "/organization/leave", {
					organizationId: ORG,
				})
			).toBeNull();
		});
	});
});

describe("organization role-ladder hook (bearer callers)", () => {
	// Desktop, CLI and Expo send only `Authorization: Bearer <session token>`.
	// The config-level hook runs before the bearer plugin's cookie rewrite, so
	// the ladder must resolve the actor from the header itself.
	const sessionsByToken = new Map(
		["primary", "co-owner", "admin"].map((userId) => [
			`tok-${userId}`,
			{
				session: {
					activeOrganizationId: ORG,
					expiresAt: new Date(Date.now() + 60_000),
					id: `s-${userId}`,
					token: `tok-${userId}`,
					userId,
				},
				user: { id: userId },
			},
		])
	);

	function bearerOnlyDecision(userId: string, path: string, body: GuardBody) {
		const headers = new Headers({ authorization: `Bearer tok-${userId}` });
		const ctx = {
			context: {
				internalAdapter: {
					findSession: async (token: string) =>
						sessionsByToken.get(token) ?? null,
				},
				options: { plugins: [{ id: "bearer" }] },
				secret: "primary-owner-guard-test-secret",
				session: null,
			},
			headers,
			request: new Request(`https://auth.test/api/auth${path}`, {
				headers,
				method: "POST",
			}),
		};
		return primaryOwnerHookDecision(
			{ body, path, resolveSession: () => resolveSessionForHook(ctx) },
			lookups
		);
	}

	it("refuses a co-owner demoting, removing, out-inviting, or deleting over the primary owner", async () => {
		const cases: [string, GuardBody][] = [
			[
				"/organization/update-member-role",
				{ memberId: "m-primary", role: "member" },
			],
			["/organization/remove-member", { memberIdOrEmail: "m-primary" }],
			["/organization/invite-member", { email: "new@x.test", role: "owner" }],
			["/organization/delete", { organizationId: ORG }],
		];
		for (const [path, body] of cases) {
			const decision = await bearerOnlyDecision("co-owner", path, body);
			expect(decision?.code).toBe("FORBIDDEN");
		}
	});

	it("refuses an admin granting themselves billing", async () => {
		const decision = await bearerOnlyDecision(
			"admin",
			"/organization/update-member-role",
			{ memberId: "m-admin", role: "admin,billing" }
		);
		expect(decision?.code).toBe("FORBIDDEN");
		expect(decision?.message).toContain("billing");
	});

	it("still lets the primary owner act over bearer", async () => {
		expect(
			await bearerOnlyDecision("primary", "/organization/update-member-role", {
				memberId: "m-admin",
				role: "owner",
			})
		).toBeNull();
		expect(
			await bearerOnlyDecision("primary", "/organization/invite-member", {
				email: "new@x.test",
				role: "owner",
			})
		).toBeNull();
	});

	it("fails closed when no actor resolves", async () => {
		expect(
			await primaryOwnerHookDecision(
				{
					body: { memberId: "m-primary", role: "member" },
					path: "/organization/update-member-role",
					resolveSession: async () => null,
				},
				lookups
			)
		).toEqual({
			code: "UNAUTHORIZED",
			message: PRIMARY_OWNER_GUARD_NO_SESSION_MESSAGE,
		});
	});

	it("does not resolve a session for unguarded routes", async () => {
		let resolved = false;
		expect(
			await primaryOwnerHookDecision(
				{
					body: {},
					path: "/organization/update",
					resolveSession: async () => {
						resolved = true;
						return null;
					},
				},
				lookups
			)
		).toBeNull();
		expect(resolved).toBe(false);
	});
});
