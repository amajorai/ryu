import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createServer } from "vite";
import { proofProxyAuthorization } from "./proof-proxy-authorization.ts";
import {
	qoderProofRoutes,
	usageHistoryProofRoutes,
	voiceProofRoutes,
} from "./proof-proxy-routes.ts";

describe("isolated live proof proxy", () => {
	test("rejects anonymous and cross-site callers before owner-token injection", async () => {
		let requests = 0;
		const upstream = createHttpServer((request, response) => {
			requests++;
			request.resume();
			response.setHeader("Connection", "close");
			response.end(
				JSON.stringify({ authorization: request.headers.authorization })
			);
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve)
		);
		const address = upstream.address();
		if (!address || isNativeText(address)) {
			throw new Error("Missing isolated upstream address");
		}
		const capability = randomBytes(32).toString("base64url");
		const port = 5386;
		const rejectedStatus = async (url: string, init: RequestInit = {}) => {
			const response = await fetch(url, init);
			await response.arrayBuffer();
			return response.status;
		};
		const server = await createServer({
			configFile: false,
			optimizeDeps: { noDiscovery: true, include: [] },
			plugins: [
				proofProxyAuthorization(capability, port, [
					{ methods: ["POST"], path: /^\/api\/probe$/u },
					...usageHistoryProofRoutes,
					...voiceProofRoutes,
					...qoderProofRoutes,
				]),
			],
			server: {
				watch: null,
				host: "127.0.0.1",
				port,
				strictPort: true,
				proxy: {
					"/api": {
						target: `http://127.0.0.1:${address.port}`,
						configure(proxy) {
							proxy.on("proxyReq", (request) =>
								request.setHeader(
									"authorization",
									"Bearer isolated-owner-fixture"
								)
							);
						},
					},
				},
			},
		});
		try {
			await server.listen();
			const url = `http://127.0.0.1:${port}/api/probe`;
			const rejectedHeaders: HeadersInit[] = [
				{},
				{ authorization: "Bearer wrong" },
				{
					authorization: `Bearer ${capability}`,
					origin: "https://outside.invalid",
				},
				{
					authorization: `Bearer ${capability}`,
					"sec-fetch-site": "cross-site",
				},
				{ authorization: `Bearer ${"é".repeat(capability.length)}` },
			];
			for (const headers of rejectedHeaders) {
				expect(await rejectedStatus(url, { method: "POST", headers })).toBe(
					403
				);
			}
			expect(requests).toBe(0);
			for (const path of [
				"/api/node/token/rotate",
				"/api/mcp/servers",
				"/api/git/file-diff",
				"/api/probe/extra",
				"/api/%70robe",
			]) {
				expect(
					await rejectedStatus(`http://127.0.0.1:${port}${path}`, {
						method: "POST",
						headers: { authorization: `Bearer ${capability}` },
					})
				).toBe(403);
			}
			expect(
				(
					await fetch(url, {
						headers: { authorization: `Bearer ${capability}` },
					})
				).status
			).toBe(403);
			expect(requests).toBe(0);
			const result = await fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${capability}`,
					origin: `http://127.0.0.1:${port}`,
					"sec-fetch-site": "same-origin",
				},
			});
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual({
				authorization: "Bearer isolated-owner-fixture",
			});
			expect(requests).toBe(1);
			for (const [method, path] of [
				["GET", "/api/usage/history?scope=session"],
				["PUT", "/api/usage/history/tracking"],
				["POST", "/api/usage/history/import"],
				["GET", "/api/voice/tts-models"],
				["POST", "/api/voice/speak"],
				["GET", "/api/pi-config/catalog"],
				["POST", "/api/pi-config/providers"],
				["PUT", "/api/pi-config"],
				["POST", "/api/pi-config/discover-models"],
			]) {
				const requestInit: RequestInit = {
					method,
					headers: {
						authorization: `Bearer ${capability}`,
						"content-type": "application/json",
					},

					signal: AbortSignal.timeout(5000),
				};
				if (method !== "GET") {
					requestInit.body = "{}";
				}
				const control = await fetch(
					`http://127.0.0.1:${port}${path}`,
					requestInit
				);
				expect(control.status).toBe(200);
				expect(await control.json()).toEqual({
					authorization: "Bearer isolated-owner-fixture",
				});
			}
		} finally {
			await server.close();
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve()))
			);
		}
	}, 120_000);
	for (const [name, routes, controls] of [
		[
			"usage",
			usageHistoryProofRoutes,
			[
				["GET", "/api/usage/history"],
				["PUT", "/api/usage/history/tracking"],
				["POST", "/api/usage/history/import"],
				["GET", "/api/usage/history/import/operations/fixture-id"],
			],
		],
		[
			"voice",
			voiceProofRoutes,
			[
				["GET", "/api/voice/tts-engines"],
				["GET", "/api/voice/tts-models"],
				["POST", "/api/voice/speak"],
			],
		],
		[
			"qoder",
			qoderProofRoutes,
			[
				["GET", "/api/pi-config/catalog"],
				["PUT", "/api/pi-config"],
				["POST", "/api/pi-config/providers"],
				["POST", "/api/pi-config/discover-models"],
			],
		],
	] as const) {
		test(`${name} route scope retains its UI operations and denies owner administration`, () => {
			for (const [method, path] of controls) {
				expect(
					routes.some(
						(route) =>
							route.methods.some((allowedMethod) => allowedMethod === method) &&
							route.path.test(path)
					)
				).toBe(true);
			}
			for (const path of [
				"/api/node/token/rotate",
				"/api/mcp/servers",
				"/api/git/reverse-edits",
				"/api/pi-config/qoder/v1/chat/completions",
			]) {
				expect(routes.some((route) => route.path.test(path))).toBe(false);
			}
		});
	}
});
