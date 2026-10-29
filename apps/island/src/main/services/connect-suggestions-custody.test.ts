import { afterAll, expect, mock, test } from "bun:test";

let target = { coreBaseUrl: "http://127.0.0.1:8980", coreToken: "local-node" };
mock.module("./config.ts", () => ({
	loadConfig: () => target,
	coreHeaders: () => ({ Authorization: `Bearer ${target.coreToken}` }),
}));
const originalFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("switching node or credential cannot forward the previous local cloud session", async () => {
	const calls: { url: string; headers: Headers }[] = [];
	globalThis.fetch = Object.assign(
		mock(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), headers: new Headers(init?.headers) });
			return Response.json(
				String(url).endsWith("/api/auth/status")
					? { token: `cloud-${target.coreToken}` }
					: { notifications: [] }
			);
		}),
		{ preconnect: originalFetch.preconnect }
	);
	const { listConnectSuggestions } = await import("./connect-suggestions.ts");
	await listConnectSuggestions();
	expect(calls.at(-1)?.headers.get("X-Ryu-User-Jwt")).toBe("cloud-local-node");
	target = { coreBaseUrl: "https://remote.example", coreToken: "remote-node" };
	await listConnectSuggestions();
	expect(calls.at(-1)?.headers.get("X-Ryu-User-Jwt")).toBeNull();
	expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer remote-node");
	expect(
		calls.filter(
			(call) =>
				call.url.startsWith("https://remote.example") &&
				call.url.endsWith("/api/auth/status")
		)
	).toHaveLength(0);
	target = {
		coreBaseUrl: "http://127.0.0.1:8980",
		coreToken: "new-local-node",
	};
	await listConnectSuggestions();
	expect(calls.at(-1)?.headers.get("X-Ryu-User-Jwt")).toBe(
		"cloud-new-local-node"
	);
});
