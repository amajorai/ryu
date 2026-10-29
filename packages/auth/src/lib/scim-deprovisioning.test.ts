import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	SCIMIdentityResolutionContext,
	SCIMIdentityResolutionInput,
	SCIMTransactionContext,
} from "@better-auth/scim";
import {
	createScimMembershipProjection,
	isScimConnectionRetirement,
	reconcileScimAdminRole,
	reconcileScimMembership,
	resolveScimUser,
	runScimConnectionRetirement,
	type ScimDeprovisioningDeps,
	type ScimRemovedMember,
} from "./scim-deprovisioning.ts";

const ORG = "org-acme";
const OTHER_ORG = "org-other";

type Row = Record<string, unknown>;
interface Where {
	field: string;
	operator?: string;
	value: unknown;
}

function matches(row: Row, where: readonly Where[]): boolean {
	return where.every((clause) =>
		clause.operator === "in"
			? (clause.value as unknown[]).includes(row[clause.field])
			: row[clause.field] === clause.value
	);
}

function fakeDatabase(tables: Record<string, Row[]>) {
	const rows = (model: string) => {
		tables[model] ??= [];
		return tables[model];
	};
	const database = {
		findOne: async ({ model, where }: { model: string; where: Where[] }) =>
			rows(model).find((row) => matches(row, where)) ?? null,
		findMany: async ({ model, where }: { model: string; where: Where[] }) =>
			rows(model).filter((row) => matches(row, where)),
		delete: async ({ model, where }: { model: string; where: Where[] }) => {
			tables[model] = rows(model).filter((row) => !matches(row, where));
		},
		update: async ({
			model,
			where,
			update,
		}: {
			model: string;
			update: Row;
			where: Where[];
		}) => {
			const row = rows(model).find((candidate) => matches(candidate, where));
			if (row) {
				Object.assign(row, update);
			}
			return row ?? null;
		},
		deleteMany: async ({ model, where }: { model: string; where: Where[] }) => {
			const before = rows(model).length;
			tables[model] = rows(model).filter((row) => !matches(row, where));
			return before - tables[model].length;
		},
	};
	return database as unknown as SCIMTransactionContext["database"];
}

function seed(): Record<string, Row[]> {
	return {
		member: [
			{ id: "m-ada", organizationId: ORG, role: "member", userId: "u-ada" },
			{
				id: "m-ada-other",
				organizationId: OTHER_ORG,
				role: "admin",
				userId: "u-ada",
			},
			{ id: "m-root", organizationId: ORG, role: "owner", userId: "u-root" },
			{ id: "m-co", organizationId: ORG, role: "admin,owner", userId: "u-co" },
		],
		team: [
			{ id: "t-eng", organizationId: ORG },
			{ id: "t-other", organizationId: OTHER_ORG },
		],
		teamMember: [
			{ id: "tm-1", teamId: "t-eng", userId: "u-ada" },
			{ id: "tm-2", teamId: "t-other", userId: "u-ada" },
			{ id: "tm-3", teamId: "t-eng", userId: "u-root" },
		],
	};
}

function deps() {
	const removed: ScimRemovedMember[] = [];
	const queued: (() => Promise<void>)[] = [];
	const value: ScimDeprovisioningDeps = {
		afterMemberRemoved: async (input) => {
			removed.push(input);
		},
		queueAfterCommit: async (hook) => {
			queued.push(hook);
		},
	};
	return { queued, removed, value };
}

function source(active: boolean, connectionId = "conn-new") {
	return {
		active,
		connectionId,
		id: `s-${connectionId}`,
		provisioningDomainId: ORG,
	};
}

describe("reconcileScimMembership", () => {
	it("removes the membership and the org's team rows when the directory deactivates the user", async () => {
		const tables = seed();
		const hooks = deps();
		const result = await reconcileScimMembership(
			{
				active: false,
				provisioningDomainId: ORG,
				sources: [source(false)],
				userId: "u-ada",
			},
			{ database: fakeDatabase(tables) },
			hooks.value
		);
		expect(result?.memberId).toBe("m-ada");
		expect(tables.member?.map((row) => row.id)).toEqual([
			"m-ada-other",
			"m-root",
			"m-co",
		]);
		// Only this organization's team rows go; the other org is untouched.
		expect(tables.teamMember?.map((row) => row.id)).toEqual(["tm-2", "tm-3"]);
		// The member-exit cleanup and audit run only after the commit.
		expect(hooks.removed).toEqual([]);
		expect(hooks.queued).toHaveLength(1);
		await hooks.queued[0]?.();
		expect(hooks.removed).toEqual([
			{
				memberId: "m-ada",
				organizationId: ORG,
				role: "member",
				userId: "u-ada",
			},
		]);
	});

	it("removes the membership after the directory deletes the user's last source", async () => {
		const tables = seed();
		tables.scimUser = [];
		const hooks = deps();
		const result = await reconcileScimMembership(
			{
				active: false,
				provisioningDomainId: ORG,
				sources: [],
				userId: "u-ada",
			},
			{ database: fakeDatabase(tables) },
			hooks.value
		);
		expect(result?.memberId).toBe("m-ada");
		expect(tables.member?.some((row) => row.id === "m-ada")).toBe(false);
	});

	it("ignores a revoked connection's stale active row once a replacement connection deactivates the user", async () => {
		const tables = seed();
		// The retired connection's row stays active forever; the plugin leaves it
		// out of `sources` because that connection is decommissioned.
		tables.scimUser = [
			{ ...source(true, "conn-old"), userId: "u-ada" },
			{ ...source(false, "conn-new"), userId: "u-ada" },
		];
		const hooks = deps();
		const result = await reconcileScimMembership(
			{
				active: false,
				provisioningDomainId: ORG,
				sources: [source(false, "conn-new")],
				userId: "u-ada",
			},
			{ database: fakeDatabase(tables) },
			hooks.value
		);
		expect(result?.memberId).toBe("m-ada");
		expect(tables.member?.some((row) => row.id === "m-ada")).toBe(false);
	});

	it("removes the membership when a replacement connection deletes the user despite a revoked connection's stale row", async () => {
		const tables = seed();
		tables.scimUser = [{ ...source(true, "conn-old"), userId: "u-ada" }];
		const hooks = deps();
		const result = await reconcileScimMembership(
			{
				active: false,
				provisioningDomainId: ORG,
				sources: [],
				userId: "u-ada",
			},
			{ database: fakeDatabase(tables) },
			hooks.value
		);
		expect(result?.memberId).toBe("m-ada");
	});

	it("keeps the membership while an admin revokes the connection that was the user's only source", async () => {
		const tables = seed();
		const hooks = deps();
		const result = await runScimConnectionRetirement(() =>
			reconcileScimMembership(
				{
					active: false,
					provisioningDomainId: ORG,
					sources: [],
					userId: "u-ada",
				},
				{ database: fakeDatabase(tables) },
				hooks.value
			)
		);
		expect(result).toBeNull();
		expect(tables.member).toHaveLength(4);
		expect(hooks.queued).toHaveLength(0);
		expect(isScimConnectionRetirement()).toBe(false);
	});

	it("still removes, during a revocation replay, a user another connection deactivated", async () => {
		const tables = seed();
		const hooks = deps();
		const result = await runScimConnectionRetirement(() =>
			reconcileScimMembership(
				{
					active: false,
					provisioningDomainId: ORG,
					sources: [source(false)],
					userId: "u-ada",
				},
				{ database: fakeDatabase(tables) },
				hooks.value
			)
		);
		expect(result?.memberId).toBe("m-ada");
	});

	it("keeps the membership while the user still has an active source", async () => {
		const tables = seed();
		const hooks = deps();
		const result = await reconcileScimMembership(
			{
				active: true,
				provisioningDomainId: ORG,
				sources: [source(true), source(false, "conn-other")],
				userId: "u-ada",
			},
			{ database: fakeDatabase(tables) },
			hooks.value
		);
		expect(result).toBeNull();
		expect(tables.member).toHaveLength(4);
		expect(hooks.queued).toHaveLength(0);
	});

	it("does nothing for a user who is not a member of the connection's organization", async () => {
		const tables = seed();
		const hooks = deps();
		const result = await reconcileScimMembership(
			{
				active: false,
				provisioningDomainId: ORG,
				sources: [source(false)],
				userId: "u-nobody",
			},
			{ database: fakeDatabase(tables) },
			hooks.value
		);
		expect(result).toBeNull();
		expect(tables.member).toHaveLength(4);
		expect(hooks.queued).toHaveLength(0);
	});

	it("never removes an owner, primary or not, and does not fail the SCIM write", async () => {
		for (const userId of ["u-co", "u-root"]) {
			const tables = seed();
			const hooks = deps();
			const result = await reconcileScimMembership(
				{
					active: false,
					provisioningDomainId: ORG,
					sources: [source(false)],
					userId,
				},
				{ database: fakeDatabase(tables) },
				hooks.value
			);
			expect(result).toBeNull();
			expect(tables.member).toHaveLength(4);
			expect(tables.teamMember).toHaveLength(3);
			expect(hooks.queued).toHaveLength(0);
		}
	});
});

function resolutionInput(email: string): SCIMIdentityResolutionInput {
	return {
		connectionId: "conn-1",
		provisioningDomainId: ORG,
		resource: {
			active: true,
			displayName: "Ada",
			emails: [],
			name: {},
			primaryEmail: email,
			schemas: [],
			userName: email,
		},
	} as unknown as SCIMIdentityResolutionInput;
}

function resolutionTables(overrides: {
	domainVerified?: boolean;
	emailVerified?: boolean;
	member?: boolean;
}): Record<string, Row[]> {
	return {
		member: [
			...(overrides.member === false
				? []
				: [
						{
							id: "m-ada",
							organizationId: ORG,
							role: "member",
							userId: "u-ada",
						},
					]),
			// Eve is a member, but her email is on another org's verified domain.
			{ id: "m-eve", organizationId: ORG, role: "member", userId: "u-eve" },
		],
		ssoProvider: [
			{
				domain: "acme.com, acme.io",
				domainVerified: overrides.domainVerified ?? true,
				organizationId: ORG,
			},
			{ domain: "evil.com", domainVerified: true, organizationId: OTHER_ORG },
		],
		user: [
			{
				email: "ada@acme.com",
				emailVerified: overrides.emailVerified ?? true,
				id: "u-ada",
			},
			{ email: "eve@evil.com", emailVerified: true, id: "u-eve" },
		],
	};
}

function resolutionContext(
	tables: Record<string, Row[]>
): SCIMIdentityResolutionContext {
	return { database: fakeDatabase(tables) };
}

describe("resolveScimUser", () => {
	it("links a verified member on the organization's verified SSO domain without managing their profile", async () => {
		const resolution = await resolveScimUser(
			resolutionInput("Ada@Acme.com"),
			resolutionContext(resolutionTables({}))
		);
		expect(resolution).toEqual({
			action: "link",
			profile: "preserve",
			userId: "u-ada",
		});
	});

	it("creates (and so conflicts) when the account is not a member of the organization", async () => {
		const resolution = await resolveScimUser(
			resolutionInput("ada@acme.com"),
			resolutionContext(resolutionTables({ member: false }))
		);
		expect(resolution).toEqual({ action: "create" });
	});

	it("never links an owner, so an admin's SCIM token cannot act on a co-owner", async () => {
		const tables = resolutionTables({});
		tables.member = (tables.member ?? []).map((row) =>
			row.id === "m-ada" ? { ...row, role: "admin,owner" } : row
		);
		const resolution = await resolveScimUser(
			resolutionInput("ada@acme.com"),
			resolutionContext(tables)
		);
		expect(resolution).toEqual({ action: "create" });
	});

	it("never links on an unverified email", async () => {
		const resolution = await resolveScimUser(
			resolutionInput("ada@acme.com"),
			resolutionContext(resolutionTables({ emailVerified: false }))
		);
		expect(resolution).toEqual({ action: "create" });
	});

	it("never links when the organization has not verified the email domain", async () => {
		const resolution = await resolveScimUser(
			resolutionInput("ada@acme.com"),
			resolutionContext(resolutionTables({ domainVerified: false }))
		);
		expect(resolution).toEqual({ action: "create" });
	});

	it("never links an account on another organization's verified domain", async () => {
		const resolution = await resolveScimUser(
			resolutionInput("eve@evil.com"),
			resolutionContext(resolutionTables({}))
		);
		expect(resolution).toEqual({ action: "create" });
	});
});

describe("reconcileScimAdminRole", () => {
	const ENV_KEYS = ["ADMIN_EMAILS", "WAITLIST_ENABLED"] as const;
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.ADMIN_EMAILS = "admin@ryu.example";
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
	});

	function adminTables(user: Row): Record<string, Row[]> {
		return { member: [], team: [], user: [{ id: "u-dir", ...user }] };
	}

	it("demotes an admin the directory renamed to an unverified address, inside the SCIM write", async () => {
		// A directory account whose allowlisted address the real owner verified
		// (so it earned admin), then renamed by the directory, which clears
		// `emailVerified`.
		const tables = adminTables({
			email: "attacker@acme.com",
			emailVerified: false,
			role: "admin",
		});
		const hooks = deps();
		await createScimMembershipProjection(hooks.value).reconcileUser(
			{
				active: true,
				grants: [],
				provisioningDomainId: ORG,
				sources: [source(true)],
				userId: "u-dir",
			},
			{ database: fakeDatabase(tables) }
		);
		expect(tables.user?.[0]?.role).toBe("waitlist");
	});

	it("falls back to the approved role when the waitlist is bypassed", async () => {
		process.env.WAITLIST_ENABLED = "false";
		const tables = adminTables({
			email: "attacker@acme.com",
			emailVerified: false,
			role: "admin",
		});
		expect(
			await reconcileScimAdminRole(
				{ userId: "u-dir" },
				{ database: fakeDatabase(tables) }
			)
		).toBe(true);
		expect(tables.user?.[0]?.role).toBe("user");
	});

	it("leaves a verified admin and a non-admin alone", async () => {
		const verified = adminTables({
			email: "admin@ryu.example",
			emailVerified: true,
			role: "admin",
		});
		expect(
			await reconcileScimAdminRole(
				{ userId: "u-dir" },
				{ database: fakeDatabase(verified) }
			)
		).toBe(false);
		expect(verified.user?.[0]?.role).toBe("admin");

		const member = adminTables({
			email: "ada@acme.com",
			emailVerified: false,
			role: "waitlist",
		});
		expect(
			await reconcileScimAdminRole(
				{ userId: "u-dir" },
				{ database: fakeDatabase(member) }
			)
		).toBe(false);
		expect(member.user?.[0]?.role).toBe("waitlist");
	});
});
