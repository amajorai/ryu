import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import { managedAgentsCommands } from "../commands/managed-agents.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import { commandLine } from "../registry.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(respond: (request: Recorded) => Response) {
	const calls: Recorded[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded);
	};
	return { calls, fetch };
}

const ENV = { RYU_API_KEY: "ryu_cli_secret_key", RYU_ORGANIZATION_ID: "org_1" };
const BASE = "https://api.ryuhq.com/api/v1/managed-agents";
const NOW = "2026-10-10T12:00:00.000Z";

const USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheWriteInputTokens: 0,
	reasoningTokens: 0,
	webSearchRequests: 0,
	activeSeconds: 0,
	listCostMicroUsd: null,
};

const AGENT = {
	id: "magt_1",
	name: "Triage",
	description: null,
	model: null,
	instructions: null,
	tools: [],
	mcpServers: [],
	reasoningEffort: null,
	metadata: {},
	createdAt: NOW,
	version: 1,
	archivedAt: null,
	updatedAt: NOW,
};

/** An environment in the protocol fixture's shape (packages/protocol/src/fixtures/managed-agents.json). */
const ENVIRONMENT = {
	id: "menv_1",
	name: "claude-prod",
	description: null,
	backend: "anthropic",
	credential: { source: "byok", credentialId: "mcred_1" },
	config: {
		networking: {
			type: "limited",
			allowedHosts: ["api.example.com"],
			allowPackageManagers: true,
			allowMcpServers: true,
		},
		packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
	},
	revision: 2,
	archivedAt: null,
	createdAt: NOW,
	updatedAt: NOW,
};

const SESSION = {
	id: "msess_1",
	agentId: "magt_1",
	agentVersion: 1,
	environmentId: "menv_1",
	environmentRevision: 1,
	backend: "anthropic",
	title: null,
	metadata: {},
	status: "pending",
	stopReason: null,
	pendingToolUseIds: [],
	lastError: null,
	headSeq: 1,
	usage: USAGE,
	billedMicroUsd: 0,
	budget: null,
	closing: null,
	createdAt: NOW,
	updatedAt: NOW,
	startedAt: null,
	endedAt: null,
};

const envelope = (seq: number) => ({
	id: `mevt_${seq}`,
	sessionId: "msess_1",
	seq,
	createdAt: NOW,
});

const EVENTS = [
	{
		...envelope(1),
		type: "user.message",
		content: [{ type: "text", text: "Hi" }],
	},
	{
		...envelope(2),
		type: "agent.message",
		content: [{ type: "text", text: "Hello" }],
	},
	{
		...envelope(3),
		type: "session.status",
		status: "idle",
		stopReason: "end_turn",
		pendingToolUseIds: [],
		detail: null,
		inputSeq: 1,
	},
	{
		...envelope(4),
		type: "session.status",
		status: "completed",
		stopReason: null,
		pendingToolUseIds: [],
		detail: null,
		inputSeq: 1,
	},
];

function sse(events: readonly { seq: number }[]): Response {
	return new Response(
		events
			.map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);
}

/** A tiny Managed Agents server. */
function managedAgentsServer(request: Recorded): Response {
	const path = new URL(request.url).pathname.replace(
		"/api/v1/managed-agents",
		""
	);
	if (request.method === "GET" && path === "/agents") {
		return Response.json({ data: [AGENT], nextCursor: null });
	}
	if (request.method === "GET" && path === "/environments") {
		// Two pages: the one after cursor c_2 is the last.
		return new URL(request.url).searchParams.get("cursor") === "c_2"
			? Response.json({
					data: [{ ...ENVIRONMENT, id: "menv_2" }],
					nextCursor: null,
				})
			: Response.json({ data: [ENVIRONMENT], nextCursor: "c_2" });
	}
	if (request.method === "POST" && path === "/sessions") {
		return Response.json(SESSION, { status: 201 });
	}
	if (request.method === "GET" && path === "/sessions/msess_1") {
		return Response.json({
			...SESSION,
			status: "idle",
			stopReason: "end_turn",
		});
	}
	if (request.method === "POST" && path === "/sessions/msess_1/events") {
		return Response.json(
			{ data: [{ ...EVENTS[0], seq: 5, id: "mevt_5" }] },
			{ status: 202 }
		);
	}
	if (request.method === "GET" && path === "/sessions/msess_1/events") {
		return Response.json({
			data: EVENTS,
			hasMore: false,
			nextAfter: 4,
			headSeq: 4,
		});
	}
	if (request.method === "GET" && path === "/sessions/msess_1/stream") {
		return sse(EVENTS);
	}
	return Response.json(
		{
			error: { code: "not_found", message: "Not found.", requestId: "req_404" },
		},
		{ status: 404 }
	);
}

function capture(fetch: RyuFetch, env: Record<string, string> = ENV) {
	let out = "";
	let err = "";
	const io: CliIo = {
		env,
		stdin: "",
		stdout: { write: (chunk: string) => (out += chunk) },
		stderr: { write: (chunk: string) => (err += chunk) },
		fetch,
	};
	return { io, stdout: () => out, stderr: () => err };
}

const lines = (text: string) =>
	text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("ryu-services managed-agents", () => {
	test("registers the design's commands", () => {
		expect(
			managedAgentsCommands.map((command) =>
				commandLine("managed-agents", command)
			)
		).toEqual([
			"ryu-services managed-agents agents list",
			"ryu-services managed-agents environments list",
			"ryu-services managed-agents sessions create",
			"ryu-services managed-agents sessions get",
			"ryu-services managed-agents sessions send",
			"ryu-services managed-agents sessions stream",
			"ryu-services managed-agents sessions pending-approvals",
			"ryu-services managed-agents sessions approve",
			"ryu-services managed-agents sessions deny",
		]);
	});

	test("agents list --json prints { data, meta } and sends the control-plane headers", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"agents",
				"list",
				"--limit",
				"5",
				"--include-archived",
				"--json",
			],
			run.io
		);
		expect(code).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: { data: { id: string }[] };
			meta: { status: number };
		};
		expect(printed.data.data[0]?.id).toBe("magt_1");
		expect(printed.meta.status).toBe(200);
		expect(calls[0]?.url).toBe(`${BASE}/agents?includeArchived=true&limit=5`);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_cli_secret_key");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe("org_1");
	});

	test("environments list prints one page with its paging flags and is read-only", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"environments",
				"list",
				"--limit",
				"5",
				"--cursor",
				"c_1",
				"--include-archived",
			],
			run.io
		);
		// One JSON line per environment; the next page's cursor goes to stderr.
		expect({ code, stderr: run.stderr() }).toEqual({
			code: 0,
			stderr:
				"More environments: pass --cursor c_2 for the next page, or --all for every one.\n",
		});
		expect(run.stdout()).toBe(`${JSON.stringify(ENVIRONMENT)}\n`);
		expect(calls.map((call) => call.method)).toEqual(["GET"]);
		expect(calls[0]?.url).toBe(
			`${BASE}/environments?cursor=c_1&includeArchived=true&limit=5`
		);
		const command = managedAgentsCommands.find(
			(entry) => entry.path.join(" ") === "environments list"
		);
		expect(command?.readOnly).toBe(true);
		const extra = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "environments", "list", "menv_1"],
				extra.io
			)
		).toBe(2);
		expect(calls).toHaveLength(1);
	});

	test("environments list --json prints the SDK page; --all streams every page", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const json = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "environments", "list", "--json"],
				json.io
			)
		).toBe(0);
		const envelope = JSON.parse(json.stdout()) as {
			data: unknown;
			meta: unknown;
		};
		expect(envelope.data).toEqual({ data: [ENVIRONMENT], nextCursor: "c_2" });
		expect(envelope).toHaveProperty("meta");
		expect(json.stderr()).toBe("");

		const all = capture(fetch);
		expect(
			await runCli(["managed-agents", "environments", "list", "--all"], all.io)
		).toBe(0);
		expect(
			all
				.stdout()
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { id: string }).id)
		).toEqual(["menv_1", "menv_2"]);
		expect(all.stderr()).toBe("");
		expect(calls.slice(1).map((call) => call.url)).toEqual([
			`${BASE}/environments`,
			`${BASE}/environments?cursor=c_2`,
		]);

		const both = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "environments", "list", "--all", "--cursor", "c_1"],
				both.io
			)
		).toBe(2);
		expect(calls).toHaveLength(3);
	});

	test("sessions create --message sends initialEvents with the caller's idempotency key", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"create",
				"--agent",
				"magt_1",
				"--environment",
				"menv_1",
				"--message",
				"Hi",
				"--idempotency-key",
				"cli-session-000001",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("cli-session-000001");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			agentId: "magt_1",
			environmentId: "menv_1",
			initialEvents: [
				{ type: "user.message", content: [{ type: "text", text: "Hi" }] },
			],
		});
		expect(run.stdout()).toContain("msess_1");
	});

	test("sessions create --follow prints the session, then events until the turn ends", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"create",
				"--agent",
				"magt_1",
				"--environment",
				"menv_1",
				"--message",
				"Hi",
				"--follow",
			],
			run.io
		);
		expect(code).toBe(0);
		const printed = lines(run.stdout());
		expect(printed[0]?.id).toBe("msess_1");
		expect(printed.slice(1).map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
	});

	test("sessions create --follow --until terminal follows to the terminal status", async () => {
		const { fetch } = stubFetch(managedAgentsServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"create",
				"--agent",
				"magt_1",
				"--environment",
				"menv_1",
				"--follow",
				"--until",
				"terminal",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(
			lines(run.stdout())
				.slice(1)
				.map((event) => event.seq)
		).toEqual([1, 2, 3, 4]);
	});

	test("sessions get, send and stream", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const get = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "get", "msess_1", "--json"],
				get.io
			)
		).toBe(0);
		expect(JSON.parse(get.stdout()).data.status).toBe("idle");

		const send = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "send", "msess_1", "--text", "More"],
				send.io
			)
		).toBe(0);
		const sent = calls.find((call) => call.method === "POST");
		expect(JSON.parse(sent?.body ?? "{}")).toEqual({
			events: [
				{ type: "user.message", content: [{ type: "text", text: "More" }] },
			],
		});
		expect(sent?.headers.get("idempotency-key")).toMatch(
			/^[A-Za-z0-9_-]{16,128}$/
		);

		const stream = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "stream", "msess_1", "--after", "0"],
				stream.io
			)
		).toBe(0);
		expect(lines(stream.stdout()).map((event) => event.seq)).toEqual([
			1, 2, 3, 4,
		]);
	});

	test("usage errors exit 2", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const missing = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "create", "--environment", "menv_1"],
				missing.io
			)
		).toBe(2);
		expect(missing.stderr()).toContain("--agent");
		const noId = capture(fetch);
		expect(await runCli(["managed-agents", "sessions", "get"], noId.io)).toBe(
			2
		);
		const badUntil = capture(fetch);
		expect(
			await runCli(
				[
					"managed-agents",
					"sessions",
					"create",
					"--agent",
					"a",
					"--environment",
					"e",
					"--until",
					"soon",
				],
				badUntil.io
			)
		).toBe(2);
		const untilWithoutFollow = capture(fetch);
		expect(
			await runCli(
				[
					"managed-agents",
					"sessions",
					"create",
					"--agent",
					"a",
					"--environment",
					"e",
					"--until",
					"terminal",
				],
				untilWithoutFollow.io
			)
		).toBe(2);
		expect(untilWithoutFollow.stderr()).toContain("--follow");
		expect(calls).toHaveLength(0);
	});

	test("an unconfigured CLI exits 2 naming RYU_API_KEY", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const run = capture(fetch, {});
		expect(await runCli(["managed-agents", "agents", "list"], run.io)).toBe(2);
		expect(run.stderr()).toContain("RYU_API_KEY");
		expect(calls).toHaveLength(0);
	});

	test("the preview-off error exits 1 with its hint", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "managed_agents_disabled",
						message: "Managed Agents is not enabled on this deployment.",
						requestId: "req_off",
					},
				},
				{ status: 503 }
			)
		);
		const run = capture(fetch);
		expect(await runCli(["managed-agents", "agents", "list"], run.io)).toBe(1);
		expect(run.stderr()).toContain("managed_agents_disabled");
		expect(run.stderr()).toContain(
			"docs.ryuhq.com/docs/standalone/managed-agents"
		);
		expect(calls).toHaveLength(1);
	});

	test("--dry-run prints curl with the key placeholder and sends nothing", async () => {
		let sent = 0;
		const run = capture(() => {
			sent += 1;
			return Promise.reject(new Error("a dry run must not send requests"));
		});
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"create",
				"--agent",
				"magt_1",
				"--environment",
				"menv_1",
				"--message",
				"Hi",
				"--follow",
				"--dry-run",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(sent).toBe(0);
		const output = run.stdout() + run.stderr();
		expect(output).toContain("curl");
		expect(output).toContain(`${BASE}/sessions`);
		expect(output).toContain("$RYU_API_KEY");
		expect(output).not.toContain("ryu_cli_secret_key");
	});
});

async function connect(fetch: RyuFetch, readOnly = false) {
	const { server, registration } = createServicesMcpServer({
		config: { env: ENV, fetch },
		log: () => undefined,
		services: ["managedAgents"],
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "ryu-services-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration, close: () => client.close() };
}

describe("managed_agents_* MCP tools", () => {
	test("registers the design tools with annotations, and only reads in read-only mode", async () => {
		const { fetch } = stubFetch(managedAgentsServer);
		const all = await connect(fetch);
		const { tools } = await all.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"managed_agents_answer_approval",
			"managed_agents_create_session",
			"managed_agents_get_session",
			"managed_agents_list_agents",
			"managed_agents_list_environments",
			"managed_agents_list_events",
			"managed_agents_list_pending_approvals",
			"managed_agents_send_message",
		]);
		const create = tools.find(
			(tool) => tool.name === "managed_agents_create_session"
		);
		expect(create?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		await all.close();

		const readOnly = await connect(fetch, true);
		const listed = await readOnly.client.listTools();
		expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
			"managed_agents_get_session",
			"managed_agents_list_agents",
			"managed_agents_list_environments",
			"managed_agents_list_events",
			"managed_agents_list_pending_approvals",
		]);
		await readOnly.close();
	});

	test("tools call the API end to end and return { data, meta }", async () => {
		const { calls, fetch } = stubFetch(managedAgentsServer);
		const { client, close } = await connect(fetch);

		const agents = await client.callTool({
			name: "managed_agents_list_agents",
			arguments: { limit: 1 },
		});
		expect(agents.isError).toBeFalsy();
		const structured = agents.structuredContent as {
			data: { data: { id: string }[] };
			meta: { status: number };
		};
		expect(structured.data.data[0]?.id).toBe("magt_1");
		expect(structured.meta.status).toBe(200);

		const created = await client.callTool({
			name: "managed_agents_create_session",
			arguments: { agentId: "magt_1", environmentId: "menv_1", message: "Hi" },
		});
		expect(
			(created.structuredContent as { data: { id: string } }).data.id
		).toBe("msess_1");
		const post = calls.find((call) => call.method === "POST");
		expect(JSON.parse(post?.body ?? "{}").initialEvents).toHaveLength(1);

		const sent = await client.callTool({
			name: "managed_agents_send_message",
			arguments: { sessionId: "msess_1", text: "More" },
		});
		expect(
			(sent.structuredContent as { data: { seq: number }[] }).data[0]?.seq
		).toBe(5);

		const got = await client.callTool({
			name: "managed_agents_get_session",
			arguments: { sessionId: "msess_1" },
		});
		expect(
			(got.structuredContent as { data: { status: string } }).data.status
		).toBe("idle");

		const page = await client.callTool({
			name: "managed_agents_list_events",
			arguments: { sessionId: "msess_1", after: 0, limit: 10 },
		});
		expect(
			(page.structuredContent as { data: { nextAfter: number } }).data.nextAfter
		).toBe(4);
		expect(calls.at(-1)?.url).toBe(
			`${BASE}/sessions/msess_1/events?after=0&limit=10`
		);

		const waited = await client.callTool({
			name: "managed_agents_list_events",
			arguments: { sessionId: "msess_1", wait: true, timeoutMs: 2000 },
		});
		const result = (
			waited.structuredContent as {
				data: {
					data: { seq: number }[];
					turnEnded: boolean;
					timedOut: boolean;
				};
			}
		).data;
		// The head read says seq 4, so the replayed idle at 3 does not stop the
		// follow; the terminal status at 4 does.
		expect(result.data.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
		expect(result.turnEnded).toBe(true);
		expect(result.timedOut).toBe(false);
		await close();
	});

	test("list_events wait: true closes the stream when it times out", async () => {
		let streamSignal: AbortSignal | null = null;
		let canceled = false;
		const encoder = new TextEncoder();
		const fetch: RyuFetch = (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (!url.includes("/stream")) {
				return Promise.resolve(
					Response.json({ data: [], hasMore: false, nextAfter: 0, headSeq: 0 })
				);
			}
			streamSignal = init?.signal ?? null;
			let timer: ReturnType<typeof setInterval> | undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					timer = setInterval(
						() => controller.enqueue(encoder.encode(": keepalive\n\n")),
						10
					);
				},
				cancel() {
					canceled = true;
					clearInterval(timer);
				},
			});
			streamSignal?.addEventListener("abort", () => clearInterval(timer));
			return Promise.resolve(
				new Response(body, { headers: { "content-type": "text/event-stream" } })
			);
		};
		const { client, close } = await connect(fetch);
		const waited = await client.callTool({
			name: "managed_agents_list_events",
			arguments: { sessionId: "msess_1", wait: true, timeoutMs: 50 },
		});
		const result = (
			waited.structuredContent as {
				data: { data: unknown[]; turnEnded: boolean; timedOut: boolean };
			}
		).data;
		expect(result.timedOut).toBe(true);
		expect(result.turnEnded).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const signal = streamSignal as AbortSignal | null;
		expect(signal?.aborted === true || canceled).toBe(true);
		await close();
	});

	test("an API error is an isError result carrying the code and hint", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "feature_disabled",
						message: "Off.",
						requestId: "req_off",
					},
				},
				{ status: 403 }
			)
		);
		const { client, close } = await connect(fetch);
		const result = await client.callTool({
			name: "managed_agents_get_session",
			arguments: { sessionId: "msess_1" },
		});
		expect(result.isError).toBe(true);
		const error = (
			result.structuredContent as { error: { code: string; hint: string } }
		).error;
		expect(error.code).toBe("feature_disabled");
		expect(error.hint).toContain("preview");
		await close();
	});
});

const USER_EVENT = {
	...envelope(1),
	type: "user.message",
	content: [{ type: "text", text: "Hi" }],
};
const TOOL_USE_ID = `mtool_${"a".repeat(32)}`;
const OTHER_TOOL_USE_ID = `mtool_${"b".repeat(32)}`;
const FUTURE = "2099-01-01T00:00:00.000Z";

const toolUseEvent = (seq: number, toolUseId = TOOL_USE_ID) => ({
	...envelope(seq),
	type: "agent.tool_use",
	toolUseId,
	name: "bash",
	input: { command: "rm -rf build" },
	inputTruncated: false,
	source: "builtin",
	server: null,
});

const approvalRequestEvent = (
	seq: number,
	toolUseId = TOOL_USE_ID,
	expiresAt = FUTURE
) => ({
	...envelope(seq),
	type: "agent.tool_approval_request",
	toolUseId,
	name: "bash",
	source: "builtin",
	server: null,
	expiresAt,
});

const approvalAnswerEvent = (
	seq: number,
	decision: "allow" | "deny",
	toolUseId = TOOL_USE_ID,
	message: string | null = null
) => ({
	...envelope(seq),
	type: "user.tool_approval",
	toolUseId,
	decision,
	message,
});

const APPROVAL_LOG = [
	USER_EVENT,
	toolUseEvent(2),
	approvalRequestEvent(3),
	{
		...envelope(4),
		type: "session.status",
		status: "idle",
		stopReason: "requires_action",
		pendingToolUseIds: [TOOL_USE_ID],
		detail: null,
		inputSeq: 1,
	},
];

/** A Managed Agents server with one open approval request. */
function approvalApiServer(
	options: {
		log?: readonly { seq: number }[];
		pendingToolUseIds?: string[];
		status?: string;
	} = {}
) {
	const log = options.log ?? APPROVAL_LOG;
	return (request: Recorded): Response => {
		const url = new URL(request.url);
		const path = url.pathname.replace("/api/v1/managed-agents", "");
		if (request.method === "POST" && path === "/sessions") {
			return Response.json(SESSION, { status: 201 });
		}
		if (request.method === "GET" && path === "/sessions/msess_1") {
			return Response.json({
				...SESSION,
				status: options.status ?? "idle",
				stopReason: "requires_action",
				pendingToolUseIds: options.pendingToolUseIds ?? [TOOL_USE_ID],
			});
		}
		if (request.method === "POST" && path === "/sessions/msess_1/events") {
			const sent = JSON.parse(request.body ?? "{}") as {
				events: {
					decision: "allow" | "deny";
					message: string | null;
					toolUseId: string;
				}[];
			};
			const [event] = sent.events;
			return Response.json(
				{
					data: [
						approvalAnswerEvent(
							9,
							event?.decision ?? "allow",
							event?.toolUseId,
							event?.message ?? null
						),
					],
				},
				{ status: 202 }
			);
		}
		if (request.method === "GET" && path === "/sessions/msess_1/events") {
			const types = (url.searchParams.get("types") ?? "").split(",");
			const data = log.filter(
				(event) =>
					types.length === 0 ||
					types[0] === "" ||
					types.includes((event as { type?: string }).type ?? "")
			);
			return Response.json({
				data,
				hasMore: false,
				nextAfter: log.at(-1)?.seq ?? 0,
				headSeq: log.at(-1)?.seq ?? 0,
			});
		}
		if (request.method === "GET" && path === "/sessions/msess_1/stream") {
			return sse(log);
		}
		return managedAgentsServer(request);
	};
}

describe("ryu-services managed-agents tool approvals", () => {
	test("sessions approve sends user.tool_approval allow with the derived key", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"approve",
				"msess_1",
				TOOL_USE_ID,
				"--json",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}/sessions/msess_1/events`);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			events: [
				{
					type: "user.tool_approval",
					toolUseId: TOOL_USE_ID,
					decision: "allow",
					message: null,
				},
			],
		});
		expect(calls[0]?.headers.get("idempotency-key")).toBe(
			`tool-approval-allow-${TOOL_USE_ID}`
		);
		expect(JSON.parse(run.stdout()).data.decision).toBe("allow");
	});

	test("sessions deny --message sends the reason", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"deny",
				"msess_1",
				TOOL_USE_ID,
				"--message",
				"Not on main.",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(JSON.parse(calls[0]?.body ?? "{}").events[0]).toMatchObject({
			decision: "deny",
			message: "Not on main.",
		});
		expect(calls[0]?.headers.get("idempotency-key")).toMatch(
			new RegExp(`^tool-approval-deny-${TOOL_USE_ID}-m[0-9a-f]{8}$`, "u")
		);
	});

	test("approve and deny need both ids and take no extra arguments", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const missing = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "approve", "msess_1"],
				missing.io
			)
		).toBe(2);
		expect(missing.stderr()).toContain("<toolUseId>");
		const extra = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "deny", "msess_1", TOOL_USE_ID, "more"],
				extra.io
			)
		).toBe(2);
		expect(calls).toHaveLength(0);
	});

	test("an already answered request exits 1 with the conflict code", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "tool_result_already_submitted",
						message: "Already answered.",
						requestId: "req_409",
					},
				},
				{ status: 409 }
			)
		);
		const run = capture(fetch);
		expect(
			await runCli(
				["managed-agents", "sessions", "approve", "msess_1", TOOL_USE_ID],
				run.io
			)
		).toBe(1);
		expect(run.stderr()).toContain("tool_result_already_submitted");
	});

	test("the approval note names the host's command line under ryu-cli services", async () => {
		const { fetch } = stubFetch(approvalApiServer());
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"create",
				"--agent",
				"magt_1",
				"--environment",
				"menv_1",
				"--message",
				"Hi",
				"--follow",
			],
			{ ...run.io, program: "ryu-cli services" }
		);
		expect(code).toBe(0);
		expect(run.stderr()).toContain(
			`allow: ryu-cli services managed-agents sessions approve msess_1 ${TOOL_USE_ID} --follow`
		);
		expect(run.stderr()).toContain(
			`deny:  ryu-cli services managed-agents sessions deny msess_1 ${TOOL_USE_ID} --message`
		);
		expect(run.stderr()).not.toMatch(/(?<![\w-])ryu-services /u);
	});

	test("sessions create --follow prints the request and the exact commands that answer it, and answers nothing", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"create",
				"--agent",
				"magt_1",
				"--environment",
				"menv_1",
				"--message",
				"Hi",
				"--follow",
			],
			run.io
		);
		expect(code).toBe(0);
		const printed = lines(run.stdout());
		expect(printed.slice(1).map((event) => event.type)).toEqual([
			"user.message",
			"agent.tool_use",
			"agent.tool_approval_request",
			"session.status",
		]);
		expect(run.stderr()).toContain("approval needed: bash");
		expect(run.stderr()).toContain(
			`ryu-services managed-agents sessions approve msess_1 ${TOOL_USE_ID}`
		);
		expect(run.stderr()).toContain(
			`ryu-services managed-agents sessions deny msess_1 ${TOOL_USE_ID} --message`
		);
		expect(run.stderr().match(/approval needed/gu)).toHaveLength(1);
		expect(
			calls.filter(
				(call) => call.method === "POST" && call.url.endsWith("/events")
			)
		).toHaveLength(0);
	});
});

describe("managed_agents approval MCP tools", () => {
	test("annotations: list_pending_approvals is read-only, answer_approval is a non-destructive open-world write", async () => {
		const { fetch } = stubFetch(approvalApiServer());
		const { client, close } = await connect(fetch);
		const { tools } = await client.listTools();
		expect(
			tools.find(
				(tool) => tool.name === "managed_agents_list_pending_approvals"
			)?.annotations
		).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(
			tools.find((tool) => tool.name === "managed_agents_answer_approval")
				?.annotations
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: true,
		});
		await close();
	});

	test("list_pending_approvals returns open requests with the call input, skipping answered ones", async () => {
		const { calls, fetch } = stubFetch(
			approvalApiServer({
				log: [
					...APPROVAL_LOG,
					toolUseEvent(5, OTHER_TOOL_USE_ID),
					approvalRequestEvent(6, OTHER_TOOL_USE_ID),
					approvalAnswerEvent(7, "deny", OTHER_TOOL_USE_ID),
				],
			})
		);
		const { client, close } = await connect(fetch);
		const result = await client.callTool({
			name: "managed_agents_list_pending_approvals",
			arguments: { sessionId: "msess_1" },
		});
		expect(result.isError).toBeFalsy();
		const payload = (
			result.structuredContent as {
				data: {
					data: Record<string, unknown>[];
					complete: boolean;
					answerWith: string;
				};
			}
		).data;
		expect(payload.data).toEqual([
			{
				toolUseId: TOOL_USE_ID,
				name: "bash",
				source: "builtin",
				server: null,
				expiresAt: FUTURE,
				requestSeq: 3,
				input: { command: "rm -rf build" },
				inputTruncated: false,
			},
		]);
		expect(payload.complete).toBe(true);
		expect(payload.answerWith).toBe("managed_agents_answer_approval");
		const eventsCall = calls.find((call) => call.url.includes("/events?"));
		expect(new URL(eventsCall?.url ?? BASE).searchParams.get("types")).toBe(
			"agent.tool_use,agent.tool_approval_request,user.tool_approval,user.interrupt,session.status"
		);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		await close();
	});

	test("list_pending_approvals drops expired requests the session no longer lists, and is empty for a terminal session", async () => {
		const expired = stubFetch(
			approvalApiServer({
				log: [
					USER_EVENT,
					approvalRequestEvent(3, TOOL_USE_ID, "2000-01-01T00:00:00.000Z"),
				],
				pendingToolUseIds: [],
			})
		);
		const first = await connect(expired.fetch);
		const none = await first.client.callTool({
			name: "managed_agents_list_pending_approvals",
			arguments: { sessionId: "msess_1" },
		});
		expect(
			(none.structuredContent as { data: { data: unknown[] } }).data.data
		).toEqual([]);
		await first.close();

		const terminal = stubFetch(approvalApiServer({ status: "canceled" }));
		const second = await connect(terminal.fetch);
		const closed = await second.client.callTool({
			name: "managed_agents_list_pending_approvals",
			arguments: { sessionId: "msess_1" },
		});
		expect(
			(closed.structuredContent as { data: { data: unknown[] } }).data.data
		).toEqual([]);
		expect(terminal.calls.some((call) => call.url.includes("/events"))).toBe(
			false
		);
		await second.close();
	});

	test("answer_approval allows or denies with the derived key", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const { client, close } = await connect(fetch);
		const allowed = await client.callTool({
			name: "managed_agents_answer_approval",
			arguments: {
				sessionId: "msess_1",
				toolUseId: TOOL_USE_ID,
				decision: "allow",
			},
		});
		expect(
			(allowed.structuredContent as { data: { decision: string } }).data
				.decision
		).toBe("allow");
		const denied = await client.callTool({
			name: "managed_agents_answer_approval",
			arguments: {
				sessionId: "msess_1",
				toolUseId: TOOL_USE_ID,
				decision: "deny",
				message: "Not on main.",
			},
		});
		expect(denied.isError).toBeFalsy();
		const posts = calls.filter((call) => call.method === "POST");
		const keys = posts.map((call) => call.headers.get("idempotency-key"));
		expect(keys[0]).toBe(`tool-approval-allow-${TOOL_USE_ID}`);
		expect(keys[1]).toMatch(
			new RegExp(`^tool-approval-deny-${TOOL_USE_ID}-m[0-9a-f]{8}$`, "u")
		);
		expect(JSON.parse(posts[1]?.body ?? "{}").events[0]).toMatchObject({
			decision: "deny",
			message: "Not on main.",
		});
		await close();
	});

	test("answer_approval rejects an unknown decision before any request", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const { client, close } = await connect(fetch);
		const result = await client.callTool({
			name: "managed_agents_answer_approval",
			arguments: {
				sessionId: "msess_1",
				toolUseId: TOOL_USE_ID,
				decision: "maybe",
			},
		});
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
		await close();
	});
});

const statusEvent = (
	seq: number,
	stopReason: string,
	inputSeq: number,
	pendingToolUseIds: string[] = []
) => ({
	...envelope(seq),
	type: "session.status",
	status: "idle",
	stopReason,
	pendingToolUseIds,
	detail: null,
	inputSeq,
});

/**
 * A log server for resumed follows: `POST /events` answers `appended`, the
 * stream serves the log after `Last-Event-ID`, `GET /events` pages the log
 * after `after` (filtered by `types`) with `headSeq` at its last event, and
 * `GET /sessions/msess_1` lists `pending`.
 */
function resumeServer(
	log: readonly { seq: number; type: string }[],
	appended: { seq: number },
	pending: string[] = []
) {
	return (request: Recorded): Response => {
		const url = new URL(request.url);
		const path = url.pathname.replace("/api/v1/managed-agents", "");
		const head = log.at(-1)?.seq ?? 0;
		if (request.method === "POST") {
			return Response.json({ data: [appended] }, { status: 202 });
		}
		if (path === "/sessions/msess_1") {
			return Response.json({
				...SESSION,
				status: "idle",
				stopReason: "requires_action",
				pendingToolUseIds: pending,
				headSeq: head,
			});
		}
		if (path.endsWith("/stream")) {
			const after = Number(request.headers.get("last-event-id") ?? "0");
			return sse(log.filter((event) => event.seq > after));
		}
		const after = Number(url.searchParams.get("after") ?? "0");
		const types = url.searchParams.get("types");
		const data = log.filter(
			(event) =>
				event.seq > after &&
				(types === null || types.split(",").includes(event.type))
		);
		return Response.json({
			data: url.searchParams.get("limit") === "1" ? data.slice(0, 1) : data,
			hasMore: false,
			nextAfter: data.at(-1)?.seq ?? after,
			headSeq: head,
		});
	};
}

describe("ryu-services managed-agents approval follow-ups", () => {
	test("approve --follow prints the rest of the turn and the commands for a second request", async () => {
		const answer = approvalAnswerEvent(5, "allow");
		const log = [
			...APPROVAL_LOG,
			answer,
			{ ...statusEvent(6, "end_turn", 5), status: "running", stopReason: null },
			toolUseEvent(7, OTHER_TOOL_USE_ID),
			approvalRequestEvent(8, OTHER_TOOL_USE_ID),
			statusEvent(9, "requires_action", 5, [OTHER_TOOL_USE_ID]),
		];
		const { calls, fetch } = stubFetch(
			resumeServer(log, answer, [OTHER_TOOL_USE_ID])
		);
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"approve",
				"msess_1",
				TOOL_USE_ID,
				"--follow",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(lines(run.stdout()).map((event) => event.seq)).toEqual([
			5, 6, 7, 8, 9,
		]);
		expect(run.stderr()).toContain(
			`ryu-services managed-agents sessions approve msess_1 ${OTHER_TOOL_USE_ID} --follow`
		);
		expect(run.stderr()).not.toContain(`approve msess_1 ${TOOL_USE_ID}`);
		expect(run.stderr().match(/approval needed/gu)).toHaveLength(1);
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	test("deny --follow notes a request that opened before the answer and still waits", async () => {
		const answer = approvalAnswerEvent(5, "deny", TOOL_USE_ID, "No.");
		const log = [
			USER_EVENT,
			approvalRequestEvent(2),
			approvalRequestEvent(3, OTHER_TOOL_USE_ID),
			statusEvent(4, "requires_action", 1, [TOOL_USE_ID, OTHER_TOOL_USE_ID]),
			answer,
		];
		const { fetch } = stubFetch(resumeServer(log, answer, [OTHER_TOOL_USE_ID]));
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"deny",
				"msess_1",
				TOOL_USE_ID,
				"--message",
				"No.",
				"--follow",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(lines(run.stdout()).map((event) => event.seq)).toEqual([5]);
		expect(run.stderr()).toContain(
			`sessions approve msess_1 ${OTHER_TOOL_USE_ID} --follow`
		);
		expect(run.stderr().match(/approval needed/gu)).toHaveLength(1);
	});

	test("send --follow prints the message and the turn until it ends", async () => {
		const message = {
			...envelope(5),
			type: "user.message",
			content: [{ type: "text", text: "More" }],
		};
		const log = [
			...EVENTS.slice(0, 3),
			message,
			{
				...envelope(6),
				type: "agent.message",
				content: [{ type: "text", text: "Sure" }],
			},
			statusEvent(7, "end_turn", 5),
		];
		const { calls, fetch } = stubFetch(resumeServer(log, message));
		const run = capture(fetch);
		const code = await runCli(
			[
				"managed-agents",
				"sessions",
				"send",
				"msess_1",
				"--text",
				"More",
				"--follow",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(lines(run.stdout()).map((event) => event.seq)).toEqual([5, 6, 7]);
		expect(run.stderr()).toBe("");
		// A settled turn end needs no approval lookup.
		expect(calls.some((call) => call.url.endsWith("/sessions/msess_1"))).toBe(
			false
		);
	});

	test("--until without --follow is a usage error on send, approve and deny", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		for (const argv of [
			["send", "msess_1", "--text", "x", "--until", "turn"],
			["approve", "msess_1", TOOL_USE_ID, "--until", "turn"],
			["deny", "msess_1", TOOL_USE_ID, "--until", "terminal"],
		]) {
			const run = capture(fetch);
			expect(
				await runCli(["managed-agents", "sessions", ...argv], run.io)
			).toBe(2);
			expect(run.stderr()).toContain("--until needs --follow");
		}
		expect(calls).toHaveLength(0);
	});

	test("sessions stream writes the approve/deny commands for each request", async () => {
		const canceled = {
			...statusEvent(5, "end_turn", 1),
			status: "canceled",
			stopReason: null,
		};
		const { fetch } = stubFetch(
			approvalApiServer({ log: [...APPROVAL_LOG, canceled] })
		);
		const run = capture(fetch);
		const code = await runCli(
			["managed-agents", "sessions", "stream", "msess_1"],
			run.io
		);
		expect(code).toBe(0);
		expect(run.stderr()).toContain(
			`sessions approve msess_1 ${TOOL_USE_ID} --follow`
		);
	});

	test("sessions pending-approvals lists open requests with their input and is read-only", async () => {
		const { calls, fetch } = stubFetch(approvalApiServer());
		const run = capture(fetch);
		const code = await runCli(
			["managed-agents", "sessions", "pending-approvals", "msess_1", "--json"],
			run.io
		);
		expect(code).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: { data: { input: unknown; toolUseId: string }[] };
		};
		expect(printed.data.data.map((request) => request.toolUseId)).toEqual([
			TOOL_USE_ID,
		]);
		expect(printed.data.data[0]?.input).toEqual({ command: "rm -rf build" });
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		expect(
			managedAgentsCommands.find(
				(command) => command.path.join(" ") === "sessions pending-approvals"
			)?.readOnly
		).toBe(true);
	});
});

describe("sessions pending-approvals human output", () => {
	test("prints one approval per line on stdout and nothing else", async () => {
		const { fetch } = stubFetch(approvalApiServer());
		const run = capture(fetch);
		const code = await runCli(
			["managed-agents", "sessions", "pending-approvals", "msess_1"],
			run.io
		);
		expect(code).toBe(0);
		const lines = run.stdout().trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			toolUseId: TOOL_USE_ID,
			input: { command: "rm -rf build" },
		});
		expect(run.stderr()).toBe("");
	});

	test("a terminal session prints the empty-page note on stderr", async () => {
		const { fetch } = stubFetch(approvalApiServer({ status: "completed" }));
		const run = capture(fetch);
		const code = await runCli(
			["managed-agents", "sessions", "pending-approvals", "msess_1"],
			run.io
		);
		expect(code).toBe(0);
		expect(run.stdout()).toBe("");
		expect(run.stderr()).toBe("No pending approvals.\n");
	});
});

describe("managed_agents approval MCP signals", () => {
	test("list_events wait: true flags a turn that stopped on an approval", async () => {
		const { fetch } = stubFetch(approvalApiServer());
		const { client, close } = await connect(fetch);
		const result = await client.callTool({
			name: "managed_agents_list_events",
			arguments: { sessionId: "msess_1", wait: true, timeoutMs: 2000 },
		});
		const payload = (
			result.structuredContent as {
				data: {
					next?: string;
					pendingToolUseIds?: string[];
					requiresAction?: boolean;
					turnEnded: boolean;
				};
			}
		).data;
		expect(payload.turnEnded).toBe(true);
		expect(payload.requiresAction).toBe(true);
		expect(payload.pendingToolUseIds).toEqual([TOOL_USE_ID]);
		expect(payload.next).toBe("managed_agents_list_pending_approvals");
		const { tools } = await client.listTools();
		for (const name of [
			"managed_agents_list_events",
			"managed_agents_create_session",
			"managed_agents_send_message",
		]) {
			expect(tools.find((tool) => tool.name === name)?.description).toContain(
				"approval"
			);
		}
		await close();
	});

	test("list_events wait: true adds nothing to a turn that ended normally", async () => {
		const { fetch } = stubFetch(managedAgentsServer);
		const { client, close } = await connect(fetch);
		const result = await client.callTool({
			name: "managed_agents_list_events",
			arguments: { sessionId: "msess_1", wait: true, timeoutMs: 2000 },
		});
		const payload = (
			result.structuredContent as { data: Record<string, unknown> }
		).data;
		expect(payload.requiresAction).toBeUndefined();
		expect(payload.next).toBeUndefined();
		await close();
	});

	test("list_pending_approvals keeps a request after an interrupt until the interrupted idle abandons it", async () => {
		const interrupt = { ...envelope(5), type: "user.interrupt" };
		const queued = stubFetch(
			approvalApiServer({ log: [...APPROVAL_LOG, interrupt] })
		);
		const first = await connect(queued.fetch);
		const open = await first.client.callTool({
			name: "managed_agents_list_pending_approvals",
			arguments: { sessionId: "msess_1" },
		});
		expect(
			(open.structuredContent as { data: { data: unknown[] } }).data.data
		).toHaveLength(1);
		await first.close();

		const abandoned = stubFetch(
			approvalApiServer({
				log: [...APPROVAL_LOG, interrupt, statusEvent(6, "interrupted", 5)],
			})
		);
		const second = await connect(abandoned.fetch);
		const none = await second.client.callTool({
			name: "managed_agents_list_pending_approvals",
			arguments: { sessionId: "msess_1" },
		});
		expect(
			(none.structuredContent as { data: { data: unknown[] } }).data.data
		).toEqual([]);
		await second.close();
	});
});
