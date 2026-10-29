import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import { fetchMyCampaigns } from "./campaigns.ts";

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
let reply = "{}";
let status = 200;
const calls: { path: string; authorization: string | null }[] = [];
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/api/auth/get-session") {
			return Response.json(null);
		}
		calls.push({ path, authorization: request.headers.get("authorization") });
		return new Response(reply, {
			status,
			headers: { "Content-Type": "application/json" },
		});
	},
});
const nativeFetch = globalThis.fetch;
const route = (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
	const request = new Request(input, options);
	return nativeFetch(
		new URL(new URL(request.url).pathname, server.url),
		request
	);
};
beforeEach(() => {
	values.clear();
	calls.length = 0;
	reply = "{}";
	status = 200;
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
test("returns absent grants without a session or on older and unavailable servers", async () => {
	expect(await fetchMyCampaigns()).toBeNull();
	expect(calls).toEqual([]);
	values.set(TOKEN_KEY, "session");
	for (const responseStatus of [401, 404, 503]) {
		status = responseStatus;
		expect(await fetchMyCampaigns()).toBeNull();
	}
	expect(calls).toEqual(
		[401, 404, 503].map(() => ({
			path: "/api/campaigns/mine",
			authorization: "Bearer session",
		}))
	);
});
test("keeps spent grants silent, warns about unreadable rows, and retains permissive expiry/provider normalization", async () => {
	values.set(TOKEN_KEY, "session");
	reply =
		'{"claims":[{"future":true}],"pools":[{"poolLabel":"Future","remainingMicroUsd":7,"isFreeProvider":true,"expiresAt":"tomorrow"},{"poolLabel":"Legacy","remainingMicroUsd":4,"isFreeProvider":"true","expiresAt":3},{"poolLabel":"Spent","remainingMicroUsd":0},{"poolLabel":"Negative","remainingMicroUsd":-1},{"poolLabel":"Overflow","remainingMicroUsd":1e400},{"poolLabel":"","remainingMicroUsd":3},null]}';
	const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		expect(await fetchMyCampaigns()).toEqual({
			pools: [
				{
					poolLabel: "Future",
					remainingMicroUsd: 7,
					isFreeProvider: true,
					expiresAt: "tomorrow",
				},
				{
					poolLabel: "Legacy",
					remainingMicroUsd: 4,
					isFreeProvider: false,
					expiresAt: null,
				},
			],
		});
		expect(warnings).toHaveBeenCalledTimes(3);
		expect(warnings.mock.calls.map((call) => call[0])).toEqual(
			Array.from(
				{ length: 3 },
				() => "[campaigns] dropped an unreadable pool balance row:"
			)
		);
	} finally {
		warnings.mockRestore();
	}
});
test("preserves malformed pool/envelope fallbacks and reports transport failures", async () => {
	values.set(TOKEN_KEY, "session");
	const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		for (const body of [
			"{}",
			'{"pools":null}',
			'{"pools":[]}',
			"4",
			"[]",
			'"text"',
		]) {
			reply = body;
			expect(await fetchMyCampaigns()).toEqual({ pools: [] });
		}
		expect(warnings).not.toHaveBeenCalled();
		reply = '{"pools":{"future":true}}';
		expect(await fetchMyCampaigns()).toEqual({ pools: [] });
		expect(warnings).toHaveBeenCalledWith(
			"[campaigns] /mine returned a non-array `pools`:",
			{ future: true }
		);
		reply = "null";
		await expect(fetchMyCampaigns()).rejects.toBeInstanceOf(TypeError);
		globalThis.fetch = Object.assign(
			async () => {
				throw new Error("offline");
			},
			{ preconnect: nativeFetch.preconnect }
		);
		await expect(fetchMyCampaigns()).rejects.toThrow("offline");
	} finally {
		warnings.mockRestore();
	}
});
