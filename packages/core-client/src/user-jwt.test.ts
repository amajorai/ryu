import { describe, expect, test } from "bun:test";
import {
	coreBrokeredUserJwtExchange,
	createUserJwtSource,
	isLoopbackCoreUrl,
	readJwtExpiry,
	sessionUserJwtExchange,
} from "./user-jwt.ts";

interface TestJwtClaims {
	alg?: string;
	exp?: number;
	sub?: string;
}
const encode = (value: TestJwtClaims): string =>
	btoa(JSON.stringify(value))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const jwtWithExp = (exp: number): string =>
	`${encode({ alg: "EdDSA" })}.${encode({ exp, sub: "u1" })}.sig`;

describe("readJwtExpiry", () => {
	test("reads exp from an unpadded base64url payload", () => {
		expect(readJwtExpiry(jwtWithExp(1234))).toBe(1234);
	});

	test("returns null for malformed tokens", () => {
		expect(readJwtExpiry("not-a-jwt")).toBeNull();
		expect(readJwtExpiry("a.%%%.c")).toBeNull();
	});
});

describe("createUserJwtSource", () => {
	test("caches until the refresh margin and single-flights exchanges", async () => {
		let clock = 1_000_000;
		let calls = 0;
		const source = createUserJwtSource({
			exchange: async () => {
				calls += 1;
				return { expiresAt: 1000 + 600, token: `t${calls}` };
			},
			now: () => clock,
		});
		expect(source.current()).toBeNull();
		const [first, second] = await Promise.all([
			source.refresh(),
			source.refresh(),
		]);
		expect(first).toBe("t1");
		expect(second).toBe("t1");
		expect(calls).toBe(1);
		expect(source.current()).toBe("t1");

		clock = (1000 + 600 - 30) * 1000;
		expect(source.current()).toBeNull();
		expect(await source.refresh()).toBe("t2");
	});

	test("falls back to the token's own exp and clears on failure", async () => {
		let result: { expiresAt: number | null; token: string } | null = {
			expiresAt: null,
			token: jwtWithExp(10_000),
		};
		const source = createUserJwtSource({
			exchange: async () => result,
			now: () => 1_000_000,
		});
		expect(await source.refresh()).toBe(result?.token ?? null);
		source.clear();
		result = null;
		expect(await source.refresh()).toBeNull();
		expect(source.current()).toBeNull();
	});

	test("clear invalidates the pending token returned to its original caller", async () => {
		let deliver:
			| ((token: { expiresAt: number; token: string }) => void)
			| undefined;
		const source = createUserJwtSource({
			exchange: () =>
				new Promise((resolve) => {
					deliver = resolve;
				}),
			now: () => 1_000_000,
		});
		const previous = source.refresh();
		expect(deliver).toBeDefined();
		source.clear();
		deliver?.({ expiresAt: 1600, token: "old-account" });
		expect(await previous).toBeNull();
		expect(source.current()).toBeNull();
	});

	test("old completion cannot clear the new generation's single flight or replace its token", async () => {
		const deliveries: Array<
			(token: { expiresAt: number; token: string }) => void
		> = [];
		const source = createUserJwtSource({
			exchange: () =>
				new Promise((resolve) => {
					deliveries.push(resolve);
				}),
			now: () => 1_000_000,
		});
		const previous = source.refresh();
		source.clear();
		const current = source.refresh();
		expect(deliveries).toHaveLength(2);
		const [previousDelivery, currentDelivery] = deliveries;
		if (!(previousDelivery && currentDelivery)) {
			throw new Error("Both refresh generations must start their exchange");
		}
		previousDelivery({ expiresAt: 1600, token: "old-account" });
		expect(await previous).toBeNull();
		const concurrent = source.refresh();
		expect(deliveries).toHaveLength(2);
		currentDelivery({ expiresAt: 1600, token: "current-account" });
		expect(await current).toBe("current-account");
		expect(await concurrent).toBe("current-account");
		expect(source.current()).toBe("current-account");
	});

	test("treats a throwing exchange as signed out", async () => {
		const source = createUserJwtSource({
			exchange: () => Promise.reject(new Error("offline")),
		});
		expect(await source.refresh()).toBeNull();
	});

	test("backs off after a failed exchange until the window passes or clear()", async () => {
		let clock = 1_000_000;
		let calls = 0;
		let result: { expiresAt: number; token: string } | null = null;
		const source = createUserJwtSource({
			exchange: async () => {
				calls += 1;
				return result;
			},
			failureBackoffMs: 30_000,
			now: () => clock,
		});
		expect(await source.refresh()).toBeNull();
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(1);

		clock += 29_999;
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(1);

		clock += 1;
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(2);

		source.clear();
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(3);

		source.clear();
		result = { expiresAt: Math.floor(clock / 1000) + 600, token: "jwt" };
		expect(await source.refresh()).toBe("jwt");
		expect(calls).toBe(4);
	});

	test("a wall clock stepped back does not stretch the failure backoff", async () => {
		let clock = 1_800_000_000_000;
		let calls = 0;
		const source = createUserJwtSource({
			exchange: async () => {
				calls += 1;
				return null;
			},
			failureBackoffMs: 30_000,
			now: () => clock,
		});
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(1);

		clock -= 3_600_000;
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(2);
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(2);
	});

	test("retries immediately without failureBackoffMs", async () => {
		let calls = 0;
		const source = createUserJwtSource({
			exchange: async () => {
				calls += 1;
				return null;
			},
			now: () => 1_000_000,
		});
		expect(await source.refresh()).toBeNull();
		expect(await source.refresh()).toBeNull();
		expect(calls).toBe(2);
	});
});

describe("exchanges", () => {
	test("session exchange calls the control plane token endpoint", async () => {
		const seen: { auth: string | null; signal: boolean; url: string }[] = [];
		const exchange = sessionUserJwtExchange({
			backendUrl: "https://auth.example/",
			fetch: async (input, init) => {
				seen.push({
					auth: new Headers(init?.headers).get("authorization"),
					signal: init?.signal instanceof AbortSignal,
					url: String(input),
				});
				return Response.json({ token: "jwt" });
			},
			sessionToken: () => "session",
		});
		expect(await exchange()).toEqual({ expiresAt: null, token: "jwt" });
		expect(seen).toEqual([
			{
				auth: "Bearer session",
				signal: true,
				url: "https://auth.example/api/auth/token",
			},
		]);
	});

	test("session exchange is null when signed out", async () => {
		const exchange = sessionUserJwtExchange({
			backendUrl: "https://auth.example",
			fetch: () => Promise.reject(new Error("must not fetch")),
			sessionToken: () => null,
		});
		expect(await exchange()).toBeNull();
	});

	test("core broker exchange calls the local Core with its node token", async () => {
		const seen: { auth: string | null; signal: boolean; url: string }[] = [];
		const exchange = coreBrokeredUserJwtExchange({
			fetch: async (input, init) => {
				seen.push({
					auth: new Headers(init?.headers).get("authorization"),
					signal: init?.signal instanceof AbortSignal,
					url: String(input),
				});
				return Response.json({ expiresAt: 99, token: "jwt" });
			},
			token: "node",
			url: "http://127.0.0.1:7980/",
		});
		expect(await exchange()).toEqual({ expiresAt: 99, token: "jwt" });
		expect(seen).toEqual([
			{
				auth: "Bearer node",
				signal: true,
				url: "http://127.0.0.1:7980/api/auth/user-jwt",
			},
		]);
	});

	test("core broker exchange is null when Core refuses", async () => {
		const exchange = coreBrokeredUserJwtExchange({
			fetch: async () => new Response("{}", { status: 401 }),
			token: null,
			url: "http://127.0.0.1:7980",
		});
		expect(await exchange()).toBeNull();
	});

	test("a hung exchange is aborted at its deadline and settles the source", async () => {
		const hangUntilAborted = (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true }
				);
			});
		const session = sessionUserJwtExchange({
			backendUrl: "https://auth.example",
			fetch: hangUntilAborted,
			sessionToken: () => "session",
			timeoutMs: 5,
		});
		const broker = coreBrokeredUserJwtExchange({
			fetch: hangUntilAborted,
			timeoutMs: 5,
			token: "node",
			url: "http://127.0.0.1:7980",
		});
		await expect(session()).rejects.toMatchObject({ name: "TimeoutError" });
		await expect(broker()).rejects.toMatchObject({ name: "TimeoutError" });

		const source = createUserJwtSource({ exchange: session });
		expect(await source.refresh()).toBeNull();
	});
});

describe("isLoopbackCoreUrl", () => {
	test("recognizes local hosts only", () => {
		expect(isLoopbackCoreUrl("http://127.0.0.1:7980")).toBe(true);
		expect(isLoopbackCoreUrl("http://localhost:8980")).toBe(true);
		expect(isLoopbackCoreUrl("http://[::1]:7980")).toBe(true);
		expect(isLoopbackCoreUrl("https://node.example.ts.net")).toBe(false);
		expect(isLoopbackCoreUrl("not a url")).toBe(false);
	});
});
