// `ryu connect …` (Treg parity B12) against one loopback stand-in for a
// Connect deployment and the control plane's tool catalog. Fixture answers
// are typed with the protocol's own browse shapes, so the client is proved
// to read what the control plane serves.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	BrowseCost,
	BrowsePlatformDetail,
	BrowsePlatformIndex,
} from "@ryuhq/protocol/tool-catalog-browse";
import {
	catalogUrl,
	formatCatalogCost,
	isConnectToolsInvocation,
	parseConnectArgs,
} from "../cli/connect.ts";
import {
	ConnectClient,
	ConnectError,
	formatMicroUsd,
} from "../cli/connectClient.ts";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO } from "../cli/types.ts";

const KEY = "ryu_connect_test_key";

interface Seen {
	body: string;
	headers: Headers;
	method: string;
	url: URL;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;

const cost = (
	usd: number | null,
	basis: BrowseCost["basis"] = "one_call"
): BrowseCost => ({
	basis,
	checked_on: "2026-10-20",
	confidence: "high",
	currency: "USD",
	free: usd === 0,
	metered_by: basis === "base_call" ? ["result"] : [],
	per: 1,
	provenance: "vendor_page",
	source: "ryu",
	source_url: "https://exa.ai/pricing",
	unit: "call",
	usd,
	value: usd,
});

const INDEX: BrowsePlatformIndex = {
	generated_at: "2026-10-21T00:00:00.000Z",
	platforms: [
		{
			capabilities: 2,
			endpoints: 3,
			label: "Web",
			price_from: cost(0.005, "base_call"),
			providers: ["brave", "exa"],
			slug: "web",
			source: "ryu",
			summary: "Search the web",
			verified_endpoints: 2,
		},
	],
	source: "ryu",
	type: "ryu.tool_catalog.platforms",
	version: 1,
};

const DETAIL = {
	...INDEX.platforms[0],
	domains: [
		{
			id: "search",
			label: "Search",
			rows: [
				{
					capability: "web/search",
					capability_name: "Search the web",
					cheapest_endpoint: "brave.web.search",
					compared: true,
					comparison_key: "web/search",
					model: null,
					endpoints: [
						{
							capability: "web/search",
							capability_id: "search.web",
							capability_name: "Search the web",
							cost: cost(0.005),
							docs_url:
								"https://api-dashboard.search.brave.com/app/documentation",
							id: "brave.web.search",
							model: null,
							name: "Brave web search",
							operation: null,
							paid_routing_allowed: true,
							platform: "web",
							platform_blocked: null,
							platform_eligible: true,
							provider: "brave",
							provider_display: "Brave",
							reliability: null,
							reviews: null,
							source: "ryu",
							spec: null,
							summary: "Web search",
							tier: "curated",
							toolkit: null,
							verification: {
								checked_on: "2026-10-21",
								method: "docs_page",
								state: "verified",
								successor: null,
								verified_on: "2026-10-21",
							},
						},
					],
				},
			],
		},
	],
	generated_at: "2026-10-21T00:00:00.000Z",
	type: "ryu.tool_catalog.platform",
	version: 1,
} satisfies BrowsePlatformDetail;

function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {}
) {
	return Response.json(body, { status, headers });
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				url,
				method: request.method,
				headers: request.headers,
				body: await request.text(),
			});
			if (url.pathname === "/catalog/api/tool-catalog/catalog/platforms") {
				return json(INDEX);
			}
			if (url.pathname === "/catalog/api/tool-catalog/catalog/platforms/web") {
				return json(DETAIL);
			}
			if (url.pathname === "/health") {
				return json({
					apiVersion: "v1",
					service: "ryu-connect",
					version: "0.4.0",
				});
			}
			if (url.pathname === "/moved/health") {
				return Response.redirect("https://evil.example.com/", 302);
			}
			if (request.headers.get("authorization") !== `Bearer ${KEY}`) {
				return json({ code: "unauthorized", ok: false }, 401);
			}
			if (url.pathname === "/v1/balance") {
				return json({
					object: "balance",
					availableMicroUsd: 12_500_000,
					billed: true,
					heldMicroUsd: 400,
					headroomMicroUsd: 13_000_000,
					suspended: false,
					topUpUrl: "https://ryuhq.com/billing",
					unsettledMicroUsd: 499_600,
					unsettledSince: "2026-10-21T00:00:00.000Z",
				});
			}
			if (url.pathname === "/v1/tools/search") {
				if (url.searchParams.get("q") === "nothing here") {
					return json({
						object: "list",
						data: [],
						missedTerms: ["nothing"],
						didYouMean: ["composio.NOTION_SEARCH_NOTION_PAGE"],
					});
				}
				return json({
					object: "list",
					data: [
						{
							id: "composio.GITHUB_CREATE_AN_ISSUE",
							name: "Create an issue",
							description: "Creates an issue",
							kind: "composio",
							provider: "ryu",
							tier: "native",
							toolkit: "github",
							price: {
								amountMicroUsd: 400,
								estimated: false,
								per: "call",
								source: "connect_native",
							},
							score: 3.25,
							catalog: { state: "verified", source: "ryu" },
						},
					],
				});
			}
			if (url.pathname === "/v1/tools/describe") {
				if (url.searchParams.get("id") !== "composio.GITHUB_GET_AN_ISSUE") {
					return json(
						{ code: "not_found", didYouMean: ["composio.GITHUB_GET_AN_ISSUE"] },
						404
					);
				}
				return json({
					id: "composio.GITHUB_GET_AN_ISSUE",
					name: "Get an issue",
					description: "Gets one issue or pull request by number.",
					kind: "composio",
					provider: "ryu",
					tier: "native",
					toolkit: "github",
					price: {
						amountMicroUsd: 400,
						estimated: false,
						per: "call",
						source: "connect_native",
					},
					reliability: {
						sufficient: true,
						successRate: 0.995,
						p50Ms: 180,
						p95Ms: 420,
					},
					parameters: { type: "object", required: ["owner"] },
				});
			}
			if (url.pathname === "/v1/tools/requests" && request.method === "POST") {
				return json({ ok: true, status: "received", id: "treq_1" }, 201);
			}
			if (url.pathname === "/v1/exec/tool" && request.method === "POST") {
				const body = JSON.parse(seen.at(-1)?.body ?? "{}") as {
					tool_id: string;
				};
				if (body.tool_id === "composio.SLACK_SEND_MESSAGE") {
					return json(
						{
							code: "precondition_required",
							error: "Connect the slack account",
							ok: false,
							precondition: {
								kind: "connection",
								toolkit: "slack",
								linkPath: "/v1/composio/link",
							},
						},
						403
					);
				}
				if (body.tool_id === "composio.BUSY") {
					return json(
						{ code: "rate_limited", error: "Slow down", ok: false },
						429,
						{
							"retry-after": "12",
						}
					);
				}
				return json({
					ok: true,
					result: {
						content: [{ type: "text", text: '{"number":1}' }],
						structuredContent: { number: 1 },
					},
					ryuCallId: "rcl_123",
					costMicroUsd: 400,
					chargedMicroUsd: 460,
					estimated: false,
					exceededMaxCost: false,
					ledgerRefId: null,
					priceSource: "connect_native",
				});
			}
			return json({ code: "not_found", ok: false }, 404);
		},
	});
});

afterAll(() => {
	server.stop(true);
});

function base(): string {
	return `http://127.0.0.1:${server.port}`;
}

async function run(
	argv: string[],
	env: Record<string, string | undefined> = {}
) {
	let out = "";
	let err = "";
	const io: CliIO = {
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
	};
	seen.length = 0;
	const code = await runCli(["connect", ...argv], {
		io,
		env: {
			RYU_CONNECT_URL: base(),
			RYU_CONNECT_KEY: KEY,
			RYU_TOOL_CATALOG_URL: `${base()}/catalog/api/tool-catalog`,
			...env,
		},
		readStdin: () =>
			Promise.resolve('{"owner":"o","repo":"r","issue_number":1}'),
	});
	return { code, out, err };
}

describe("argument parsing and formatting", () => {
	test("the first word routes 'connect' between Ryu Connect and a coding agent", () => {
		for (const argv of [
			[],
			["--json"],
			["help"],
			["browse", "web"],
			["--url", "https://connect.example", "search", "x"],
			["call", "composio.X", "--args", "{}"],
		]) {
			expect(isConnectToolsInvocation(argv)).toBe(true);
		}
		for (const argv of [
			["claude-code"],
			["codex", "--token-env"],
			["--agent", "status", "cursor"],
			["notepad"],
		]) {
			expect(isConnectToolsInvocation(argv)).toBe(false);
		}
	});

	test("value flags take the next token or an inline value; unknown flags are refused", () => {
		expect(
			parseConnectArgs([
				"call",
				"x",
				"--args={}",
				"--max-cost",
				"500",
				"--json",
			])
		).toEqual({
			positional: ["call", "x"],
			values: { args: "{}", maxCost: "500" },
		});
		expect(() => parseConnectArgs(["search", "--bogus"])).toThrow(
			"Unknown option"
		);
		expect(() => parseConnectArgs(["call", "x", "--args"])).toThrow(
			"needs a value"
		);
	});

	test("the catalog URL follows Core's default chain", () => {
		expect(catalogUrl({})).toBe("https://api.ryuhq.com/api/tool-catalog");
		expect(catalogUrl({ RYU_SERVER_URL: "https://cp.example.com/" })).toBe(
			"https://cp.example.com/api/tool-catalog"
		);
		expect(() => catalogUrl({ RYU_TOOL_CATALOG_URL: "off" })).toThrow(
			"turned off"
		);
	});

	test("prices read as dollars and say what they cover", () => {
		expect(formatMicroUsd(400)).toBe("$0.0004");
		expect(formatMicroUsd(12_500_000)).toBe("$12.5");
		expect(formatMicroUsd(null)).toBe("-");
		expect(formatCatalogCost(cost(0.005))).toBe("$0.005");
		expect(formatCatalogCost(cost(0.005, "base_call"))).toBe("$0.005+");
		expect(formatCatalogCost(cost(null, "usage"))).toBe("usage");
		expect(formatCatalogCost(cost(null))).toBe("unverified");
		expect(formatCatalogCost(cost(0))).toBe("free");
	});

	test("the key is never sent to a non-loopback plain HTTP URL", () => {
		expect(() => new ConnectClient("http://connect.example.com", KEY)).toThrow(
			"HTTPS"
		);
		expect(
			() => new ConnectClient("https://u:p@connect.example.com", KEY)
		).toThrow();
	});
});

describe("ryu connect", () => {
	test("no subcommand prints live status", async () => {
		const { code, out } = await run([]);
		expect(code).toBe(0);
		expect(out).toContain(`Connect  ${base()}  ryu-connect 0.4.0`);
		expect(out).toContain("Key      set (RYU_CONNECT_KEY)");
		expect(out).toContain("Balance  $12.5 available, $0.0004 held");
		const json = await run(["--json"]);
		expect(JSON.parse(json.out)).toMatchObject({
			service: "ryu-connect",
			key: true,
			balance: { availableMicroUsd: 12_500_000 },
		});
	});

	test("status without a URL is a usage error", async () => {
		const { code, err } = await run([], { RYU_CONNECT_URL: undefined });
		expect(code).toBe(2);
		expect(err).toContain("RYU_CONNECT_URL");
	});

	test("browse lists platforms and one platform's endpoints, with no key", async () => {
		const index = await run(["browse"], { RYU_CONNECT_KEY: undefined });
		expect(index.code).toBe(0);
		expect(index.out).toMatch(
			/PLATFORM\s+ENDPOINTS\s+VERIFIED\s+FROM\s+PROVIDERS/u
		);
		expect(index.out).toMatch(/web\s+3\s+2\s+\$0\.005\+\s+brave, exa/u);
		expect(seen[0]?.headers.get("authorization")).toBeNull();
		const detail = await run(["browse", "web"]);
		expect(detail.out).toMatch(
			/Search the web\s+brave\.web\.search\s+Brave\s+\$0\.005\s+verified\s+cheapest/u
		);
		const bad = await run(["browse", "../x"]);
		expect(bad.code).toBe(1);
	});

	test("search shows price, catalog state and score; a miss shows suggestions", async () => {
		const found = await run([
			"search",
			"create",
			"github",
			"issue",
			"--limit",
			"5",
		]);
		expect(found.code).toBe(0);
		expect(seen[0]?.url.searchParams.get("q")).toBe("create github issue");
		expect(seen[0]?.url.searchParams.get("limit")).toBe("5");
		expect(found.out).toMatch(
			/composio\.GITHUB_CREATE_AN_ISSUE\s+ryu\s+native\s+\$0\.0004\s+verified\s+3\.25/u
		);
		const missed = await run(["search", "nothing", "here"]);
		expect(missed.out).toContain("No tool matched: nothing");
		expect(missed.out).toContain(
			"Did you mean: composio.NOTION_SEARCH_NOTION_PAGE"
		);
		expect((await run(["search", "x", "--limit", "99"])).code).toBe(2);
	});

	test("describe prints price, reliability and parameters; unknown ids suggest", async () => {
		const { code, out } = await run([
			"describe",
			"composio.GITHUB_GET_AN_ISSUE",
		]);
		expect(code).toBe(0);
		expect(out).toContain("Price      $0.0004 per call (connect_native)");
		expect(out).toContain(
			"Reliable   99.5% over 7 days, p50 180 ms, p95 420 ms"
		);
		expect(out).toContain('"required": [');
		const unknown = await run(["describe", "composio.GITHUB_GET_ISSUE"]);
		expect(unknown.code).toBe(1);
		expect(unknown.err).toContain("Did you mean: composio.GITHUB_GET_AN_ISSUE");
	});

	test("request files a missing tool", async () => {
		const { code, out } = await run([
			"request",
			"Post",
			"to",
			"Mastodon",
			"--toolkit",
			"mastodon",
		]);
		expect(code).toBe(0);
		expect(out).toBe("Request received (treq_1).\n");
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
			description: "Post to Mastodon",
			toolkit: "mastodon",
		});
	});

	test("call prints the result and one JSON line with the call id and charge", async () => {
		const { code, out, err } = await run([
			"call",
			"composio.GITHUB_GET_AN_ISSUE",
			"--args-file",
			"-",
			"--max-cost",
			"1000",
			"--idempotency-key",
			"retry-label-1",
		]);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toEqual({ number: 1 });
		const request = seen[0];
		expect(request?.headers.get("idempotency-key")).toBe("retry-label-1");
		expect(request?.headers.get("x-ryu-max-cost-micro-usd")).toBe("1000");
		expect(JSON.parse(request?.body ?? "{}")).toEqual({
			tool_id: "composio.GITHUB_GET_AN_ISSUE",
			arguments: { owner: "o", repo: "r", issue_number: 1 },
		});
		expect(JSON.parse(err)).toEqual({
			call_id: "rcl_123",
			tool: "composio.GITHUB_GET_AN_ISSUE",
			ok: true,
			charged_micro_usd: 460,
			cost_micro_usd: 400,
			estimated: false,
			price_source: "connect_native",
			exceeded_max_cost: false,
			idempotency_key: "retry-label-1",
		});
	});

	test("call generates a fresh idempotency label and refuses non-object arguments", async () => {
		const first = await run(["call", "composio.X", "--args", "{}", "--json"]);
		expect(first.code).toBe(0);
		const label = JSON.parse(first.out).idempotencyKey as string;
		expect(label).toMatch(/^ryu-cli-[0-9a-f-]{36}$/u);
		expect(seen[0]?.headers.get("idempotency-key")).toBe(label);
		expect((await run(["call", "composio.X", "--args", "[1]"])).code).toBe(2);
		expect((await run(["call", "composio.X", "--args", "{"])).code).toBe(2);
	});

	test("refusals say what to do next", async () => {
		const unlinked = await run(["call", "composio.SLACK_SEND_MESSAGE"]);
		expect(unlinked.code).toBe(1);
		expect(unlinked.err).toContain("Error: Connect the slack account");
		expect(unlinked.err).toContain(
			"Connect the slack account (in Ryu, from Integrations)"
		);
		const busy = await run(["call", "composio.BUSY"]);
		expect(busy.err).toContain("Retry after 12 s.");
		const json = await run(["call", "composio.BUSY", "--json"]);
		expect(JSON.parse(json.err)).toMatchObject({
			code: "rate_limited",
			status: 429,
		});
		const noKey = await run(["balance"], { RYU_CONNECT_KEY: undefined });
		expect(noKey.code).toBe(1);
		expect(noKey.err).toContain("RYU_CONNECT_KEY");
		const wrongKey = await run(["balance"], { RYU_CONNECT_KEY: "wrong" });
		expect(wrongKey.err).toContain("unauthorized");
	});

	test("balance shows what new calls can spend", async () => {
		const { out } = await run(["balance"]);
		expect(out).toContain("Available  $12.5");
		expect(out).toContain("Top up     https://ryuhq.com/billing");
	});

	test("a redirect is refused rather than followed with the key", async () => {
		const client = new ConnectClient(`${base()}/moved`, KEY);
		const error = await client.health().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ConnectError);
		expect((error as ConnectError).code).toBe("redirect_refused");
	});

	test("help lists every subcommand", async () => {
		const { out } = await run(["help"]);
		for (const word of [
			"browse",
			"search",
			"describe",
			"request",
			"call",
			"balance",
		]) {
			expect(out).toContain(`ryu-cli connect ${word}`);
		}
	});
});
