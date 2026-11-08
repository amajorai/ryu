import { afterEach, describe, expect, it } from "bun:test";
import {
	clearAgentEgressAllowlist,
	fetchAgentEgressAllowlist,
	formatAllowlistText,
	parseAllowlistText,
	saveAgentEgressAllowlist,
} from "./agent-egress-allowlist.ts";
import type { ApiTarget } from "./client.ts";

const target: ApiTarget = {
	url: "https://allowlist-client.fixture",
	token: "allowlist-token",
	userJwt: null,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function answer(
	allowlist: string[] | null,
	seen: { url: string; method: string; body?: string }[]
) {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body === undefined ? undefined : String(init.body),
			});
			return Promise.resolve(Response.json({ agent_id: "a", allowlist }));
		},
		{ preconnect: originalFetch.preconnect }
	);
}

describe("agent egress allowlist text", () => {
	it("splits lines and commas and drops blanks", () => {
		expect(parseAllowlistText(" a.com\n\n*.b.org, c.net ,\n")).toEqual([
			"a.com",
			"*.b.org",
			"c.net",
		]);
		expect(parseAllowlistText("   ")).toEqual([]);
	});

	it("formats one host per line", () => {
		expect(formatAllowlistText(["a.com", "*.b.org"])).toBe("a.com\n*.b.org");
	});
});

describe("agent egress allowlist requests", () => {
	it("reads, writes and clears one agent's list at its own path", async () => {
		const seen: { url: string; method: string; body?: string }[] = [];
		answer(["a.com"], seen);
		expect(await fetchAgentEgressAllowlist(target, "acp:claude")).toEqual([
			"a.com",
		]);
		expect(
			await saveAgentEgressAllowlist(target, "acp:claude", ["A.com"])
		).toEqual(["a.com"]);
		answer(null, seen);
		await clearAgentEgressAllowlist(target, "acp:claude");
		expect(
			seen.map(({ url, method }) => [new URL(url).pathname, method])
		).toEqual([
			["/api/agents/acp%3Aclaude/egress-allowlist", "GET"],
			["/api/agents/acp%3Aclaude/egress-allowlist", "PUT"],
			["/api/agents/acp%3Aclaude/egress-allowlist", "DELETE"],
		]);
		expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({ allowlist: ["A.com"] });
	});

	it("reads an unrestricted agent as null", async () => {
		answer(null, []);
		expect(await fetchAgentEgressAllowlist(target, "agent-1")).toBeNull();
	});
});
