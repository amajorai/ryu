// Every registry tool declares an MCP outputSchema (`{ data, meta }`), and
// what its body answers conforms to it. Each tool runs against the stubbed
// replies in test/tool-output-cases.ts (shared with the Python port's
// test_services_tools_output.py), plus the variants a body can answer; the projected success is then checked against the zod
// schema and against the JSON Schema `tools/list` advertises. The data
// schemas that mirror a decoder in this package are pinned to it.

import { describe, expect, test } from "bun:test";
import * as z from "zod";
import {
	MA_LOG,
	type StubReply,
	TOOL_OUTPUT_CASES,
	TOOL_OUTPUT_ENV,
	TOOL_OUTPUT_VARIANTS,
} from "../../test/tool-output-cases.ts";
import {
	gatewayChatCompletionSchema,
	gatewayModelListSchema,
} from "../gateway/client.ts";
import {
	passportConnectionListSchema,
	passportFetchResultSchema,
	passportProfileListSchema,
} from "../passport/client.ts";
import { Ryu } from "../ryu.ts";
import { sitesProjectSchema } from "../sites/client.ts";
import {
	GATEWAY_CHAT_COMPLETION_DATA,
	GATEWAY_MODEL_LIST_DATA,
} from "./gateway.ts";
import {
	getRyuTool,
	RYU_TOOLS,
	runRyuTool,
	ryuToolJsonSchema,
	ryuToolOutputJsonSchema,
	toolMetaSchema,
	toPlainJson,
	toToolResultJson,
} from "./index.ts";
import {
	PASSPORT_CONNECTION_LIST_DATA,
	PASSPORT_FETCH_DATA,
	PASSPORT_PROFILE_LIST_DATA,
} from "./passport.ts";
import { SITES_PROJECT_DATA } from "./sites.ts";

const ENV = TOOL_OUTPUT_ENV;

function sse(events: readonly object[], keepOpen = false): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				const { seq } = event as { seq: number };
				controller.enqueue(
					encoder.encode(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`)
				);
			}
			if (!keepOpen) {
				controller.close();
			}
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function stubResponse(reply: StubReply): Response {
	const headers = { "x-request-id": "req_out" };
	if ("empty" in reply) {
		return new Response(null, { status: 204, headers });
	}
	if ("text" in reply) {
		return new Response(reply.text, { headers });
	}
	return Response.json(reply.json, { headers });
}

/** A route this test adds: the shared stub replies, or a Response factory (streams). */
type Route = readonly [string, StubReply | (() => Response)];

function routedFetch(routes: readonly Route[]) {
	return (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const key = `${init?.method ?? request.method} ${new URL(request.url).pathname}`;
		const route = routes.find(([pattern]) =>
			new RegExp(pattern, "u").test(key)
		);
		if (route === undefined) {
			return Promise.resolve(
				Response.json({ error: `no stub for ${key}` }, { status: 599 })
			);
		}
		const reply = route[1];
		return Promise.resolve(
			typeof reply === "function" ? reply() : stubResponse(reply)
		);
	};
}

const CASES = TOOL_OUTPUT_CASES;
const EMPTY_EVENTS: Route = [
	"sessions/msess_1/events$",
	{ json: { data: [], hasMore: false, nextAfter: 0, headSeq: 0 } },
];

/** Validates `value` with the zod schema and with the advertised JSON Schema. */
function conforms(tool: (typeof RYU_TOOLS)[number], value: unknown) {
	const fromZod = tool.outputSchema.safeParse(value);
	const fromJson = z
		.fromJSONSchema(
			ryuToolOutputJsonSchema(tool) as z.core.JSONSchema.JSONSchema
		)
		.safeParse(value);
	return {
		zod: fromZod.success ? "ok" : fromZod.error.message,
		json: fromJson.success ? "ok" : fromJson.error.message,
	};
}

describe("every tool declares an outputSchema", () => {
	test("the root is { data, meta }, both required", () => {
		for (const tool of RYU_TOOLS) {
			const schema = ryuToolOutputJsonSchema(tool);
			expect({
				tool: tool.name,
				type: schema.type,
				required: schema.required,
			}).toEqual({
				tool: tool.name,
				type: "object",
				required: ["data", "meta"],
			});
			expect(Object.keys(schema.properties as object).sort()).toEqual([
				"data",
				"meta",
			]);
			expect(tool.outputSchema.shape.meta).toBe(toolMetaSchema);
			// The input schema conversion is unaffected.
			expect(ryuToolJsonSchema(tool).type).toBe("object");
		}
	});

	test("there is a success case for every tool and no stale one", () => {
		expect(Object.keys(CASES).sort()).toEqual(
			RYU_TOOLS.map((tool) => tool.name).sort()
		);
		const names = new Set(RYU_TOOLS.map((tool) => tool.name));
		for (const variant of TOOL_OUTPUT_VARIANTS) {
			expect({
				variant: variant.label,
				known: names.has(variant.tool),
			}).toEqual({ variant: variant.label, known: true });
		}
	});
});

/**
 * Runs `tool` against `routes` and checks both projections of its success
 * against the schema. `outcome` equals CONFORMING when the call succeeded and
 * both conform.
 */
async function runSuccess(
	tool: (typeof RYU_TOOLS)[number],
	input: Record<string, unknown>,
	routes: readonly Route[]
) {
	const ryu = new Ryu({ env: ENV, fetch: routedFetch(routes) });
	const result = await runRyuTool(ryu, tool, input);
	// What the AI SDK, @ryuhq/sdk and Python adapters return: compact meta.
	// Their success also carries `error: null`, outside the schema.
	const compact = toToolResultJson(result);
	return {
		data: compact.data as Record<string, unknown> | null,
		outcome: {
			tool: tool.name,
			error: result.error?.message ?? null,
			// What `ryu-services mcp` puts in structuredContent: the full meta.
			mcp: conforms(
				tool,
				toPlainJson({ data: result.data ?? null, meta: result.meta })
			),
			compact: conforms(tool, { data: compact.data, meta: compact.meta }),
		},
	};
}

const OK = { zod: "ok", json: "ok" };
const conforming = (tool: string) => ({
	tool,
	error: null,
	mcp: OK,
	compact: OK,
});

function registered(name: string) {
	const tool = getRyuTool(name);
	if (tool === undefined) {
		throw new Error(`${name} is not registered`);
	}
	return tool;
}

describe("every tool body's success conforms to its outputSchema", () => {
	for (const tool of RYU_TOOLS) {
		test(tool.name, async () => {
			const definition = CASES[tool.name];
			if (definition === undefined) {
				throw new Error(`no case for ${tool.name}`);
			}
			const { outcome } = await runSuccess(
				tool,
				definition.input,
				definition.routes
			);
			expect(outcome).toEqual(conforming(tool.name));
		});
	}

	for (const variant of TOOL_OUTPUT_VARIANTS) {
		test(`${variant.tool}: ${variant.label}`, async () => {
			const { outcome } = await runSuccess(
				registered(variant.tool),
				variant.input,
				variant.routes
			);
			expect(outcome).toEqual(conforming(variant.tool));
		});
	}

	test("the variants reach the result shapes they name", async () => {
		const run = async (label: string) => {
			const variant = TOOL_OUTPUT_VARIANTS.find((item) => item.label === label);
			if (variant === undefined) {
				throw new Error(`no variant ${label}`);
			}
			// Conformance is checked per variant above; this pins the shape.
			const { data } = await runSuccess(
				registered(variant.tool),
				variant.input,
				variant.routes
			);
			return data;
		};
		expect(await run("still pending when waitMs runs out")).toMatchObject({
			approved: false,
			status: "pending",
			timedOut: false,
			value: null,
		});
		expect(await run("expired (timedOut true)")).toMatchObject({
			status: "expired",
			timedOut: true,
		});
		expect(await run("answered with a value")).toMatchObject({
			approved: true,
			value: "after 5pm",
		});
		expect(
			await run("a self-hosted server's snake_case message")
		).toMatchObject({
			inboxId: "inbox_1",
			threadId: "thr_1",
			from: "p@example.com",
			cc: ["cc@example.com"],
			attachments: [{ contentId: "logo", inline: true, size: 42 }],
		});
		expect(
			await run("a sparse snake_case status (defaults filled in)")
		).toEqual({
			apiVersion: "v1",
			configured: true,
			domain: null,
			domainMode: "byo",
			inboxCount: 2,
			inbound: "webhook",
			sendConfigured: false,
		});
		expect(await run("hosted Mail's status with its domain")).toEqual({
			apiVersion: "v1",
			configured: true,
			domain: "agents.example.com",
			domainMode: "managed",
			inboxCount: 0,
			inbound: "sns",
			sendConfigured: true,
		});
		expect(
			await run(
				"a remixed Site with a custom domain, a connection and a Site tool"
			)
		).toMatchObject({
			domains: [{ host: "launch.example.com", status: "pending_tls" }],
			connections: [{ id: "crm", readOnly: true }],
			remixedFrom: { siteId: "site_source", versionId: "ver_source" },
			versions: [{ extensions: { mcp: true, connections: ["crm"] } }],
		});
	});

	test("a Mail count or size that is not a number is an invalid response, not null", async () => {
		const sendCase = CASES.mail_send;
		if (sendCase === undefined) {
			throw new Error("no case for mail_send");
		}
		const failures = [
			{
				tool: "mail_status",
				input: {},
				routes: [
					[
						"/api/mail/status$",
						{ json: { configured: true, inboxCount: "n/a" } },
					],
				] as const,
			},
			{
				tool: "mail_send",
				input: sendCase.input,
				routes: [
					[
						"^POST /api/mail/inboxes/inbox_1/send$",
						{
							json: {
								id: "msg_1",
								inboxId: "inbox_1",
								attachments: [{ id: "att_1", size: "n/a" }],
							},
						},
					],
				] as const,
			},
		];
		for (const failure of failures) {
			const ryu = new Ryu({ env: ENV, fetch: routedFetch(failure.routes) });
			const result = await runRyuTool(
				ryu,
				registered(failure.tool),
				failure.input
			);
			expect(result.data).toBeNull();
			expect(result.error?.code).toBe("invalid_response");
		}
	});

	test("managed_agents_list_events with wait conforms, approval stop included", async () => {
		const { data, outcome } = await runSuccess(
			registered("managed_agents_list_events"),
			{ sessionId: "msess_1", wait: true, timeoutMs: 2000 },
			[EMPTY_EVENTS, ["sessions/msess_1/stream$", () => sse(MA_LOG)]]
		);
		expect(outcome).toEqual(conforming("managed_agents_list_events"));
		expect(data).toMatchObject({
			requiresAction: true,
			next: "managed_agents_list_pending_approvals",
		});
	});

	test("managed_agents_list_events with wait conforms when it times out", async () => {
		const { data, outcome } = await runSuccess(
			registered("managed_agents_list_events"),
			{ sessionId: "msess_1", wait: true, timeoutMs: 50 },
			[
				EMPTY_EVENTS,
				["sessions/msess_1/stream$", () => sse(MA_LOG.slice(0, 1), true)],
			]
		);
		expect(outcome).toEqual(conforming("managed_agents_list_events"));
		expect(data).toMatchObject({ turnEnded: false, timedOut: true });
	});

	test("managed_agents_list_events with wait conforms when the host cancels", async () => {
		const tool = registered("managed_agents_list_events");
		const ryu = new Ryu({
			env: ENV,
			fetch: routedFetch([
				EMPTY_EVENTS,
				["sessions/msess_1/stream$", () => sse(MA_LOG.slice(0, 1), true)],
			]),
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await runRyuTool(
			ryu,
			tool,
			{ sessionId: "msess_1", wait: true, timeoutMs: 5000 },
			{ signal: controller.signal }
		);
		expect(result.error).toBeNull();
		expect(result.data).toMatchObject({ canceled: true, turnEnded: false });
		expect(
			conforms(tool, toPlainJson({ data: result.data, meta: result.meta }))
		).toEqual({ zod: "ok", json: "ok" });
	});

	test("a result that breaks the contract is refused", () => {
		const tool = getRyuTool("box_read_file");
		if (tool === undefined) {
			throw new Error("box_read_file is not registered");
		}
		expect(conforms(tool, { data: { path: "a" }, meta: {} }).zod).not.toBe(
			"ok"
		);
		expect(conforms(tool, { data: null, meta: {} }).json).not.toBe("ok");
	});
});

describe("data schemas that mirror a decoder in this package stay equal to it", () => {
	const json = (schema: z.ZodType) =>
		z.toJSONSchema(schema, { io: "output", unrepresentable: "any" });
	test.each([
		["sites project", SITES_PROJECT_DATA, sitesProjectSchema],
		[
			"passport profiles",
			PASSPORT_PROFILE_LIST_DATA,
			passportProfileListSchema,
		],
		[
			"passport connections",
			PASSPORT_CONNECTION_LIST_DATA,
			passportConnectionListSchema,
		],
		["passport fetch", PASSPORT_FETCH_DATA, passportFetchResultSchema],
		["gateway models", GATEWAY_MODEL_LIST_DATA, gatewayModelListSchema],
		["gateway chat", GATEWAY_CHAT_COMPLETION_DATA, gatewayChatCompletionSchema],
	] as const)("%s", (_name, mirror, decoder) => {
		expect(json(mirror)).toEqual(json(decoder));
	});
});
