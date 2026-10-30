import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RyuJsonValue, rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import {
	configureGatewayProviderAccount,
	DEFAULT_SMART_ROUTING,
	formatPoolList,
	type GatewayRoutingConfig,
	isOpenRoutePool,
	parsePoolList,
	runGatewayEvals,
	runGatewayRedTeam,
	SmartRoutingUnavailableError,
	sameGuardrailSections,
	saveAgentRoutePool,
	scoreGatewayOutput,
} from "./gateway.ts";
import {
	fetchWithBody,
	rustSource,
	SERVED_ROUTING_BASE,
} from "./gateway-test-support.ts";

describe("provider account contract", () => {
	it("keeps the desktop account fields aligned with the Gateway view", () => {
		const canonical = rustSource("apps/gateway/src/api/config.rs").match(
			/struct ProviderAccountView \{([\s\S]*?)\n\}/
		)?.[1];
		const desktop = readFileSync(
			join(import.meta.dir, "gateway.ts"),
			"utf8"
		).match(/interface GatewayProviderAccount \{([\s\S]*?)\n\}/)?.[1];
		expect(canonical).toBeDefined();
		expect(desktop).toBeDefined();
		const fields = (body: string) =>
			[...body.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]).sort();
		const viewFields = fields(canonical ?? "")
			.map((field) =>
				field === "drain_threshold_percent" ? "drainThresholdPercent" : field
			)
			.sort();
		expect(canonical).toContain('rename = "drainThresholdPercent"');
		expect(fields(desktop ?? "")).toEqual(viewFields);
		// The struct's own attribute lines are kept with its body: a `rename_all`
		// there would rename every wire key just as a field-level `rename` would.
		const policyDeclaration = rustSource(
			"crates/gateway/credentials/src/lib.rs"
		).match(
			/((?:#\[[^\n]*\]\n)*)pub struct ProviderAccountPolicy \{([\s\S]*?)\n\}/
		);
		const policy = policyDeclaration?.[2];
		expect(policy).toBeDefined();
		expect(policyDeclaration?.[1]).toContain("deny_unknown_fields");
		// The policy is what Core deserializes from the desktop's `accountPolicy`
		// (`SetProviderBody` in `apps/core/src/server/mod.rs`), and it denies
		// unknown fields. It carries no serde rename, so its wire keys ARE its Rust
		// field names, snake_case `drain_threshold_percent` included; only the
		// read-side view renames that field to `drainThresholdPercent`. Compare Rust
		// names to Rust names, and pin that the policy stays un-renamed, because
		// the desktop sends `drain_threshold_percent` (see "live provider account
		// save").
		expect(`${policyDeclaration?.[1]}${policy}`).not.toContain("rename");
		expect(
			[...(policy ?? "").matchAll(/^\s*pub (\w+):/gm)]
				.map((match) => match[1])
				.sort()
		).toEqual(
			fields(canonical ?? "").filter(
				(field) => field !== "id" && field !== "source"
			)
		);
	});
});

describe("live provider account save", () => {
	it("accepts a live application without requiring a restart", async () => {
		const original = globalThis.fetch;
		let sent: RyuJsonValue | undefined;
		globalThis.fetch = Object.assign(
			async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sent = rpcJsonResponseSchema.parse(JSON.parse(String(init?.body)));
				return new Response(
					JSON.stringify({
						success: true,
						accountsApplied: true,
						gateway_restarted: false,
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			},
			{ preconnect: original.preconnect }
		);
		try {
			const account = {
				id: "a".repeat(64),
				name: "Primary",
				enabled: true,
				priority: 10,
			};
			await configureGatewayProviderAccount(
				{ url: "http://127.0.0.1:7980", token: null, userJwt: null },
				"fal",
				account
			);
			expect(sent).toEqual({
				provider: "fal",
				account_action: "configure",
				accountId: account.id,
				accountPolicy: {
					name: "Primary",
					enabled: true,
					priority: 10,
					drain_threshold_percent: null,
				},
			});
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("gateway response/request codecs accept every valid wire value", () => {
	it("accepts open ProviderId routing targets, not only ProviderKind", async () => {
		// Gateway `RoutingView` serializes `default_provider` / `fallback_chain` as
		// plain `ProviderId` strings; media and custom providers are valid.
		const cfg = await fetchWithBody({
			routing: {
				...SERVED_ROUTING_BASE,
				default_provider: "modal",
				fallback_chain: ["replicate", "fal", "my-custom-provider"],
			},
		});
		expect(cfg.routing.default_provider).toBe("modal");
		expect(cfg.routing.fallback_chain).toEqual([
			"replicate",
			"fal",
			"my-custom-provider",
		]);
	});

	it("sends eval, score and red-team bodies whose optional fields are undefined", async () => {
		// PromptStudio spreads optional fields as explicit `undefined`; the
		// request codec must tolerate what JSON.stringify omits instead of
		// failing locally before any request is made.
		const target = { url: "http://127.0.0.1:7980", token: null, userJwt: null };
		const sent: string[] = [];
		const transportStop = new Error("transport stub");
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			(_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sent.push(String(init?.body));
				return Promise.reject(transportStop);
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			await expect(
				runGatewayEvals(target, {
					models: undefined,
					system_messages: undefined,
					judge_model: undefined,
				})
			).rejects.toThrow();
			await expect(
				scoreGatewayOutput(target, {
					response: "ok",
					model: undefined,
					expected: undefined,
				})
			).rejects.toThrow();
			await expect(
				runGatewayRedTeam(target, {
					agent_id: "agent-1",
					model: undefined,
					strategies: undefined,
				})
			).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(sent.map((body) => JSON.parse(body))).toEqual([
			{},
			{ response: "ok" },
			{ agent_id: "agent-1" },
		]);
	});
});

// ─── Routing pools ──────────────────────────────────────────────────────────

describe("routing pool list fields", () => {
	it("splits on commas and newlines, trims, drops blanks, and dedupes", () => {
		expect(parsePoolList(" *claude*, gpt-*,\n,gpt-* ,  ")).toEqual([
			"*claude*",
			"gpt-*",
		]);
		expect(parsePoolList("")).toEqual([]);
	});

	it("round-trips through the editable form", () => {
		const entries = ["*claude*", "gpt-*"];
		expect(parsePoolList(formatPoolList(entries))).toEqual(entries);
		expect(formatPoolList(undefined)).toBe("");
	});

	it("treats a pool with both lists empty as open", () => {
		expect(isOpenRoutePool({ allowed_models: [], allowed_providers: [] })).toBe(
			true
		);
		expect(
			isOpenRoutePool({ allowed_models: [], allowed_providers: ["core"] })
		).toBe(false);
	});
});

describe("saveAgentRoutePool", () => {
	const target = { url: "http://127.0.0.1:7980", token: null, userJwt: null };

	async function saveWith(
		served: Record<string, unknown>,
		save: () => Promise<void>
	): Promise<Record<string, unknown>[]> {
		const puts: Record<string, unknown>[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PUT") {
					puts.push(JSON.parse(String(init.body)));
					return Response.json({ ok: true });
				}
				// A gateway always serves `auth` and `providers` beside routing.
				return Response.json({
					auth: { api_keys: [], require_auth: false },
					providers: {
						anthropic: null,
						core: null,
						genai: null,
						local: null,
						openai: null,
						openrouter: null,
					},
					...served,
				});
			},
			{ preconnect: original.preconnect }
		);
		try {
			await save();
		} finally {
			globalThis.fetch = original;
		}
		return puts;
	}

	it("changes only this agent's entry and keeps the rest of routing", async () => {
		const served = {
			routing: {
				...SERVED_ROUTING_BASE,
				default_provider: "anthropic",
				smart_routing: {
					...DEFAULT_SMART_ROUTING,
					enabled: true,
					allowed_models: ["*claude*", "gpt-*"],
					agent_pools: {
						other: { allowed_models: ["gpt-*"], allowed_providers: [] },
						stale: { allowed_models: ["x"], allowed_providers: [] },
					},
				},
			},
		};
		const [put] = await saveWith(served, () =>
			saveAgentRoutePool(target, "bot", {
				allowed_models: ["*claude*"],
				allowed_providers: [],
			})
		);
		const routing = put?.routing as GatewayRoutingConfig;
		expect(routing.default_provider).toBe("anthropic");
		expect(routing.smart_routing?.enabled).toBe(true);
		expect(routing.smart_routing?.allowed_models).toEqual([
			"*claude*",
			"gpt-*",
		]);
		expect(routing.smart_routing?.agent_pools).toEqual({
			bot: { allowed_models: ["*claude*"], allowed_providers: [] },
			other: { allowed_models: ["gpt-*"], allowed_providers: [] },
			stale: { allowed_models: ["x"], allowed_providers: [] },
		});

		const [cleared] = await saveWith(served, () =>
			saveAgentRoutePool(target, "stale", {
				allowed_models: [],
				allowed_providers: [],
			})
		);
		const clearedRouting = cleared?.routing as GatewayRoutingConfig;
		expect(
			Object.keys(clearedRouting.smart_routing?.agent_pools ?? {})
		).toEqual(["other"]);
	});

	it("refuses to write when the gateway does not serve smart_routing", async () => {
		const puts = await saveWith(
			{ routing: { ...SERVED_ROUTING_BASE } },
			async () => {
				await expect(
					saveAgentRoutePool(target, "bot", {
						allowed_models: ["gpt-*"],
						allowed_providers: [],
					})
				).rejects.toBeInstanceOf(SmartRoutingUnavailableError);
			}
		);
		expect(puts).toEqual([]);
	});
});

describe("sameGuardrailSections", () => {
	const firewall = {
		enabled: true,
		locked_fields: ["mode"],
		mode: "block",
	};

	it("ignores other sections, the revision and map key order", async () => {
		const base = await fetchWithBody({
			configRevision: "a".repeat(64),
			firewall,
			firewall_agent_overlays: {},
			firewall_org_overlays: {
				"org-a": { mode: "warn" },
				"org-b": { mode: "block" },
			},
			routing: { ...SERVED_ROUTING_BASE },
		});
		// A provider-key or routing save elsewhere moved the revision only.
		const fresh = await fetchWithBody({
			configRevision: "b".repeat(64),
			firewall: { mode: "block", locked_fields: ["mode"], enabled: true },
			firewall_agent_overlays: {},
			firewall_org_overlays: {
				"org-b": { mode: "block" },
				"org-a": { mode: "warn" },
			},
			routing: { ...SERVED_ROUTING_BASE, default_provider: "anthropic" },
		});
		expect(sameGuardrailSections(base, fresh)).toBe(true);
	});

	it("flags a firewall or overlay change saved elsewhere", async () => {
		const base = await fetchWithBody({
			firewall,
			firewall_agent_overlays: {},
			firewall_org_overlays: {},
		});
		const postureChanged = await fetchWithBody({
			firewall: { ...firewall, mode: "warn" },
			firewall_agent_overlays: {},
			firewall_org_overlays: {},
		});
		const overlayAdded = await fetchWithBody({
			firewall,
			firewall_agent_overlays: { "agent-1": { mode: "warn" } },
			firewall_org_overlays: {},
		});
		expect(sameGuardrailSections(base, postureChanged)).toBe(false);
		expect(sameGuardrailSections(base, overlayAdded)).toBe(false);
	});
});
