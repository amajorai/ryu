import { z } from "zod";
import type { HttpFixtureBody } from "./test-support/http-fixture.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";
// packages/core-client/src/gateway.test.ts
//
// Pins the ONE contract `@ryuhq/core-client/gateway` has that can silently
// destroy a node's config: `fetchGatewayConfig` must return `routing` exactly as
// the gateway served it.
//
// Why this is worth a test even though no in-repo surface imports this module
// (the desktop carries its own copy of the client): the package's export map is
// `"./*": "./src/*.ts"`, so `@ryuhq/core-client/gateway` is a published entry
// point on npm. The assertions below are about the shape a third-party consumer
// receives, not about an internal call graph — which is exactly the case where
// "nothing in this repo calls it" is not a reason to leave it wrong.
//
// The defect being pinned: `fetchGatewayConfig` used to coalesce
// `routing.smart_routing` to `DEFAULT_SMART_ROUTING`. `PUT /v1/config { routing }`
// replaces the routing section wholesale and `RoutingConfig::smart_routing` is
// `#[serde(default)]`, so that fabricated `enabled: false` is not inert — a
// consumer that read, spread and wrote back any *other* routing field would turn
// a hand-written `[routing.smart_routing]` off. Served-and-off and never-served
// must therefore stay distinguishable at the load edge.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	buildGatewayEvalBatchPlan,
	createGatewayBatch,
	DEFAULT_SMART_ROUTING,
	deleteGatewayBatch,
	fetchGatewayConfig,
	GATEWAY_PHONE_LINE_LIMITS,
	type GatewayRoutingConfig,
	gatewayPhoneCallsConfigSchema,
	getGatewayBatch,
	isGatewayE164Number,
	listGatewayBatches,
	providerIdSchema,
	providerKindSchema,
	routingViewIncludesSmartRouting,
	type SmartRoutingConfig,
	scoreGatewayEvalBatch,
} from "./gateway.ts";

// Admit the complete existing legacy routing contract used by these fixture
// assertions. This observes the fixture's routing field, not a whole native
// ConfigView (which carries 23 sections). Extra raw fields retain their identity.
const testedSmartRoutingFields = z.object({
	cache_by_session: z.boolean(),
	classifier_model: z.string(),
	default_model: z.string().nullable().optional(),
	embedding_model: z.string(),
	enabled: z.boolean(),
	escalation_confirmations: z.number().optional(),
	escalation_judge_model: z.string().optional(),
	escalation_message_chars: z.number().optional(),
	escalation_recent_message_window: z.number().optional(),
	escalation_strong_model: z.string().optional(),
	escalation_weak_model: z.string().optional(),
	random_seed: z.number().nullable().optional(),
	router_type: z
		.enum([
			"llm_classifier",
			"passthrough",
			"random",
			"stage_router",
			"escalation",
		])
		.optional(),
	rules: z.array(
		z.object({
			description: z.string(),
			model: z.string(),
			weight: z.number().optional(),
		})
	),
	similarity_threshold: z.number(),
	stage_capable_model: z.string().optional(),
	stage_confidence_threshold: z.number().optional(),
	stage_efficient_model: z.string().optional(),
	stage_picker: z.enum(["capable_first", "efficient_first"]).optional(),
	stage_recent_message_window: z.number().optional(),
	strategy: z.enum(["llm", "embedding", "keyword"]),
	timeout_ms: z.number(),
});
const testedRoutingFields = z.object({
	default_provider: providerKindSchema,
	fallback_chain: z.array(providerKindSchema),
	model_map: z.record(
		z.string(),
		z.object({
			provider: providerKindSchema,
			provider_model: z.string().nullable().optional(),
		})
	),
	smart_routing: testedSmartRoutingFields.optional(),
});
const testedRoutingSchema = z.custom<z.output<typeof testedRoutingFields>>(
	(value) => testedRoutingFields.safeParse(value).success
);

const testedEvalReceiptFields = z.object({ run_id: z.string() });
const testedEvalReceiptSchema = z.custom<
	z.output<typeof testedEvalReceiptFields>
>((value) => testedEvalReceiptFields.safeParse(value).success);
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "t",
	userJwt: null,
};

function stub(
	body: HttpFixtureBody | ReturnType<typeof configBody>,
	status = 200
): void {
	globalThis.fetch = createFetchFixture((_url: string, _init: RequestInit) =>
		Promise.resolve(new Response(JSON.stringify(body), { status }))
	);
}

/** A minimal `GET /api/gateway/config` body with a routing section we control. */
function configBody(
	routing: GatewayRoutingConfig | HttpFixtureBody | undefined
) {
	const body = {
		auth: { api_keys: [], require_auth: false },
		providers: {
			anthropic: null,
			core: null,
			local: null,
			openai: null,
			openrouter: null,
		},
	};
	return routing === undefined ? body : { ...body, routing };
}

const servedRouting = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
} satisfies GatewayRoutingConfig;

describe("fetchGatewayConfig: routing.smart_routing served vs not served", () => {
	test("a gateway that does not serve the section yields no smart_routing key", async () => {
		stub(configBody(servedRouting));

		const response = await fetchGatewayConfig(target);
		const cfg = {
			...response,
			routing: testedRoutingSchema.parse(response.routing),
		};

		// Not `toBeUndefined()`: the point is the KEY is absent, so a spread-based
		// read-modify-write cannot carry a fabricated section back out to the PUT.
		expect("smart_routing" in cfg.routing).toBe(false);
		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
	});

	test("a gateway that serves the section switched off is NOT the same state", async () => {
		const off: SmartRoutingConfig = { ...DEFAULT_SMART_ROUTING };
		stub(configBody({ ...servedRouting, smart_routing: off }));

		const response = await fetchGatewayConfig(target);
		const cfg = {
			...response,
			routing: testedRoutingSchema.parse(response.routing),
		};

		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(true);
		expect(cfg.routing.smart_routing).toEqual(off);
	});

	test("a served section is passed through byte-for-byte, not merged over a default", async () => {
		// Every field deliberately differs from DEFAULT_SMART_ROUTING, including the
		// three (`strategy`, `embedding_model`, `similarity_threshold`) this
		// package's interface could not see until now. A merge-over-default would
		// still produce `enabled: true` and pass a shallower assertion.
		const served = {
			enabled: true,
			strategy: "embedding",
			classifier_model: "gemma-3-270m-it-qat-Q4_0",
			embedding_model: "nomic-embed-text",
			similarity_threshold: 0.62,
			rules: [{ description: "writing code", model: "claude-sonnet" }],
			default_model: "gpt-4o-mini",
			cache_by_session: false,
			timeout_ms: 1500,
		} satisfies SmartRoutingConfig;
		stub(configBody({ ...servedRouting, smart_routing: served }));

		const response = await fetchGatewayConfig(target);
		const cfg = {
			...response,
			routing: testedRoutingSchema.parse(response.routing),
		};

		expect(cfg.routing.smart_routing).toEqual(served);
	});

	test("no routing section at all still omits smart_routing", async () => {
		// The `DEFAULT_ROUTING` stand-in used when a 2xx carries no `routing` at all
		// must not manufacture the section either — it stands for "the gateway told
		// us nothing", which is the strongest form of not-served.
		stub(configBody(undefined));

		const response = await fetchGatewayConfig(target);
		const cfg = {
			...response,
			routing: testedRoutingSchema.parse(response.routing),
		};

		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
		expect(cfg.routing.default_provider).toBe("openai");
	});
});

describe("routingViewIncludesSmartRouting", () => {
	test("an explicitly undefined value still counts as served", () => {
		// `in` is a key test, not a value test, and that is the intended semantics:
		// the desktop predicate behaves the same way. A caller that constructs
		// `{ smart_routing: undefined }` by hand has asserted the key exists; only
		// omission means the gateway never mentioned it.
		const routing = {
			default_provider: "openai",
			model_map: {},
			fallback_chain: [],
			smart_routing: undefined,
		} satisfies GatewayRoutingConfig;

		expect(routingViewIncludesSmartRouting(routing)).toBe(true);
	});
});

describe("DEFAULT_SMART_ROUTING", () => {
	test("carries every field RoutingView serves, so a form bound to it round-trips", () => {
		// `RoutingView.smart_routing` (apps/gateway/src/api/config.rs) is a plain
		// struct whose `#[serde(default)]` fields are all always emitted. A default
		// object missing any of them is a consumer-visible hole: spread it into a
		// PUT and the absent fields deserialize back to the Rust defaults, silently
		// resetting an operator's `strategy`/`similarity_threshold`.
		expect(Object.keys(DEFAULT_SMART_ROUTING).sort()).toEqual([
			"cache_by_session",
			"classifier_model",
			"default_model",
			"embedding_model",
			"enabled",
			"escalation_confirmations",
			"escalation_judge_model",
			"escalation_message_chars",
			"escalation_recent_message_window",
			"escalation_strong_model",
			"escalation_weak_model",
			"random_seed",
			"router_type",
			"rules",
			"similarity_threshold",
			"stage_capable_model",
			"stage_confidence_threshold",
			"stage_efficient_model",
			"stage_picker",
			"stage_recent_message_window",
			"strategy",
			"timeout_ms",
		]);
	});
});

describe("OpenRouter batch client", () => {
	test("builds chat batches from eval cases and keeps scoring metadata local", () => {
		const testCase = {
			assertions: [{ kind: "contains" as const, value: "hello" }],
			expected: "hello",
			id: "greeting",
			prompt: "Say hi to {{name}}",
			vars: { name: "Ada", persona: "friendly assistant" },
		};
		const plan = buildGatewayEvalBatchPlan(" openai/gpt-4o-mini ", [testCase], {
			prefix: "Please: ",
			suffix: "!",
			system_prompt: "You are {{persona}}.",
		});

		expect(plan.request.model).toBe("openai/gpt-4o-mini");
		expect(plan.request.endpoint).toBe("/v1/chat/completions");
		expect(plan.request.completion_window).toBe("24h");
		expect(plan.request.requests).toEqual([
			{
				custom_id: "eval-000001",
				body: {
					messages: [
						{ role: "system", content: "You are friendly assistant." },
						{
							role: "user",
							content: "Please: Say hi to Ada!",
						},
					],
				},
			},
		]);
		expect(plan.cases_by_custom_id["eval-000001"]).toBe(testCase);
		expect(plan.request.requests[0]?.body).not.toHaveProperty("expected");
	});

	test("rejects eval cases whose provider or cache semantics cannot fit one batch", () => {
		expect(() =>
			buildGatewayEvalBatchPlan("openai/gpt-4o-mini", [
				{ prompt: "hello", provider: "openai" },
			])
		).toThrow("cannot override the batch model");
		expect(() =>
			buildGatewayEvalBatchPlan("openai/gpt-4o-mini", [
				{ prompt: "hello", options: { cache: true } },
			])
		).toThrow("does not support per-case response caching");
		expect(() =>
			buildGatewayEvalBatchPlan("openai/gpt-4o-mini", [
				{ prompt: "{{ name | upper }}", vars: { name: "Ada" } },
			])
		).toThrow("supports variable lookup only");
		expect(() =>
			buildGatewayEvalBatchPlan("openai/gpt-4o-mini", [
				{ prompt: "{% if premium %}hello{% endif %}", vars: { premium: true } },
			])
		).toThrow("does not render template control blocks");
	});

	test("Core client exposes batch submit, repeatable filters, poll, and delete", async () => {
		const seen: Array<{ method: string; url: string }> = [];
		const batchTarget: ApiTarget = {
			...target,
			fetch: (input, init) => {
				seen.push({ method: init?.method ?? "GET", url: String(input) });
				const url = new URL(String(input));
				const body = url.pathname.endsWith("/batches")
					? {
							id: "batch_1",
							model: "openai/gpt-4o-mini",
							endpoint: "/v1/chat/completions",
							status: "validating",
						}
					: url.pathname.endsWith("/batch_1")
						? {
								id: "batch_1",
								model: "openai/gpt-4o-mini",
								endpoint: "/v1/chat/completions",
								status: "completed",
							}
						: { id: "batch_1", deletion: { openrouter: "deleted" } };
				return Promise.resolve(
					new Response(JSON.stringify(body), { status: 200 })
				);
			},
		};
		const input = {
			endpoint: "/v1/chat/completions" as const,
			model: "openai/gpt-4o-mini",
			requests: [
				{
					custom_id: "eval-000001",
					body: { messages: [{ role: "user", content: "hello" }] },
				},
			],
		};

		await createGatewayBatch(batchTarget, input);
		await listGatewayBatches(batchTarget, {
			limit: 2,
			status: ["completed", "failed"],
		});
		await getGatewayBatch(batchTarget, "batch_1");
		await deleteGatewayBatch(batchTarget, "batch_1");

		expect(seen.map((entry) => entry.method)).toEqual([
			"POST",
			"GET",
			"GET",
			"DELETE",
		]);
		const listUrl = new URL(seen[1]?.url ?? "http://invalid");
		expect(listUrl.searchParams.getAll("status")).toEqual([
			"completed",
			"failed",
		]);
		expect(seen[2]?.url).toEndWith("/api/gateway/batches/batch_1");
		expect(seen[3]?.url).toEndWith("/api/gateway/batches/batch_1");
	});

	test("scores successful result rows through the existing Gateway eval scorer", async () => {
		const scoreRequestSchema = z.object({
			system_prompt: z.string(),
			dataset: z.array(
				z.object({
					id: z.string(),
					provider_output_provider: z.string(),
					provider_latency_ms: z.number(),
					provider_cost_micro_usd: z.number(),
				})
			),
		});
		const scoreRequests: z.infer<typeof scoreRequestSchema>[] = [];
		const batchTarget: ApiTarget = {
			...target,
			fetch: (input, init) => {
				if (String(input).endsWith("/api/gateway/evals/run")) {
					scoreRequests.push(
						scoreRequestSchema.parse(JSON.parse(String(init?.body)))
					);
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({ run_id: "eval_run", aggregate: {}, cases: [] }),
						{
							status: 200,
						}
					)
				);
			},
		};
		const plan = buildGatewayEvalBatchPlan(
			"openai/gpt-4o-mini",
			[
				{
					id: "policy",
					prompt: "Summarize the refund window.",
					expected: "30 days",
				},
				{ id: "failed", prompt: "This provider row will fail." },
			],
			{ system_prompt: "Answer briefly." }
		);
		const scoreResponse = await scoreGatewayEvalBatch(batchTarget, plan, {
			id: "batch_1",
			endpoint: "/v1/chat/completions",
			model: "openai/gpt-4o-mini",
			status: "completed",
			created_at: 1,
			finalized_at: 43,
			results: [
				{
					id: "row-1",
					custom_id: "eval-000001",
					error: null,
					response: {
						status_code: 200,
						body: {
							choices: [
								{
									message: { content: "Refunds are available within 30 days." },
								},
							],
							usage: {
								prompt_tokens: 12,
								completion_tokens: 7,
								cost: 0.000_777,
							},
						},
					},
				},
				{
					id: "row-2",
					custom_id: "eval-000002",
					error: { message: "provider row failed" },
					response: null,
				},
			],
		});

		const scored = {
			...scoreResponse,
			result: testedEvalReceiptSchema.parse(scoreResponse.result),
		};
		expect(scored.batch_turnaround_ms).toBe(42_000);
		expect(scored.failures).toEqual([
			{ custom_id: "eval-000002", error: '{"message":"provider row failed"}' },
		]);
		expect(scored.result?.run_id).toBe("eval_run");
		const scoreRequest = scoreRequests[0];
		const dataset = scoreRequest?.dataset;
		expect(dataset?.[0]?.id).toBe("policy");
		expect(dataset?.[0]?.provider_output_provider).toBe("openrouter");
		expect(dataset?.[0]?.provider_latency_ms).toBe(42_000);
		expect(dataset?.[0]?.provider_cost_micro_usd).toBe(777);
		expect(scoreRequest?.system_prompt).toBe("Answer briefly.");
	});
});

describe("batch eval wire boundaries", () => {
	test("renders nested JSON, array indices, scalar values and own proto-named keys", () => {
		const vars = {
			person: Object.fromEntries([
				["__proto__", "owned"],
				["name", "Ada"],
			]),
			items: ["first", "second"],
			flag: false,
			count: 0,
			empty: null,
			json: '{"nested":{"answer":42}}',
		};
		const plan = buildGatewayEvalBatchPlan("model", [
			{
				vars,
				prompt:
					"{{person.name}}/{{person.__proto__}}/{{items.1}}/{{items.length}}/{{flag}}/{{count}}/{{empty}}/{{missing}}/{{person.name.0}}",
			},
			{
				vars: { json: '{"nested":{"answer":42,"__proto__":"owned"}}' },
				options: { transform_vars: "json" },
				prompt: "{{json.nested.answer}}/{{json.nested.__proto__}}",
			},
		]);
		expect(plan.request.requests[0]?.body).toEqual({
			messages: [
				{
					role: "user",
					content: "Ada/owned/second/2/false/0//{{missing}}/{{person.name.0}}",
				},
			],
		});
		expect(plan.request.requests[1]?.body).toEqual({
			messages: [{ role: "user", content: "42/owned" }],
		});
		expect(() =>
			buildGatewayEvalBatchPlan("model", [
				{
					prompt: "invalid",
					vars: { json: "invalid" },
					options: { transform_vars: "json" },
				},
			])
		).toThrow("Eval variable json is not valid JSON.");
	});

	test("keeps valid dollar fallback, zero micro-dollar precedence and absent costs distinct", async () => {
		const submittedSchema = z.object({
			dataset: z.array(
				z.object({ provider_cost_micro_usd: z.number().optional() })
			),
		});
		let submitted: z.output<typeof submittedSchema> | undefined;
		const batchTarget: ApiTarget = {
			...target,
			fetch: (_url, init) => {
				submitted = submittedSchema.parse(JSON.parse(String(init?.body)));
				return Promise.resolve(
					Response.json({ run_id: "costs", aggregate: {}, cases: [] })
				);
			},
		};
		const plan = buildGatewayEvalBatchPlan("model", [
			{ prompt: "fallback" },
			{ prompt: "zero" },
			{ prompt: "missing" },
		]);
		await scoreGatewayEvalBatch(batchTarget, plan, {
			id: "batch_costs",
			endpoint: "/v1/chat/completions",
			model: "model",
			status: "completed",
			created_at: 0,
			finalized_at: 1,
			results: [
				{
					id: "one",
					custom_id: "eval-000001",
					response: {
						status_code: 200,
						body: { usage: { cost_micro_usd: -1, cost: 0.000_002 } },
					},
				},
				{
					id: "two",
					custom_id: "eval-000002",
					response: {
						status_code: 200,
						body: { usage: { cost_micro_usd: 0, cost: 10 } },
					},
				},
				{
					id: "three",
					custom_id: "eval-000003",
					response: { status_code: 200, body: { usage: { cost: "invalid" } } },
				},
			],
		});
		expect(submitted?.dataset[0]?.provider_cost_micro_usd).toBe(2);
		expect(submitted?.dataset[1]?.provider_cost_micro_usd).toBe(0);
		expect(submitted?.dataset[2]).not.toHaveProperty("provider_cost_micro_usd");
	});
});

test("routing accepts custom provider IDs independently of backend kinds", () => {
	expect(providerIdSchema.parse("acme-private")).toBe("acme-private");
	expect(providerIdSchema.array().parse(["acme-private", "openai"])).toEqual([
		"acme-private",
		"openai",
	]);
	expect(providerKindSchema.safeParse("acme-private").success).toBe(false);
});

describe("phone line caller controls", () => {
	test("E.164 numbers follow the Gateway's rule", () => {
		expect(isGatewayE164Number("+14155550123")).toBe(true);
		expect(isGatewayE164Number("+447700900123")).toBe(true);
		expect(isGatewayE164Number("14155550123")).toBe(false);
		expect(isGatewayE164Number("+04155550123")).toBe(false);
		expect(isGatewayE164Number("+1415555")).toBe(false);
		expect(isGatewayE164Number("+1234567890123456")).toBe(false);
		expect(isGatewayE164Number("+1 415 555 0123")).toBe(false);
		expect(GATEWAY_PHONE_LINE_LIMITS).toEqual({
			defaultConcurrentCalls: 2,
			maxAllowedCallers: 100,
			maxConcurrentCalls: 20,
		});
	});

	test("the phone config view keeps caller controls and unknown line fields", () => {
		const served = {
			enabled: true,
			lines: [
				{
					id: "line-primary",
					label: "Primary",
					twilioNumber: "+14155550123",
					callerId: "",
					greeting: "",
					allowedCallers: ["+14155550199"],
					maxConcurrentCalls: 3,
					futureSetting: "kept",
				},
			],
		};
		const parsed = gatewayPhoneCallsConfigSchema.parse(served);
		expect(parsed).toBe(served);
		expect(parsed.lines[0]).toHaveProperty("futureSetting", "kept");
		expect(parsed.lines[0]?.allowedCallers).toEqual(["+14155550199"]);
		expect(parsed.lines[0]?.maxConcurrentCalls).toBe(3);
	});
});
