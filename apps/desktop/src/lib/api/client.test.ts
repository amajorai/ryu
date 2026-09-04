import { afterEach, describe, expect, test } from "bun:test";
import { type ApiTarget, request } from "./client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("managed node authentication", () => {
	test("uses the managed user JWT as the Core bearer when no node token exists", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			captured = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as unknown as typeof fetch;

		const target: ApiTarget = {
			url: "https://node.example",
			token: null,
			userJwt: "managed-user-jwt",
		};
		await request(target, "/api/mcp/tools");

		const headers = captured?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer managed-user-jwt");
		expect(headers["x-ryu-user-jwt"]).toBe("managed-user-jwt");
	});

	test("keeps an explicit node token as the admission bearer", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			captured = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as unknown as typeof fetch;

		const target: ApiTarget = {
			url: "https://node.example",
			token: "node-token",
			userJwt: "managed-user-jwt",
		};
		await request(target, "/api/mcp/tools");

		const headers = captured?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer node-token");
		expect(headers["x-ryu-user-jwt"]).toBe("managed-user-jwt");
	});

	test("can skip the control-plane JWT exchange for node-local probes", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			captured = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as unknown as typeof fetch;

		await request(
			{ token: "node-token", url: "http://127.0.0.1:8980" },
			"/api/health",
			{ skipUserJwt: true }
		);

		const headers = captured?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer node-token");
		expect(headers["x-ryu-user-jwt"]).toBeUndefined();
	});
});
