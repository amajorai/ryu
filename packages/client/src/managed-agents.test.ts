import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type CreateManagedAgentEnvironmentInput,
	type CreateManagedAgentInput,
	type CreateManagedAgentSessionInput,
	createManagedAgentsClient,
	MANAGED_AGENTS_PROTOCOL_VERSION,
	MANAGED_AGENTS_REDIRECT_ERROR_CODE,
	type ManagedAgentBackend,
	type ManagedAgentEvent,
	type ManagedAgentsAPI,
	ManagedAgentsError,
	type ManagedAgentUserEventInput,
	type UpdateManagedAgentEnvironmentInput,
	type UpdateManagedAgentInput,
	type UpdateManagedAgentSessionInput,
} from "./managed-agents.ts";
import {
	MANAGED_AGENT_EVENT_TYPES,
	managedAgentCredentialSchema,
	managedAgentEnvironmentSchema,
	managedAgentEventListSchema,
	managedAgentEventSchema,
	managedAgentSchema,
	managedAgentSessionSchema,
	managedAgentStreamEndSchema,
	managedAgentsErrorBodySchema,
	managedAgentsListSchema,
	managedAgentUnknownEventSchema,
	managedAgentVersionSchema,
} from "./managed-agents-contracts.ts";

// The shared contract fixtures of @ryuhq/protocol/managed-agents. Both packages are mirrored
// together, so the relative path holds in the public repository too.
const FIXTURE_URL = new URL(
	"../../protocol/src/fixtures/managed-agents.json",
	import.meta.url
);
const fixtureSchema = z.object({
	inputs: z.object({
		cancelSession: z.unknown(),
		createAgent: z.unknown(),
		createEnvironment: z.record(z.string(), z.unknown()),
		createSession: z.unknown(),
		sendEvents: z.record(z.string(), z.unknown()),
		updateAgent: z.unknown(),
		updateEnvironment: z.unknown(),
		updateSession: z.unknown(),
	}),
	protocolVersion: z.string(),
	responses: z.object({
		agent: z.unknown(),
		agentList: z.unknown(),
		agentVersion: z.unknown(),
		credential: z.unknown(),
		environments: z.record(z.string(), z.unknown()),
		errorBody: z.unknown(),
		eventList: z.unknown(),
		events: z.array(z.unknown()),
		reservedEvents: z.array(z.unknown()),
		session: z.unknown(),
		streamEnd: z.unknown(),
		unknownEvent: z.unknown(),
	}),
});
const fixture = fixtureSchema.parse(await Bun.file(FIXTURE_URL).json());
const { inputs, responses } = fixture;

const API_KEY = "ryu_test_key_0123456789";
const ORGANIZATION_ID = "6720a3c1f0e1d2c3b4a59600";
const IDEMPOTENCY_KEY = "create-agent-0000000001";
const AGENT_ID = "magt_99d6c3da89ede61e1136eda4c3586ae5";
const ENVIRONMENT_ID = "menv_297797c5c1da7ff84a99ac4f7e6a89ae";
const CREDENTIAL_ID = "mcred_f82a3a00752b694f4bc2a7f40bb14448";
const SESSION_ID = "msess_f134fbee29b73487eafbf568809a051d";
const BASE = "/api/v1/managed-agents";

// Typed request bodies, proven equal to the protocol's input fixtures below.
const createAgentInput: CreateManagedAgentInput = {
	name: "Support triage",
	description: null,
	model: "claude-opus-5-5",
	instructions: "You triage support tickets.",
	reasoningEffort: "medium",
	tools: [
		{
			type: "builtin",
			name: "web_search",
			allowedDomains: ["docs.example.com"],
		},
		{
			type: "custom",
			name: "lookup_order",
			description: "Find an order by id",
			inputSchema: {
				type: "object",
				properties: { orderId: { type: "string" } },
				required: ["orderId"],
			},
		},
	],
	mcpServers: [
		{ name: "tickets", url: "https://mcp.example.com/mcp", allowedTools: null },
	],
	metadata: { team: "support" },
};
const updateAgentInput: UpdateManagedAgentInput = {
	expectedVersion: 1,
	instructions: "You triage support tickets and suggest a priority.",
	reasoningEffort: null,
	metadata: { team: "support", owner: null },
};
const createEnvironmentInputs: Record<
	ManagedAgentBackend,
	CreateManagedAgentEnvironmentInput
> = {
	anthropic: {
		name: "claude-prod",
		description: null,
		backend: "anthropic",
		credential: { source: "byok", credentialId: CREDENTIAL_ID },
		config: {
			networking: {
				type: "limited",
				allowedHosts: ["api.example.com"],
				allowPackageManagers: true,
				allowMcpServers: true,
			},
			packages: {
				apt: [],
				cargo: [],
				gem: [],
				go: [],
				npm: [],
				pip: ["pandas"],
			},
		},
	},
	openai: {
		name: "openai-prod",
		backend: "openai",
		credential: { source: "platform" },
	},
	gemini: {
		name: "gemini-prod",
		description: "Gemini with a narrow allowlist",
		backend: "gemini",
		credential: { source: "platform" },
		config: {
			network: {
				type: "allowlist",
				domains: ["*.example.com", "api.example.org"],
			},
			maxTotalTokens: 200_000,
		},
	},
	ryu_node: {
		name: "office-node",
		backend: "ryu_node",
		credential: { source: "none" },
		config: { nodeId: "4f0c2a9e-6d4b-4f1e-9a63-2b8f0d7c5e11" },
	},
	ryu_serverless: { name: "serverless-preview", backend: "ryu_serverless" },
};
const updateEnvironmentInput: UpdateManagedAgentEnvironmentInput = {
	expectedRevision: 1,
	name: "claude-prod-2",
	config: {
		networking: { type: "limited", allowedHosts: ["api.example.com"] },
	},
};
const createSessionInput: CreateManagedAgentSessionInput = {
	agentId: AGENT_ID,
	agentVersion: 3,
	environmentId: ENVIRONMENT_ID,
	title: "Ticket 1234",
	metadata: { ticket: "1234" },
	budget: { maxCostMicroUsd: 2_000_000 },
	initialEvents: [
		{
			type: "user.message",
			content: [{ type: "text", text: "Summarize ticket 1234" }],
		},
	],
};
const updateSessionInput: UpdateManagedAgentSessionInput = {
	title: "Ticket 1234 (escalated)",
	metadata: { ticket: null, priority: "high" },
};
const sendEventsInputs: Record<
	"customToolResults" | "interrupt" | "messages",
	{ events: ManagedAgentUserEventInput[] }
> = {
	messages: {
		events: [
			{
				type: "user.message",
				content: [{ type: "text", text: "What is the weather in Oslo?" }],
			},
		],
	},
	interrupt: { events: [{ type: "user.interrupt" }] },
	customToolResults: {
		events: [
			{
				type: "user.custom_tool_result",
				toolUseId: "mtool_282960f9254fdec6c49291a498e6ca78",
				content: [{ type: "text", text: "4°C, rain" }],
				isError: false,
			},
		],
	},
};
const cancelReason = "No longer needed";

const logEvents = z.array(managedAgentEventSchema).parse(responses.events);
const environmentReplies = Object.values(responses.environments);

interface RecordedRequest {
	body: string;
	headers: Headers;
	method: string;
	path: string;
	query: Record<string, string>;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers) {
		server.stop(true);
	}
	servers.length = 0;
});

function stubServer(
	reply: (request: RecordedRequest, index: number) => Response
) {
	const requests: RecordedRequest[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const recorded: RecordedRequest = {
				body: await request.text(),
				headers: request.headers,
				method: request.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
			};
			requests.push(recorded);
			return reply(recorded, requests.length - 1);
		},
	});
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${server.port}/`, requests };
}

function clientFor(baseUrl: string, organizationId?: string) {
	return createManagedAgentsClient({
		apiKey: API_KEY,
		baseUrl,
		organizationId,
	});
}

const encoder = new TextEncoder();

function eventFrame(event: { seq: number; type: string }): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** An SSE reply. `close: false` keeps the connection open until the client cancels it. */
function sseReply(frames: string[], close: boolean): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("retry: 2000\n\n"));
			for (const frame of frames) {
				controller.enqueue(encoder.encode(frame));
			}
			controller.enqueue(encoder.encode(": keepalive\n\n"));
			if (close) {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: {
			"Cache-Control": "no-cache, no-transform",
			"Content-Type": "text/event-stream; charset=utf-8",
		},
	});
}

function eventAt(seq: number): ManagedAgentEvent {
	const event = logEvents.find((entry) => entry.seq === seq);
	if (!event) {
		throw new Error(`fixture has no event ${seq}`);
	}
	return event;
}

async function collect(
	iterator: AsyncGenerator<ManagedAgentEvent>
): Promise<ManagedAgentEvent[]> {
	const events: ManagedAgentEvent[] = [];
	for await (const event of iterator) {
		events.push(event);
	}
	return events;
}

interface RouteCase {
	body?: unknown;
	call: (client: ManagedAgentsAPI) => Promise<unknown>;
	expected: unknown;
	idempotencyKey?: string;
	method: string;
	path: string;
	query?: Record<string, string>;
	reply: unknown;
	route: string;
	status: number;
}

const appendedEvent = eventAt(2);
const routeCases: RouteCase[] = [
	{
		route: "POST /agents",
		call: (client) =>
			client.agents.create(createAgentInput, {
				idempotencyKey: IDEMPOTENCY_KEY,
			}),
		method: "POST",
		path: "/agents",
		body: createAgentInput,
		idempotencyKey: IDEMPOTENCY_KEY,
		status: 201,
		reply: responses.agent,
		expected: responses.agent,
	},
	{
		route: "GET /agents",
		call: (client) =>
			client.agents.list({ cursor: "c1", includeArchived: true, limit: 10 }),
		method: "GET",
		path: "/agents",
		query: { cursor: "c1", includeArchived: "true", limit: "10" },
		status: 200,
		reply: responses.agentList,
		expected: responses.agentList,
	},
	{
		route: "GET /agents/{agentId}",
		call: (client) => client.agents.get(AGENT_ID),
		method: "GET",
		path: `/agents/${AGENT_ID}`,
		status: 200,
		reply: responses.agent,
		expected: responses.agent,
	},
	{
		route: "PATCH /agents/{agentId}",
		call: (client) =>
			client.agents.update(AGENT_ID, updateAgentInput, {
				idempotencyKey: IDEMPOTENCY_KEY,
			}),
		method: "PATCH",
		path: `/agents/${AGENT_ID}`,
		body: updateAgentInput,
		idempotencyKey: IDEMPOTENCY_KEY,
		status: 200,
		reply: responses.agent,
		expected: responses.agent,
	},
	{
		route: "POST /agents/{agentId}/archive",
		call: (client) => client.agents.archive(AGENT_ID),
		method: "POST",
		path: `/agents/${AGENT_ID}/archive`,
		status: 200,
		reply: responses.agent,
		expected: responses.agent,
	},
	{
		route: "GET /agents/{agentId}/versions",
		call: (client) => client.agents.listVersions(AGENT_ID, { limit: 5 }),
		method: "GET",
		path: `/agents/${AGENT_ID}/versions`,
		query: { limit: "5" },
		status: 200,
		reply: { data: [responses.agentVersion], nextCursor: null },
		expected: { data: [responses.agentVersion], nextCursor: null },
	},
	{
		route: "GET /agents/{agentId}/versions/{version}",
		call: (client) => client.agents.getVersion(AGENT_ID, 3),
		method: "GET",
		path: `/agents/${AGENT_ID}/versions/3`,
		status: 200,
		reply: responses.agentVersion,
		expected: responses.agentVersion,
	},
	{
		route: "POST /environments",
		call: (client) =>
			client.environments.create(createEnvironmentInputs.anthropic, {
				idempotencyKey: IDEMPOTENCY_KEY,
			}),
		method: "POST",
		path: "/environments",
		body: createEnvironmentInputs.anthropic,
		idempotencyKey: IDEMPOTENCY_KEY,
		status: 201,
		reply: responses.environments.anthropic,
		expected: responses.environments.anthropic,
	},
	{
		route: "GET /environments",
		call: (client) =>
			client.environments.list({
				cursor: "c2",
				includeArchived: true,
				limit: 2,
			}),
		method: "GET",
		path: "/environments",
		query: { cursor: "c2", includeArchived: "true", limit: "2" },
		status: 200,
		reply: { data: environmentReplies, nextCursor: null },
		expected: { data: environmentReplies, nextCursor: null },
	},
	{
		route: "GET /environments/{environmentId}",
		call: (client) => client.environments.get(ENVIRONMENT_ID),
		method: "GET",
		path: `/environments/${ENVIRONMENT_ID}`,
		status: 200,
		reply: responses.environments.anthropic,
		expected: responses.environments.anthropic,
	},
	{
		route: "PATCH /environments/{environmentId}",
		call: (client) =>
			client.environments.update(ENVIRONMENT_ID, updateEnvironmentInput, {
				idempotencyKey: IDEMPOTENCY_KEY,
			}),
		method: "PATCH",
		path: `/environments/${ENVIRONMENT_ID}`,
		body: updateEnvironmentInput,
		idempotencyKey: IDEMPOTENCY_KEY,
		status: 200,
		reply: responses.environments.anthropic,
		expected: responses.environments.anthropic,
	},
	{
		route: "POST /environments/{environmentId}/archive",
		call: (client) => client.environments.archive(ENVIRONMENT_ID),
		method: "POST",
		path: `/environments/${ENVIRONMENT_ID}/archive`,
		status: 200,
		reply: responses.environments.anthropic,
		expected: responses.environments.anthropic,
	},
	{
		route: "GET /credentials",
		call: (client) =>
			client.credentials.list({ includeRevoked: true, limit: 1 }),
		method: "GET",
		path: "/credentials",
		query: { includeRevoked: "true", limit: "1" },
		status: 200,
		reply: { data: [responses.credential], nextCursor: null },
		expected: { data: [responses.credential], nextCursor: null },
	},
	{
		route: "GET /credentials/{credentialId}",
		call: (client) => client.credentials.get(CREDENTIAL_ID),
		method: "GET",
		path: `/credentials/${CREDENTIAL_ID}`,
		status: 200,
		reply: responses.credential,
		expected: responses.credential,
	},
	{
		route: "POST /sessions",
		call: (client) =>
			client.sessions.create(createSessionInput, {
				idempotencyKey: IDEMPOTENCY_KEY,
			}),
		method: "POST",
		path: "/sessions",
		body: createSessionInput,
		idempotencyKey: IDEMPOTENCY_KEY,
		status: 201,
		reply: responses.session,
		expected: responses.session,
	},
	{
		route: "GET /sessions",
		call: (client) =>
			client.sessions.list({
				agentId: AGENT_ID,
				cursor: "c2",
				environmentId: ENVIRONMENT_ID,
				limit: 2,
				status: "idle",
			}),
		method: "GET",
		path: "/sessions",
		query: {
			agentId: AGENT_ID,
			cursor: "c2",
			environmentId: ENVIRONMENT_ID,
			limit: "2",
			status: "idle",
		},
		status: 200,
		reply: { data: [responses.session], nextCursor: null },
		expected: { data: [responses.session], nextCursor: null },
	},
	{
		route: "GET /sessions/{sessionId}",
		call: (client) => client.sessions.get(SESSION_ID),
		method: "GET",
		path: `/sessions/${SESSION_ID}`,
		status: 200,
		reply: responses.session,
		expected: responses.session,
	},
	{
		route: "PATCH /sessions/{sessionId}",
		call: (client) => client.sessions.update(SESSION_ID, updateSessionInput),
		method: "PATCH",
		path: `/sessions/${SESSION_ID}`,
		body: updateSessionInput,
		status: 200,
		reply: responses.session,
		expected: responses.session,
	},
	{
		route: "POST /sessions/{sessionId}/events",
		call: (client) =>
			client.sessions.send(SESSION_ID, sendEventsInputs.messages.events, {
				idempotencyKey: IDEMPOTENCY_KEY,
			}),
		method: "POST",
		path: `/sessions/${SESSION_ID}/events`,
		body: sendEventsInputs.messages,
		idempotencyKey: IDEMPOTENCY_KEY,
		status: 202,
		reply: { data: [appendedEvent] },
		expected: [appendedEvent],
	},
	{
		route: "GET /sessions/{sessionId}/events",
		call: (client) =>
			client.sessions.events(SESSION_ID, {
				after: 0,
				limit: 2,
				types: ["session.status", "user.message"],
			}),
		method: "GET",
		path: `/sessions/${SESSION_ID}/events`,
		query: { after: "0", limit: "2", types: "session.status,user.message" },
		status: 200,
		reply: responses.eventList,
		expected: responses.eventList,
	},
	{
		route: "POST /sessions/{sessionId}/cancel",
		call: (client) => client.sessions.cancel(SESSION_ID, cancelReason),
		method: "POST",
		path: `/sessions/${SESSION_ID}/cancel`,
		body: { reason: cancelReason },
		status: 202,
		reply: responses.session,
		expected: responses.session,
	},
	{
		route: "POST /sessions/{sessionId}/complete",
		call: (client) => client.sessions.complete(SESSION_ID),
		method: "POST",
		path: `/sessions/${SESSION_ID}/complete`,
		status: 202,
		reply: responses.session,
		expected: responses.session,
	},
	{
		route: "DELETE /sessions/{sessionId}",
		call: (client) => client.sessions.delete(SESSION_ID),
		method: "DELETE",
		path: `/sessions/${SESSION_ID}`,
		status: 204,
		reply: null,
		expected: undefined,
	},
];

function replyFor(routeCase: RouteCase | undefined): Response {
	if (!routeCase) {
		return Response.json({ unexpected: true }, { status: 500 });
	}
	if (routeCase.reply === null) {
		return new Response(null, { status: routeCase.status });
	}
	return Response.json(routeCase.reply, { status: routeCase.status });
}

describe("ManagedAgentsAPI fixture parity", () => {
	test("pins the protocol contract version the client mirrors", () => {
		expect(fixture.protocolVersion).toBe(MANAGED_AGENTS_PROTOCOL_VERSION);
		expect(MANAGED_AGENTS_PROTOCOL_VERSION).toBe("ryu.managed-agents.v1");
	});

	test("every response fixture parses with the client contracts to the raw value", () => {
		expect<unknown>(managedAgentSchema.parse(responses.agent)).toBe(
			responses.agent
		);
		expect<unknown>(
			managedAgentVersionSchema.parse(responses.agentVersion)
		).toBe(responses.agentVersion);
		expect<unknown>(
			managedAgentsListSchema(managedAgentSchema).parse(responses.agentList)
		).toBe(responses.agentList);
		for (const environment of environmentReplies) {
			expect<unknown>(managedAgentEnvironmentSchema.parse(environment)).toBe(
				environment
			);
		}
		expect<unknown>(
			managedAgentCredentialSchema.parse(responses.credential)
		).toBe(responses.credential);
		expect<unknown>(managedAgentSessionSchema.parse(responses.session)).toBe(
			responses.session
		);
		expect<unknown>(
			managedAgentEventListSchema.parse(responses.eventList)
		).toBe(responses.eventList);
		expect<unknown>(
			managedAgentStreamEndSchema.parse(responses.streamEnd)
		).toBe(responses.streamEnd);
		expect<unknown>(
			managedAgentsErrorBodySchema.parse(responses.errorBody)
		).toBe(responses.errorBody);
	});

	test("every event fixture parses as a known event and covers every event type", () => {
		const events = [...responses.events, ...responses.reservedEvents];
		const types = new Set<string>();
		for (const event of events) {
			const parsed = managedAgentEventSchema.parse(event);
			expect<unknown>(parsed).toBe(event);
			types.add(parsed.type);
		}
		expect(types).toEqual(new Set<string>(MANAGED_AGENT_EVENT_TYPES));
	});

	test("an unknown event type is tolerated as unknown, not as a known event", () => {
		expect(
			managedAgentEventSchema.safeParse(responses.unknownEvent).success
		).toBe(false);
		expect<unknown>(
			managedAgentUnknownEventSchema.parse(responses.unknownEvent)
		).toBe(responses.unknownEvent);
		const page = {
			data: [responses.unknownEvent],
			hasMore: false,
			nextAfter: 18,
			headSeq: 18,
		};
		expect<unknown>(managedAgentEventListSchema.parse(page)).toBe(page);
	});

	test("fields the protocol carries as JSON accept JSON and reject values JSON cannot carry", () => {
		const agent = z.record(z.string(), z.unknown()).parse(responses.agent);
		const customToolUse = logEvents.find(
			(event) => event.type === "agent.custom_tool_use"
		);
		const unknownEvent = z
			.record(z.string(), z.unknown())
			.parse(responses.unknownEvent);
		const errorBody = z
			.object({ error: z.record(z.string(), z.unknown()) })
			.parse(responses.errorBody);
		expect(customToolUse).toBeDefined();
		const values = [
			{ value: 1, accepted: true },
			{ value: Number.NaN, accepted: false },
			{ value: Number.POSITIVE_INFINITY, accepted: false },
			{ value: undefined, accepted: false },
		];
		for (const { value, accepted } of values) {
			const customTool = {
				type: "custom",
				name: "lookup_order",
				description: "Find an order by id",
				inputSchema: { type: "object", default: value },
			};
			expect(
				managedAgentSchema.safeParse({ ...agent, tools: [customTool] }).success
			).toBe(accepted);
			expect(
				managedAgentEventSchema.safeParse({
					...customToolUse,
					input: { orderId: value },
				}).success
			).toBe(accepted);
			expect(
				managedAgentUnknownEventSchema.safeParse({
					...unknownEvent,
					future: value,
				}).success
			).toBe(accepted);
			expect(
				managedAgentsErrorBodySchema.safeParse({
					error: { ...errorBody.error, details: { latestVersion: value } },
				}).success
			).toBe(accepted);
		}
	});

	test("the typed request bodies equal the protocol's input fixtures", () => {
		expect<unknown>(createAgentInput).toEqual(inputs.createAgent);
		expect<unknown>(updateAgentInput).toEqual(inputs.updateAgent);
		expect<unknown>(createEnvironmentInputs).toEqual(inputs.createEnvironment);
		expect<unknown>(updateEnvironmentInput).toEqual(inputs.updateEnvironment);
		expect<unknown>(createSessionInput).toEqual(inputs.createSession);
		expect<unknown>(updateSessionInput).toEqual(inputs.updateSession);
		expect<unknown>(sendEventsInputs).toEqual(inputs.sendEvents);
		expect<unknown>({ reason: cancelReason }).toEqual(inputs.cancelSession);
	});
});

describe("ManagedAgentsAPI requests", () => {
	test("each method sends its method, path, query, headers and body", async () => {
		const { baseUrl, requests } = stubServer((_request, index) =>
			replyFor(routeCases[index])
		);
		const client = clientFor(baseUrl, ORGANIZATION_ID);
		for (const routeCase of routeCases) {
			const result = await routeCase.call(client);
			expect<unknown>(result).toEqual(routeCase.expected);
		}
		expect(requests).toHaveLength(routeCases.length);
		for (const [index, routeCase] of routeCases.entries()) {
			const request = requests[index];
			expect(request?.method).toBe(routeCase.method);
			expect(request?.path).toBe(`${BASE}${routeCase.path}`);
			expect(request?.query).toEqual(routeCase.query ?? {});
			expect(request?.headers.get("x-api-key")).toBe(API_KEY);
			expect(request?.headers.get("x-ryu-organization")).toBe(ORGANIZATION_ID);
			expect(request?.headers.get("authorization")).toBeNull();
			expect(request?.headers.get("accept")).toBe("application/json");
			expect(request?.headers.get("idempotency-key")).toBe(
				routeCase.idempotencyKey ?? null
			);
			expect(request?.headers.get("content-type")).toBe(
				routeCase.body === undefined ? null : "application/json"
			);
			expect<unknown>(
				request?.body ? JSON.parse(request.body) : undefined
			).toEqual(routeCase.body);
		}
	});

	test("the methods cover every key-usable REST route", () => {
		expect(routeCases.map((routeCase) => routeCase.route)).toEqual([
			"POST /agents",
			"GET /agents",
			"GET /agents/{agentId}",
			"PATCH /agents/{agentId}",
			"POST /agents/{agentId}/archive",
			"GET /agents/{agentId}/versions",
			"GET /agents/{agentId}/versions/{version}",
			"POST /environments",
			"GET /environments",
			"GET /environments/{environmentId}",
			"PATCH /environments/{environmentId}",
			"POST /environments/{environmentId}/archive",
			"GET /credentials",
			"GET /credentials/{credentialId}",
			"POST /sessions",
			"GET /sessions",
			"GET /sessions/{sessionId}",
			"PATCH /sessions/{sessionId}",
			"POST /sessions/{sessionId}/events",
			"GET /sessions/{sessionId}/events",
			"POST /sessions/{sessionId}/cancel",
			"POST /sessions/{sessionId}/complete",
			"DELETE /sessions/{sessionId}",
		]);
	});

	test("omits the organization header when none is configured and keeps keys out of URLs", async () => {
		const { baseUrl, requests } = stubServer(() =>
			Response.json(responses.session)
		);
		await clientFor(baseUrl).sessions.get(SESSION_ID);
		const [request] = requests;
		expect(request?.headers.has("x-ryu-organization")).toBe(false);
		expect(request?.headers.get("x-api-key")).toBe(API_KEY);
		expect(JSON.stringify(request?.query)).not.toContain(API_KEY);
		expect(request?.path).not.toContain(API_KEY);
	});

	test("respondToApproval appends one user.tool_approval answer", async () => {
		const approval = eventAt(16);
		const { baseUrl, requests } = stubServer(() =>
			Response.json({ data: [approval] }, { status: 202 })
		);
		const appended = await clientFor(baseUrl).sessions.respondToApproval(
			SESSION_ID,
			"mtool_5d2c8e1f0a9b4c7d6e3f2a1b0c9d8e7f",
			"deny",
			{
				message: "Do not run shell commands on this ticket.",
				idempotencyKey: "approval-key-0000000001",
			}
		);
		expect<unknown>(appended).toEqual(approval);
		expect(requests[0]?.path).toBe(`${BASE}/sessions/${SESSION_ID}/events`);
		expect(requests[0]?.headers.get("idempotency-key")).toBe(
			"approval-key-0000000001"
		);
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
			events: [
				{
					type: "user.tool_approval",
					toolUseId: "mtool_5d2c8e1f0a9b4c7d6e3f2a1b0c9d8e7f",
					decision: "deny",
					message: "Do not run shell commands on this ticket.",
				},
			],
		});
	});

	test("cancel without a reason sends an empty object and ids are path-encoded", async () => {
		const { baseUrl, requests } = stubServer(() =>
			Response.json(responses.session, { status: 202 })
		);
		await clientFor(baseUrl).sessions.cancel("a/b c");
		expect(requests[0]?.path).toBe(`${BASE}/sessions/a%2Fb%20c/cancel`);
		expect(requests[0]?.body).toBe("{}");
	});
});

describe("ManagedAgentsAPI errors and responses", () => {
	test("the error envelope becomes a ManagedAgentsError", async () => {
		const { baseUrl } = stubServer(() =>
			Response.json(responses.errorBody, {
				headers: { "Retry-After": "1", "X-Request-ID": "req_header" },
				status: 409,
			})
		);
		const error = await clientFor(baseUrl)
			.agents.update(AGENT_ID, { expectedVersion: 3 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ManagedAgentsError);
		expect(error).toMatchObject({
			code: "version_conflict",
			details: { latestVersion: 4 },
			message: "agent version 3 is not the latest (4)",
			name: "ManagedAgentsError",
			requestId: "req_6560026397b928c09cb55aa71c2732a5",
			retryAfterSeconds: 1,
			status: 409,
		});
	});

	test("a reply without the envelope keeps its status and the header request id", async () => {
		const { baseUrl } = stubServer(
			() =>
				new Response("<html>Bad gateway</html>", {
					headers: {
						"Content-Type": "text/html",
						"X-Request-ID": "req_from_header",
					},
					status: 502,
				})
		);
		const error = await clientFor(baseUrl)
			.agents.get(AGENT_ID)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ManagedAgentsError);
		expect(error).toMatchObject({
			code: "unknown_error",
			details: null,
			requestId: "req_from_header",
			retryAfterSeconds: null,
			status: 502,
		});
	});

	test("a redirect is refused and never followed, so the API key stays on the configured origin", async () => {
		const target = stubServer(() => Response.json(responses.agent));
		const targetOrigin = new URL(target.baseUrl).origin;
		const statuses = [301, 302, 303, 307, 308];
		const { baseUrl, requests } = stubServer(
			(_request, index) =>
				new Response(null, {
					headers: {
						Location: `${target.baseUrl}login?state=opaque`,
						"X-Request-ID": "req_redirect",
					},
					status: statuses[index] ?? 301,
				})
		);
		const client = clientFor(baseUrl, ORGANIZATION_ID);
		for (const status of statuses) {
			const error = await client.agents
				.get(AGENT_ID)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ManagedAgentsError);
			expect(error).toMatchObject({
				code: MANAGED_AGENTS_REDIRECT_ERROR_CODE,
				details: { location: targetOrigin },
				requestId: "req_redirect",
				retryAfterSeconds: null,
				status,
			});
		}
		expect(requests).toHaveLength(statuses.length);
		expect(target.requests).toHaveLength(0);
	});

	test("a redirected stream is refused without reconnecting or following it", async () => {
		const target = stubServer(() => sseReply([], true));
		const { baseUrl, requests } = stubServer(
			() =>
				new Response(null, {
					headers: { Location: `${target.baseUrl}stream` },
					status: 307,
				})
		);
		const error = await collect(
			clientFor(baseUrl).sessions.stream(SESSION_ID)
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ManagedAgentsError);
		expect(error).toMatchObject({
			code: MANAGED_AGENTS_REDIRECT_ERROR_CODE,
			status: 307,
		});
		expect(requests).toHaveLength(1);
		expect(target.requests).toHaveLength(0);
	});

	test("requests use manual redirects and a browser's opaque redirect is refused", async () => {
		const inits: (RequestInit | undefined)[] = [];
		const client = createManagedAgentsClient({
			apiKey: API_KEY,
			baseUrl: "https://ryu.example.test",
			fetch: (_input, init) => {
				inits.push(init);
				// What a browser returns for `redirect: "manual"`: status 0, no headers, no body.
				const response = new Response(null);
				Object.defineProperties(response, {
					ok: { value: false },
					status: { value: 0 },
					type: { value: "opaqueredirect" },
				});
				return Promise.resolve(response);
			},
		});
		const error = await client.sessions
			.get(SESSION_ID)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ManagedAgentsError);
		expect(error).toMatchObject({
			code: MANAGED_AGENTS_REDIRECT_ERROR_CODE,
			details: { location: null },
			requestId: null,
			status: 0,
		});
		expect(inits).toHaveLength(1);
		expect(inits[0]?.redirect).toBe("manual");
	});

	test("malformed replies are rejected", async () => {
		const malformedSession = {
			...z.record(z.string(), z.unknown()).parse(responses.session),
			status: "paused",
		};
		const badStatusEvent = { ...eventAt(1), pendingToolUseIds: "none" };
		const replies = [
			{ ...z.record(z.string(), z.unknown()).parse(responses.agent), name: 7 },
			{ data: [malformedSession], nextCursor: null },
			{ data: [badStatusEvent], hasMore: false, nextAfter: 1, headSeq: 1 },
		];
		const { baseUrl } = stubServer((_request, index) =>
			index < replies.length
				? Response.json(replies[index])
				: new Response("{not json", { status: 200 })
		);
		const client = clientFor(baseUrl);
		await expect(client.agents.get(AGENT_ID)).rejects.toThrow();
		await expect(client.sessions.list()).rejects.toThrow();
		await expect(client.sessions.events(SESSION_ID)).rejects.toThrow();
		await expect(client.sessions.get(SESSION_ID)).rejects.toThrow();
	});

	test("extra fields are retained and unknown event types are dropped from a page", async () => {
		const agent = {
			...z.record(z.string(), z.unknown()).parse(responses.agent),
			future: { nested: [1, 2] },
			tools: [{ type: "mcp_toolset", server: "tickets" }],
		};
		const page = {
			data: [eventAt(1), responses.unknownEvent, eventAt(2)],
			future: "page",
			hasMore: false,
			headSeq: 18,
			nextAfter: 18,
		};
		const { baseUrl } = stubServer((_request, index) =>
			Response.json(index === 0 ? agent : page)
		);
		const client = clientFor(baseUrl);
		expect<unknown>(await client.agents.get(AGENT_ID)).toEqual(agent);
		expect<unknown>(await client.sessions.events(SESSION_ID)).toEqual({
			...page,
			data: [eventAt(1), eventAt(2)],
		});
	});
});

describe("ManagedAgentsAPI stream", () => {
	test("reconnects with Last-Event-ID after a drop, dedupes the replay and stops at the terminal status", async () => {
		const { baseUrl, requests } = stubServer((_request, index) =>
			index === 0
				? sseReply(logEvents.slice(0, 3).map(eventFrame), true)
				: sseReply(logEvents.slice(2).map(eventFrame), false)
		);
		const events = await collect(
			clientFor(baseUrl, ORGANIZATION_ID).sessions.stream(SESSION_ID)
		);
		expect(events.map((event) => event.seq)).toEqual(
			logEvents.map((event) => event.seq)
		);
		expect(events.at(-1)).toMatchObject({
			type: "session.status",
			status: "completed",
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]?.path).toBe(`${BASE}/sessions/${SESSION_ID}/stream`);
		expect(requests[0]?.headers.get("last-event-id")).toBeNull();
		expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(requests[0]?.headers.get("x-api-key")).toBe(API_KEY);
		expect(requests[0]?.headers.get("x-ryu-organization")).toBe(
			ORGANIZATION_ID
		);
		expect(requests[1]?.headers.get("last-event-id")).toBe("3");
	});

	test("starts after the given seq and stops on the end frame", async () => {
		const end = `event: end\ndata: ${JSON.stringify(responses.streamEnd)}\n\n`;
		const { baseUrl, requests } = stubServer(() =>
			sseReply([eventFrame(eventAt(6)), eventFrame(eventAt(7)), end], false)
		);
		const events = await collect(
			clientFor(baseUrl).sessions.stream(SESSION_ID, { after: 5 })
		);
		expect(events.map((event) => event.seq)).toEqual([6, 7]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.query).toEqual({ after: "5" });
	});

	test("skips unknown event types but resumes after their seq", async () => {
		const unknown = {
			...z.record(z.string(), z.unknown()).parse(responses.unknownEvent),
			seq: 2,
			type: "agent.thinking",
		};
		const terminal = { ...eventAt(18), seq: 3 };
		const { baseUrl, requests } = stubServer((_request, index) =>
			index === 0
				? sseReply([eventFrame(eventAt(1)), eventFrame(unknown)], true)
				: sseReply([eventFrame(terminal)], false)
		);
		const events = await collect(
			clientFor(baseUrl).sessions.stream(SESSION_ID)
		);
		expect(events.map((event) => [event.seq, event.type])).toEqual([
			[1, "session.status"],
			[3, "session.status"],
		]);
		expect(requests[1]?.headers.get("last-event-id")).toBe("2");
	});

	test("a connection that fails mid-stream is resumed from the last seq", async () => {
		const terminal = { ...eventAt(18), seq: 3 };
		const { baseUrl, requests } = stubServer(() =>
			sseReply([eventFrame(eventAt(2)), eventFrame(terminal)], false)
		);
		let calls = 0;
		const client = createManagedAgentsClient({
			apiKey: API_KEY,
			baseUrl,
			// The first connection is reset by the network after two events.
			fetch: (input, init) => {
				calls += 1;
				if (calls > 1) {
					return fetch(input, init);
				}
				const failing = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(eventFrame(eventAt(1))));
						controller.enqueue(encoder.encode(eventFrame(eventAt(2))));
						setTimeout(() => controller.error(new TypeError("reset")), 20);
					},
				});
				return Promise.resolve(
					new Response(failing, {
						headers: { "Content-Type": "text/event-stream" },
					})
				);
			},
		});
		const events = await collect(client.sessions.stream(SESSION_ID));
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(calls).toBe(2);
		expect(requests[0]?.headers.get("last-event-id")).toBe("2");
	});

	test("aborting ends the iteration without an error", async () => {
		const { baseUrl, requests } = stubServer(() =>
			sseReply([eventFrame(eventAt(1))], false)
		);
		const controller = new AbortController();
		const events: ManagedAgentEvent[] = [];
		for await (const event of clientFor(baseUrl).sessions.stream(SESSION_ID, {
			signal: controller.signal,
		})) {
			events.push(event);
			controller.abort();
		}
		expect(events.map((event) => event.seq)).toEqual([1]);
		expect(requests).toHaveLength(1);
	});

	test("aborting while waiting for events ends the iteration", async () => {
		const { baseUrl } = stubServer(() => sseReply([], false));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const events = await collect(
			clientFor(baseUrl).sessions.stream(SESSION_ID, {
				signal: controller.signal,
			})
		);
		expect(events).toEqual([]);
	});

	test("an HTTP error on the stream throws a ManagedAgentsError", async () => {
		const { baseUrl } = stubServer(() =>
			Response.json(
				{
					error: {
						code: "stream_limit_reached",
						message: "Too many concurrent streams.",
						requestId: "req_0123456789abcdef0123456789abcdef",
						details: { scope: "session" },
					},
				},
				{ headers: { "Retry-After": "5" }, status: 429 }
			)
		);
		const error = await collect(
			clientFor(baseUrl).sessions.stream(SESSION_ID)
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ManagedAgentsError);
		expect(error).toMatchObject({
			code: "stream_limit_reached",
			details: { scope: "session" },
			retryAfterSeconds: 5,
			status: 429,
		});
	});

	test("a malformed event frame is rejected without reconnecting", async () => {
		const malformed = { ...eventAt(1), status: "paused" };
		const { baseUrl, requests } = stubServer(() =>
			sseReply([eventFrame(malformed)], true)
		);
		await expect(
			collect(clientFor(baseUrl).sessions.stream(SESSION_ID))
		).rejects.toThrow();
		expect(requests).toHaveLength(1);
	});
});
