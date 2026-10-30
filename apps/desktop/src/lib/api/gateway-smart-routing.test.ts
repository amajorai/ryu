import { describe, expect, it } from "bun:test";
import {
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_SESSION_BUDGET,
	DEFAULT_SMART_ROUTING,
	type GatewayRoutingConfig,
	routingViewIncludesModalityMap,
	routingViewIncludesSmartRouting,
	saveAgentRouteOverride,
	saveAgentRoutePool,
} from "./gateway.ts";
import {
	fetchWithBody,
	GATEWAY_API_CONFIG_RS,
	gatewayApiConfigRs,
	gatewayDialogTsx,
	rustBlock,
	SERVED_ROUTING_BASE,
} from "./gateway-test-support.ts";

describe("routingViewIncludesSmartRouting", () => {
	it("separates a gateway that omits the section from one that serves it off", () => {
		// Both render as "smart routing disabled" once a card coalesces. Only the
		// first means a save from this app would overwrite the operator's config.
		expect(routingViewIncludesSmartRouting({ ...SERVED_ROUTING_BASE })).toBe(
			false
		);
		expect(
			routingViewIncludesSmartRouting({
				...SERVED_ROUTING_BASE,
				smart_routing: DEFAULT_SMART_ROUTING,
			})
		).toBe(true);
	});

	it("matches the presence test the modality editor already relies on", () => {
		// One rule for the whole routing section, not two — the two predicates
		// disagreeing is how "which fields are safe to round-trip?" becomes a
		// per-field guess.
		const served = {
			...SERVED_ROUTING_BASE,
			smart_routing: DEFAULT_SMART_ROUTING,
		};
		expect(routingViewIncludesSmartRouting(served)).toBe(
			routingViewIncludesModalityMap(served)
		);
	});

	// The predecessor of this block asserted the OPPOSITE — that the dialog did
	// *not* consult this predicate — as a deliberate record of an unfinished fix,
	// with an instruction to replace it once the card grew a `served` state. The
	// card now has one, so the record is replaced by the guarantees it was standing
	// in for. Textual, because the `.tsx` cannot be imported here (same technique
	// as the buildBudgetRule guards above).

	it("is consulted by the dialog, on both the load edge and the save edge", () => {
		// Two call sites, not one, and the second is the one that matters. Checking
		// only at mount would leave the save writing a fabricated section whenever
		// the gateway restarts (or is swapped for an older build) between mount and
		// Save — the card re-fetches the config there anyway, so the fresh object is
		// what has to be tested.
		expect(gatewayDialogTsx).toContain("routingViewIncludesModalityMap(");
		const calls = gatewayDialogTsx.match(/routingViewIncludesSmartRouting\(/g);
		expect(calls?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(gatewayDialogTsx).toContain(
			"setServed(routingViewIncludesSmartRouting(cfg.routing))"
		);
		expect(gatewayDialogTsx).toContain(
			"if (!routingViewIncludesSmartRouting(cfg.routing))"
		);
	});

	it("refuses to save on anything but a positively served section", () => {
		// `served !== true`, NOT `served === false`. The three-state exists so a
		// gateway mid-first-fetch is not accused of being about to lose data; the
		// flip side is that `null` must not be treated as permission to write. A
		// `!draft || served === false` guard would let a save fire before the first
		// fetch resolved, writing DEFAULT_SMART_ROUTING over live config — the exact
		// destruction the predicate was introduced to prevent.
		expect(gatewayDialogTsx).toContain("if (!draft || served !== true) {");
		// And the controls are inert in that state, so the refusal is not a dead end
		// the user only discovers by pressing Save.
		expect(gatewayDialogTsx).toContain("|| served === false;");
	});

	it("tells the operator that an off-looking switch is an unreported one", () => {
		// The specific misreading this whole predicate exists to prevent: a switch
		// rendered off by DEFAULT_SMART_ROUTING is indistinguishable from a node
		// reporting "off". The copy has to name that, not merely say "unavailable",
		// or the user still believes they have read a fact about their config.
		expect(gatewayDialogTsx).toContain(
			"does not report its smart-routing config"
		);
		expect(gatewayDialogTsx).toContain(
			"shows off because nothing was reported"
		);
	});

	it("is exact on a gateway that serves the section switched off", () => {
		// `SmartRoutingConfig` is a plain struct on `RoutingView` (not an `Option`,
		// no `skip_serializing_if`), so a gateway that has the field ALWAYS emits
		// it — presence is a decision, not a heuristic.
		const view = rustBlock(
			gatewayApiConfigRs,
			GATEWAY_API_CONFIG_RS,
			"struct RoutingView"
		);
		expect(/\n\s*smart_routing:\s*SmartRoutingConfig,/.test(view)).toBe(true);
		expect(view).not.toContain("smart_routing: Option<");
	});
});

describe("fetchGatewayConfig preserves what the gateway did and did not serve", () => {
	it("keeps the safe ACP defaults when an older gateway omits the section", async () => {
		const cfg = await fetchWithBody({});
		expect(cfg.acp).toEqual(DEFAULT_GATEWAY_ACP);
	});

	it("keeps locked use disabled when an older gateway omits the section", async () => {
		const cfg = await fetchWithBody({});
		expect(cfg.computer_use).toEqual(DEFAULT_GATEWAY_COMPUTER_USE);
	});

	it("preserves the Gateway computer-use policy when it is served", async () => {
		const computerUse = { locked_use: true, security_key: true };
		const cfg = await fetchWithBody({ computer_use: computerUse });
		expect(cfg.computer_use).toEqual(computerUse);
	});

	it("preserves Gateway ACP policy and Core runtime status", async () => {
		const acp = {
			...DEFAULT_GATEWAY_ACP,
			active_agents: 1,
			auto_max_parallel_agents: 2,
			effective_max_parallel_agents: 2,
			max_parallel_agents: null,
		};
		const cfg = await fetchWithBody({ acp });
		expect(cfg.acp).toEqual(acp);
	});

	it("leaves smart_routing absent when the gateway omitted it", async () => {
		const cfg = await fetchWithBody({ routing: { ...SERVED_ROUTING_BASE } });
		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
		// Spelled out separately: `in` would still be true for an explicit
		// `smart_routing: undefined`, and that value spreads into a PUT body as an
		// omitted key — indistinguishable on the wire from the fabricated default
		// this test exists to keep out.
		expect(Object.keys(cfg.routing)).not.toContain("smart_routing");
	});

	it("returns the served section verbatim, including a disabled one", async () => {
		const served = { ...DEFAULT_SMART_ROUTING, classifier_model: "router-1" };
		const cfg = await fetchWithBody({
			routing: { ...SERVED_ROUTING_BASE, smart_routing: served },
		});
		expect(cfg.routing.smart_routing).toEqual(served);
	});

	it("asserts no routing section at all when the response carries none", async () => {
		// The `DEFAULT_ROUTING` stand-in exists so the budgets/keys cards do not
		// throw; it must not claim a smart-routing state either.
		const cfg = await fetchWithBody({});
		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
		expect(routingViewIncludesModalityMap(cfg.routing)).toBe(false);
	});

	it("still coalesces the sections whose controls bind straight to them", async () => {
		// The distinction is not "never default anything": `firewall.alert` and the
		// session budget back Selects that render uncontrolled on `undefined`. They
		// stay coalesced on purpose, and this pins that the routing change did not
		// quietly widen into them.
		const cfg = await fetchWithBody({});
		expect(cfg.firewall.alert).toBe("silent");
		expect(cfg.budgets.session).toEqual(DEFAULT_SESSION_BUDGET);
	});
});

describe("concurrent smart-routing saves", () => {
	const target = { url: "http://127.0.0.1:7981", token: null, userJwt: null };

	interface ConfigServer {
		/** Revisions sent with each PUT, in arrival order. */
		expectedRevisions: unknown[];
		/** Applied after the next read, as if another window saved meanwhile. */
		interleave?: (routing: GatewayRoutingConfig) => GatewayRoutingConfig;
		routing: GatewayRoutingConfig;
		staleWrites: number;
	}

	/**
	 * A gateway that keeps its routing between calls, bumps a revision on every
	 * write, and answers 409 to a write carrying a stale revision, like
	 * `PUT /v1/config`. Reads and writes yield, so overlapping saves interleave.
	 */
	async function withConfigServer(
		server: ConfigServer,
		run: () => Promise<void>
	): Promise<void> {
		let revision = 1;
		const revisionId = () => String(revision).padStart(64, "0");
		const original = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				if (init?.method === "PUT") {
					const body = JSON.parse(String(init.body)) as {
						expectedRevision?: unknown;
						routing: GatewayRoutingConfig;
					};
					server.expectedRevisions.push(body.expectedRevision);
					// An unrevisioned write is accepted, as the real gateway does.
					const stale =
						body.expectedRevision !== undefined &&
						body.expectedRevision !== revisionId();
					if (stale) {
						server.staleWrites += 1;
						return Response.json(
							{ error: "configuration changed" },
							{ status: 409 }
						);
					}
					server.routing = body.routing;
					revision += 1;
					return Response.json({ ok: true, configRevision: revisionId() });
				}
				const served = {
					auth: { api_keys: [], require_auth: false },
					configRevision: revisionId(),
					providers: {
						anthropic: null,
						core: null,
						genai: null,
						local: null,
						openai: null,
						openrouter: null,
					},
					routing: server.routing,
				};
				if (server.interleave) {
					server.routing = server.interleave(server.routing);
					server.interleave = undefined;
					revision += 1;
				}
				return Response.json(served);
			},
			{ preconnect: original.preconnect }
		);
		try {
			await run();
		} finally {
			globalThis.fetch = original;
		}
	}

	const servedRouting = (): GatewayRoutingConfig => ({
		...SERVED_ROUTING_BASE,
		smart_routing: { ...DEFAULT_SMART_ROUTING, agent_pools: {} },
	});

	it("keeps both an agent's pool and its override when saved together", async () => {
		const server: ConfigServer = {
			expectedRevisions: [],
			routing: servedRouting(),
			staleWrites: 0,
		};
		await withConfigServer(server, async () => {
			await Promise.all([
				saveAgentRoutePool(target, "bot", {
					allowed_models: ["*claude*"],
					allowed_providers: [],
				}),
				saveAgentRouteOverride(target, "bot", {
					...DEFAULT_SMART_ROUTING,
					enabled: true,
				}),
				saveAgentRoutePool(target, "other", {
					allowed_models: ["gpt-*"],
					allowed_providers: [],
				}),
			]);
		});
		const smart = server.routing.smart_routing;
		expect(smart?.agent_pools).toEqual({
			bot: { allowed_models: ["*claude*"], allowed_providers: [] },
			other: { allowed_models: ["gpt-*"], allowed_providers: [] },
		});
		expect(smart?.agent_routes?.bot?.enabled).toBe(true);
		expect(server.staleWrites).toBe(0);
		expect(server.expectedRevisions.every((r) => typeof r === "string")).toBe(
			true
		);
	});

	it("re-applies its change on top of a save made elsewhere meanwhile", async () => {
		const server: ConfigServer = {
			expectedRevisions: [],
			interleave: (routing) => ({
				...routing,
				default_provider: "anthropic",
				smart_routing: {
					...DEFAULT_SMART_ROUTING,
					...routing.smart_routing,
					agent_pools: {
						elsewhere: { allowed_models: ["x"], allowed_providers: [] },
					},
				},
			}),
			routing: servedRouting(),
			staleWrites: 0,
		};
		await withConfigServer(server, () =>
			saveAgentRoutePool(target, "bot", {
				allowed_models: ["*claude*"],
				allowed_providers: [],
			})
		);
		expect(server.staleWrites).toBe(1);
		expect(server.routing.default_provider).toBe("anthropic");
		expect(server.routing.smart_routing?.agent_pools).toEqual({
			bot: { allowed_models: ["*claude*"], allowed_providers: [] },
			elsewhere: { allowed_models: ["x"], allowed_providers: [] },
		});
	});
});
