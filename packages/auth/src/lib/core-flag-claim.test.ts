import { describe, expect, it } from "bun:test";

import {
	type CoreFlagClaimSubject,
	registerCoreFlagClaimResolver,
	resolveCoreFlagClaim,
	selectCoreFlagClaimOrganization,
	withCoreFlagClaim,
} from "./core-flag-claim.ts";
import {
	CLOUD_TASKS_BOX_BACKEND_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG,
	CORE_FLAG_CLAIM,
	CORE_FLAG_ORG_CLAIM,
	coreClaimFlagKeys,
	coreFlagClaimFromValues,
	INDIVIDUAL_PLANS_FLAG,
} from "./feature-flags.ts";

/**
 * The JWT payload builder for the signed Core flag claim. The resolver slot
 * is module state, so the unregistered case is asserted first.
 */
const NONE = { keys: [], organizationId: null };

const USER = {
	id: "user_1",
	email: "root@ryu.test",
	emailVerified: true,
	isAnonymous: false,
	role: "user",
	name: "Root",
};

describe("resolveCoreFlagClaim", () => {
	it("omits every flag when no evaluator is registered", async () => {
		expect(await resolveCoreFlagClaim(USER)).toEqual(NONE);
	});

	it("passes the parsed subject and keeps only enabled coreClaim keys", async () => {
		const seen: CoreFlagClaimSubject[] = [];
		registerCoreFlagClaimResolver(async (subject) => {
			seen.push(subject);
			return {
				[CLOUD_TASKS_BOX_BACKEND_FLAG]: true,
				// Enabled, but not a coreClaim flag: never widens the token.
				[INDIVIDUAL_PLANS_FLAG]: true,
			};
		});
		expect(await resolveCoreFlagClaim(USER)).toEqual({
			keys: [CLOUD_TASKS_BOX_BACKEND_FLAG],
			organizationId: null,
		});
		expect(seen).toEqual([
			{
				email: "root@ryu.test",
				emailVerified: true,
				id: "user_1",
				isAnonymous: false,
				organizationId: null,
				orgMemberRole: null,
				role: "user",
			},
		]);
	});

	it("passes the evaluated org and the caller's role in it", async () => {
		const seen: CoreFlagClaimSubject[] = [];
		registerCoreFlagClaimResolver(async (subject) => {
			seen.push(subject);
			// Stand-in for an org_admin-targeted rule.
			return {
				[CLOUD_TASKS_BOX_BACKEND_FLAG]:
					subject.organizationId === "org_a" &&
					subject.orgMemberRole === "admin",
			};
		});
		expect(
			await resolveCoreFlagClaim(USER, { id: "org_a", role: "admin" })
		).toEqual({
			keys: [CLOUD_TASKS_BOX_BACKEND_FLAG],
			organizationId: "org_a",
		});
		expect(
			await resolveCoreFlagClaim(USER, { id: "org_b", role: "member" })
		).toEqual({ keys: [], organizationId: "org_b" });
		expect(
			seen.map(({ organizationId, orgMemberRole }) => ({
				organizationId,
				orgMemberRole,
			}))
		).toEqual([
			{ organizationId: "org_a", orgMemberRole: "admin" },
			{ organizationId: "org_b", orgMemberRole: "member" },
		]);
	});

	it("fails closed when the evaluator throws", async () => {
		registerCoreFlagClaimResolver(() =>
			Promise.reject(new Error("database down"))
		);
		expect(
			await resolveCoreFlagClaim(USER, { id: "org_a", role: "owner" })
		).toEqual(NONE);
	});

	it("fails closed when the evaluator stalls past the bound", async () => {
		registerCoreFlagClaimResolver(
			() =>
				new Promise((resolve) => {
					setTimeout(
						() => resolve({ [CLOUD_TASKS_BOX_BACKEND_FLAG]: true }),
						200
					);
				})
		);
		expect(
			await resolveCoreFlagClaim(USER, { id: "org_a", role: "admin" }, 10)
		).toEqual(NONE);
	});

	it("omits a key whose value is not exactly true", async () => {
		registerCoreFlagClaimResolver(async () => ({
			[CLOUD_TASKS_BOX_BACKEND_FLAG]: "true",
		}));
		expect((await resolveCoreFlagClaim(USER)).keys).toEqual([]);
	});

	it("does not evaluate a user without an id", async () => {
		let called = false;
		registerCoreFlagClaimResolver(async () => {
			called = true;
			return { [CLOUD_TASKS_BOX_BACKEND_FLAG]: true };
		});
		expect(await resolveCoreFlagClaim({ email: "x@ryu.test" })).toEqual(NONE);
		expect(called).toBe(false);
		registerCoreFlagClaimResolver(null);
	});
});

describe("selectCoreFlagClaimOrganization", () => {
	const memberships = [
		{ createdAt: new Date("2026-03-01"), id: "org_team", role: "admin" },
		{ createdAt: new Date("2026-01-01"), id: "org_personal", role: "owner" },
		{ createdAt: null, id: "org_undated", role: "member" },
	];

	it("uses the active org when the user is a member of it", () => {
		expect(selectCoreFlagClaimOrganization("org_team", memberships)).toEqual({
			id: "org_team",
			role: "admin",
		});
	});

	it("follows an org switch", () => {
		expect(selectCoreFlagClaimOrganization("org_undated", memberships)).toEqual(
			{ id: "org_undated", role: "member" }
		);
	});

	it("falls back to the earliest membership, like resolveActiveOrgId", () => {
		const earliest = { id: "org_personal", role: "owner" };
		expect(selectCoreFlagClaimOrganization(null, memberships)).toEqual(
			earliest
		);
		// An active org the user does not belong to is ignored.
		expect(selectCoreFlagClaimOrganization("org_foreign", memberships)).toEqual(
			earliest
		);
	});

	it("is null for a user in no org", () => {
		expect(selectCoreFlagClaimOrganization("org_team", [])).toBeNull();
	});
});

describe("withCoreFlagClaim", () => {
	it("adds the claim only when a flag is enabled", () => {
		const payload = { id: "user_1", email: "root@ryu.test", orgs: [] };
		expect(
			withCoreFlagClaim(payload, { keys: [], organizationId: "org_a" })
		).toEqual(payload);
		expect(
			withCoreFlagClaim(payload, {
				keys: [CLOUD_TASKS_BOX_BACKEND_FLAG],
				organizationId: "org_a",
			})
		).toEqual({
			...payload,
			[CORE_FLAG_CLAIM]: [CLOUD_TASKS_BOX_BACKEND_FLAG],
			[CORE_FLAG_ORG_CLAIM]: "org_a",
		});
		expect(
			withCoreFlagClaim(payload, {
				keys: [CLOUD_TASKS_BOX_BACKEND_FLAG],
				organizationId: null,
			})
		).toEqual({
			...payload,
			[CORE_FLAG_CLAIM]: [CLOUD_TASKS_BOX_BACKEND_FLAG],
			[CORE_FLAG_ORG_CLAIM]: null,
		});
	});

	it("uses the wire names Core parses", () => {
		expect(CORE_FLAG_CLAIM).toBe("ryu_flags");
		expect(CORE_FLAG_ORG_CLAIM).toBe("ryu_flags_org");
	});
});

describe("catalog", () => {
	it("marks exactly the Core-enforced rollout flags for the claim", () => {
		expect(coreClaimFlagKeys()).toEqual([
			CLOUD_TASKS_BOX_BACKEND_FLAG,
			CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
			CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG,
		]);
		expect(coreFlagClaimFromValues({})).toEqual([]);
	});
});
