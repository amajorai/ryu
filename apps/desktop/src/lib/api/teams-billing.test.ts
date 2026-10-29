import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import {
	type AppJsonValue,
	appJsonValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import type { WalletResponse } from "./credits.ts";
import {
	checkoutHostedAgents,
	checkoutOrganizationPlan,
	checkoutTeams,
	checkoutTeamsOnboarding,
	fetchOrgRole,
	fetchSubscriptionStatus,
	fetchTeamsSeatStatus,
	fetchWallet,
	hasTeamsBillingAuth,
	type OrgMembership,
	openBillingPortalUrl,
	type SubscriptionStatus,
	TeamsBillingError,
	type TeamsBillingErrorKind,
	type TeamsSeatStatus,
	updateTeamsSeats,
} from "./teams-billing.ts";
import {
	teamsSeatStatusSchema,
	teamsSubscriptionStatusSchema,
} from "./teams-billing-wire-contracts.ts";

interface TeamsCall {
	authorization: string | null;
	body: AppJsonValue | null;
	method: string;
	path: string;
}
const calls: TeamsCall[] = [];
const idempotencyKeys: string[] = [];
let response: AppJsonValue = {};
let responseStatus = 200;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		// The native identity client can refresh its session after module import.
		// Give that independent endpoint its real signed-out response.
		if (path === "/api/auth/get-session") {
			return Response.json(null);
		}
		const idempotencyKey = request.headers.get("idempotency-key");
		if (idempotencyKey) {
			idempotencyKeys.push(idempotencyKey);
		}
		const body = await request.text();
		calls.push({
			path,
			method: request.method,
			authorization: request.headers.get("authorization"),
			body: body ? appJsonValueSchema.parse(JSON.parse(body)) : null,
		});
		return Response.json(response, { status: responseStatus });
	},
});
const nativeFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
const values = new Map<string, string>();
const storage: Storage = {
	get length() {
		return values.size;
	},
	clear: () => values.clear(),
	getItem: (key) => values.get(key) ?? null,
	key: (index) => [...values.keys()][index] ?? null,
	removeItem: (key) => {
		values.delete(key);
	},
	setItem: (key, value) => {
		values.set(key, value);
	},
};
const route = (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
	const request = new Request(input, options);
	return nativeFetch(
		new URL(new URL(request.url).pathname, server.url),
		request
	);
};
beforeEach(() => {
	calls.length = 0;
	idempotencyKeys.length = 0;
	values.clear();
	response = {};
	responseStatus = 200;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	globalThis.fetch = Object.assign(route, {
		preconnect: nativeFetch.preconnect,
	});
});
afterEach(() => {
	globalThis.fetch = nativeFetch;
	if (storageDescriptor) {
		Object.defineProperty(globalThis, "localStorage", storageDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});
afterAll(() => server.stop(true));

it("validates complete billing and seat views while preserving legacy rollout omissions and future metadata", async () => {
	storage.setItem(TOKEN_KEY, "teams-session");
	const subscription = {
		entitlement: {
			desktopAccess: true,
			managedInference: true,
			monthlyCreditPoolMicroUsd: 500,
			plan: "future-plan",
		},
		features: { preview: true },
		hostedAgents: null,
		organizationId: "org-1",
		plan: "future-plan",
		scope: "org",
		future: { retained: true },
	} satisfies SubscriptionStatus & { future: { retained: boolean } };
	response = subscription;
	expect(JSON.stringify(await fetchSubscriptionStatus())).toBe(
		JSON.stringify(subscription)
	);
	expect(
		Object.is(teamsSubscriptionStatusSchema.parse(subscription), subscription)
	).toBe(true);
	const seats = {
		allocatedSeats: 5,
		availableSeats: 0,
		billedSeats: 5,
		bonusExpiresAt: null,
		bonusSeats: 0,
		canInvite: false,
		includedCreditPoolMicroUsd: 500,
		includedSeats: 5,
		invitationBlockedReason: "full",
		memberCount: 5,
		minRequired: 5,
		minSeats: 5,
		organizationId: "org-1",
		overAllocated: false,
		pendingInvitations: 0,
		pendingSeatReservations: 0,
		plan: "future-plan",
		future: { version: 2 },
	} satisfies TeamsSeatStatus & { future: { version: number } };
	response = seats;
	expect(JSON.stringify(await fetchTeamsSeatStatus())).toBe(
		JSON.stringify(seats)
	);
	expect(Object.is(teamsSeatStatusSchema.parse(seats), seats)).toBe(true);
	const currentSeats = {
		...seats,
		businessEmailBlockedMemberCount: 0,
		businessEmailReason: null,
		businessEmailRequired: true,
		canUpgradeToTeams: false,
		organizationKind: "future-kind",
		teamEmailPolicyPassed: true,
	};
	response = currentSeats;
	expect(JSON.stringify(await fetchTeamsSeatStatus())).toBe(
		JSON.stringify(currentSeats)
	);
	response = { ...currentSeats, businessEmailRequired: "true" };
	await expect(fetchTeamsSeatStatus()).rejects.toThrow();
	response = {
		...subscription,
		features: appJsonValueSchema.parse(JSON.parse('{"__proto__":true}')),
	};
	expect(JSON.stringify(await fetchSubscriptionStatus())).toBe(
		JSON.stringify(response)
	);
	response = {
		...subscription,
		features: appJsonValueSchema.parse(JSON.parse('{"__proto__":"invalid"}')),
	};
	await expect(fetchSubscriptionStatus()).rejects.toThrow();
	expect(calls[0]?.authorization).toBe("Bearer teams-session");
});
it("keeps all checkout wire bodies and fresh native idempotency keys while the server owns quantities and offers", async () => {
	storage.setItem(TOKEN_KEY, "teams-session");
	const organizationReply = {
		monthlyPriceMicroUsd: 5_000_000,
		plan: "teams-lite",
		seats: 2,
		url: "https://checkout.invalid/org",
		future: { retained: true },
	};
	response = organizationReply;
	expect(
		JSON.stringify(
			await checkoutOrganizationPlan("teams-lite", "yearly", 2, undefined)
		)
	).toBe(JSON.stringify(organizationReply));
	expect(calls.at(-1)?.body).toEqual({
		interval: "yearly",
		planId: "teams-lite",
		seats: 2,
	});
	response = { seats: 5, url: "https://checkout.invalid/teams" };
	expect(JSON.stringify(await checkoutTeams("monthly", 5, null))).toBe(
		JSON.stringify(response)
	);
	expect(calls.at(-1)?.body).toEqual({
		interval: "monthly",
		organizationId: null,
		seats: 5,
	});
	response = {
		offer: { firstMonthUsd: 1, interval: "monthly", recurringMonthUsd: 25 },
		seats: 5,
		url: "https://checkout.invalid/onboarding",
	};
	expect(JSON.stringify(await checkoutTeamsOnboarding())).toBe(
		JSON.stringify(response)
	);
	expect(calls.at(-1)?.body).toEqual({});
	response = {
		agentCount: 3,
		monthlyPriceUsd: 30,
		planId: "max",
		url: "https://checkout.invalid/agents",
	};
	expect(JSON.stringify(await checkoutHostedAgents("max", 3))).toBe(
		JSON.stringify(response)
	);
	expect(calls.at(-1)?.body).toEqual({ agentCount: 3, planId: "max" });
	expect(idempotencyKeys).toHaveLength(4);
	expect(new Set(idempotencyKeys).size).toBe(4);
	for (const key of idempotencyKeys) {
		expect(key).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
	}
	response = {
		memberCount: 5,
		pendingSeatCount: 0,
		prorationBehavior: "invoice",
		prorationLabel: "Immediate invoice",
		seats: 6,
	};
	expect(JSON.stringify(await updateTeamsSeats(6))).toBe(
		JSON.stringify(response)
	);
	expect(calls.at(-1)?.body).toEqual({ seats: 6 });
	expect(idempotencyKeys).toHaveLength(4);
	response = { url: "https://billing.invalid/portal", future: "retained" };
	expect(JSON.stringify(await openBillingPortalUrl())).toBe(
		JSON.stringify(response)
	);
	expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([
		{ path: "/api/billing/checkout/organization", method: "POST" },
		{ path: "/api/billing/checkout/teams", method: "POST" },
		{ path: "/api/billing/checkout/teams/onboarding", method: "POST" },
		{ path: "/api/billing/checkout/agents", method: "POST" },
		{ path: "/api/billing/seats", method: "POST" },
		{ path: "/api/billing/portal", method: "GET" },
	]);
});
it("uses the complete wallet owner, retaining future provenance and provider metadata", async () => {
	const wallet = {
		balanceMicroUsd: 100,
		currency: "USD",
		id: "wallet-1",
		ownerId: "org-1",
		ownerType: "org",
		source: "future-provenance",
		subscriptionBalanceMicroUsd: null,
		topupBalanceMicroUsd: 100,
		updatedAt: "2026-10-06T00:00:00Z",
		providerAllocations: [
			{
				expiresAt: null,
				isFreeProvider: true,
				label: "Future tier",
				poolId: "future-pool",
				remainingMicroUsd: 10,
			},
		],
		future: { retained: true },
	};
	const reply = { wallet, ledger: [] } satisfies WalletResponse;
	response = reply;
	expect(JSON.stringify(await fetchWallet())).toBe(JSON.stringify(reply));
	response = { wallet: { ...wallet, balanceMicroUsd: "100" }, ledger: [] };
	await expect(fetchWallet()).rejects.toThrow();
});
it("projects actual organization roles and leaves absence distinct from a role", async () => {
	const membershipRoles = [
		"owner",
		"admin",
		"member",
		"viewer",
		null,
	] satisfies OrgMembership["role"][];
	for (const role of membershipRoles) {
		response = {
			organizations: [
				{
					id: "org-1",
					name: "Personal",
					role,
					createdAt: "2026-10-06T00:00:00Z",
					slug: "personal",
					logo: null,
					isPersonal: true,
					future: { retained: true },
				},
			],
		};
		expect(await fetchOrgRole("org-1")).toBe(role);
		expect(await fetchOrgRole("missing")).toBeNull();
	}
	response = { organizations: [] };
	expect(await fetchOrgRole("org-1")).toBeNull();
	response = {
		organizations: [
			{
				id: "org-1",
				name: "Legacy",
				role: "member",
				createdAt: null,
				slug: null,
				logo: null,
				isPersonal: false,
			},
		],
	};
	expect(await fetchOrgRole("org-1")).toBe("member");
	response = {
		organizations: [{ id: "org-1", name: "Bad", role: "future-invalid-role" }],
	};
	await expect(fetchOrgRole("org-1")).rejects.toThrow();
});
it("preserves native status classifications, scalar legacy messages and upgrade truthiness", async () => {
	const classifications = [
		{ status: 401, kind: "auth" },
		{ status: 403, kind: "forbidden" },
		{ status: 409, kind: "no_org" },
		{ status: 422, kind: "needs_upgrade" },
		{ status: 503, kind: "unknown" },
	] satisfies { status: number; kind: TeamsBillingErrorKind }[];
	for (const { status, kind } of classifications) {
		responseStatus = status;
		response = { message: "Server explanation", needsUpgrade: 1 };
		try {
			await fetchTeamsSeatStatus();
			throw new Error("Expected HTTP failure");
		} catch (error) {
			expect(error).toBeInstanceOf(TeamsBillingError);
			if (!(error instanceof TeamsBillingError)) {
				throw error;
			}
			expect(error.kind).toBe(kind);
			expect(error.message).toBe("Server explanation");
			expect(error.needsUpgrade).toBe(status === 422);
		}
	}
	responseStatus = 422;
	response = { message: 0, needsUpgrade: false };
	await expect(fetchTeamsSeatStatus()).rejects.toMatchObject({
		kind: "invalid",
		message: "0",
		needsUpgrade: false,
	});
	expect(hasTeamsBillingAuth()).toBe(false);
	expect(calls[0]?.authorization).toBeNull();
});
it("rejects incomplete successful endpoint replies instead of claiming typed financial records", async () => {
	response = {};
	await expect(checkoutTeams("monthly", 5)).rejects.toThrow();
	await expect(checkoutTeamsOnboarding()).rejects.toThrow();
	await expect(updateTeamsSeats(5)).rejects.toThrow();
	await expect(openBillingPortalUrl()).rejects.toThrow();
	await expect(fetchSubscriptionStatus()).rejects.toThrow();
});
