import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Real SDK and native owned HTTP verify caller authentication compatibility.
const nativeFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const previousBackend = process.env.VITE_APP_BACKEND_URL;
const ledger: Array<{
	method: string;
	path: string;
	bearer: string | null;
	body: unknown;
	idempotency: string | null;
}> = [];
const unexpected: string[] = [];
const egress: string[] = [];
const wallet = (account: string) => ({
	orgs: [],
	source: {
		orgId: `${account}-personal`,
		grants: [],
		topupMicroUsd: account === "A" ? 5_000_000 : 8_000_000,
	},
});
const transferBody = (account: string) => ({
	fromOrgId: `${account}-personal`,
	toOrgId: `${account}-team`,
	grantIds: [`${account}-grant`],
	topupMicroUsd: 1_250_000,
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const bearer = request.headers.get("authorization");
		const body = request.method === "POST" ? await request.json() : null;
		ledger.push({
			method: request.method,
			path: url.pathname + url.search,
			bearer,
			body,
			idempotency: request.headers.get("idempotency-key"),
		});
		const account =
			bearer === "Bearer sdk-session-A"
				? "A"
				: bearer === "Bearer sdk-session-B"
					? "B"
					: null;
		const known =
			(request.method === "GET" &&
				url.pathname === "/api/credits/transferable" &&
				[...url.searchParams.keys()].every((key) => key === "orgId")) ||
			(request.method === "POST" &&
				url.pathname === "/api/credits/transfer" &&
				!url.search) ||
			(request.method === "GET" &&
				url.pathname === "/api/control-plane/orgs" &&
				!url.search);
		if (!known) {
			unexpected.push(`${request.method} ${url.pathname}${url.search}`);
			return NativeResponse.json(
				{ error: "Unknown SDK owner contract" },
				{ status: 503 }
			);
		}
		if (!account) {
			return NativeResponse.json(
				{ error: "Session required" },
				{ status: 401 }
			);
		}
		if (url.pathname === "/api/control-plane/orgs") {
			return NativeResponse.json({
				organizations: [
					{
						id: `${account}-personal`,
						name: `${account} Personal`,
						slug: `${account.toLowerCase()}-personal`,
						role: "owner",
						logo: null,
						createdAt: "2026-10-09T00:00:00.000Z",
						isPersonal: true,
					},
				],
			});
		}
		if (request.method === "GET") {
			if (url.searchParams.get("orgId") !== `${account}-personal`) {
				unexpected.push("Foreign SDK read workspace");
				return NativeResponse.json(
					{ error: "Foreign workspace" },
					{ status: 403 }
				);
			}
			return NativeResponse.json(wallet(account));
		}
		if (JSON.stringify(body) !== JSON.stringify(transferBody(account))) {
			unexpected.push("Incorrect exact SDK transfer body");
			return NativeResponse.json(
				{ error: "Incorrect transfer body" },
				{ status: 400 }
			);
		}
		return NativeResponse.json({
			ok: true,
			reason: null,
			movedGrantIds: [`${account}-grant`],
			movedGrantMicroUsd: 3_000_000,
			movedTopupMicroUsd: 1_250_000,
		});
	},
});
process.env.VITE_APP_BACKEND_URL = server.url.origin;
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== server.url.origin) {
			egress.push(request.url);
			throw new Error("Unowned SDK HTTP origin");
		}
		return await nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;
const { TOKEN_KEY, BACKEND_URL } = await import("@/lib/auth-client.ts");
const { fetchTransferable, transferCredits, listOrgs } = await import(
	"./orgs.ts"
);
const previousToken = localStorage.getItem(TOKEN_KEY);
beforeEach(() => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: The imported SDK must use its real canonical backend input.
	expect(BACKEND_URL).toBe(server.url.origin);
	ledger.length = 0;
	unexpected.length = 0;
	egress.length = 0;
	localStorage.setItem(TOKEN_KEY, "sdk-session-A");
});
afterEach(() => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: Unknown routes invalidate every real SDK case.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Unowned network access invalidates every case.
	expect(egress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	if (previousBackend === undefined) {
		delete process.env.VITE_APP_BACKEND_URL;
	} else {
		process.env.VITE_APP_BACKEND_URL = previousBackend;
	}
	if (previousToken === null) {
		localStorage.removeItem(TOKEN_KEY);
	} else {
		localStorage.setItem(TOKEN_KEY, previousToken);
	}
});
for (const mode of ["default", "captured", "null"] as const) {
	test(`transferable ${mode} authentication is sent through native HTTP`, async () => {
		const account = mode === "captured" ? "B" : "A";
		const operation =
			mode === "default"
				? fetchTransferable(`${account}-personal`)
				: fetchTransferable(
						`${account}-personal`,
						mode === "captured" ? "sdk-session-B" : null
					);
		if (mode === "null") {
			await expect(operation).rejects.toThrow("Session required");
		} else {
			expect(await operation).toEqual(wallet(account));
		}
		expect(ledger).toEqual([
			{
				method: "GET",
				path: `/api/credits/transferable?orgId=${account}-personal`,
				bearer: mode === "null" ? null : `Bearer sdk-session-${account}`,
				body: null,
				idempotency: null,
			},
		]);
		expect(localStorage.getItem(TOKEN_KEY)).toBe("sdk-session-A");
	});
	test(`credit POST ${mode} authentication keeps its exact payload and real idempotency`, async () => {
		const account = mode === "captured" ? "B" : "A";
		const idempotencyKey = crypto.randomUUID();
		const operation =
			mode === "default"
				? transferCredits(transferBody(account), idempotencyKey)
				: transferCredits(
						transferBody(account),
						idempotencyKey,
						mode === "captured" ? "sdk-session-B" : null
					);
		if (mode === "null") {
			await expect(operation).rejects.toThrow("Session required");
		} else {
			expect(await operation).toEqual({
				ok: true,
				reason: null,
				movedGrantIds: [`${account}-grant`],
				movedGrantMicroUsd: 3_000_000,
				movedTopupMicroUsd: 1_250_000,
			});
		}
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			method: "POST",
			path: "/api/credits/transfer",
			bearer: mode === "null" ? null : `Bearer sdk-session-${account}`,
			body: transferBody(account),
		});
		expect(ledger[0]?.idempotency).toBe(idempotencyKey);
		expect(localStorage.getItem(TOKEN_KEY)).toBe("sdk-session-A");
	});
}
test("legacy organization callers read the current stored token on each native request", async () => {
	const a = await listOrgs();
	localStorage.setItem(TOKEN_KEY, "sdk-session-B");
	const b = await listOrgs();
	expect(a.map((org) => org.id)).toEqual(["A-personal"]);
	expect(b.map((org) => org.id)).toEqual(["B-personal"]);
	expect(ledger.map((entry) => entry.bearer)).toEqual([
		"Bearer sdk-session-A",
		"Bearer sdk-session-B",
	]);
	expect(
		ledger.every(
			(entry) =>
				entry.method === "GET" && entry.path === "/api/control-plane/orgs"
		)
	).toBe(true);
});
test("signed-out legacy organization calls admit no HTTP request", async () => {
	localStorage.removeItem(TOKEN_KEY);
	expect(await listOrgs()).toEqual([]);
	expect(ledger).toEqual([]);
});
