import { expect, test } from "bun:test";
import {
	cancelNativeAccountLogin,
	createNativeAccount,
	disconnectNativeAccount,
	listNativeAccounts,
	logoutNativeAccount,
	nativeAccountLoginProgress,
	startNativeAccountLogin,
} from "./native-accounts.ts";

test("native lifecycle HTTP requests retain managed identity and encode resource ids", async () => {
	const received: { body: unknown; method: string; path: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer node-secret");
			expect(request.headers.get("x-ryu-user-jwt")).toBe("managed-user");
			received.push({
				path: new URL(request.url).pathname,
				method: request.method,
				body:
					request.method === "POST" &&
					request.headers.get("content-length") !== "0"
						? await request.text()
						: null,
			});
			const path = new URL(request.url).pathname;
			if (path.includes("/operations/")) {
				return Response.json(
					request.method === "DELETE"
						? { cancelled: true }
						: {
								operation: {
									accountId: "account/one",
									error: null,
									instructions: "Sign in with the native CLI",
									operationId: "operation/one",
									state: "running",
								},
							}
				);
			}
			if (path.endsWith("/login")) {
				return Response.json({
					accountId: "account/one",
					operationId: "operation/one",
					state: "running",
					verified: false,
				});
			}
			if (path.endsWith("/disconnect")) {
				return Response.json({ disconnected: true });
			}
			if (path.endsWith("/logout")) {
				return Response.json({ loggedOut: true });
			}
			return Response.json(
				request.method === "POST"
					? {
							account: {
								accountId: "account/one",
								active: false,
								kind: "native_cli",
								label: "Work",
								state: "pending",
								verified: false,
							},
						}
					: { nativeAccounts: true, accounts: [] }
			);
		},
	});
	const target = {
		url: server.url.toString(),
		token: "node-secret",
		userJwt: "managed-user",
	};
	try {
		await listNativeAccounts(target, "acp:qwen");
		await createNativeAccount(target, "acp:qwen", "Work");
		await startNativeAccountLogin(target, "acp:qwen", "account/one");
		await nativeAccountLoginProgress(target, "acp:qwen", "operation/one");
		await cancelNativeAccountLogin(target, "acp:qwen", "operation/one");
		await disconnectNativeAccount(target, "acp:qwen", "account/one");
		await logoutNativeAccount(target, "acp:qwen", "account/one");
		expect(received.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"GET /api/agents/acp%3Aqwen/native-accounts",
			"POST /api/agents/acp%3Aqwen/native-accounts",
			"POST /api/agents/acp%3Aqwen/native-accounts/account%2Fone/login",
			"GET /api/agents/acp%3Aqwen/native-accounts/operations/operation%2Fone",
			"DELETE /api/agents/acp%3Aqwen/native-accounts/operations/operation%2Fone",
			"POST /api/agents/acp%3Aqwen/native-accounts/account%2Fone/disconnect",
			"POST /api/agents/acp%3Aqwen/native-accounts/account%2Fone/logout",
		]);
		expect(received[1]?.body).toBe('{"label":"Work"}');
	} finally {
		server.stop(true);
	}
});
