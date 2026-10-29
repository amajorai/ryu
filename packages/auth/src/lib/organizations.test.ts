import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { User } from "@ryu/db/models/auth.model";
import {
	Member,
	PersonalOrganizationClaim,
} from "@ryu/db/models/control-plane.model";

import {
	cancelOrganizationInvitation,
	ensurePersonalOrganization,
	type OrganizationApi,
	type PersonalOrganizationDeps,
	resolveInitialActiveOrganization,
} from "./organizations.ts";

const headers = new Headers({ cookie: "session=test" });

/**
 * What a new session starts scoped to.
 *
 * The failure this guards against is not "the header says Select organization".
 * Org-scoped control-plane routes REFUSE a caller with no membership — the
 * credits wallet answers 409 on every request and every SSE reconnect — so a
 * session that starts unscoped is an account that cannot use the product, and
 * no client-side retry can clear it.
 *
 * The fix is an ORDER: look up, heal if empty, look up AGAIN. The second lookup
 * is the fragile half, because `ensurePersonalOrganization` reports only whether
 * it created something and never which organization, so a refactor that "returns
 * the ensure result" compiles and silently reinstates the unscoped session.
 * These cases pin the order, which is why the dependencies are injected.
 */
describe("resolveInitialActiveOrganization", () => {
	it("returns the existing membership without writing", async () => {
		let ensureCalls = 0;
		const orgId = await resolveInitialActiveOrganization({
			userId: "user_1",
			findEarliestMembership: () => Promise.resolve("org_existing"),
			ensureOrganization: () => {
				ensureCalls += 1;
				return Promise.resolve();
			},
		});

		expect(orgId).toBe("org_existing");
		// Every login runs this hook; healing an already-healthy user would put a
		// pointless write on the sign-in path.
		expect(ensureCalls).toBe(0);
	});

	it("heals a user with no membership and returns the created org", async () => {
		const lookups: string[] = [];
		let created = false;
		const orgId = await resolveInitialActiveOrganization({
			userId: "user_2",
			findEarliestMembership: (userId) => {
				lookups.push(userId);
				return Promise.resolve(created ? "org_personal" : null);
			},
			ensureOrganization: () => {
				created = true;
				return Promise.resolve();
			},
		});

		// The whole point: an org-less user gets a scoped session, so the 409 the
		// wallet was returning cannot recur for them.
		expect(orgId).toBe("org_personal");
		// Two lookups, not one — the id can only come from the re-query.
		expect(lookups).toEqual(["user_2", "user_2"]);
	});

	it("returns null when the heal produced no membership", async () => {
		const waits: number[] = [];
		const orgId = await resolveInitialActiveOrganization({
			userId: "user_3",
			findEarliestMembership: () => Promise.resolve(null),
			ensureOrganization: () => Promise.resolve(),
			wait: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
		});

		// The caller is fail-open: an unscoped session still beats a blocked login.
		expect(orgId).toBeNull();
		// The re-read retry is bounded, so a broken heal cannot stall login.
		expect(waits).toEqual([250, 250, 250]);
	});

	it("waits for a concurrent heal that holds the claim", async () => {
		// The losing login's ensure returns without creating; the winner's
		// membership lands a moment later and this session must still be scoped.
		let lookups = 0;
		const orgId = await resolveInitialActiveOrganization({
			userId: "user_5",
			findEarliestMembership: () => {
				lookups += 1;
				return Promise.resolve(lookups >= 4 ? "org_winner" : null);
			},
			ensureOrganization: () => Promise.resolve(),
			wait: () => Promise.resolve(),
		});

		expect(orgId).toBe("org_winner");
		expect(lookups).toBe(4);
	});

	it("propagates a failing heal to the caller's fail-open catch", async () => {
		await expect(
			resolveInitialActiveOrganization({
				userId: "user_4",
				findEarliestMembership: () => Promise.resolve(null),
				ensureOrganization: () =>
					Promise.reject(new Error("organization plugin exploded")),
			})
		).rejects.toThrow("organization plugin exploded");
	});
});

type CreateOrganizationBody = Parameters<
	OrganizationApi["createOrganization"]
>[0]["body"];

/**
 * In-memory stand-ins for the member, user and claim collections. The claim is
 * a Set keyed by user id: the same "one live claim per user" guarantee the
 * `_id` = userId unique key gives in Mongo.
 */
function personalOrganizationHarness(
	options: {
		failCreate?: () => boolean;
		user?: { email?: string | null; isAnonymous?: boolean } | null;
	} = {}
) {
	const members = new Set<string>();
	const claims = new Set<string>();
	const creates: CreateOrganizationBody[] = [];
	const released: string[] = [];
	const api: OrganizationApi = {
		createOrganization: async ({ body }) => {
			creates.push(body);
			// Yield so a concurrent heal gets a turn while this one holds the claim.
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 5);
			});
			if (options.failCreate?.()) {
				throw new Error("organization plugin exploded");
			}
			members.add(body.userId);
			return { id: `org_${creates.length}` };
		},
	};
	const deps: PersonalOrganizationDeps = {
		claim: (userId) => {
			if (claims.has(userId)) {
				return Promise.resolve(null);
			}
			claims.add(userId);
			return Promise.resolve(`claim_${userId}`);
		},
		findUser: () =>
			Promise.resolve(
				options.user === undefined
					? { email: "person@gmail.com" }
					: options.user
			),
		hasMembership: (userId) => Promise.resolve(members.has(userId)),
		release: (userId, claimKey) => {
			released.push(claimKey);
			claims.delete(userId);
			return Promise.resolve();
		},
	};
	return { api, claims, creates, deps, members, released };
}

describe("ensurePersonalOrganization", () => {
	it("provisions a durable user with a server-side personal org", async () => {
		const harness = personalOrganizationHarness();
		const result = await ensurePersonalOrganization(
			"user_1",
			harness.api,
			harness.deps
		);

		expect(result).toEqual({ created: true });
		expect(harness.creates).toHaveLength(1);
		const [body] = harness.creates;
		expect(body?.slug.startsWith("personal-")).toBe(true);
		expect(body?.userId).toBe("user_1");
		expect(body?.keepCurrentActiveOrganization).toBe(true);
		expect(body?.metadata).toEqual({ organizationKind: "personal" });
		// The claim is released once the org exists.
		expect(harness.claims.size).toBe(0);
	});

	it("creates exactly one org when two heals race for the same user", async () => {
		// Two logins at once (or a login racing the backfill) both see no
		// membership; only the claim holder may create.
		const harness = personalOrganizationHarness();
		const results = await Promise.all([
			ensurePersonalOrganization("user_race", harness.api, harness.deps),
			ensurePersonalOrganization("user_race", harness.api, harness.deps),
		]);

		expect(harness.creates).toHaveLength(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(harness.members.has("user_race")).toBe(true);
	});

	it("releases the claim when create fails so the next heal can retry", async () => {
		let failures = 1;
		const harness = personalOrganizationHarness({
			failCreate: () => {
				failures -= 1;
				return failures >= 0;
			},
		});

		await expect(
			ensurePersonalOrganization("user_retry", harness.api, harness.deps)
		).rejects.toThrow("organization plugin exploded");
		expect(harness.claims.size).toBe(0);

		const retry = await ensurePersonalOrganization(
			"user_retry",
			harness.api,
			harness.deps
		);
		expect(retry).toEqual({ created: true });
		expect(harness.creates).toHaveLength(2);
	});

	it("does not create when a heal finished between the check and the claim", async () => {
		const harness = personalOrganizationHarness();
		const claim = harness.deps.claim;
		harness.deps.claim = async (userId) => {
			// The other heal committed its membership and released its claim just
			// before this call claimed.
			harness.members.add(userId);
			return await claim(userId);
		};

		const result = await ensurePersonalOrganization(
			"user_late",
			harness.api,
			harness.deps
		);

		expect(result).toEqual({ created: false });
		expect(harness.creates).toHaveLength(0);
		expect(harness.claims.size).toBe(0);
	});

	it("short-circuits an existing membership without claiming", async () => {
		const harness = personalOrganizationHarness();
		harness.members.add("user_member");

		const result = await ensurePersonalOrganization(
			"user_member",
			harness.api,
			harness.deps
		);

		expect(result).toEqual({ created: false });
		expect(harness.creates).toHaveLength(0);
		expect(harness.released).toHaveLength(0);
	});

	it("never provisions an organization for a guest", async () => {
		const harness = personalOrganizationHarness({
			user: { email: null, isAnonymous: true },
		});

		const result = await ensurePersonalOrganization(
			"user_guest",
			harness.api,
			harness.deps
		);

		expect(result).toEqual({ created: false });
		expect(harness.creates).toHaveLength(0);
		expect(harness.released).toHaveLength(0);
	});
});

/**
 * The injected fakes above prove the flow; these pin the production wiring to
 * the stored claim, whose `_id` = userId duplicate key is the real guard.
 */
describe("ensurePersonalOrganization stored claim", () => {
	const spies: { mockRestore: () => void }[] = [];

	afterEach(() => {
		for (const spy of spies.splice(0)) {
			spy.mockRestore();
		}
	});

	interface ClaimCall {
		filter: { _id?: string; expiresAt?: { $lte?: Date } };
		options: { new?: boolean; upsert?: boolean };
		update: { $set?: { claimKey?: string; expiresAt?: Date } };
	}

	function stubStores(claim: (call: ClaimCall) => Promise<unknown>) {
		const claimCalls: ClaimCall[] = [];
		const releases: unknown[] = [];
		const creates: CreateOrganizationBody[] = [];
		spies.push(
			spyOn(Member, "exists").mockResolvedValue(null as never),
			spyOn(User, "findById").mockReturnValue({
				select: () => ({
					lean: () => Promise.resolve({ email: "person@gmail.com" }),
				}),
			} as never),
			spyOn(PersonalOrganizationClaim, "findOneAndUpdate").mockImplementation(((
				filter: ClaimCall["filter"],
				update: ClaimCall["update"],
				options: ClaimCall["options"]
			) => {
				const call = { filter, options, update };
				claimCalls.push(call);
				return { lean: () => claim(call) };
			}) as never),
			spyOn(PersonalOrganizationClaim, "deleteOne").mockImplementation(((
				filter: unknown
			) => {
				releases.push(filter);
				return Promise.resolve({ deletedCount: 1 });
			}) as never)
		);
		const api: OrganizationApi = {
			createOrganization: ({ body }) => {
				creates.push(body);
				return Promise.resolve({ id: "org_stored" });
			},
		};
		return { api, claimCalls, creates, releases };
	}

	it("does not create while another heal holds a live claim", async () => {
		const stores = stubStores(() =>
			Promise.reject(
				Object.assign(new Error("E11000 duplicate key"), { code: 11_000 })
			)
		);

		const result = await ensurePersonalOrganization("user_held", stores.api);

		expect(result).toEqual({ created: false });
		expect(stores.creates).toHaveLength(0);
		// Nothing was claimed, so nothing is released: the holder's claim stays.
		expect(stores.releases).toHaveLength(0);
		// Only an expired claim may be taken over; a live one forces the insert,
		// which the `_id` key refuses.
		const [call] = stores.claimCalls;
		expect(call?.filter._id).toBe("user_held");
		expect(call?.filter.expiresAt?.$lte).toBeInstanceOf(Date);
		expect(call?.options).toEqual({ new: true, upsert: true });
	});

	it("creates under its own claim and releases only that claim", async () => {
		const stores = stubStores((call) =>
			Promise.resolve({ claimKey: call.update.$set?.claimKey })
		);

		const result = await ensurePersonalOrganization("user_free", stores.api);

		expect(result).toEqual({ created: true });
		expect(stores.creates).toHaveLength(1);
		const claimKey = stores.claimCalls[0]?.update.$set?.claimKey;
		expect(claimKey).toBeString();
		const expiresAt = stores.claimCalls[0]?.update.$set?.expiresAt;
		expect(expiresAt?.getTime()).toBeGreaterThan(Date.now());
		expect(stores.releases).toEqual([{ _id: "user_free", claimKey }]);
	});

	it("propagates a claim store failure without creating", async () => {
		const stores = stubStores(() =>
			Promise.reject(new Error("claim store unavailable"))
		);

		await expect(
			ensurePersonalOrganization("user_outage", stores.api)
		).rejects.toThrow("claim store unavailable");
		expect(stores.creates).toHaveLength(0);
	});
});

describe("cancelOrganizationInvitation", () => {
	it("cancels only a live pending invitation through Better Auth", async () => {
		let canceled = 0;
		const result = await cancelOrganizationInvitation(
			{
				listInvitations: () =>
					Promise.resolve([
						{
							expiresAt: new Date(Date.now() + 60_000),
							id: "invite_1",
							status: "pending",
						},
					]),
				cancelInvitation: () => {
					canceled += 1;
					return Promise.resolve();
				},
			},
			{ headers, invitationId: "invite_1", organizationId: "org_1" }
		);

		expect(result).toEqual({ changed: true, status: "canceled" });
		expect(canceled).toBe(1);
	});

	it("retains successful cancellation when the native adapter returns null", async () => {
		let canceled = 0;
		const result = await cancelOrganizationInvitation(
			{
				listInvitations: () =>
					Promise.resolve([{ id: "native_null", status: "pending" }]),
				cancelInvitation: () => {
					canceled += 1;
					return Promise.resolve(null);
				},
			},
			{ headers, invitationId: "native_null", organizationId: "org_1" }
		);
		expect(result).toEqual({ changed: true, status: "canceled" });
		expect(canceled).toBe(1);
	});

	it("is idempotent for a canceled invitation and protects terminal states", async () => {
		let canceled = 0;
		const api = {
			listInvitations: () =>
				Promise.resolve([
					{ id: "canceled", status: "canceled" },
					{ id: "accepted", status: "accepted" },
				]),
			cancelInvitation: () => {
				canceled += 1;
				return Promise.resolve();
			},
		};

		expect(
			await cancelOrganizationInvitation(api, {
				headers,
				invitationId: "canceled",
				organizationId: "org_1",
			})
		).toEqual({ changed: false, status: "canceled" });
		expect(
			await cancelOrganizationInvitation(api, {
				headers,
				invitationId: "accepted",
				organizationId: "org_1",
			})
		).toEqual({ changed: false, status: "accepted" });
		expect(canceled).toBe(0);
	});

	it("does not rewrite an expired pending invitation", async () => {
		let canceled = 0;
		const result = await cancelOrganizationInvitation(
			{
				listInvitations: () =>
					Promise.resolve([
						{
							expiresAt: new Date(1),
							id: "expired",
							status: "pending",
						},
					]),
				cancelInvitation: () => {
					canceled += 1;
					return Promise.resolve();
				},
			},
			{ headers, invitationId: "expired", organizationId: "org_1" }
		);

		expect(result).toEqual({ changed: false, status: "expired" });
		expect(canceled).toBe(0);
	});
});
