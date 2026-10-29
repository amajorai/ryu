import { afterEach, expect, test } from "bun:test";
import { fetchInterfaceWallet } from "./use-interface-account.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function entry(index: number) {
	return {
		balanceAfter: 5_000_000 - index,
		createdAt: new Date(
			Date.UTC(2026, 9, 15, 12) - index * 60_000
		).toISOString(),
		delta: -1000,
		durationMs: null,
		estimated: null,
		id: `entry-${index}`,
		inputTokens: 10,
		model: "model-a",
		orgId: "org-1",
		outputTokens: 5,
		provider: "provider-a",
		reason: "gateway_usage",
		refId: null,
		taskLabel: null,
		upstreamProvider: null,
		userId: "user-1",
		walletId: "wallet-1",
	};
}

const WALLET = {
	balanceMicroUsd: 5_000_000,
	currency: "usd",
	id: "wallet-1",
	ownerId: "org-1",
	ownerType: "org",
	subscriptionBalanceMicroUsd: null,
	topupBalanceMicroUsd: null,
	updatedAt: "2026-10-15T12:00:00.000Z",
};

const STATS = {
	byModel: [],
	byProvider: [],
	byReason: [],
	creditedMicroUsd: 0,
	durationMs: 0,
	inputTokens: 0,
	outputTokens: 0,
	spentMicroUsd: 0,
	transactions: 0,
};

function serve(routes: Record<string, () => Response>): string[] {
	const requested: string[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL) => {
			const url = new URL(String(input));
			requested.push(url.pathname + url.search);
			const route = routes[url.pathname];
			return Promise.resolve(
				route ? route() : new Response("not found", { status: 404 })
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	return requested;
}

test("reads the ledger from the usage statement, not the wallet preview", async () => {
	const preview = Array.from({ length: 50 }, (_, index) => entry(index));
	const statement = Array.from({ length: 180 }, (_, index) => entry(index));
	const requested = serve({
		"/api/credits/usage": () =>
			Response.json({ entries: statement, nextCursor: "c", stats: STATS }),
		"/api/credits/wallet": () =>
			Response.json({ ledger: preview, wallet: WALLET }),
	});
	const response = await fetchInterfaceWallet();
	expect(requested).toContain("/api/credits/usage?limit=200");
	expect(response.wallet.balanceMicroUsd).toBe(5_000_000);
	expect(response.ledger).toHaveLength(180);
	expect(new Set(response.ledger.map((row) => row.id)).size).toBe(180);
});

test("keeps the wallet preview when the statement is temporarily unavailable", async () => {
	serve({
		"/api/credits/usage": () => new Response("busy", { status: 503 }),
		"/api/credits/wallet": () =>
			Response.json({ ledger: [entry(0)], wallet: WALLET }),
	});
	const response = await fetchInterfaceWallet();
	expect(response.ledger.map((row) => row.id)).toEqual(["entry-0"]);
});
