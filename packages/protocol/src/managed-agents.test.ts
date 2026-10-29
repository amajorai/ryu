import { describe, expect, it } from "bun:test";
import fixture from "./fixtures/managed-agents.json" with { type: "json" };
import {
	DEFAULT_GEMINI_AGENT,
	hasUnsupportedManagedAgentContent,
	isManagedAgentAllowedHost,
	isManagedAgentId,
	isManagedAgentMcpServerUrl,
	isManagedAgentsIdempotencyKey,
	isTerminalSessionStatus,
	isUserEventType,
	MANAGED_AGENT_EVENT_TYPES,
	MANAGED_AGENT_SESSION_ERROR_CODES,
	MANAGED_AGENT_SESSION_ERROR_INFO,
	MANAGED_AGENT_SESSION_ERROR_MESSAGES,
	MANAGED_AGENTS_ERROR_STATUS,
	MANAGED_AGENTS_HEADERS,
	MANAGED_AGENTS_LIMITS,
	MANAGED_AGENTS_PROTOCOL_VERSION,
	MANAGED_AGENTS_ROUTES,
	managedAgentEventBodySchema,
	parseCancelManagedAgentSessionInput,
	parseCreateManagedAgentCredentialInput,
	parseCreateManagedAgentEnvironmentInput,
	parseCreateManagedAgentInput,
	parseCreateManagedAgentSessionInput,
	parseManagedAgent,
	parseManagedAgentCredential,
	parseManagedAgentEnvironment,
	parseManagedAgentEnvironmentConfig,
	parseManagedAgentEvent,
	parseManagedAgentEventList,
	parseManagedAgentSession,
	parseManagedAgentStreamEnd,
	parseManagedAgentsErrorBody,
	parseManagedAgentsIdempotencyKey,
	parseManagedAgentsList,
	parseManagedAgentVersion,
	parseRotateManagedAgentCredentialInput,
	parseSendManagedAgentEventsInput,
	parseUpdateManagedAgentEnvironmentInput,
	parseUpdateManagedAgentInput,
	parseUpdateManagedAgentSessionInput,
} from "./managed-agents.ts";

const inputs = fixture.inputs;
const responses = fixture.responses;
const TOOL_USE_ID = "mtool_282960f9254fdec6c49291a498e6ca78";
const OTHER_TOOL_USE_ID = "mtool_fef283329845543d126588f65f3a3e71";

/**
 * A request body or fixture value as a test builds it. TypeScript reads a key that only some
 * fixture entries carry as `undefined` on the others, so this is wire JSON plus `undefined`.
 */
type TestWireValue =
	| boolean
	| null
	| number
	| string
	| undefined
	| readonly TestWireValue[]
	| { readonly [key: string]: TestWireValue };
type TestWireFields = Readonly<Record<string, TestWireValue>>;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function text(length: number): string {
	return "a".repeat(length);
}

function textMessage(length: number) {
	return {
		type: "user.message",
		content: [{ type: "text", text: text(length) }],
	};
}

function agentWith(fields: TestWireFields) {
	return { name: "Agent", ...fields };
}

function customTool(name: string) {
	return {
		type: "custom",
		name,
		description: "A tool",
		inputSchema: { type: "object" },
	};
}

function mcpServer(name: string, fields: TestWireFields = {}) {
	return {
		name,
		url: "https://mcp.example.com/mcp",
		allowedTools: null,
		...fields,
	};
}

function anthropicEnvironment(config: TestWireFields) {
	return {
		name: "env",
		backend: "anthropic",
		credential: { source: "platform" },
		config,
	};
}

function sessionWith(fields: TestWireFields) {
	return { ...clone(inputs.createSession), ...fields };
}

function sendEvents(events: readonly TestWireValue[]) {
	return { events };
}

function hosts(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `h${index}.example.com`);
}

const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
	"createdAt",
	"id",
	"seq",
	"sessionId",
]);

function stripEnvelope(event: TestWireFields) {
	return Object.fromEntries(
		Object.entries(event).filter(([field]) => !ENVELOPE_FIELDS.has(field))
	);
}

function jsonOfBytes(bytes: number) {
	const base = JSON.stringify({ type: "object", description: "" }).length;
	return { type: "object", description: text(bytes - base) };
}

function toolInputOfBytes(bytes: number) {
	const base = JSON.stringify({ value: "" }).length;
	return { value: text(bytes - base) };
}

function toolUseBody(input: TestWireFields) {
	return {
		type: "agent.tool_use",
		toolUseId: OTHER_TOOL_USE_ID,
		name: "bash",
		input,
		inputTruncated: false,
		source: "builtin",
		server: null,
	};
}

function toolResultBody(blocks: number, chars: number) {
	return {
		type: "agent.tool_result",
		toolUseId: OTHER_TOOL_USE_ID,
		content: Array.from({ length: blocks }, () => ({
			type: "text",
			text: text(chars),
		})),
		isError: false,
		truncated: false,
	};
}

function metadataPairs(count: number): Record<string, string> {
	return Object.fromEntries(
		Array.from({ length: count }, (_, index) => [`k${index}`, "v"])
	);
}

type ParserInput = Parameters<typeof parseCreateManagedAgentInput>[0];

function acceptsBody(body: ParserInput): boolean {
	return managedAgentEventBodySchema.safeParse(body).success;
}

describe("managed agents fixtures", () => {
	it("pins the protocol version", () => {
		expect(fixture.protocolVersion).toBe(MANAGED_AGENTS_PROTOCOL_VERSION);
		expect(MANAGED_AGENTS_PROTOCOL_VERSION).toBe("ryu.managed-agents.v1");
	});

	it("parses every input fixture", () => {
		expect(parseCreateManagedAgentInput(inputs.createAgent)).toBeDefined();
		expect(parseUpdateManagedAgentInput(inputs.updateAgent)).toBeDefined();
		for (const environment of Object.values(inputs.createEnvironment)) {
			expect(
				parseCreateManagedAgentEnvironmentInput(environment)
			).toBeDefined();
		}
		expect(
			parseUpdateManagedAgentEnvironmentInput(inputs.updateEnvironment)
		).toBeDefined();
		expect<unknown>(
			parseCreateManagedAgentCredentialInput(inputs.createCredential)
		).toEqual(inputs.createCredential);
		expect(
			parseRotateManagedAgentCredentialInput(inputs.rotateCredential)
		).toEqual(inputs.rotateCredential);
		expect<unknown>(
			parseCreateManagedAgentSessionInput(inputs.createSession)
		).toEqual(inputs.createSession);
		expect(parseUpdateManagedAgentSessionInput(inputs.updateSession)).toEqual(
			inputs.updateSession
		);
		for (const body of Object.values(inputs.sendEvents)) {
			expect<unknown>(parseSendManagedAgentEventsInput(body)).toEqual(body);
		}
		expect(parseCancelManagedAgentSessionInput(inputs.cancelSession)).toEqual(
			inputs.cancelSession
		);
	});

	it("parses every response fixture to the raw value", () => {
		expect<unknown>(parseManagedAgent(responses.agent)).toBe(responses.agent);
		expect<unknown>(parseManagedAgentVersion(responses.agentVersion)).toBe(
			responses.agentVersion
		);
		for (const environment of Object.values(responses.environments)) {
			expect<unknown>(parseManagedAgentEnvironment(environment)).toBe(
				environment
			);
		}
		expect<unknown>(parseManagedAgentCredential(responses.credential)).toBe(
			responses.credential
		);
		expect<unknown>(parseManagedAgentSession(responses.session)).toBe(
			responses.session
		);
		expect<unknown>(parseManagedAgentEventList(responses.eventList)).toBe(
			responses.eventList
		);
		expect<unknown>(parseManagedAgentStreamEnd(responses.streamEnd)).toBe(
			responses.streamEnd
		);
		expect<unknown>(parseManagedAgentsErrorBody(responses.errorBody)).toBe(
			responses.errorBody
		);
		expect(
			parseManagedAgentsList(responses.agentList, parseManagedAgent)
		).toEqual(responses.agentList);
	});

	it("covers every event type and parses each one as known", () => {
		const events = [...responses.events, ...responses.reservedEvents];
		expect(new Set(events.map((event) => event.type))).toEqual(
			new Set(MANAGED_AGENT_EVENT_TYPES)
		);
		for (const event of events) {
			expect<unknown>(parseManagedAgentEvent(event)).toEqual({
				...event,
				known: true,
			});
		}
	});

	it("accepts every logged fixture event body in the closed append schema", () => {
		for (const event of responses.events) {
			expect(acceptsBody(stripEnvelope(event))).toBe(true);
		}
	});
});

describe("managed agents closed input parsers", () => {
	it("rejects unknown fields at every level", () => {
		expect(
			parseCreateManagedAgentInput({ ...inputs.createAgent, owner: "x" })
		).toBeUndefined();
		expect(
			parseCreateManagedAgentInput(
				agentWith({ tools: [{ ...customTool("t"), strict: true }] })
			)
		).toBeUndefined();
		expect(
			parseCreateManagedAgentInput(
				agentWith({ mcpServers: [mcpServer("m", { headers: {} })] })
			)
		).toBeUndefined();
		expect(
			parseCreateManagedAgentEnvironmentInput(
				anthropicEnvironment({
					networking: { type: "unrestricted", allowedHosts: [] },
				})
			)
		).toBeUndefined();
		expect(
			parseCreateManagedAgentEnvironmentInput({
				...inputs.createEnvironment.openai,
				credential: { source: "platform", credentialId: "x" },
			})
		).toBeUndefined();
		expect(
			parseCreateManagedAgentSessionInput(
				sessionWith({ budget: { maxCostMicroUsd: 20_000, currency: "USD" } })
			)
		).toBeUndefined();
		expect(
			parseSendManagedAgentEventsInput(
				sendEvents([
					{
						type: "user.message",
						content: [{ type: "text", text: "hi", cacheControl: {} }],
					},
				])
			)
		).toBeUndefined();
		expect(
			parseCreateManagedAgentCredentialInput({
				...inputs.createCredential,
				organizationId: "org",
			})
		).toBeUndefined();
		expect(
			parseCancelManagedAgentSessionInput({ reason: "x", force: true })
		).toBeUndefined();
	});

	it("accepts tool approvals as answers and requireApproval on tools", () => {
		const toolUseId = "mtool_5d2c8e1f0a9b4c7d6e3f2a1b0c9d8e7f";
		expect(
			parseSendManagedAgentEventsInput(
				sendEvents([
					{ type: "user.tool_approval", toolUseId, decision: "allow" },
				])
			)
		).toEqual({
			events: [
				{
					type: "user.tool_approval",
					toolUseId,
					decision: "allow",
					message: null,
				},
			],
		});
		// Approvals and custom tool results answer together, one answer per tool use.
		expect(
			parseSendManagedAgentEventsInput(
				sendEvents([
					{
						type: "user.tool_approval",
						toolUseId,
						decision: "deny",
						message: "no",
					},
					{
						type: "user.custom_tool_result",
						toolUseId: "mtool_282960f9254fdec6c49291a498e6ca78",
					},
				])
			)
		).toBeDefined();
		for (const events of [
			[
				{ type: "user.tool_approval", toolUseId, decision: "allow" },
				{ type: "user.tool_approval", toolUseId, decision: "deny" },
			],
			[
				{ type: "user.tool_approval", toolUseId, decision: "allow" },
				{ type: "user.message", content: [{ type: "text", text: "hi" }] },
			],
			[{ type: "user.tool_approval", toolUseId, decision: "maybe" }],
			[
				{
					type: "user.tool_approval",
					toolUseId,
					decision: "deny",
					message: "x".repeat(1025),
				},
			],
		]) {
			expect(
				parseSendManagedAgentEventsInput(sendEvents(events))
			).toBeUndefined();
		}
		const agent = parseCreateManagedAgentInput({
			name: "approvals",
			tools: [
				{ type: "builtin", name: "code_execution", requireApproval: true },
			],
			mcpServers: [
				{
					name: "tickets",
					url: "https://mcp.example.com",
					requireApproval: true,
				},
			],
		});
		expect(agent?.tools[0]).toEqual({
			type: "builtin",
			name: "code_execution",
			allowedDomains: [],
			requireApproval: true,
		});
		expect(agent?.mcpServers[0]?.requireApproval).toBe(true);
		expect(
			acceptsBody({
				type: "agent.tool_approval_request",
				toolUseId,
				name: "bash",
				source: "builtin",
				server: null,
				expiresAt: "2026-10-10T12:13:00.000Z",
			})
		).toBe(true);
		expect(
			acceptsBody({
				type: "agent.tool_approval_request",
				toolUseId,
				name: "lookup",
				source: "mcp",
				server: null,
				expiresAt: "2026-10-10T12:13:00.000Z",
			})
		).toBe(false);
	});

	it("rejects non-object bodies", () => {
		for (const body of [null, undefined, [], "x", 1]) {
			expect(parseCreateManagedAgentInput(body)).toBeUndefined();
			expect(parseSendManagedAgentEventsInput(body)).toBeUndefined();
		}
	});

	it("fills agent defaults from a name-only body", () => {
		expect(parseCreateManagedAgentInput({ name: "Minimal" })).toEqual({
			name: "Minimal",
			description: null,
			model: null,
			instructions: null,
			tools: [],
			mcpServers: [],
			reasoningEffort: null,
			metadata: {},
		});
		expect(parseCreateManagedAgentInput({})).toBeUndefined();
		expect(parseCreateManagedAgentInput({ name: "   " })).toBeUndefined();
	});

	it("keeps agent patches sparse and accepts null deletions", () => {
		expect(parseUpdateManagedAgentInput({})).toEqual({});
		expect(
			parseUpdateManagedAgentInput({ model: null, metadata: { team: null } })
		).toEqual({ model: null, metadata: { team: null } });
		expect(parseUpdateManagedAgentInput({ name: null })).toBeUndefined();
		expect(
			parseUpdateManagedAgentInput({ expectedVersion: 0 })
		).toBeUndefined();
	});

	it("enforces the custom tool name rules", () => {
		const parseNames = (...names: string[]) =>
			parseCreateManagedAgentInput(
				agentWith({ tools: names.map((name) => customTool(name)) })
			);
		expect(parseNames("lookup_order", "get-weather")).toBeDefined();
		for (const name of [
			"bash",
			"Bash",
			"web_search",
			"code_interpreter",
			"google_search",
			"write_to_file",
			"grep_search",
			"mcp__tickets",
			"ant__helper",
			"has space",
			"dotted.name",
			"",
			text(65),
		]) {
			expect(parseNames(name)).toBeUndefined();
		}
		expect(parseNames("same", "same")).toBeUndefined();
		expect(parseNames(text(64))).toBeDefined();
	});

	it("enforces builtin tool and input schema rules", () => {
		const parseTools = (tools: readonly TestWireValue[]) =>
			parseCreateManagedAgentInput(agentWith({ tools }));
		expect(
			parseTools([{ type: "builtin", name: "code_execution" }])
		).toMatchObject({
			tools: [{ type: "builtin", name: "code_execution", allowedDomains: [] }],
		});
		expect(
			parseTools([
				{
					type: "builtin",
					name: "code_execution",
					allowedDomains: ["a.example.com"],
				},
			])
		).toBeUndefined();
		expect(
			parseTools([
				{ type: "builtin", name: "web_fetch", allowedDomains: ["*.com"] },
			])
		).toBeUndefined();
		expect(
			parseTools([
				{ type: "builtin", name: "web_search" },
				{ type: "builtin", name: "web_search" },
			])
		).toBeUndefined();
		expect(
			parseTools([{ type: "builtin", name: "image_generation" }])
		).toBeUndefined();
		expect(
			parseTools([{ ...customTool("t"), inputSchema: { type: "array" } }])
		).toBeUndefined();
		expect(
			parseTools([{ ...customTool("t"), inputSchema: [] }])
		).toBeUndefined();
		for (const notJson of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
			expect(
				parseTools([
					{
						...customTool("t"),
						inputSchema: { type: "object", default: notJson },
					},
				])
			).toBeUndefined();
		}
	});

	it("enforces MCP server rules", () => {
		const parseServers = (servers: readonly TestWireValue[]) =>
			parseCreateManagedAgentInput(agentWith({ mcpServers: servers }));
		expect(
			parseServers([{ name: "tickets", url: "https://mcp.example.com/mcp" }])
		).toMatchObject({ mcpServers: [{ allowedTools: null }] });
		expect(
			parseServers([mcpServer("tickets"), mcpServer("tickets")])
		).toBeUndefined();
		expect(parseServers([mcpServer("Tickets")])).toBeUndefined();
		expect(
			parseServers([mcpServer("tickets", { allowedTools: ["a b"] })])
		).toBeUndefined();
		for (const url of [
			"http://mcp.example.com/mcp",
			"https://user:secret@mcp.example.com/mcp",
			"https://127.0.0.1/mcp",
			"https://0x7f.1/mcp",
			"https://[::1]/mcp",
			"https://localhost/mcp",
			"https://api.localhost/mcp",
			"not a url",
		]) {
			expect(isManagedAgentMcpServerUrl(url)).toBe(false);
			expect(parseServers([mcpServer("m", { url })])).toBeUndefined();
		}
		expect(isManagedAgentMcpServerUrl("https://mcp.example.com/mcp")).toBe(
			true
		);
	});

	it("restricts metadata keys to Mongo-safe names", () => {
		for (const key of ["a.b", "$where", "", "tab\tkey"]) {
			expect(
				parseCreateManagedAgentInput(agentWith({ metadata: { [key]: "v" } }))
			).toBeUndefined();
		}
		expect(
			parseCreateManagedAgentInput(agentWith({ metadata: { "team-id": "" } }))
		).toBeDefined();
		expect(
			parseCreateManagedAgentInput(agentWith({ metadata: { team: 1 } }))
		).toBeUndefined();
	});

	it("validates credential bodies", () => {
		const parseKey = (apiKey: string) =>
			parseCreateManagedAgentCredentialInput({
				...inputs.createCredential,
				apiKey,
			});
		expect(parseKey("sk has space")).toBeUndefined();
		expect(parseKey("sk-line\nbreak")).toBeUndefined();
		expect(
			parseCreateManagedAgentCredentialInput({
				...inputs.createCredential,
				provider: "ryu_node",
			})
		).toBeUndefined();
		expect(parseRotateManagedAgentCredentialInput({})).toBeUndefined();
	});

	it("validates session create bodies", () => {
		expect(
			parseCreateManagedAgentSessionInput({
				agentId: inputs.createSession.agentId,
				environmentId: inputs.createSession.environmentId,
			})
		).toEqual({
			agentId: inputs.createSession.agentId,
			agentVersion: null,
			environmentId: inputs.createSession.environmentId,
			title: null,
			metadata: {},
			budget: null,
			initialEvents: [],
		});
		expect(
			parseCreateManagedAgentSessionInput(sessionWith({ agentId: "magt_123" }))
		).toBeUndefined();
		expect(
			parseCreateManagedAgentSessionInput(
				sessionWith({ environmentId: inputs.createSession.agentId })
			)
		).toBeUndefined();
		expect(
			parseCreateManagedAgentSessionInput(
				sessionWith({ initialEvents: [{ type: "user.interrupt" }] })
			)
		).toBeUndefined();
		expect(
			parseCreateManagedAgentSessionInput(sessionWith({ agentVersion: 0 }))
		).toBeUndefined();
	});

	it("validates session patch and cancel bodies", () => {
		expect(parseUpdateManagedAgentSessionInput({ title: null })).toEqual({
			title: null,
		});
		expect(parseCancelManagedAgentSessionInput({})).toEqual({
			reason: null,
		});
		expect(
			parseCancelManagedAgentSessionInput({ reason: text(256) })
		).toBeDefined();
		expect(
			parseCancelManagedAgentSessionInput({ reason: text(257) })
		).toBeUndefined();
	});
});

describe("managed agents user event mix rules", () => {
	const message = textMessage(5);
	const interrupt = { type: "user.interrupt" };
	const result = (toolUseId: string) => ({
		type: "user.custom_tool_result",
		toolUseId,
		content: [],
		isError: false,
	});

	it("accepts the three allowed shapes", () => {
		expect(
			parseSendManagedAgentEventsInput(sendEvents([message, message]))
		).toBeDefined();
		expect(
			parseSendManagedAgentEventsInput(sendEvents([interrupt]))
		).toBeDefined();
		expect(
			parseSendManagedAgentEventsInput(
				sendEvents([result(TOOL_USE_ID), result(OTHER_TOOL_USE_ID)])
			)
		).toBeDefined();
	});

	it("rejects every other mix", () => {
		for (const events of [
			[],
			[message, interrupt],
			[interrupt, interrupt],
			[interrupt, message],
			[result(TOOL_USE_ID), message],
			[message, result(TOOL_USE_ID)],
			[result(TOOL_USE_ID), result(TOOL_USE_ID)],
			[{ type: "agent.message", content: [] }],
		]) {
			expect(
				parseSendManagedAgentEventsInput(sendEvents(events))
			).toBeUndefined();
		}
	});

	it("fills tool result defaults and checks the tool use id", () => {
		expect<unknown>(
			parseSendManagedAgentEventsInput(
				sendEvents([
					{ type: "user.custom_tool_result", toolUseId: TOOL_USE_ID },
				])
			)
		).toEqual(sendEvents([result(TOOL_USE_ID)]));
		expect(
			parseSendManagedAgentEventsInput(
				sendEvents([{ type: "user.custom_tool_result", toolUseId: "call_1" }])
			)
		).toBeUndefined();
	});

	it("rejects empty text and flags non-text content as unsupported", () => {
		expect(
			parseSendManagedAgentEventsInput(sendEvents([textMessage(0)]))
		).toBeUndefined();
		const image = sendEvents([
			{
				type: "user.message",
				content: [{ type: "image", source: { type: "url", url: "https://x" } }],
			},
		]);
		expect(parseSendManagedAgentEventsInput(image)).toBeUndefined();
		expect(hasUnsupportedManagedAgentContent(image)).toBe(true);
		expect(
			hasUnsupportedManagedAgentContent(
				sessionWith({
					initialEvents: [
						{ type: "user.message", content: [{ type: "document" }] },
					],
				})
			)
		).toBe(true);
		expect(hasUnsupportedManagedAgentContent(inputs.sendEvents.messages)).toBe(
			false
		);
		expect(hasUnsupportedManagedAgentContent("not a body")).toBe(false);
	});
});

describe("managed agents environment defaults", () => {
	it("fills the defaults of every backend", () => {
		const minimal = (backend: string, extra: TestWireFields = {}) =>
			parseCreateManagedAgentEnvironmentInput({
				name: "env",
				backend,
				...extra,
			});
		expect(
			minimal("anthropic", { credential: { source: "platform" } })
		).toEqual({
			name: "env",
			description: null,
			backend: "anthropic",
			credential: { source: "platform" },
			config: {
				networking: {
					type: "limited",
					allowedHosts: [],
					allowPackageManagers: false,
					allowMcpServers: true,
				},
				packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
			},
		});
		expect(
			minimal("openai", { credential: { source: "platform" } })
		).toMatchObject({
			config: {
				mode: "responses",
				codeExecutionTool: "code_interpreter",
				container: { memoryLimit: "4g", network: { type: "disabled" } },
				maxToolCalls: null,
				vectorStoreIds: [],
			},
		});
		expect(
			minimal("gemini", { credential: { source: "platform" } })
		).toMatchObject({
			config: {
				agent: DEFAULT_GEMINI_AGENT,
				network: { type: "disabled" },
				maxTotalTokens: null,
			},
		});
		expect(minimal("ryu_node", { config: { nodeId: "node-1" } })).toEqual({
			name: "env",
			description: null,
			backend: "ryu_node",
			credential: { source: "none" },
			config: { nodeId: "node-1", timeoutSeconds: 60 },
		});
		expect(minimal("ryu_serverless")).toMatchObject({
			credential: { source: "none" },
			config: {},
		});
		expect(DEFAULT_GEMINI_AGENT).toBe("antigravity-preview-09-2026");
	});

	it("fills nested defaults inside a partial config", () => {
		expect(
			parseManagedAgentEnvironmentConfig("anthropic", {
				networking: { type: "limited", allowedHosts: ["api.example.com"] },
			})
		).toEqual({
			networking: {
				type: "limited",
				allowedHosts: ["api.example.com"],
				allowPackageManagers: false,
				allowMcpServers: true,
			},
			packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
		});
		expect(
			parseManagedAgentEnvironmentConfig("openai", {
				container: { memoryLimit: "16g" },
			})
		).toMatchObject({
			container: { memoryLimit: "16g", network: { type: "disabled" } },
		});
		expect(
			parseManagedAgentEnvironmentConfig("anthropic", { mode: "responses" })
		).toBeUndefined();
	});

	it("drops the server-set runAsUserId from ryu_node input", () => {
		expect(
			parseManagedAgentEnvironmentConfig(
				"ryu_node",
				responses.environments.ryu_node.config
			)
		).toEqual({
			nodeId: responses.environments.ryu_node.config.nodeId,
			timeoutSeconds: 60,
		});
	});

	it("matches the credential source to the backend", () => {
		expect(
			parseCreateManagedAgentEnvironmentInput({
				...inputs.createEnvironment.anthropic,
				credential: { source: "none" },
			})
		).toBeUndefined();
		expect(
			parseCreateManagedAgentEnvironmentInput({
				...inputs.createEnvironment.ryu_node,
				credential: { source: "platform" },
			})
		).toBeUndefined();
		expect(
			parseCreateManagedAgentEnvironmentInput({
				...inputs.createEnvironment.openai,
				credential: { source: "byok", credentialId: "key-1" },
			})
		).toBeUndefined();
		expect(
			parseCreateManagedAgentEnvironmentInput({
				...inputs.createEnvironment.openai,
				backend: "openai-agents",
			})
		).toBeUndefined();
	});

	it("keeps PATCH config raw and refuses a backend change", () => {
		expect(
			parseUpdateManagedAgentEnvironmentInput(inputs.updateEnvironment)
		).toEqual(inputs.updateEnvironment);
		expect(
			parseUpdateManagedAgentEnvironmentInput({ backend: "openai" })
		).toBeUndefined();
		expect(
			parseUpdateManagedAgentEnvironmentInput({ config: { bogus: true } })
		).toBeUndefined();
		expect(
			parseUpdateManagedAgentEnvironmentInput({
				config: { networking: { type: "limited", allowedHosts: ["*"] } },
			})
		).toBeUndefined();
	});

	it("accepts unrestricted networking syntactically (platform is refused later)", () => {
		expect(
			parseCreateManagedAgentEnvironmentInput(
				anthropicEnvironment({ networking: { type: "unrestricted" } })
			)
		).toBeDefined();
		expect(
			parseManagedAgentEnvironmentConfig("gemini", {
				network: { type: "unrestricted" },
			})
		).toBeDefined();
		expect(
			parseManagedAgentEnvironmentConfig("openai", {
				container: { network: { type: "unrestricted" } },
			})
		).toBeUndefined();
	});

	it("validates Gemini agents, vector stores and node ids", () => {
		expect(
			parseManagedAgentEnvironmentConfig("gemini", { agent: "Bad Agent" })
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("openai", {
				vectorStoreIds: Array.from({ length: 9 }, (_, index) => `vs_${index}`),
			})
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("openai", {
				vectorStoreIds: ["vs_1", "vs_1"],
			})
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("ryu_node", { nodeId: "../etc" })
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("ryu_serverless", { nodeId: "x" })
		).toBeUndefined();
	});
});

describe("managed agents AllowedHost rule", () => {
	it("rejects wildcards over public suffixes and non-hosts", () => {
		for (const host of [
			"*",
			"*.com",
			"*.co.uk",
			"*.com.au",
			"*.github.io",
			"*.amazonaws.com",
			"*.kawasaki.jp",
			"*.ny.us",
			"*.k12.ak.us",
			"*.aichi.jp",
			"*.nsw.edu.au",
			"*.xn--80au.xn--90a3ac",
			"*.*.example.com",
			"127.0.0.1",
			"10.0.0.1",
			"::1",
			"[::1]",
			"localhost",
			"api.localhost",
			"example",
			"API.example.com",
			"https://api.example.com",
			"api.example.com:443",
			"api.example.com/path",
			"user@api.example.com",
			"-bad.example.com",
			"bad_.example.com",
			"example.com.",
			"",
		]) {
			expect(isManagedAgentAllowedHost(host)).toBe(false);
		}
	});

	it("accepts hostnames and wildcards over registrable domains", () => {
		for (const host of [
			"*.example.com",
			"api.example.com",
			"example.co.uk",
			"*.example.co.uk",
			"*.team.github.io",
			"*.city.kawasaki.jp",
			"*.corp.ny.us",
			"*.uni.nsw.edu.au",
			"*.shop.xn--80au.xn--90a3ac",
			"xn--bcher-kva.example",
		]) {
			expect(isManagedAgentAllowedHost(host)).toBe(true);
		}
	});

	it("applies the rule to every allowlist field", () => {
		expect(
			parseCreateManagedAgentEnvironmentInput(
				anthropicEnvironment({
					networking: { type: "limited", allowedHosts: ["*.co.uk"] },
				})
			)
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("gemini", {
				network: { type: "allowlist", domains: ["*"] },
			})
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("gemini", {
				network: { type: "allowlist", domains: [] },
			})
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironmentConfig("openai", {
				container: { network: { type: "allowlist", domains: ["10.0.0.1"] } },
			})
		).toBeUndefined();
	});
});

describe("managed agents limits", () => {
	const boundaryCases: {
		limit: string;
		parse: (value: ParserInput) => object | boolean | undefined;
		accepted: object;
		rejected: object;
	}[] = [
		{
			limit: "nameChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ name: text(256) }),
			rejected: agentWith({ name: text(257) }),
		},
		{
			limit: "descriptionChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ description: text(2048) }),
			rejected: agentWith({ description: text(2049) }),
		},
		{
			limit: "titleChars",
			parse: parseCreateManagedAgentSessionInput,
			accepted: sessionWith({ title: text(256) }),
			rejected: sessionWith({ title: text(257) }),
		},
		{
			limit: "labelChars",
			parse: parseCreateManagedAgentCredentialInput,
			accepted: { ...inputs.createCredential, label: text(64) },
			rejected: { ...inputs.createCredential, label: text(65) },
		},
		{
			limit: "modelChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ model: text(128) }),
			rejected: agentWith({ model: text(129) }),
		},
		{
			limit: "instructionsChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ instructions: text(100_000) }),
			rejected: agentWith({ instructions: text(100_001) }),
		},
		{
			limit: "toolsPerAgent",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				tools: Array.from({ length: 64 }, (_, index) =>
					customTool(`t${index}`)
				),
			}),
			rejected: agentWith({
				tools: Array.from({ length: 65 }, (_, index) =>
					customTool(`t${index}`)
				),
			}),
		},
		{
			limit: "toolDescriptionChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				tools: [{ ...customTool("t"), description: text(1024) }],
			}),
			rejected: agentWith({
				tools: [{ ...customTool("t"), description: text(1025) }],
			}),
		},
		{
			limit: "inputSchemaBytes",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				tools: [{ ...customTool("t"), inputSchema: jsonOfBytes(65_536) }],
			}),
			rejected: agentWith({
				tools: [{ ...customTool("t"), inputSchema: jsonOfBytes(65_537) }],
			}),
		},
		{
			limit: "mcpServersPerAgent",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				mcpServers: Array.from({ length: 20 }, (_, index) =>
					mcpServer(`m${index}`)
				),
			}),
			rejected: agentWith({
				mcpServers: Array.from({ length: 21 }, (_, index) =>
					mcpServer(`m${index}`)
				),
			}),
		},
		{
			limit: "mcpUrlChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				mcpServers: [
					mcpServer("m", {
						url: `https://mcp.example.com/${text(2048 - 24)}`,
					}),
				],
			}),
			rejected: agentWith({
				mcpServers: [
					mcpServer("m", {
						url: `https://mcp.example.com/${text(2049 - 24)}`,
					}),
				],
			}),
		},
		{
			limit: "mcpAllowedToolsPerServer",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				mcpServers: [
					mcpServer("m", {
						allowedTools: Array.from(
							{ length: 128 },
							(_, index) => `t${index}`
						),
					}),
				],
			}),
			rejected: agentWith({
				mcpServers: [
					mcpServer("m", {
						allowedTools: Array.from(
							{ length: 129 },
							(_, index) => `t${index}`
						),
					}),
				],
			}),
		},
		{
			limit: "allowedDomainsPerTool",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({
				tools: [
					{ type: "builtin", name: "web_search", allowedDomains: hosts(64) },
				],
			}),
			rejected: agentWith({
				tools: [
					{ type: "builtin", name: "web_search", allowedDomains: hosts(65) },
				],
			}),
		},
		{
			limit: "networkDomains",
			parse: parseCreateManagedAgentEnvironmentInput,
			accepted: anthropicEnvironment({
				networking: { type: "limited", allowedHosts: hosts(64) },
			}),
			rejected: anthropicEnvironment({
				networking: { type: "limited", allowedHosts: hosts(65) },
			}),
		},
		{
			limit: "packagesPerManager",
			parse: parseCreateManagedAgentEnvironmentInput,
			accepted: anthropicEnvironment({
				packages: {
					pip: Array.from({ length: 64 }, (_, index) => `p${index}`),
				},
			}),
			rejected: anthropicEnvironment({
				packages: {
					pip: Array.from({ length: 65 }, (_, index) => `p${index}`),
				},
			}),
		},
		{
			limit: "packageNameChars",
			parse: parseCreateManagedAgentEnvironmentInput,
			accepted: anthropicEnvironment({ packages: { npm: [text(128)] } }),
			rejected: anthropicEnvironment({ packages: { npm: [text(129)] } }),
		},
		{
			limit: "metadataPairs",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ metadata: metadataPairs(16) }),
			rejected: agentWith({ metadata: metadataPairs(17) }),
		},
		{
			limit: "metadataKeyChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ metadata: { [text(64)]: "v" } }),
			rejected: agentWith({ metadata: { [text(65)]: "v" } }),
		},
		{
			limit: "metadataValueChars",
			parse: parseCreateManagedAgentInput,
			accepted: agentWith({ metadata: { k: text(512) } }),
			rejected: agentWith({ metadata: { k: text(513) } }),
		},
		{
			limit: "apiKeyChars (min)",
			parse: parseRotateManagedAgentCredentialInput,
			accepted: { apiKey: text(8) },
			rejected: { apiKey: text(7) },
		},
		{
			limit: "apiKeyChars (max)",
			parse: parseRotateManagedAgentCredentialInput,
			accepted: { apiKey: text(512) },
			rejected: { apiKey: text(513) },
		},
		{
			limit: "eventsPerRequest",
			parse: parseSendManagedAgentEventsInput,
			accepted: sendEvents(Array.from({ length: 8 }, () => textMessage(1))),
			rejected: sendEvents(Array.from({ length: 9 }, () => textMessage(1))),
		},
		{
			limit: "initialEventsPerSession",
			parse: parseCreateManagedAgentSessionInput,
			accepted: sessionWith({
				initialEvents: Array.from({ length: 8 }, () => textMessage(1)),
			}),
			rejected: sessionWith({
				initialEvents: Array.from({ length: 9 }, () => textMessage(1)),
			}),
		},
		{
			limit: "textBlocksPerMessage",
			parse: parseSendManagedAgentEventsInput,
			accepted: sendEvents([
				{
					type: "user.message",
					content: Array.from({ length: 16 }, () => ({
						type: "text",
						text: "a",
					})),
				},
			]),
			rejected: sendEvents([
				{
					type: "user.message",
					content: Array.from({ length: 17 }, () => ({
						type: "text",
						text: "a",
					})),
				},
			]),
		},
		{
			limit: "messageTextChars",
			parse: parseSendManagedAgentEventsInput,
			accepted: sendEvents([textMessage(100_000)]),
			rejected: sendEvents([textMessage(100_001)]),
		},
		{
			limit: "agentMessageTextChars",
			parse: acceptsBody,
			accepted: {
				type: "agent.message",
				content: [{ type: "text", text: text(100_000) }],
			},
			rejected: {
				type: "agent.message",
				content: [{ type: "text", text: text(100_001) }],
			},
		},
		{
			limit: "agentToolResultBlockChars",
			parse: acceptsBody,
			accepted: toolResultBody(1, 32_768),
			rejected: toolResultBody(1, 32_769),
		},
		{
			limit: "agentToolResultBlocks",
			parse: acceptsBody,
			accepted: toolResultBody(8, 1),
			rejected: toolResultBody(9, 1),
		},
		{
			limit: "toolInputBytes",
			parse: acceptsBody,
			accepted: toolUseBody(toolInputOfBytes(65_536)),
			rejected: toolUseBody(toolInputOfBytes(65_537)),
		},
		{
			limit: "sessionBudgetMicroUsd (min)",
			parse: parseCreateManagedAgentSessionInput,
			accepted: sessionWith({ budget: { maxCostMicroUsd: 10_000 } }),
			rejected: sessionWith({ budget: { maxCostMicroUsd: 9999 } }),
		},
		{
			limit: "sessionBudgetMicroUsd (max)",
			parse: parseCreateManagedAgentSessionInput,
			accepted: sessionWith({ budget: { maxCostMicroUsd: 1_000_000_000_000 } }),
			rejected: sessionWith({ budget: { maxCostMicroUsd: 1_000_000_000_001 } }),
		},
		{
			limit: "openaiMaxToolCalls",
			parse: (value) => parseManagedAgentEnvironmentConfig("openai", value),
			accepted: { maxToolCalls: 200 },
			rejected: { maxToolCalls: 201 },
		},
		{
			limit: "openaiMaxToolCalls (min)",
			parse: (value) => parseManagedAgentEnvironmentConfig("openai", value),
			accepted: { maxToolCalls: 1 },
			rejected: { maxToolCalls: 0 },
		},
		{
			limit: "geminiMaxTotalTokens",
			parse: (value) => parseManagedAgentEnvironmentConfig("gemini", value),
			accepted: { maxTotalTokens: 10_000_000 },
			rejected: { maxTotalTokens: 10_000_001 },
		},
		{
			limit: "geminiMaxTotalTokens (min)",
			parse: (value) => parseManagedAgentEnvironmentConfig("gemini", value),
			accepted: { maxTotalTokens: 1000 },
			rejected: { maxTotalTokens: 999 },
		},
		{
			limit: "ryuNodeTimeoutSeconds",
			parse: (value) => parseManagedAgentEnvironmentConfig("ryu_node", value),
			accepted: { nodeId: "node-1", timeoutSeconds: 120 },
			rejected: { nodeId: "node-1", timeoutSeconds: 121 },
		},
		{
			limit: "ryuNodeTimeoutSeconds (min)",
			parse: (value) => parseManagedAgentEnvironmentConfig("ryu_node", value),
			accepted: { nodeId: "node-1", timeoutSeconds: 30 },
			rejected: { nodeId: "node-1", timeoutSeconds: 29 },
		},
	];

	for (const boundary of boundaryCases) {
		it(`enforces ${boundary.limit} at its boundary`, () => {
			expect(boundary.parse(boundary.accepted)).toBeTruthy();
			expect(boundary.parse(boundary.rejected)).toBeFalsy();
		});
	}

	it("publishes the §4.9 values", () => {
		expect(MANAGED_AGENTS_LIMITS).toEqual({
			nameChars: 256,
			descriptionChars: 2048,
			titleChars: 256,
			labelChars: 64,
			modelChars: 128,
			instructionsChars: 100_000,
			toolsPerAgent: 64,
			toolDescriptionChars: 1024,
			inputSchemaBytes: 65_536,
			mcpServersPerAgent: 20,
			mcpUrlChars: 2048,
			mcpAllowedToolsPerServer: 128,
			allowedDomainsPerTool: 64,
			networkDomains: 64,
			packagesPerManager: 64,
			packageNameChars: 128,
			metadataPairs: 16,
			metadataKeyChars: 64,
			metadataValueChars: 512,
			apiKeyChars: { min: 8, max: 512 },
			agentsPerOrg: 500,
			versionsPerAgent: 1000,
			agentVersionsPerOrg: 10_000,
			environmentsPerOrg: 100,
			credentialsPerOrg: 50,
			activeSessionsPerOrg: 100,
			sessionsCreatedPerOrgPerHour: 1000,
			idleSessionTtlDays: 7,
			writesPerOrgPerMinute: 600,
			eventsPerRequest: 8,
			initialEventsPerSession: 8,
			queuedInputsPerSession: 32,
			userEventBytesPerOrgPerDay: 536_870_912,
			textBlocksPerMessage: 16,
			messageTextChars: 100_000,
			agentMessageTextChars: 100_000,
			agentToolResultBlockChars: 32_768,
			agentToolResultBlocks: 8,
			toolInputBytes: 65_536,
			eventBytes: 524_288,
			eventsPerSession: 100_000,
			toolApprovalTimeoutSeconds: 600,
			approvalMessageChars: 1024,
			listLimitDefault: 20,
			listLimitMax: 100,
			eventsListLimitDefault: 100,
			eventsListLimitMax: 500,
			eventsListMaxBytes: 4_194_304,
			streamMaxSeconds: 600,
			streamKeepaliveMs: 8000,
			streamRetryMs: 2000,
			streamsPerReplica: 512,
			streamsPerOrgPerReplica: 16,
			streamsPerSession: 4,
			streamsPerPrincipal: 8,
			idempotencyKeyPattern: "^[A-Za-z0-9_-]{16,128}$",
			idempotencyTtlHours: 24,
			sessionBudgetMicroUsd: { min: 10_000, max: 1_000_000_000_000 },
			openaiMaxToolCalls: { min: 1, max: 200 },
			geminiMaxTotalTokens: { min: 1000, max: 10_000_000 },
			ryuNodeTimeoutSeconds: { min: 30, max: 120 },
		});
	});
});

describe("managed agents closed event body schema", () => {
	it("rejects reserved, unknown and malformed bodies", () => {
		expect(acceptsBody(stripEnvelope(responses.reservedEvents[0] ?? {}))).toBe(
			false
		);
		expect(acceptsBody(stripEnvelope(responses.unknownEvent))).toBe(false);
		const status = stripEnvelope(responses.events[0] ?? {});
		expect(acceptsBody({ ...status, extra: true })).toBe(false);
		expect(acceptsBody({ ...status, stopReason: "future" })).toBe(false);
		expect(
			acceptsBody({ ...toolUseBody({}), source: "mcp", server: null })
		).toBe(false);
		expect(
			acceptsBody({ ...toolUseBody({}), source: "mcp", server: "tickets" })
		).toBe(true);
		expect(acceptsBody(toolUseBody({ nested: [{ ok: true }, null] }))).toBe(
			true
		);
		expect(acceptsBody(toolUseBody({ timeout: undefined }))).toBe(false);
		expect(acceptsBody(toolUseBody({ ratio: Number.NaN }))).toBe(false);
		expect(
			acceptsBody({
				type: "session.error",
				code: "made_up",
				message: "x",
				retryable: false,
				source: "ryu",
				details: {},
			})
		).toBe(false);
	});

	it("accepts negative usage deltas but not negative totals", () => {
		const usage = stripEnvelope(responses.events[6] ?? {});
		expect(usage.type).toBe("session.usage");
		expect(acceptsBody(usage)).toBe(true);
		const negativeDelta = clone(responses.events[6]?.delta);
		expect(
			acceptsBody({ ...usage, delta: { ...negativeDelta, inputTokens: -5 } })
		).toBe(true);
		expect(
			acceptsBody({
				...usage,
				cumulative: { ...negativeDelta, inputTokens: -5 },
			})
		).toBe(false);
	});
});

describe("managed agents tolerant response parsers", () => {
	it("keeps unknown response fields on every resource", () => {
		const cases: [object, (value: ParserInput) => object | undefined][] = [
			[
				{ ...responses.agent, futureField: { nested: true } },
				parseManagedAgent,
			],
			[{ ...responses.agentVersion, futureField: 1 }, parseManagedAgentVersion],
			[
				{
					...responses.environments.openai,
					config: { ...responses.environments.openai.config, newKnob: "on" },
				},
				parseManagedAgentEnvironment,
			],
			[
				{ ...responses.credential, futureField: null },
				parseManagedAgentCredential,
			],
			[
				{
					...responses.session,
					usage: { ...responses.session.usage, newCounter: 3 },
				},
				parseManagedAgentSession,
			],
			[{ ...responses.eventList, cursor: "x" }, parseManagedAgentEventList],
			[
				{ error: { ...responses.errorBody.error, docsUrl: "x" } },
				parseManagedAgentsErrorBody,
			],
		];
		for (const [value, parse] of cases) {
			expect(parse(value)).toEqual(value);
			expect(parse(value)).toBe(value);
		}
	});

	it("tolerates additive enum values in v1 responses", () => {
		const session = { ...responses.session, stopReason: "context_full" };
		expect<unknown>(parseManagedAgentSession(session)).toBe(session);
		const environment = {
			...responses.environments.ryu_serverless,
			backend: "future_backend",
			credential: { source: "future_source" },
		};
		expect<unknown>(parseManagedAgentEnvironment(environment)).toBe(
			environment
		);
		const agent = {
			...responses.agent,
			reasoningEffort: "xhigh",
			tools: [{ type: "computer_use", displayWidth: 1024 }],
		};
		expect<unknown>(parseManagedAgent(agent)).toBe(agent);
		const error = { error: { ...responses.errorBody.error, code: "new_code" } };
		expect<unknown>(parseManagedAgentsErrorBody(error)).toBe(error);
	});

	it("rejects malformed responses", () => {
		expect(
			parseManagedAgent({ ...responses.agent, version: "3" })
		).toBeUndefined();
		expect(
			parseManagedAgentSession({ ...responses.session, status: "paused" })
		).toBeUndefined();
		expect(
			parseManagedAgentSession({ ...responses.session, usage: undefined })
		).toBeUndefined();
		expect(
			parseManagedAgentEnvironment({
				...responses.environments.anthropic,
				credential: { source: "byok" },
			})
		).toBeUndefined();
		expect(
			parseManagedAgentCredential({ ...responses.credential, label: 1 })
		).toBeUndefined();
		expect(
			parseManagedAgentsErrorBody({ error: { code: "x" } })
		).toBeUndefined();
		expect(
			parseManagedAgentEventList({ ...responses.eventList, data: [{}] })
		).toBeUndefined();
		expect(
			parseManagedAgentsList(
				{ data: [{}], nextCursor: null },
				parseManagedAgent
			)
		).toBeUndefined();
		expect(parseManagedAgent(null)).toBeUndefined();
		expect(
			parseManagedAgentStreamEnd({ ...responses.streamEnd, headSeq: "16" })
		).toBeUndefined();
	});

	it("accepts only JSON in tool inputs, input schemas and error details", () => {
		const toolUse = responses.events[3];
		expect(toolUse?.type).toBe("agent.tool_use");
		expect(
			parseManagedAgentEvent({ ...toolUse, input: { at: new Date(0) } })
		).toBeUndefined();
		const customToolUse = responses.events[5];
		expect(customToolUse?.type).toBe("agent.custom_tool_use");
		expect(
			parseManagedAgentEvent({ ...customToolUse, input: { n: Number.NaN } })
		).toBeUndefined();
		expect(
			parseManagedAgentsErrorBody({
				error: { ...responses.errorBody.error, details: { latest: undefined } },
			})
		).toBeUndefined();
		expect(
			parseManagedAgentEvent({ ...responses.unknownEvent, extra: () => 1 })
		).toBeUndefined();
	});

	it("tolerates unknown event types and keeps their fields", () => {
		expect(parseManagedAgentEvent(responses.unknownEvent)).toEqual({
			...responses.unknownEvent,
			known: false,
		});
		const list = {
			...responses.eventList,
			data: [...responses.eventList.data, responses.unknownEvent],
		};
		expect<unknown>(parseManagedAgentEventList(list)).toBe(list);
		const { seq, ...withoutSeq } = responses.unknownEvent;
		expect(seq).toBe(18);
		expect(parseManagedAgentEvent(withoutSeq)).toBeUndefined();
	});

	it("keeps unknown fields on known events and rejects broken known bodies", () => {
		const status = { ...responses.events[0], futureField: [1] };
		expect<unknown>(parseManagedAgentEvent(status)).toEqual({
			...status,
			known: true,
		});
		const { inputSeq, ...legacyStatus } = responses.events[0] ?? {};
		expect(inputSeq).toBeNull();
		expect(parseManagedAgentEvent(legacyStatus)).toMatchObject({
			known: true,
		});
		expect(
			parseManagedAgentEvent({ ...responses.events[1], content: "hi" })
		).toBeUndefined();
		expect(
			parseManagedAgentEvent({
				...responses.events[1],
				content: [{ type: "image", source: {} }],
			})
		).toMatchObject({ known: true });
	});
});

describe("managed agents error codes", () => {
	it("maps every §4.8.1 code to its HTTP status", () => {
		expect(MANAGED_AGENTS_ERROR_STATUS).toEqual({
			invalid_request: 400,
			invalid_cursor: 400,
			invalid_idempotency_key: 400,
			organization_required: 400,
			unauthenticated: 401,
			insufficient_credits: 402,
			api_key_spend_cap_reached: 402,
			forbidden: 403,
			organization_mismatch: 403,
			org_access_denied: 403,
			feature_disabled: 403,
			step_up_required: 403,
			not_found: 404,
			version_conflict: 409,
			revision_conflict: 409,
			name_taken: 409,
			agent_archived: 409,
			environment_archived: 409,
			limit_reached: 409,
			idempotency_key_reused: 409,
			idempotency_in_progress: 409,
			session_closed: 409,
			session_running: 409,
			session_not_terminal: 409,
			tool_result_required: 409,
			unknown_tool_use: 409,
			tool_result_already_submitted: 409,
			session_budget_exhausted: 409,
			event_log_full: 409,
			payload_too_large: 413,
			unsupported_for_backend: 422,
			unsupported_content: 422,
			model_not_priced: 422,
			credential_unavailable: 422,
			platform_credentials_disabled: 422,
			node_not_found: 422,
			node_unreachable: 422,
			node_forbidden: 422,
			rate_limited: 429,
			session_limit_reached: 429,
			stream_limit_reached: 429,
			internal_error: 500,
			backend_not_implemented: 501,
			vendor_error: 502,
			managed_agents_disabled: 503,
			backend_disabled: 503,
			billing_unavailable: 503,
			event_append_contended: 503,
			service_unavailable: 503,
		});
	});

	it("covers every in-log session error code with info and a Ryu message", () => {
		const codes = [...MANAGED_AGENT_SESSION_ERROR_CODES].sort();
		expect(Object.keys(MANAGED_AGENT_SESSION_ERROR_INFO).sort()).toEqual(codes);
		expect(Object.keys(MANAGED_AGENT_SESSION_ERROR_MESSAGES).sort()).toEqual(
			codes
		);
		for (const message of Object.values(MANAGED_AGENT_SESSION_ERROR_MESSAGES)) {
			expect(message.length).toBeGreaterThan(0);
			expect(message.length).toBeLessThanOrEqual(1024);
		}
		expect(MANAGED_AGENT_SESSION_ERROR_MESSAGES.vendor_rate_limited).toBe(
			"The model provider is busy. Ryu will retry."
		);
		expect(MANAGED_AGENT_SESSION_ERROR_INFO.credential_rejected).toEqual({
			retryable: false,
			source: "vendor",
		});
		expect(MANAGED_AGENT_SESSION_ERROR_INFO.idle_timeout.retryable).toBeNull();
	});
});

describe("managed agents routes and helpers", () => {
	it("lists 27 unique routes in table order", () => {
		expect(MANAGED_AGENTS_ROUTES).toHaveLength(27);
		const keys = MANAGED_AGENTS_ROUTES.map(
			(route) => `${route.method} ${route.path}`
		);
		expect(new Set(keys).size).toBe(27);
		const operations = MANAGED_AGENTS_ROUTES.map((route) => route.operation);
		expect(new Set(operations).size).toBe(27);
		expect(operations[0]).toBe("agents.create");
		expect(operations.at(-1)).toBe("sessions.delete");
		for (const route of MANAGED_AGENTS_ROUTES) {
			expect(route.path).toMatch(/^(\/[a-z]+|\/\{[A-Za-z]+\})+$/u);
		}
	});

	it("names the public headers", () => {
		expect(MANAGED_AGENTS_HEADERS).toEqual({
			organization: "X-Ryu-Organization",
			requestId: "X-Request-ID",
			idempotencyKey: "Idempotency-Key",
			replayed: "Idempotent-Replayed",
			lastEventId: "Last-Event-ID",
		});
	});

	it("classifies statuses, event types, ids and idempotency keys", () => {
		expect(isTerminalSessionStatus("canceled")).toBe(true);
		expect(isTerminalSessionStatus("idle")).toBe(false);
		expect(isUserEventType("user.interrupt")).toBe(true);
		expect(isUserEventType("agent.message")).toBe(false);
		expect(isManagedAgentId("session", responses.session.id)).toBe(true);
		expect(isManagedAgentId("agent", responses.session.id)).toBe(false);
		expect(isManagedAgentId("toolUse", "mtool_ABCDEF")).toBe(false);
		expect(isManagedAgentsIdempotencyKey("abcd-efgh_ijkl-mn")).toBe(true);
		expect(isManagedAgentsIdempotencyKey("short")).toBe(false);
		expect(isManagedAgentsIdempotencyKey(`${text(128)}a`)).toBe(false);
		expect(isManagedAgentsIdempotencyKey("has spaces in the key!")).toBe(false);
	});

	it("parses an Idempotency-Key header as a bare token or a Structured Field String", () => {
		const key = "abcd-efgh_ijkl-mn";
		expect(parseManagedAgentsIdempotencyKey(key)).toBe(key);
		expect(parseManagedAgentsIdempotencyKey(`"${key}"`)).toBe(key);
		expect(parseManagedAgentsIdempotencyKey(`  "${key}" `)).toBe(key);
		expect(parseManagedAgentsIdempotencyKey(`"${text(128)}"`)).toBe(text(128));
		// The inner value keeps the bare-token rule.
		expect(parseManagedAgentsIdempotencyKey('"short"')).toBeNull();
		expect(parseManagedAgentsIdempotencyKey(`"${text(128)}a"`)).toBeNull();
		expect(
			parseManagedAgentsIdempotencyKey('"has spaces in the key!"')
		).toBeNull();
		expect(
			parseManagedAgentsIdempotencyKey('"abcd-efgh\\"ijkl-mn"')
		).toBeNull();
		// Unbalanced or doubled quotes are malformed, never stripped further.
		expect(parseManagedAgentsIdempotencyKey(`"${key}`)).toBeNull();
		expect(parseManagedAgentsIdempotencyKey(`${key}"`)).toBeNull();
		expect(parseManagedAgentsIdempotencyKey(`""${key}""`)).toBeNull();
		expect(parseManagedAgentsIdempotencyKey('"')).toBeNull();
		expect(parseManagedAgentsIdempotencyKey("")).toBeNull();
	});
});
