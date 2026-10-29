import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	ApiError,
	type ApiTarget,
	maySendUserIdentity,
	readJsonBody,
	request,
} from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import { fetchHealth } from "./system.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("API error compatibility", () => {
	const target: ApiTarget = {
		url: "http://127.0.0.1:8980",
		token: "node-token",
	};
	test("keeps legacy string messages and the historical error text", async () => {
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					new Response(JSON.stringify({ error: "Legacy refusal" }), {
						status: 403,
					})
				),
			{ preconnect: realFetch.preconnect }
		);
		try {
			await request(
				target,
				"/api/test",
				{ skipUserJwt: true },
				gatewayJsonValueSchema
			);
			throw new Error("Expected API refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			if (!(error instanceof ApiError)) {
				throw error;
			}
			expect(error.message).toBe("/api/test failed: 403");
			expect(error.serverMessage).toBe("Legacy refusal");
			expect(error.code).toBeUndefined();
		}
	});
	test("preserves structured safe messages and machine codes", async () => {
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: "cloud_runtime_unavailable",
								message: "Configure OpenSandbox to run this policy",
							},
						}),
						{ status: 501 }
					)
				),
			{ preconnect: realFetch.preconnect }
		);
		try {
			await request(
				target,
				"/api/cloud-environments/test/launch",
				{
					skipUserJwt: true,
				},
				gatewayJsonValueSchema
			);
			throw new Error("Expected API refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			if (!(error instanceof ApiError)) {
				throw error;
			}
			expect(error.status).toBe(501);
			expect(error.serverMessage).toBe(
				"Configure OpenSandbox to run this policy"
			);
			expect(error.code).toBe("cloud_runtime_unavailable");
		}
	});
	test("uses the same structured message decoder for response readers", async () => {
		const result = await readJsonBody(
			new Response(
				JSON.stringify({
					error: {
						code: "policy_unavailable",
						message: "This policy needs an enforced proxy",
					},
				}),
				{ status: 422 }
			),
			"Run setup",
			gatewayJsonValueSchema
		);
		expect(result.error).toBe("This policy needs an enforced proxy");
		expect(result.status).toBe(422);
	});
});

describe("managed node authentication", () => {
	test("does not mint a general account JWT for an unauthenticated node URL", () => {
		expect(
			maySendUserIdentity({
				url: "https://node.example",
				token: null,
				userJwt: null,
			})
		).toBe(false);
		expect(
			maySendUserIdentity({
				url: "https://node.example",
				token: null,
				userJwt: "node-bound",
			})
		).toBe(true);
	});
	test("uses the managed user JWT as the Core bearer when no node token exists", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			(_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				captured = init;
				return Promise.resolve(new Response("{}", { status: 200 }));
			},
			{ preconnect: realFetch.preconnect }
		);

		const target: ApiTarget = {
			url: "https://node.example",
			token: null,
			userJwt: "managed-user-jwt",
		};
		await request(target, "/api/mcp/tools", undefined, gatewayJsonValueSchema);

		const headers = new Headers(captured?.headers);
		expect(headers.get("Authorization")).toBe("Bearer managed-user-jwt");
		expect(headers.get("x-ryu-user-jwt")).toBe("managed-user-jwt");
	});

	test("keeps an explicit node token as the admission bearer", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			(_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				captured = init;
				return Promise.resolve(new Response("{}", { status: 200 }));
			},
			{ preconnect: realFetch.preconnect }
		);

		const target: ApiTarget = {
			url: "https://node.example",
			token: "node-token",
			userJwt: "managed-user-jwt",
		};
		await request(target, "/api/mcp/tools", undefined, gatewayJsonValueSchema);

		const headers = new Headers(captured?.headers);
		expect(headers.get("Authorization")).toBe("Bearer node-token");
		expect(headers.get("x-ryu-user-jwt")).toBe("managed-user-jwt");
	});

	test("does not send credentials to public health probes", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			(_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				captured = init;
				return Promise.resolve(new Response("{}", { status: 200 }));
			},
			{ preconnect: realFetch.preconnect }
		);

		await request(
			{
				token: "node-token",
				url: "https://node.example",
				userJwt: "node-delegation",
			},
			"/api/health",
			{ skipAuthentication: true },
			gatewayJsonValueSchema
		);

		const headers = new Headers(captured?.headers);
		expect(headers.has("Authorization")).toBe(false);
		expect(headers.has("x-ryu-user-jwt")).toBe(false);
	});

	test("typed health checks use the same anonymous request path", async () => {
		let captured: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			(_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				captured = init;
				return Promise.resolve(
					Response.json({ status: "ok", version: "test", capabilities: [] })
				);
			},
			{ preconnect: realFetch.preconnect }
		);

		await fetchHealth({
			url: "https://node.example",
			token: "node-token",
			userJwt: "node-bound-delegation",
		});

		const headers = new Headers(captured?.headers);
		expect(headers.has("Authorization")).toBe(false);
		expect(headers.has("x-ryu-user-jwt")).toBe(false);
	});
});

test("response readers reject invalid successful DTOs before publishing typed data", async () => {
	const result = await readJsonBody(
		Response.json({ path: 7 }),
		"Create folder",
		z.object({ path: z.string() })
	);
	expect(result.status).toBe(200);
	expect(result.data).toBeNull();
	expect(result.error).toBe("Create folder returned an invalid response.");
});
test("response readers preserve typed conflict payloads and server failure messages", async () => {
	const result = await readJsonBody(
		Response.json(
			{ kind: "conflict", error: "Changed since turn" },
			{ status: 409 }
		),
		"Reverse edits",
		z.object({ kind: z.literal("conflict") })
	);
	expect(result.data).toEqual({ kind: "conflict" });
	expect(result.error).toBe("Changed since turn");
});

describe("request response codecs", () => {
	const target: ApiTarget = { url: "http://127.0.0.1:8980", token: null };
	test("rejects malformed successful DTOs without reporting a JSON syntax failure", async () => {
		globalThis.fetch = Object.assign(
			() => Promise.resolve(Response.json({ id: 42 })),
			{ preconnect: realFetch.preconnect }
		);
		await expect(
			request(
				target,
				"/api/test",
				{ skipUserJwt: true },
				z.object({ id: z.string() })
			)
		).rejects.toBeInstanceOf(z.ZodError);
	});
	test("validates no-content responses through the endpoint codec", async () => {
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response(null, { status: 204 })),
			{ preconnect: realFetch.preconnect }
		);
		expect(
			await request(target, "/api/test", { skipUserJwt: true }, z.void())
		).toBeUndefined();
		await expect(
			request(
				target,
				"/api/test",
				{ skipUserJwt: true },
				z.object({ id: z.string() })
			)
		).rejects.toBeInstanceOf(z.ZodError);
	});
});
