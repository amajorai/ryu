import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { TOKEN_KEY, vaultHydrated } from "@/lib/auth-client.ts";
import { clearRealtimeJwt, getRealtimeJwt, getRealtimeUserId } from "./jwt.ts";

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
let responseText = "{}";
let responseStatus = 200;
let calls = 0;
let authorization: string | null = null;
let signal: AbortSignal | null = null;
const reply = async (
	_input: Parameters<typeof fetch>[0],
	options?: RequestInit
) => {
	calls += 1;
	authorization = new Headers(options?.headers).get("authorization");
	signal = options?.signal ?? null;
	return new Response(responseText, { status: responseStatus });
};
function token(payload: string) {
	return `header.${btoa(payload).replaceAll("+", "-").replaceAll("/", "_")}.signature`;
}
function respondWithToken(payload: string) {
	const minted = token(payload);
	responseText = JSON.stringify({ token: minted });
	return minted;
}
// Importing auth-client starts vault hydration, which migrates any legacy
// session token it later finds in localStorage by fetching the account profile.
// Settle it first so that fetch can never land in a test's counted calls.
beforeAll(async () => {
	await vaultHydrated;
});
beforeEach(() => {
	clearRealtimeJwt();
	values.clear();
	calls = 0;
	authorization = null;
	signal = null;
	responseStatus = 200;
	responseText = "{}";
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	globalThis.fetch = Object.assign(reply, {
		preconnect: nativeFetch.preconnect,
	});
});
afterEach(() => {
	clearRealtimeJwt();
	globalThis.fetch = nativeFetch;
	if (storageDescriptor) {
		Object.defineProperty(globalThis, "localStorage", storageDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});
it("joins anonymously without a session and validates the token endpoint reply", async () => {
	expect(await getRealtimeJwt()).toBeNull();
	expect(calls).toBe(0);
	storage.setItem(TOKEN_KEY, "session");
	for (const body of ["null", "[]", '{"token":42}', "not-json"]) {
		clearRealtimeJwt();
		responseText = body;
		expect(await getRealtimeJwt()).toBeNull();
	}
	expect(calls).toBe(4);
	expect(authorization).toBe("Bearer session");
	expect(signal).toBeInstanceOf(AbortSignal);
});
it("coalesces concurrent exchanges and invalidates cached identity when the account changes", async () => {
	storage.setItem(TOKEN_KEY, "first");
	const first = respondWithToken('{"id":"first-id"}');
	expect(await Promise.all([getRealtimeJwt(), getRealtimeJwt()])).toEqual([
		first,
		first,
	]);
	expect(calls).toBe(1);
	expect(await getRealtimeUserId()).toBe("first-id");
	expect(calls).toBe(1);
	storage.setItem(TOKEN_KEY, "second");
	respondWithToken('{"sub":"second-id"}');
	expect(await getRealtimeUserId()).toBe("second-id");
	expect(calls).toBe(2);
	expect(authorization).toBe("Bearer second");
	storage.removeItem(TOKEN_KEY);
	expect(await getRealtimeUserId()).toBeNull();
});
it("retains native expiration and id-before-sub semantics for legacy JSON claims", async () => {
	storage.setItem(TOKEN_KEY, "session");
	for (const [payload, expected] of [
		['{"id":null,"sub":"fallback"}', "fallback"],
		['{"id":4,"sub":"fallback"}', null],
		['{"id":"","sub":"fallback"}', null],
		['{"sub":"subject","exp":1e400}', "subject"],
		['{"sub":"subject","exp":"legacy"}', "subject"],
		["[]", null],
		["null", null],
		["not-json", null],
	] satisfies [string, string | null][]) {
		clearRealtimeJwt();
		respondWithToken(payload);
		expect(await getRealtimeUserId()).toBe(expected);
	}
	clearRealtimeJwt();
	respondWithToken('{"id":"expired","exp":0}');
	const previous = calls;
	await getRealtimeJwt();
	await getRealtimeJwt();
	expect(calls - previous).toBe(2);
});
it("backs off a rejected exchange per session token until cleared or re-signed-in", async () => {
	storage.setItem(TOKEN_KEY, "session");
	responseStatus = 401;
	expect(await getRealtimeJwt()).toBeNull();
	expect(calls).toBe(1);
	responseStatus = 200;
	const minted = respondWithToken('{"sub":"recovered"}');
	// A revoked session or auth outage must not become one token call per
	// Core request: the failure is remembered for this session token.
	expect(await Promise.all([getRealtimeJwt(), getRealtimeJwt()])).toEqual([
		null,
		null,
	]);
	expect(calls).toBe(1);
	clearRealtimeJwt();
	expect(await getRealtimeJwt()).toBe(minted);
	expect(calls).toBe(2);

	clearRealtimeJwt();
	responseStatus = 503;
	expect(await getRealtimeJwt()).toBeNull();
	expect(calls).toBe(3);
	responseStatus = 200;
	storage.setItem(TOKEN_KEY, "signed-in-again");
	expect(await getRealtimeJwt()).toBe(minted);
	expect(calls).toBe(4);
	expect(authorization).toBe("Bearer signed-in-again");
});
