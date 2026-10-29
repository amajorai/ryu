import { expect, test } from "bun:test";
import {
	activateProductMode,
	defaultProductModePreference,
	parseProductModePreference,
} from "./productMode.ts";

test("a corrupted persisted sibling does not discard valid startup and surface choices", () => {
	expect(
		parseProductModePreference({
			mode: "os",
			startupRealm: "console",
			surfaces: { bot: "/chat/..", console: "/settings", os: 42 },
		})
	).toEqual({
		mode: "os",
		startupRealm: "console",
		version: 1,
		surfaces: { bot: "/chat", console: "/settings", os: "/app-launcher" },
	});
});

test("malformed control-plane permissions cannot authorize managed Console access", async () => {
	const target = {
		url: "https://managed.example",
		token: null,
		userJwt: "delegation",
	};
	for (const payload of [
		null,
		{ permissions: [null, 42, true] },
		{ permissions: "gateway.configure" },
		{ permissions: [{ "gateway.configure": true }, "gateway.configure", 42] },
		{ organizations: [{ id: "org", role: "owner" }] },
	]) {
		const result = await activateProductMode("console", {
			activeTarget: target,
			authSourceTarget: { url: "http://localhost:2049", token: null },
			knownUnmanagedTarget: false,
			preference: defaultProductModePreference(),
			request: async (_target, path) =>
				path === "/api/auth/status"
					? { authenticated: true, token: "account" }
					: payload,
			fetchManagedNodes: async () => [
				{
					name: "managed",
					url: target.url,
					token: null,
					userJwt: "delegation",
					managed: true,
					orgId: "org",
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issue.kind).toBe("console-denied");
		}
	}
});
