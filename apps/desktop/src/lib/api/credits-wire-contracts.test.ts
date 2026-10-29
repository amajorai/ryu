import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	CreditsError,
	createTopup,
	fetchAutoTopup,
	fetchCreditAlert,
	fetchUsage,
	fetchWallet,
	isCreditLedgerReason,
	ledgerReasonLabel,
	putAutoTopup,
} from "./credits.ts";
import {
	autoTopupSettingsSchema,
	creditAlertSettingsSchema,
	walletResponseSchema,
	walletUpdateSchema,
} from "./credits-wire-contracts.ts";

const NativeResponse = Response;
const NativeHeaders = Headers;
const NativeURL = URL;

const wallet = {
	balanceMicroUsd: 100,
	currency: "usd",
	id: "wallet",
	ownerId: "org",
	ownerType: "org",
	subscriptionBalanceMicroUsd: null,
	topupBalanceMicroUsd: null,
	updatedAt: "2026-10-06T00:00:00Z",
	source: "polar",
};
const ledger = {
	balanceAfter: 100,
	createdAt: "2026-10-06T00:00:00Z",
	delta: 1,
	durationMs: null,
	estimated: null,
	id: "entry",
	inputTokens: null,
	model: null,
	orgId: "org",
	outputTokens: null,
	provider: null,
	reason: "future_reason",
	refId: null,
	taskLabel: null,
	upstreamProvider: null,
	userId: null,
	walletId: "wallet",
};
const stats = {
	byModel: [],
	byProvider: [],
	byReason: [],
	creditedMicroUsd: 1,
	durationMs: 0,
	inputTokens: 0,
	outputTokens: 0,
	spentMicroUsd: 0,
	transactions: 1,
};
let reply = NativeResponse.json({});
const received: { headers: Headers; body: string; path: string }[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		received.push({
			headers: new NativeHeaders(request.headers),
			body: await request.text(),
			path:
				new NativeURL(request.url).pathname + new NativeURL(request.url).search,
		});
		return reply;
	},
});
const nativeFetch = globalThis.fetch;
const registeredHere = globalThis.document === undefined;
if (registeredHere) {
	GlobalRegistrator.register({ url: "http://fixture.invalid" });
}
const originalToken = localStorage.getItem(TOKEN_KEY);
localStorage.setItem(TOKEN_KEY, "fixture-session");
globalThis.fetch = Object.assign(
	async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new NativeURL(String(input), "http://fixture.invalid");
		return nativeFetch(
			new NativeURL(url.pathname + url.search, server.url),
			init
		);
	},
	{ preconnect: nativeFetch.preconnect }
);
beforeEach(() => {
	received.length = 0;
});
afterAll(async () => {
	globalThis.fetch = nativeFetch;
	if (originalToken === null) {
		localStorage.removeItem(TOKEN_KEY);
	} else {
		localStorage.setItem(TOKEN_KEY, originalToken);
	}
	server.stop(true);
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});
test("wallet and usage HTTP replies validate complete owner records and retain future ledger reasons", async () => {
	reply = NativeResponse.json({
		wallet,
		ledger: [
			{ ...ledger, future: JSON.parse('{"__proto__":{"retained":true}}') },
		],
	});
	const result = await fetchWallet();
	expect(result.ledger[0]?.reason).toBe("future_reason");
	expect(JSON.stringify(result)).toContain('"__proto__":{"retained":true}');
	expect(ledgerReasonLabel(result.ledger[0]?.reason ?? "")).toBeUndefined();
	expect(isCreditLedgerReason(result.ledger[0]?.reason ?? "")).toBe(false);
	expect(ledgerReasonLabel("topup")).toBe("Top-up");
	expect(ledgerReasonLabel("managed_agents")).toBe("Managed Agents");
	expect(isCreditLedgerReason("managed_agents")).toBe(false);
	expect(isCreditLedgerReason("gift_credit")).toBe(true);
	expect(received[0]?.headers.get("Authorization")).toBe(
		"Bearer fixture-session"
	);
	reply = NativeResponse.json({ entries: [ledger], nextCursor: null, stats });
	await expect(
		fetchUsage({ provider: "A & B", model: null, limit: 50 })
	).resolves.toMatchObject({ entries: [ledger] });
	expect(received[1]?.path).toBe(
		"/api/credits/usage?provider=A+%26+B&limit=50"
	);
});
test("wallet validates optional pool projections and preserves the original pure wire document", () => {
	const wire = {
		wallet: {
			...wallet,
			source: "future_balance_owner",
			providerAllocations: [
				{
					expiresAt: null,
					isFreeProvider: true,
					label: "Fast",
					poolId: "fast",
					remainingMicroUsd: 2,
				},
			],
		},
		ledger: [ledger],
		future: { kept: true },
	};
	expect(walletResponseSchema.parse(wire) === wire).toBe(true);
	expect(
		walletResponseSchema.safeParse({
			...wire,
			wallet: {
				...wallet,
				source: "future_balance_owner",
				providerAllocations: [{ poolId: "missing-fields" }],
			},
		}).success
	).toBe(false);
	expect(
		walletResponseSchema.safeParse({
			wallet: { ...wallet, balanceMicroUsd: "100" },
			ledger: [],
		}).success
	).toBe(false);
});
test("wallet validates the held and available balances from open credit holds", () => {
	const held = {
		wallet: { ...wallet, availableMicroUsd: 70, heldMicroUsd: 30 },
		ledger: [ledger],
	};
	expect(walletResponseSchema.parse(held) === held).toBe(true);
	expect(
		walletResponseSchema.safeParse({
			wallet: { ...wallet, heldMicroUsd: "30" },
			ledger: [],
		}).success
	).toBe(false);
	const frame = {
		availableMicroUsd: 70,
		balanceMicroUsd: 100,
		currency: "usd",
		heldMicroUsd: 30,
		id: "wallet-1",
		ownerId: "org-1",
		updatedAt: "2026-09-24T00:00:00.000Z",
	};
	expect(walletUpdateSchema.parse(frame)).toEqual(frame);
	expect(
		walletUpdateSchema.safeParse({ ...frame, heldMicroUsd: "30" }).success
	).toBe(false);
});
test("topup preserves session headers, idempotency and the actual fee quote", async () => {
	const quote = { faceCents: 1000, feeCents: 100, chargeCents: 1100 };
	reply = NativeResponse.json({ url: "https://checkout.example", quote });
	await expect(
		createTopup({ pack: 100, successUrl: "https://return.example" })
	).resolves.toEqual({ url: "https://checkout.example", quote });
	expect(received[0]?.headers.get("Authorization")).toBe(
		"Bearer fixture-session"
	);
	expect(received[0]?.headers.get("Content-Type")).toBe("application/json");
	expect(received[0]?.headers.get("Idempotency-Key")).toMatch(/^[\da-f-]{36}$/);
	expect(JSON.parse(received[0]?.body ?? "")).toEqual({
		pack: "100",
		successUrl: "https://return.example",
	});
	reply = NativeResponse.json({ url: null });
	await expect(createTopup({ amountCents: 1000 })).rejects.toThrow(
		"Checkout session has no URL."
	);
});
test("HTTP failures retain status classification and native Error message coercion", async () => {
	reply = NativeResponse.json({ message: null, error: null }, { status: 409 });
	try {
		await fetchWallet();
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toMatchObject({
			kind: "no_org",
			message:
				"Credits wallets are org-level. Create or select an organization first.",
		});
	}
	reply = NativeResponse.json({ message: 42 }, { status: 503 });
	await expect(fetchWallet()).rejects.toMatchObject({
		kind: "billing",
		message: "42",
	});
	reply = NativeResponse.json({ error: "sign in" }, { status: 401 });
	await expect(fetchWallet()).rejects.toBeInstanceOf(CreditsError);
});
test("settings HTTP reads and writes preserve every legacy per-field fallback", async () => {
	reply = NativeResponse.json({
		settings: {
			amountCents: "1000",
			enabled: "yes",
			lastError: "",
			cooldownSec: 300,
			monthKey: 7,
		},
	});
	await expect(fetchAutoTopup()).resolves.toMatchObject({
		amountCents: 0,
		enabled: true,
		lastError: "",
		cooldownSec: 300,
		monthKey: null,
	});
	reply = NativeResponse.json({ settings: null });
	await expect(
		putAutoTopup({
			amountCents: 1000,
			enabled: false,
			thresholdCents: 500,
			monthlyCapCents: 0,
		})
	).resolves.toBeNull();
	expect(JSON.parse(received[1]?.body ?? "")).toEqual({
		enabled: false,
		amountCents: 1000,
		thresholdCents: 500,
		monthlyCapCents: 0,
	});
	reply = NativeResponse.json({
		settings: {
			recipients: "future",
			thresholdCents: "500",
			notifiedAt: false,
		},
	});
	await expect(fetchCreditAlert()).resolves.toEqual({
		recipients: "none",
		thresholdCents: 0,
		notifiedAt: null,
		belowSince: null,
		lastError: null,
	});
	expect(autoTopupSettingsSchema.parse([])).toMatchObject({
		amountCents: 0,
		enabled: false,
	});
	expect(creditAlertSettingsSchema.parse(true)).toBeNull();
});
