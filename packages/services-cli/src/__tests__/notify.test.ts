import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import {
	APPROVAL_KEY_REUSED_CLI_HINT,
	defaultUsageWindow,
	notifyCommands,
} from "../commands/notify.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import {
	DEFAULT_APPROVAL_TOOL_TIMEOUT_MS,
	MAX_APPROVAL_TIMEOUT_MS,
	MAX_APPROVAL_WAIT_MS,
} from "../mcp/tools/notify.ts";
import { withProgram, workspaceProgram } from "../program.ts";
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

/** The JSON lines a list command prints. */
function ndjson(stdout: string): unknown[] {
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as unknown);
}

const ENV = {
	RYU_NOTIFY_API_KEY: "notify_cli_secret",
	RYU_NOTIFY_URL: "http://127.0.0.1:8092",
};
const NOW = "2026-10-01T12:00:00.000Z";

function event(id: string, responseStatus: string | null = null) {
	return {
		acknowledgedAt: null,
		actions: [],
		archivedAt: null,
		attachment: null,
		body: "",
		createdAt: NOW,
		data: {},
		externalId: null,
		fingerprint: null,
		icon: null,
		id,
		level: "info",
		occurredAt: NOW,
		priority: 3,
		project: null,
		recipient: null,
		response:
			responseStatus === null
				? null
				: {
						callbackUrl: null,
						callbackUrlPreview: null,
						expiresAt: "2026-10-01T12:10:00.000Z",
						prompt: null,
						respondedAt: null,
						status: responseStatus,
						type: "approval",
						value: null,
					},
		source: "api",
		tags: [],
		title: "Deploy finished",
		topic: null,
		type: "notification",
		url: null,
	};
}

/** A Notify server stub routed by `METHOD /path`. */
function notifyServer(): (request: Recorded) => Response {
	return (request) => {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		switch (route) {
			case "POST /v1/events": {
				const body = JSON.parse(request.body ?? "{}") as {
					response?: unknown;
				};
				return Response.json(
					{
						event: event("evt_new", body.response ? "pending" : null),
						idempotent: false,
						ok: true,
					},
					{ status: 201 }
				);
			}
			case "GET /v1/events": {
				const before = url.searchParams.get("before");
				return Response.json(
					before === null
						? { events: [event("e1"), event("e2")], nextCursor: "c1" }
						: { events: [event("e3")], nextCursor: null }
				);
			}
			case "GET /v1/events/evt_new":
				return Response.json({ event: event("evt_new", "approved") });
			case "GET /v1/events/e1":
				return Response.json({ event: event("e1") });
			case "POST /v1/events/e1/ack":
				return Response.json({
					event: { ...event("e1"), acknowledgedAt: NOW },
				});
			case "GET /v1/usage":
				return Response.json({
					from: url.searchParams.get("from"),
					meters: { events: 42 },
					ok: true,
					to: url.searchParams.get("to"),
					type: "usage.report",
				});
			default:
				return new Response(`no route ${route}`, { status: 599 });
		}
	};
}

interface Run {
	code: number;
	stderr: string;
	stdout: string;
}

async function run(
	argv: string[],
	io: Partial<CliIo> & { env: Record<string, string> }
): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const code = await runCli(argv, {
		stdin: "",
		fetch: () => Promise.reject(new Error("unexpected network call")),
		stdout: { write: (chunk: string) => (stdout += chunk) },
		stderr: { write: (chunk: string) => (stderr += chunk) },
		...io,
	});
	return { code, stdout, stderr };
}

describe("ryu-services notify", () => {
	test("registers the design §10 commands", () => {
		expect(
			notifyCommands.map((command) => commandLine("notify", command))
		).toEqual([
			"ryu-services notify publish",
			"ryu-services notify request-approval",
			"ryu-services notify events list",
			"ryu-services notify events get",
			"ryu-services notify events ack",
			"ryu-services notify usage",
		]);
		expect(
			notifyCommands
				.filter((command) => command.readOnly)
				.map((command) => command.path.join(" "))
		).toEqual(["events list", "events get", "usage"]);
	});

	test("covers every notify_* tool's inputs with a command and flags", () => {
		const flagsOf = (path: string) =>
			Object.keys(
				notifyCommands.find((command) => command.path.join(" ") === path)
					?.flags ?? {}
			);
		for (const flag of ["recipient", "topic", "source", "level", "tag"]) {
			expect(flagsOf("publish")).toContain(flag);
			expect(flagsOf("request-approval")).toContain(flag);
		}
		for (const flag of ["prompt", "response-type", "timeout-ms", "wait-ms"]) {
			expect(flagsOf("request-approval")).toContain(flag);
		}
		for (const flag of ["recipient", "acknowledged", "unacknowledged"]) {
			expect(flagsOf("events list")).toContain(flag);
		}
	});

	test("publish sends --recipient; events list filters by recipient and acknowledgement", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const published = await run(
			["notify", "publish", "--title", "Page", "--recipient", "oncall"],
			{ env: ENV, fetch }
		);
		expect(published.code).toBe(0);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			recipient: "oncall",
			title: "Page",
		});
		const listed = await run(
			[
				"notify",
				"events",
				"list",
				"--recipient",
				"oncall",
				"--unacknowledged",
				"--json",
			],
			{ env: ENV, fetch }
		);
		expect(listed.code).toBe(0);
		const query = new URL(calls[1]?.url ?? "").searchParams;
		expect(query.get("recipient")).toBe("oncall");
		expect(query.get("acknowledged")).toBe("false");
		const both = await run(
			["notify", "events", "list", "--acknowledged", "--unacknowledged"],
			{ env: ENV, fetch }
		);
		expect(both.code).toBe(2);
		expect(both.stderr).toContain(
			"Pass either --acknowledged or --unacknowledged, not both."
		);
		expect(calls).toHaveLength(2);
	});

	test("events ack acknowledges one event", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const acked = await run(["notify", "events", "ack", "e1", "--json"], {
			env: ENV,
			fetch,
		});
		expect(acked.code).toBe(0);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("http://127.0.0.1:8092/v1/events/e1/ack");
		expect(
			(JSON.parse(acked.stdout) as { data: { acknowledgedAt: string } }).data
				.acknowledgedAt
		).toBe(NOW);
		const missing = await run(["notify", "events", "ack"], { env: ENV, fetch });
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("<id> is required.");
	});

	test("request-approval publishes an approval request and waits for the answer", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const result = await run(
			[
				"notify",
				"request-approval",
				"--title",
				"Deploy build 184?",
				"--prompt",
				"Ship build 184?",
				"--response-type",
				"yes_no",
				"--timeout-ms",
				"60000",
				"--wait-ms",
				"5000",
				"--idempotency-key",
				"deploy-184",
				"--json",
			],
			{ env: ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(calls[0]?.url).toBe("http://127.0.0.1:8092/v1/events");
		expect(calls[0]?.headers.get("idempotency-key")).toBe("deploy-184");
		const body = JSON.parse(calls[0]?.body ?? "{}") as {
			response?: { prompt?: string; type?: string };
			title: string;
		};
		expect(body.title).toBe("Deploy build 184?");
		expect(body.response).toMatchObject({
			prompt: "Ship build 184?",
			type: "yes_no",
		});
		const printed = JSON.parse(result.stdout) as {
			data: { approved: boolean; status: string };
		};
		expect(printed.data.status).toBe("approved");
		expect(printed.data.approved).toBe(true);
	});

	test("a keyed request-approval rerun's 409 idempotency_conflict says to read the first request", async () => {
		const conflict = () =>
			Response.json(
				{
					error: {
						code: "idempotency_conflict",
						message: "Idempotency-Key was reused with a different body.",
					},
				},
				{ status: 409 }
			);
		const { calls, fetch } = stubFetch(conflict);
		const keyed = await run(
			[
				"notify",
				"request-approval",
				"--title",
				"Deploy build 184?",
				"--idempotency-key",
				"deploy-184",
				"--json",
			],
			{ env: ENV, fetch }
		);
		expect(keyed.code).toBe(1);
		expect(calls).toHaveLength(1);
		const printed = JSON.parse(keyed.stdout || keyed.stderr) as {
			error: { code: string; hint: string };
		};
		expect(printed.error.code).toBe("idempotency_conflict");
		// A workspace build names its bun launch line in place of ryu-services.
		expect(printed.error.hint).toBe(
			withProgram(APPROVAL_KEY_REUSED_CLI_HINT, workspaceProgram())
		);
		expect(printed.error.hint).toContain("notify events get");

		const human = await run(
			[
				"notify",
				"request-approval",
				"--title",
				"Deploy build 184?",
				"--idempotency-key",
				"deploy-184",
			],
			{ env: ENV, fetch: stubFetch(conflict).fetch }
		);
		expect(human.code).toBe(1);
		expect(human.stderr).toContain("hint: An approval request was already");

		// Without --idempotency-key the conflict is not a rerun, so no hint is added.
		const unkeyed = await run(
			["notify", "request-approval", "--title", "x", "--json"],
			{ env: ENV, fetch: stubFetch(conflict).fetch }
		);
		expect(unkeyed.code).toBe(1);
		expect(`${unkeyed.stdout}${unkeyed.stderr}`).not.toContain("events get");
	});

	test("request-approval rejects out-of-range waits and unknown response types", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		for (const argv of [
			["--wait-ms", "60000"],
			["--timeout-ms", "10"],
			["--response-type", "maybe"],
		]) {
			const result = await run(
				["notify", "request-approval", "--title", "x", ...argv],
				{ env: ENV, fetch }
			);
			expect(result.code).toBe(2);
		}
		expect(calls).toHaveLength(0);
	});

	test("ryu-cli services never rewrites an event's own text", async () => {
		const { fetch } = stubFetch(() =>
			Response.json({
				event: { ...event("e1"), title: "ryu-services notify rocks" },
			})
		);
		const got = await run(["notify", "events", "get", "e1"], {
			env: ENV,
			fetch,
			program: "ryu-cli services",
		});
		expect(got.code).toBe(0);
		expect(got.stdout).toContain("ryu-services notify rocks");
	});

	test("publish sends the event with Bearer and --idempotency-key", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const result = await run(
			[
				"notify",
				"publish",
				"--title",
				"Deploy finished",
				"--body",
				"v2 is live",
				"--level",
				"success",
				"--topic",
				"deployments",
				"--tag",
				"deploy",
				"--tag",
				"prod",
				"--idempotency-key",
				"deploy-4821",
				"--json",
			],
			{ env: ENV, fetch }
		);
		expect(result.code).toBe(0);
		const [call] = calls;
		expect(call?.url).toBe("http://127.0.0.1:8092/v1/events");
		expect(call?.headers.get("authorization")).toBe("Bearer notify_cli_secret");
		expect(call?.headers.get("idempotency-key")).toBe("deploy-4821");
		expect(JSON.parse(call?.body ?? "{}")).toEqual({
			body: "v2 is live",
			level: "success",
			tags: ["deploy", "prod"],
			title: "Deploy finished",
			topic: "deployments",
		});
		const printed = JSON.parse(result.stdout) as {
			data: { id: string };
			meta: { idempotencyKey: string; replayed: boolean; status: number };
		};
		expect(printed.data.id).toBe("evt_new");
		expect(printed.meta).toMatchObject({
			idempotencyKey: "deploy-4821",
			replayed: false,
			status: 201,
		});
		expect(result.stdout).not.toContain("notify_cli_secret");
	});

	test("publish without --idempotency-key still sends an auto key", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const result = await run(["notify", "publish", "--title", "x"], {
			env: ENV,
			fetch,
		});
		expect(result.code).toBe(0);
		expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
	});

	test("events list sends filters; --all pages with before", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const page = await run(
			[
				"notify",
				"events",
				"list",
				"--limit",
				"2",
				"--level",
				"error",
				"--before",
				"c0",
				"--json",
			],
			{ env: ENV, fetch }
		);
		expect(page.code).toBe(0);
		expect(new URL(calls[0]?.url ?? "").searchParams.toString()).toBe(
			"limit=2&level=error&before=c0"
		);

		const all = await run(
			["notify", "events", "list", "--all", "--limit", "2"],
			{
				env: ENV,
				fetch,
			}
		);
		expect(all.code).toBe(0);
		expect(
			all.stdout
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { id: string }).id)
		).toEqual(["e1", "e2", "e3"]);
		expect(
			calls.slice(1).map((call) => new URL(call.url).searchParams.get("before"))
		).toEqual([null, "c1"]);
	});

	test("events list and events get print the same shapes", async () => {
		const { fetch } = stubFetch(notifyServer());
		const list = await run(["notify", "events", "list"], { env: ENV, fetch });
		expect(list.code).toBe(0);
		// One page prints one JSON line per event, like --all; paging is on stderr.
		const items = ndjson(list.stdout) as { id: string }[];
		expect(items.map((item) => item.id)).toEqual(["e1", "e2"]);
		expect(list.stderr).toBe(
			"More events: pass --before c1 for the next page, or --all for every event.\n"
		);

		const got = await run(["notify", "events", "get", "e1"], {
			env: ENV,
			fetch,
		});
		expect(got.code).toBe(0);
		// `events get` prints one item of the same shape `events list` prints.
		const item = JSON.parse(got.stdout) as Record<string, unknown>;
		expect(Object.keys(item).sort()).toEqual(
			Object.keys(items[0] ?? {}).sort()
		);

		const last = await run(["notify", "events", "list", "--before", "c1"], {
			env: ENV,
			fetch,
		});
		expect(
			(ndjson(last.stdout) as { id: string }[]).map((event) => event.id)
		).toEqual(["e3"]);
		expect(last.stderr).toBe("");

		const json = await run(["notify", "events", "list", "--json"], {
			env: ENV,
			fetch,
		});
		const envelope = JSON.parse(json.stdout) as {
			data: { events: { id: string }[]; nextCursor: string | null };
			meta: unknown;
		};
		expect(envelope.data.nextCursor).toBe("c1");
		expect(envelope.data.events.map((event) => event.id)).toEqual(["e1", "e2"]);
		expect(envelope).toHaveProperty("meta");
		expect(json.stderr).toBe("");
	});

	test("events get and usage read one resource each", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const got = await run(["notify", "events", "get", "e1", "--json"], {
			env: ENV,
			fetch,
		});
		expect((JSON.parse(got.stdout) as { data: { id: string } }).data.id).toBe(
			"e1"
		);
		const usage = await run(
			[
				"notify",
				"usage",
				"--from",
				"2026-10-01T00:00:00Z",
				"--to",
				"2026-10-02T00:00:00Z",
				"--json",
			],
			{ env: ENV, fetch }
		);
		expect(usage.code).toBe(0);
		expect(
			(JSON.parse(usage.stdout) as { data: { meters: { events: number } } })
				.data.meters.events
		).toBe(42);
		const query = new URL(calls[1]?.url ?? "").searchParams;
		expect(query.get("from")).toBe("2026-10-01T00:00:00Z");
		expect(query.get("to")).toBe("2026-10-02T00:00:00Z");

		const defaulted = await run(["notify", "usage"], { env: ENV, fetch });
		expect(defaulted.code).toBe(0);
		const window = new URL(calls[2]?.url ?? "").searchParams;
		const from = Date.parse(window.get("from") ?? "");
		const to = Date.parse(window.get("to") ?? "");
		expect(to - from).toBe(24 * 3_600_000);
		expect(to % 3_600_000).toBe(0);
	});

	test("defaultUsageWindow ends at the next whole hour and includes the current one", () => {
		expect(defaultUsageWindow(Date.parse("2026-10-01T12:30:00.000Z"))).toEqual({
			from: "2026-09-30T13:00:00.000Z",
			to: "2026-10-01T13:00:00.000Z",
		});
		expect(defaultUsageWindow(Date.parse("2026-10-01T12:00:00.000Z"))).toEqual({
			from: "2026-09-30T13:00:00.000Z",
			to: "2026-10-01T13:00:00.000Z",
		});
	});

	test("usage errors exit 2 without a request", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		for (const argv of [
			["notify", "publish"],
			["notify", "publish", "--title", "x", "--level", "loud"],
			["notify", "events", "get"],
			["notify", "events", "list", "--limit", "500"],
			["notify", "events", "list", "--all", "--before", "c1"],
			["notify", "usage", "--from", "2026-10-01T00:00:00Z"],
		]) {
			const result = await run(argv, { env: ENV, fetch });
			expect(`${argv.join(" ")} -> ${result.code}`).toBe(
				`${argv.join(" ")} -> 2`
			);
		}
		expect(calls).toHaveLength(0);
	});

	test("an API error exits 1 with Notify's code and request id", async () => {
		const fetch: RyuFetch = async () =>
			Response.json(
				{
					code: "unauthorized",
					error: {
						code: "unauthorized",
						message: "Missing or invalid API key.",
						requestId: "req_notify_1",
						status: 401,
					},
					message: "Missing or invalid API key.",
					ok: false,
					requestId: "req_notify_1",
					status: 401,
					type: "notify.error",
				},
				{ status: 401, headers: { "x-request-id": "req_notify_1" } }
			);
		const result = await run(["notify", "events", "list", "--json"], {
			env: ENV,
			fetch,
		});
		expect(result.code).toBe(1);
		const printed = JSON.parse(result.stdout || result.stderr) as {
			error: { code: string; requestId: string };
		};
		expect(printed.error).toMatchObject({
			code: "unauthorized",
			requestId: "req_notify_1",
		});
	});

	test("missing configuration exits 2 and names the env vars", async () => {
		// RYU_NOTIFY_URL defaults to hosted Notify; the key has no default.
		const result = await run(["notify", "events", "list"], { env: {} });
		expect(result.code).toBe(2);
		expect(result.stderr + result.stdout).toContain("RYU_NOTIFY_API_KEY");
	});

	test("--dry-run prints curl with the key placeholder and sends nothing", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const result = await run(
			["notify", "publish", "--title", "Deploy finished", "--dry-run"],
			{ env: ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(calls).toHaveLength(0);
		expect(result.stdout).toContain("curl");
		expect(result.stdout).toContain("http://127.0.0.1:8092/v1/events");
		expect(result.stdout).toContain("$RYU_NOTIFY_API_KEY");
		expect(result.stdout).not.toContain("notify_cli_secret");
	});
});

async function connectMcp(
	env: Record<string, string>,
	fetch: RyuFetch,
	readOnly = false
) {
	const { server, registration } = createServicesMcpServer({
		config: { env, fetch },
		log: () => undefined,
		services: ["notify"],
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "notify-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration };
}

describe("notify MCP tools", () => {
	test("registers the six design §9 tools with honest annotations", async () => {
		const { fetch } = stubFetch(notifyServer());
		const { client, registration } = await connectMcp(ENV, fetch);
		try {
			expect(registration.tools).toEqual([
				"notify_publish",
				"notify_request_approval",
				"notify_list_events",
				"notify_get_event",
				"notify_ack_event",
				"notify_usage",
			]);
			const { tools } = await client.listTools();
			const byName = new Map(tools.map((tool) => [tool.name, tool]));
			for (const name of ["notify_publish", "notify_request_approval"]) {
				expect(byName.get(name)?.annotations).toMatchObject({
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				});
			}
			expect(byName.get("notify_ack_event")?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
			});
			for (const name of [
				"notify_list_events",
				"notify_get_event",
				"notify_usage",
			]) {
				expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
			}
		} finally {
			await client.close();
		}
	});

	test("read-only mode keeps only the read tools", async () => {
		const { fetch } = stubFetch(notifyServer());
		const { client, registration } = await connectMcp(ENV, fetch, true);
		try {
			expect(registration.tools).toEqual([
				"notify_list_events",
				"notify_get_event",
				"notify_usage",
			]);
		} finally {
			await client.close();
		}
	});

	test("no Notify env registers no Notify tools", async () => {
		const { fetch } = stubFetch(notifyServer());
		const { client, registration } = await connectMcp({}, fetch);
		try {
			expect(registration.tools).toEqual([]);
			expect(registration.skipped.map((entry) => entry.service)).toEqual([
				"notify",
			]);
		} finally {
			await client.close();
		}
	});

	test("publish, list, get, ack and usage answer { data, meta }", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const { client } = await connectMcp(ENV, fetch);
		try {
			const published = await client.callTool({
				name: "notify_publish",
				arguments: { title: "Deploy finished", idempotencyKey: "mcp-pub-1" },
			});
			expect(published.isError).toBeFalsy();
			expect(
				(published.structuredContent as { meta: { idempotencyKey: string } })
					.meta.idempotencyKey
			).toBe("mcp-pub-1");
			expect(calls[0]?.headers.get("idempotency-key")).toBe("mcp-pub-1");

			const listed = await client.callTool({
				name: "notify_list_events",
				arguments: { limit: 2, acknowledged: false },
			});
			expect(
				(listed.structuredContent as { data: { nextCursor: string } }).data
					.nextCursor
			).toBe("c1");
			expect(new URL(calls[1]?.url ?? "").searchParams.toString()).toBe(
				"limit=2&acknowledged=false"
			);

			const got = await client.callTool({
				name: "notify_get_event",
				arguments: { eventId: "e1" },
			});
			expect((got.structuredContent as { data: { id: string } }).data.id).toBe(
				"e1"
			);
			const acked = await client.callTool({
				name: "notify_ack_event",
				arguments: { eventId: "e1" },
			});
			expect(
				(acked.structuredContent as { data: { acknowledgedAt: string } }).data
					.acknowledgedAt
			).toBe(NOW);
			const usage = await client.callTool({
				name: "notify_usage",
				arguments: {},
			});
			expect(
				(usage.structuredContent as { data: { meters: { events: number } } })
					.data.meters.events
			).toBe(42);
			const partial = await client.callTool({
				name: "notify_usage",
				arguments: { from: "2026-10-01T00:00:00Z" },
			});
			expect(partial.isError).toBe(true);
		} finally {
			await client.close();
		}
	});

	test("notify_request_approval publishes an approval and returns the answer", async () => {
		const { calls, fetch } = stubFetch(notifyServer());
		const { client } = await connectMcp(ENV, fetch);
		try {
			const result = await client.callTool({
				name: "notify_request_approval",
				arguments: {
					title: "Ship v2?",
					prompt: "Ship build 184?",
					timeoutMs: 5000,
				},
			});
			expect(result.isError).toBeFalsy();
			expect(
				(result.structuredContent as { data: { approved: boolean } }).data
			).toMatchObject({ approved: true, status: "approved", timedOut: false });
			const body = JSON.parse(calls[0]?.body ?? "{}") as {
				response: { prompt: string; type: string };
			};
			expect(body.response).toMatchObject({
				prompt: "Ship build 184?",
				type: "approval",
			});
			expect(calls[1]?.url).toBe("http://127.0.0.1:8092/v1/events/evt_new");

			const tooLong = await client.callTool({
				name: "notify_request_approval",
				arguments: { title: "x", timeoutMs: MAX_APPROVAL_TIMEOUT_MS + 1 },
			});
			expect(tooLong.isError).toBe(true);
		} finally {
			await client.close();
		}
	});

	test("notify_request_approval returns pending once waitMs ends, without publishing again", async () => {
		const answer = notifyServer();
		const { calls, fetch } = stubFetch((request) =>
			request.method === "GET"
				? Response.json({ event: event("evt_new", "pending") })
				: answer(request)
		);
		const { client } = await connectMcp(ENV, fetch);
		try {
			const before = Date.now();
			const result = await client.callTool({
				name: "notify_request_approval",
				arguments: { title: "Ship v2?", waitMs: 0 },
			});
			expect(result.isError).toBeFalsy();
			const data = (
				result.structuredContent as {
					data: {
						approved: boolean;
						event: { id: string };
						status: string;
						timedOut: boolean;
					};
				}
			).data;
			expect(data).toMatchObject({
				approved: false,
				status: "pending",
				timedOut: false,
			});
			expect(data.event.id).toBe("evt_new");
			expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
			// The request stays open for the default timeoutMs, not for waitMs.
			const body = JSON.parse(calls[0]?.body ?? "{}") as {
				response: { expiresAt: string };
			};
			const expiresAt = Date.parse(body.response.expiresAt);
			expect(expiresAt).toBeGreaterThanOrEqual(
				before + DEFAULT_APPROVAL_TOOL_TIMEOUT_MS
			);
			expect(expiresAt).toBeLessThan(
				Date.now() + DEFAULT_APPROVAL_TOOL_TIMEOUT_MS + 1000
			);

			const tooLong = await client.callTool({
				name: "notify_request_approval",
				arguments: { title: "x", waitMs: MAX_APPROVAL_WAIT_MS + 1 },
			});
			expect(tooLong.isError).toBe(true);
			expect(calls).toHaveLength(2);
		} finally {
			await client.close();
		}
	});

	test("the approval wait stays under a 60 s MCP request timeout", () => {
		expect(MAX_APPROVAL_WAIT_MS).toBeLessThan(60_000);
	});
});
