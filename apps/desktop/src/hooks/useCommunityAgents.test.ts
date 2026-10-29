import { describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

if (!globalThis.window) {
	GlobalRegistrator.register();
}
// SAFETY: The actual installed ReactDOM act environment reads this optional
// global flag. This test writes the authored boolean true to that native hook;
// the declaration gap concerns only this flag, without asserting other globals
// or replacing the registered DOM/native React test environment.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const installPublishedAgent = mock(async () => ({
	agent: { id: "installed-agent" },
	requestedSpaceCount: 0,
	requires: {},
}));

mock.module("@/src/lib/api/agents.ts", () => ({ installPublishedAgent }));
mock.module("@/src/lib/api/marketplace.ts", () => ({
	fetchCatalog: mock(async () => []),
}));
mock.module("@/src/lib/auth-client.ts", () => ({
	getActiveUserId: () => "account-a",
}));
mock.module("@/src/lib/core-refresh.ts", () => ({
	triggerAgentsRefresh: mock(),
}));
mock.module("./useActiveNode.ts", () => ({
	useActiveNode: () => ({ url: "https://node-a.example", token: "token-a" }),
}));

const {
	communityAgentInstallCacheKey,
	communityAgentInstallIdempotencyKey,
	useCommunityAgents,
} = await import("./useCommunityAgents.ts");

describe("community agent install cache keys", () => {
	test("separates node URL, node token, and account", () => {
		const base = communityAgentInstallCacheKey(
			{ url: "https://node-a.example/", token: "token-a", userJwt: null },
			"account-a",
			"listing-1"
		);

		expect(
			communityAgentInstallCacheKey(
				{ url: "https://node-b.example", token: "token-a", userJwt: null },
				"account-a",
				"listing-1"
			)
		).not.toBe(base);
		expect(
			communityAgentInstallCacheKey(
				{ url: "https://node-a.example", token: "token-b", userJwt: null },
				"account-a",
				"listing-1"
			)
		).not.toBe(base);
		expect(
			communityAgentInstallCacheKey(
				{ url: "https://node-a.example", token: "token-a", userJwt: null },
				"account-b",
				"listing-1"
			)
		).not.toBe(base);
	});

	test("treats a trailing slash as the same node URL", () => {
		expect(
			communityAgentInstallCacheKey(
				{ url: "https://node-a.example/", token: null, userJwt: null },
				null,
				"listing-1"
			)
		).toBe(
			communityAgentInstallCacheKey(
				{ url: "https://node-a.example", token: null, userJwt: null },
				null,
				"listing-1"
			)
		);
	});

	test("idempotency key is scoped to node, account, and listing, not token", () => {
		const key = communityAgentInstallIdempotencyKey(
			{ url: "https://node-a.example/", token: "token-a", userJwt: null },
			"account-a",
			"listing-1"
		);
		expect(
			communityAgentInstallIdempotencyKey(
				{ url: "https://node-a.example", token: "token-b", userJwt: null },
				"account-a",
				"listing-1"
			)
		).toBe(key);
		expect(
			communityAgentInstallIdempotencyKey(
				{ url: "https://node-b.example", token: "token-a", userJwt: null },
				"account-a",
				"listing-1"
			)
		).not.toBe(key);
		expect(
			communityAgentInstallIdempotencyKey(
				{ url: "https://node-a.example", token: "token-a", userJwt: null },
				"account-b",
				"listing-1"
			)
		).not.toBe(key);
	});
});

describe("useCommunityAgents install lifecycle", () => {
	test("does not reuse a completed install after the agent is deleted", async () => {
		let hookResult: ReturnType<typeof useCommunityAgents> | undefined;
		function Harness(): ReactNode {
			hookResult = useCommunityAgents();
			return null;
		}
		const root = createRoot(document.createElement("div"));
		await act(async () => {
			root.render(createElement(Harness));
		});

		await act(async () => {
			await hookResult?.install("listing-1");
		});
		await act(async () => {
			await hookResult?.install("listing-1");
		});

		expect(installPublishedAgent).toHaveBeenCalledTimes(2);
		await act(async () => {
			root.unmount();
		});
	});
});
