// Tool behaviour every surface shares: the compact model-facing result,
// argument rules in the schemas, idempotency keys on open-world writes,
// truncated reads, cancellation, the shared approval ledger, and selection
// errors.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RyuNotFoundError } from "../errors.ts";
import { pendingToolApprovals } from "../managed-agents/helpers.ts";
import { Ryu } from "../ryu.ts";
import { defaultToolBoxName } from "./box.ts";
import {
	DEFAULT_BOX_READ_CHARS,
	getRyuTool,
	listPendingApprovals,
	RYU_TOOLS,
	runRyuTool,
	ryuToolPassesFilter,
	selectRyuTools,
	toAiSdkTools,
	toRyuAgentTools,
	toToolResultJson,
} from "./index.ts";
import { APPROVAL_KEY_REUSED_HINT } from "./notify.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	signal: AbortSignal | null;
	url: string;
}

function stubFetch(
	respond: (request: Recorded) => Response | Promise<Response>
) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? request.method,
			signal: init?.signal ?? null,
			url: request.url,
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

function tool(name: string) {
	const found = getRyuTool(name);
	if (found === undefined) {
		throw new Error(`${name} is not in RYU_TOOLS`);
	}
	return found;
}

/** Polls until `predicate` holds (about a second at most); resolves to whether it did. */
async function until(predicate: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 500 && !predicate(); attempt += 1) {
		await new Promise((done) => setTimeout(done, 2));
	}
	return predicate();
}

/** A fetch answer that never arrives; it rejects when the request is aborted. */
function hangUntilAborted(request: Recorded): Promise<Response> {
	return new Promise((_resolve, reject) => {
		const fail = () =>
			reject(new DOMException("The operation was aborted.", "AbortError"));
		if (request.signal?.aborted) {
			fail();
		}
		request.signal?.addEventListener("abort", fail, { once: true });
	});
}

const NOTIFY_ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-tools-secret",
};
const BOX_URL = "http://127.0.0.1:8090";
const BOX_ENV = { RYU_BOX_URL: BOX_URL, RYU_BOX_API_KEY: "box-key" };
const MA_ENV = { RYU_API_KEY: "ryu_test_key", RYU_ORGANIZATION_ID: "org_1" };
const MA_BASE = "https://api.ryuhq.com/api/v1/managed-agents";
const SITES_ENV = {
	RYU_SITES_URL: "https://sites.example.com",
	RYU_SITES_API_KEY: "sites-key",
};
const PASSPORT_ENV = {
	RYU_PASSPORT_URL: "https://passport.example.com",
	RYU_PASSPORT_API_KEY: "passport-key",
};

function notifyFixture(name: string) {
	return JSON.parse(
		readFileSync(
			resolve(import.meta.dir, "../../test/fixtures/notify", name),
			"utf8"
		)
	) as { body: unknown; headers: Record<string, string>; status: number };
}

function fixtureResponse(name: string): Response {
	const answer = notifyFixture(name);
	return new Response(JSON.stringify(answer.body), {
		status: answer.status,
		headers: answer.headers,
	});
}

function boxFixture(name: string) {
	return JSON.parse(
		readFileSync(
			resolve(import.meta.dir, "../../test/fixtures/box", name),
			"utf8"
		)
	) as { body: unknown; status: number };
}

// Managed Agents fixtures, in the shapes of managed-agents.test.ts.
const NOW = "2026-10-21T12:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";
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

function session(status: string, pendingToolUseIds: string[] = []) {
	return {
		id: "msess_1",
		agentId: "magt_1",
		agentVersion: 1,
		environmentId: "menv_1",
		environmentRevision: 1,
		backend: "anthropic",
		title: null,
		metadata: {},
		status,
		stopReason: status === "idle" ? "requires_action" : null,
		pendingToolUseIds,
		lastError: null,
		headSeq: 20,
		usage: USAGE,
		billedMicroUsd: 0,
		budget: null,
		closing: null,
		createdAt: NOW,
		updatedAt: NOW,
		startedAt: NOW,
		endedAt: null,
	};
}

function envelope(seq: number) {
	return { id: `mevt_${seq}`, sessionId: "msess_1", seq, createdAt: NOW };
}

const toolUseId = (letter: string) => `mtool_${letter.repeat(32)}`;

function toolUse(seq: number, id: string) {
	return {
		...envelope(seq),
		type: "agent.tool_use",
		toolUseId: id,
		name: "bash",
		input: { command: `echo ${seq}` },
		inputTruncated: false,
		source: "builtin",
		server: null,
	};
}

function approvalRequest(seq: number, id: string, expiresAt = FUTURE) {
	return {
		...envelope(seq),
		type: "agent.tool_approval_request",
		toolUseId: id,
		name: "bash",
		source: "builtin",
		server: null,
		expiresAt,
	};
}

function approvalAnswer(seq: number, id: string) {
	return {
		...envelope(seq),
		type: "user.tool_approval",
		toolUseId: id,
		decision: "allow",
		message: null,
	};
}

function status(
	seq: number,
	value: string,
	stopReason: string | null,
	inputSeq: number | null,
	pending: string[] = []
) {
	return {
		...envelope(seq),
		type: "session.status",
		status: value,
		stopReason,
		pendingToolUseIds: pending,
		detail: null,
		inputSeq,
	};
}

/**
 * One log covering every rule: a request answered (a), one abandoned by an
 * interrupt (b), one open (c), one open but expired and no longer pending
 * (d), and one expired that the session still lists (e).
 */
const APPROVAL_LOG = [
	toolUse(1, toolUseId("a")),
	approvalRequest(2, toolUseId("a")),
	approvalAnswer(3, toolUseId("a")),
	toolUse(4, toolUseId("b")),
	approvalRequest(5, toolUseId("b")),
	{ ...envelope(6), type: "user.interrupt" },
	status(7, "idle", "interrupted", 6),
	toolUse(8, toolUseId("c")),
	approvalRequest(9, toolUseId("c")),
	toolUse(10, toolUseId("d")),
	approvalRequest(11, toolUseId("d"), PAST),
	toolUse(12, toolUseId("e")),
	approvalRequest(13, toolUseId("e"), PAST),
	status(14, "idle", "requires_action", 12, [toolUseId("c"), toolUseId("e")]),
];

describe("the model-facing result", () => {
	test("an error keeps only what a model acts on, with no null keys", async () => {
		const { fetch } = stubFetch(() =>
			fixtureResponse("publish-rate-limited.json")
		);
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch, maxRetries: 0 });
		const output = toToolResultJson(
			await runRyuTool(ryu, tool("notify_publish"), {
				title: "x",
				idempotencyKey: "deploy-1",
			})
		);
		expect(output.error).toEqual({
			code: "rate_limited",
			message: expect.any(String),
			service: "notify",
			status: 429,
			retryable: true,
			requestId: "req_a94d3c7e10b24bdcb757a9b90039e9ad",
			retryAfterSeconds: 1,
			...(output.error?.hint === undefined ? {} : { hint: output.error.hint }),
		});
		expect(Object.values(output.error ?? {}).includes(null)).toBe(false);
		expect(output.meta).toEqual({
			requestId: "req_a94d3c7e10b24bdcb757a9b90039e9ad",
			idempotencyKey: "deploy-1",
		});
	});

	test("success meta carries only the fields that are set", async () => {
		const { fetch } = stubFetch(() => fixtureResponse("publish-replayed.json"));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch, maxRetries: 0 });
		const output = toToolResultJson(
			await runRyuTool(ryu, tool("notify_publish"), {
				title: "x",
				idempotencyKey: "deploy-1",
			})
		);
		expect(output.error).toBeNull();
		expect(Object.keys(output.meta).sort()).toEqual(
			["idempotencyKey", "replayed", "requestId"].sort()
		);
		expect(output.meta.replayed).toBe(true);
		const offline = await runRyuTool(ryu, tool("notify_publish"), {});
		expect(toToolResultJson(offline).meta).toEqual({});
	});
});

describe("argument rules live in the schemas", () => {
	test("notify_usage needs both from and to, or neither", async () => {
		const { calls, fetch } = stubFetch(() => new Response("{}"));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const result = await runRyuTool(ryu, tool("notify_usage"), {
			from: "2026-10-01T00:00:00Z",
		});
		expect(calls).toEqual([]);
		expect(result.error).toMatchObject({
			code: "invalid_arguments",
			hint: expect.stringContaining("details.issues"),
			details: {
				tool: "notify_usage",
				issues: [
					expect.objectContaining({
						path: "to",
						message: "Pass both from and to, or neither.",
					}),
				],
			},
		});
	});

	test("sites_deploy needs exactly one of html and versionId", async () => {
		const { calls, fetch } = stubFetch(() => new Response("{}"));
		const ryu = new Ryu({ env: SITES_ENV, fetch });
		for (const input of [
			{ siteId: "site_1", expectedRevision: 1 },
			{
				siteId: "site_1",
				expectedRevision: 1,
				html: "<!doctype html><p>hi</p>",
				versionId: "ver_1",
			},
		]) {
			const result = await runRyuTool(ryu, tool("sites_deploy"), input);
			expect(result.error).toMatchObject({
				code: "invalid_arguments",
				details: {
					issues: [
						expect.objectContaining({
							path: "html",
							message: "Give exactly one of html or versionId.",
						}),
					],
				},
			});
		}
		expect(calls).toEqual([]);
	});

	test("mail_send on a server without an outbound transport returns the SMTP hint", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{ error: "email transport is not configured" },
				{ status: 400 }
			)
		);
		const ryu = new Ryu({
			env: {
				RYU_MAIL_URL: "https://mail.example.com",
				RYU_MAIL_API_KEY: "mail-key",
			},
			fetch,
			maxRetries: 0,
		});
		const sent = await runRyuTool(ryu, tool("mail_send"), {
			from: "inbox_1",
			to: ["someone@example.com"],
			subject: "Hi",
			text: "Hello",
			idempotencyKey: "welcome-1",
		});
		expect(sent.error?.message).toStartWith(
			"email transport is not configured. Hint: The Mail server has no outbound email transport."
		);
		expect(sent.error?.hint).toContain("RYU_SMTP_HOST");
		expect(toToolResultJson(sent)).toMatchObject({
			data: null,
			error: { hint: expect.stringContaining("RYU_SMTP_HOST") },
		});
	});

	test("mail_create_inbox posts the inbox with its clientId and returns the normalized inbox", async () => {
		const inbox = {
			id: "inbox_new",
			address: "support@acme.example",
			name: "Support",
			client_id: "support-inbox",
			provider: "webhook",
			created_at: NOW,
			updated_at: NOW,
		};
		const { calls, fetch } = stubFetch(() =>
			Response.json({ inbox }, { status: 201 })
		);
		const ryu = new Ryu({
			env: {
				RYU_MAIL_URL: "https://mail.example.com",
				RYU_MAIL_API_KEY: "mail-key",
			},
			fetch,
		});
		const created = await runRyuTool(ryu, tool("mail_create_inbox"), {
			name: "Support",
			clientId: "support-inbox",
			address: "support@acme.example",
			description: "Customer replies",
		});
		expect(created.error).toBeNull();
		expect(created.data).toMatchObject({
			id: "inbox_new",
			address: "support@acme.example",
			clientId: "support-inbox",
			agentId: null,
			metadata: {},
		});
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"POST https://mail.example.com/api/mail/inboxes",
		]);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			name: "Support",
			clientId: "support-inbox",
			address: "support@acme.example",
			description: "Customer replies",
		});
		for (const input of [
			{ name: "Support" },
			{ name: "Support", clientId: "" },
			{ name: "Support", clientId: "   " },
			{ name: "Support", clientId: "caf\u00e9" },
			{ name: "   ", clientId: "k" },
			{ name: "Support", clientId: "k", address: "support" },
			{ name: "Support", clientId: "k", address: "a b@acme.example" },
			{ name: "Support", clientId: "k", podId: "../webhooks" },
			{ name: "Support", clientId: "k", domainId: "dom/1" },
			{ name: "Support", clientId: "k", localPart: "" },
		]) {
			const result = await runRyuTool(ryu, tool("mail_create_inbox"), input);
			expect({ input, code: result.error?.code }).toEqual({
				input,
				code: "invalid_arguments",
			});
		}
		expect(calls).toHaveLength(1);
		const definition = tool("mail_create_inbox");
		// A repeat with the same clientId returns the first inbox: idempotent, closed world.
		expect(definition.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			toAiSdkTools(ryu, { readOnly: false }).mail_create_inbox?.needsApproval
		).toBe(true);
		expect(Object.keys(toAiSdkTools(ryu))).not.toContain("mail_create_inbox");
	});

	test("sites_create posts name, slug, template and the description as the brief", async () => {
		const site = {
			aliases: [],
			createdAt: NOW,
			deploymentId: null,
			domains: [],
			hasPublished: false,
			id: "site_new",
			name: "Launch",
			ownerId: "owner",
			prompt: "Release notes",
			revision: 0,
			settings: { audience: "private" },
			slug: "launch-notes",
			template: "website",
			updatedAt: NOW,
			versions: [],
		};
		const { calls, fetch } = stubFetch(() =>
			Response.json(site, { status: 201 })
		);
		const ryu = new Ryu({ env: SITES_ENV, fetch });
		const created = await runRyuTool(ryu, tool("sites_create"), {
			name: " Launch ",
			slug: "launch-notes",
			template: "website",
			description: "Release notes",
		});
		expect(created.error).toBeNull();
		expect(created.data).toMatchObject({ id: "site_new", revision: 0 });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"POST https://sites.example.com/api/sites/projects",
		]);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			name: "Launch",
			prompt: "Release notes",
			slug: "launch-notes",
			template: "website",
		});
		for (const input of [
			{ name: "Launch", slug: "abc" },
			{ name: "Launch", slug: "Launch-Notes" },
			{ name: "Launch", slug: "launch--notes" },
			{ name: "", slug: "launch-notes" },
			{ name: "   ", slug: "launch-notes" },
			{ name: "Launch", slug: "launch-notes", template: "blog" },
		]) {
			const result = await runRyuTool(ryu, tool("sites_create"), input);
			expect({ input, code: result.error?.code }).toEqual({
				input,
				code: "invalid_arguments",
			});
		}
		expect(calls).toHaveLength(1);
		expect(tool("sites_create").annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(ryuToolPassesFilter(tool("sites_create"), { readOnly: true })).toBe(
			false
		);
	});
});

describe("sites_update_settings and managed_agents_list_environments", () => {
	const current = {
		aliases: [],
		createdAt: NOW,
		deploymentId: null,
		domains: [],
		hasPublished: false,
		id: "site_1",
		name: "Launch",
		ownerId: "owner",
		prompt: "",
		revision: 7,
		settings: {
			audience: "private",
			viewers: [],
			workspaceId: "ws_1",
			extensions: { mcp: false },
		},
		slug: "launch-notes",
		template: "website",
		updatedAt: NOW,
		versions: [],
	};

	test("sites_update_settings keeps other settings and sends the revision it was given", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.method === "GET"
				? Response.json(current)
				: Response.json({ ...current, revision: 3 })
		);
		const ryu = new Ryu({ env: SITES_ENV, fetch });
		const updated = await runRyuTool(ryu, tool("sites_update_settings"), {
			siteId: "site_1",
			audience: "public",
			workspaceId: null,
			expectedRevision: 2,
		});
		expect(updated.error).toBeNull();
		expect(updated.data).toMatchObject({ revision: 3 });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"GET https://sites.example.com/api/sites/projects/site_1",
			"PUT https://sites.example.com/api/sites/projects/site_1/settings",
		]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			expectedRevision: 2,
			settings: { ...current.settings, audience: "public", workspaceId: null },
		});
		for (const input of [
			{ siteId: "site_1", expectedRevision: 2 },
			{ siteId: "site_1", audience: "private" },
			{ siteId: "site_1", audience: "everyone", expectedRevision: 2 },
			{ siteId: "site_1", viewers: ["not an email"], expectedRevision: 2 },
			// Editors gain write and deploy rights: not settable from this tool.
			{ siteId: "site_1", editors: ["eve@example.com"], expectedRevision: 2 },
		]) {
			const result = await runRyuTool(
				ryu,
				tool("sites_update_settings"),
				input
			);
			expect({ input, code: result.error?.code }).toEqual({
				input,
				code: "invalid_arguments",
			});
		}
		expect(calls).toHaveLength(2);
		const withEditors = await runRyuTool(ryu, tool("sites_update_settings"), {
			siteId: "site_1",
			allowRemix: true,
			editors: ["eve@example.com"],
			expectedRevision: 7,
		});
		// The schema has no editors field, so the value is dropped, never sent.
		expect(withEditors.error).toBeNull();
		expect(JSON.parse(calls[3]?.body ?? "{}").settings).toEqual({
			...current.settings,
			allowRemix: true,
		});
		const definition = tool("sites_update_settings");
		expect(definition.description).toContain("editors are not changed here");
		expect(definition.description).toContain(
			"Ask the user before widening access"
		);
		// Revision-guarded like sites_deploy: a repeat answers 409, so not idempotent.
		expect(definition.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(
			ryuToolPassesFilter(tool("sites_update_settings"), { readOnly: true })
		).toBe(false);
	});

	test("managed_agents_list_environments reads one page and is read-only", async () => {
		const page = { data: [], nextCursor: null };
		const { calls, fetch } = stubFetch(() => Response.json(page));
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const listed = await runRyuTool(
			ryu,
			tool("managed_agents_list_environments"),
			{ limit: 5, includeArchived: true }
		);
		expect(listed.error).toBeNull();
		expect(listed.data).toEqual(page);
		const url = new URL(calls[0]?.url ?? "");
		expect(`${calls[0]?.method} ${url.origin}${url.pathname}`).toBe(
			`GET ${MA_BASE}/environments`
		);
		expect(url.searchParams.get("limit")).toBe("5");
		expect(url.searchParams.get("includeArchived")).toBe("true");
		expect(
			ryuToolPassesFilter(tool("managed_agents_list_environments"), {
				readOnly: true,
			})
		).toBe(true);
	});
});

describe("open-world writes take an idempotencyKey", () => {
	test("box_create, create_session, send_message and notify_publish send the model's key", async () => {
		const created = boxFixture("create-201.json");
		const box = stubFetch(() =>
			Response.json(created.body, { status: created.status })
		);
		const boxRyu = new Ryu({ env: BOX_ENV, fetch: box.fetch, maxRetries: 0 });
		const boxResult = await runRyuTool(boxRyu, tool("box_create"), {
			idempotencyKey: "box-for-ticket-42",
		});
		expect(boxResult.error).toBeNull();
		expect(box.calls[0]?.headers.get("idempotency-key")).toBe(
			"box-for-ticket-42"
		);
		expect(toToolResultJson(boxResult).meta.idempotencyKey).toBe(
			"box-for-ticket-42"
		);

		const ma = stubFetch((request) =>
			request.url.endsWith("/events")
				? Response.json({
						data: [
							{
								...envelope(5),
								type: "user.message",
								content: [{ type: "text", text: "More" }],
							},
						],
					})
				: Response.json(session("running"), { status: 201 })
		);
		const maRyu = new Ryu({ env: MA_ENV, fetch: ma.fetch, maxRetries: 0 });
		await runRyuTool(maRyu, tool("managed_agents_create_session"), {
			agentId: "magt_1",
			environmentId: "menv_1",
			idempotencyKey: "session-for-ticket-42",
		});
		await runRyuTool(maRyu, tool("managed_agents_send_message"), {
			sessionId: "msess_1",
			text: "More",
			idempotencyKey: "message-for-ticket-42",
		});
		expect(ma.calls.map((call) => call.headers.get("idempotency-key"))).toEqual(
			["session-for-ticket-42", "message-for-ticket-42"]
		);

		const notify = stubFetch(() => fixtureResponse("publish-created.json"));
		const notifyRyu = new Ryu({ env: NOTIFY_ENV, fetch: notify.fetch });
		await runRyuTool(notifyRyu, tool("notify_publish"), {
			title: "x",
			idempotencyKey: "publish-for-ticket-42",
		});
		expect(notify.calls[0]?.headers.get("idempotency-key")).toBe(
			"publish-for-ticket-42"
		);
	});

	test("a retried box_create with one key and no name sends a byte-identical body", async () => {
		const created = boxFixture("create-201.json");
		const box = stubFetch(() =>
			Response.json(created.body, { status: created.status })
		);
		const ryu = new Ryu({ env: BOX_ENV, fetch: box.fetch, maxRetries: 0 });
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const result = await runRyuTool(ryu, tool("box_create"), {
				size: "small",
				idempotencyKey: "retry-safe-key-0001",
			});
			expect(result.error).toBeNull();
		}
		expect(box.calls).toHaveLength(2);
		expect(box.calls[1]?.body).toBe(box.calls[0]?.body ?? "");
		// Shared golden with test_services_tools.py: mcp- plus 12 hex of sha256(key).
		expect(JSON.parse(box.calls[0]?.body ?? "{}")).toEqual({
			size: "small",
			name: "mcp-b4771560cb3e",
		});
		expect(await defaultToolBoxName("retry-safe-key-0001")).toBe(
			"mcp-b4771560cb3e"
		);
		const unkeyed = [
			await defaultToolBoxName(undefined),
			await defaultToolBoxName(undefined),
		];
		expect(unkeyed[0]).toMatch(/^mcp-[0-9a-f]{12}$/u);
		expect(unkeyed[0]).not.toBe(unkeyed[1]);
	});

	test("every open-world write describes its key the same way, and a malformed key is refused", async () => {
		for (const name of [
			"box_create",
			"managed_agents_create_session",
			"managed_agents_send_message",
			"notify_publish",
		]) {
			const description =
				tool(name).inputSchema.shape.idempotencyKey?.description ?? "";
			expect({ name, description }).toEqual({
				name,
				description: expect.stringContaining(
					"Reuse the same key when you retry the same call: the server answers from the first attempt"
				),
			});
		}
		const ryu = new Ryu({
			env: MA_ENV,
			fetch: () => Promise.reject(new Error("no call")),
		});
		const result = await runRyuTool(
			ryu,
			tool("managed_agents_create_session"),
			{
				agentId: "magt_1",
				environmentId: "menv_1",
				idempotencyKey: "short",
			}
		);
		expect(result.error?.code).toBe("invalid_arguments");
	});
});

describe("notify_request_approval keys", () => {
	test("its key does not promise a replay, and a keyed retry's 409 says to poll the first event", async () => {
		const description =
			tool("notify_request_approval").inputSchema.shape.idempotencyKey
				?.description ?? "";
		expect(description).not.toContain(
			"the server answers from the first attempt"
		);
		expect(description).toContain("idempotency_conflict");
		expect(description).toContain("notify_get_event");

		const notify = stubFetch(() => fixtureResponse("publish-conflict.json"));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch: notify.fetch });
		const keyed = toToolResultJson(
			await runRyuTool(ryu, tool("notify_request_approval"), {
				title: "Ship build 184?",
				idempotencyKey: "approval-for-build-184",
			})
		);
		expect(notify.calls[0]?.headers.get("idempotency-key")).toBe(
			"approval-for-build-184"
		);
		expect(keyed.error?.code).toBe("idempotency_conflict");
		// Shared golden with test_services_tools.py.
		expect(keyed.error?.hint).toBe(
			"An approval request was already published under this idempotencyKey, and a retry cannot replay it because each call sets a new deadline. Poll notify_get_event with the event.id from the first call (or find the event with notify_list_events) instead of calling notify_request_approval again; use a new key only to ask again."
		);
		expect(keyed.error?.hint).toBe(APPROVAL_KEY_REUSED_HINT);

		// Without a model key the conflict is the SDK's own and keeps its plain message.
		const unkeyed = toToolResultJson(
			await runRyuTool(ryu, tool("notify_request_approval"), {
				title: "Ship build 184?",
			})
		);
		expect(unkeyed.error?.code).toBe("idempotency_conflict");
		expect(unkeyed.error?.hint).toBeUndefined();
	});
});

describe("box_read_file", () => {
	function boxReading(text: string) {
		return stubFetch(
			() =>
				new Response(text, {
					headers: { "content-type": "application/octet-stream" },
				})
		);
	}

	test("cuts the file to maxChars and says so", async () => {
		const { fetch } = boxReading("abcdefghij");
		const ryu = new Ryu({ env: BOX_ENV, fetch });
		const result = await runRyuTool(ryu, tool("box_read_file"), {
			boxId: "bx_1",
			path: "notes.txt",
			maxChars: 4,
		});
		expect(result.data).toEqual({
			path: "notes.txt",
			content: "abcd",
			truncated: true,
			totalChars: 10,
		});
	});

	test("defaults to the same limit as passport_fetch", async () => {
		const { fetch } = boxReading("x".repeat(DEFAULT_BOX_READ_CHARS + 5));
		const ryu = new Ryu({ env: BOX_ENV, fetch });
		const result = await runRyuTool(ryu, tool("box_read_file"), {
			boxId: "bx_1",
			path: "big.log",
		});
		const data = result.data as { content: string; truncated: boolean };
		expect(DEFAULT_BOX_READ_CHARS).toBe(20_000);
		expect(data.content).toHaveLength(DEFAULT_BOX_READ_CHARS);
		expect(data.truncated).toBe(true);
		const small = await runRyuTool(
			new Ryu({ env: BOX_ENV, fetch: boxReading("hi\n").fetch }),
			tool("box_read_file"),
			{ boxId: "bx_1", path: "a" }
		);
		expect(small.data).toMatchObject({ content: "hi\n", truncated: false });
	});
});

describe("box_get and box_resume", () => {
	const created = boxFixture("create-201.json").body as {
		box: { id: string; status: string };
	};

	test("box_get reads one Box so a provisioning Box can be polled", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ box: { ...created.box, status: "provisioning" } })
		);
		const ryu = new Ryu({ env: BOX_ENV, fetch, maxRetries: 0 });
		const result = await runRyuTool(ryu, tool("box_get"), {
			boxId: created.box.id,
		});
		expect(result.error).toBeNull();
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BOX_URL}/v1/boxes/${created.box.id}`,
		]);
		expect(result.data).toMatchObject({
			id: created.box.id,
			status: "provisioning",
		});
	});

	test("box_resume starts a stopped Box again and returns it", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ box: created.box, ok: true, type: "box.resumed" })
		);
		const ryu = new Ryu({ env: BOX_ENV, fetch, maxRetries: 0 });
		const result = await runRyuTool(ryu, tool("box_resume"), {
			boxId: created.box.id,
		});
		expect(result.error).toBeNull();
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`POST ${BOX_URL}/v1/boxes/${created.box.id}/resume`,
		]);
		expect(result.data).toMatchObject({ id: created.box.id, status: "ready" });
	});

	test("box_resume is a write the default read-only selection leaves out", () => {
		const ryu = new Ryu({ env: BOX_ENV });
		const readOnly = selectRyuTools(ryu).map((entry) => entry.name);
		expect(readOnly).toContain("box_get");
		expect(readOnly).not.toContain("box_resume");
		expect(
			selectRyuTools(ryu, { readOnly: false }).map((entry) => entry.name)
		).toContain("box_resume");
	});
});

describe("managed_agents_list_events", () => {
	test("reads small pages by default", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ data: [], hasMore: false, nextAfter: 0, headSeq: 0 })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		await runRyuTool(ryu, tool("managed_agents_list_events"), {
			sessionId: "msess_1",
		});
		expect(new URL(calls[0]?.url ?? "").searchParams.get("limit")).toBe("50");
	});

	test("a host cancel closes the live stream at once", async () => {
		const { calls, fetch } = stubFetch((request) => {
			if (request.url.includes("/stream")) {
				return new Response(
					new ReadableStream({
						start(controller) {
							request.signal?.addEventListener("abort", () =>
								controller.error(new DOMException("aborted", "AbortError"))
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } }
				);
			}
			return Response.json({
				data: [],
				hasMore: false,
				nextAfter: 0,
				headSeq: 0,
			});
		});
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const host = new AbortController();
		const started = Date.now();
		const pending = runRyuTool(
			ryu,
			tool("managed_agents_list_events"),
			{ sessionId: "msess_1", wait: true, timeoutMs: 60_000 },
			{ signal: host.signal }
		);
		expect(
			await until(() => calls.some((call) => call.url.includes("/stream")))
		).toBe(true);
		host.abort();
		const result = await pending;
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.data).toMatchObject({ turnEnded: false, canceled: true });
		const stream = calls.find((call) => call.url.includes("/stream"));
		expect(stream?.signal?.aborted).toBe(true);
	});
});

describe("managed_agents_list_pending_approvals", () => {
	test("its open set is the SDK ledger's, minus expired requests the session no longer lists", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.includes("/events")
				? Response.json({
						data: APPROVAL_LOG,
						hasMore: false,
						nextAfter: 14,
						headSeq: 14,
					})
				: Response.json(session("idle", [toolUseId("c"), toolUseId("e")]))
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const listed = await listPendingApprovals(ryu, "msess_1");
		const ledger = pendingToolApprovals(
			APPROVAL_LOG as Parameters<typeof pendingToolApprovals>[0]
		).map((request) => request.toolUseId);
		expect(ledger).toEqual([toolUseId("c"), toolUseId("d"), toolUseId("e")]);
		expect(listed.data.map((request) => request.toolUseId)).toEqual(
			ledger.filter((id) => id !== toolUseId("d"))
		);
		expect(listed.data[0]?.input).toEqual({ command: "echo 8" });
		const eventsUrl = new URL(
			calls.find((call) => call.url.includes("/events"))?.url ?? MA_BASE
		);
		expect(eventsUrl.searchParams.getAll("types").join(",")).toContain(
			"agent.tool_approval_request"
		);
	});
});

describe("cancellation through the adapters", () => {
	test("toRyuAgentTools passes the Agent's runnableContext.signal to the call", async () => {
		const { calls, fetch } = stubFetch(hangUntilAborted);
		const ryu = new Ryu({ env: BOX_ENV, fetch, maxRetries: 0 });
		const exec = toRyuAgentTools(ryu, { readOnly: false }).box_exec;
		const controller = new AbortController();
		const pending = exec?.run(
			{ boxId: "bx_1", command: "sleep 600" },
			{ signal: controller.signal, gateway: {} }
		);
		expect(await until(() => calls.length > 0)).toBe(true);
		controller.abort();
		const output = await pending;
		expect(calls[0]?.signal?.aborted).toBe(true);
		expect(output?.error?.status).toBe(0);
	});

	test("toAiSdkTools passes abortSignal to the call", async () => {
		const { calls, fetch } = stubFetch(hangUntilAborted);
		const ryu = new Ryu({ env: BOX_ENV, fetch, maxRetries: 0 });
		const exec = toAiSdkTools(ryu, { readOnly: false }).box_exec;
		const controller = new AbortController();
		const pending = exec?.execute(
			{ boxId: "bx_1", command: "sleep 600" },
			{ abortSignal: controller.signal, toolCallId: "call_1" }
		);
		expect(await until(() => calls.length > 0)).toBe(true);
		controller.abort();
		await pending;
		expect(calls[0]?.signal?.aborted).toBe(true);
	});

	test("the host signal and a body's own idempotency key reach the same request", async () => {
		const created = boxFixture("create-201.json");
		const { calls, fetch } = stubFetch(() =>
			Response.json(created.body, { status: created.status })
		);
		const ryu = new Ryu({ env: BOX_ENV, fetch, maxRetries: 0 });
		const host = new AbortController();
		const result = await runRyuTool(
			ryu,
			tool("box_create"),
			{ idempotencyKey: "box-with-signal" },
			{ signal: host.signal }
		);
		expect(result.error).toBeNull();
		expect(calls[0]?.headers.get("idempotency-key")).toBe("box-with-signal");
		expect(calls[0]?.signal).not.toBeNull();
		// The bound view still answers the client's own methods.
		expect(ryu.isConfigured("box")).toBe(true);
	});

	test("a context without a usable signal is ignored", async () => {
		const { fetch } = stubFetch(() => fixtureResponse("events-page-1.json"));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const list = toRyuAgentTools(ryu).notify_list_events;
		for (const context of [undefined, null, 7, { signal: "nope" }]) {
			expect((await list?.run({}, context))?.error).toBeNull();
		}
	});
});

describe("approval defaults", () => {
	test("passport_fetch is read-only but open-world, so it asks first", () => {
		const ryu = new Ryu({ env: PASSPORT_ENV });
		const agentTools = toRyuAgentTools(ryu);
		const aiTools = toAiSdkTools(ryu);
		expect(Object.keys(agentTools)).toContain("passport_fetch");
		expect(agentTools.passport_fetch?.needsApproval).toBe(true);
		expect(aiTools.passport_fetch?.needsApproval).toBe(true);
		expect(agentTools.passport_list_connections?.needsApproval).toBe(false);
	});

	test("the default asks for every write and every open-world tool", () => {
		const ryu = new Ryu({
			env: {
				...NOTIFY_ENV,
				...BOX_ENV,
				...MA_ENV,
				...SITES_ENV,
				...PASSPORT_ENV,
				RYU_MAIL_URL: "https://mail.example.com",
				RYU_MAIL_API_KEY: "mail-key",
				RYU_GATEWAY_URL: "https://gateway.example.com",
				RYU_GATEWAY_TOKEN: "gateway-token",
			},
		});
		const tools = toRyuAgentTools(ryu, { readOnly: false });
		for (const definition of RYU_TOOLS) {
			const expected =
				!definition.annotations.readOnlyHint ||
				definition.annotations.openWorldHint;
			expect({
				name: definition.name,
				needsApproval: tools[definition.name]?.needsApproval,
			}).toEqual({ name: definition.name, needsApproval: expected });
		}
	});
});

describe("selection errors name the real problem", () => {
	const ryu = new Ryu({ env: { ...NOTIFY_ENV, ...BOX_ENV } });

	function thrown(run: () => unknown): Record<string, unknown> {
		try {
			run();
		} catch (error) {
			return error as Record<string, unknown>;
		}
		throw new Error("expected a configuration error");
	}

	test("an unknown service is unknown, not unconfigured", () => {
		const error = thrown(() =>
			selectRyuTools(ryu, { services: ["nope" as "notify"] })
		);
		expect(error.name).toBe("RyuConfigurationError");
		expect(String(error.message)).toContain(
			"Unknown service in services: nope"
		);
		expect(String(error.message)).not.toContain("Not configured");
		expect(error.details).toMatchObject({ unknown: ["nope"], service: null });
	});

	test("an unconfigured service names its settings and docs, not a CLI", () => {
		const error = thrown(() =>
			selectRyuTools(ryu, { services: ["notify", "mail", "sites"] })
		);
		const message = String(error.message);
		expect(message).toContain("Not configured: mail, sites.");
		expect(message).toContain(
			"mail reads RYU_API_KEY, RYU_MAIL_URL, RYU_MAIL_GATEWAY_KEY, RYU_MAIL_API_KEY (new Ryu() options: apiKey,"
		);
		expect(message).toContain("sites reads RYU_SITES_URL, RYU_SITES_API_KEY");
		expect(message).toContain("https://docs.ryuhq.com/docs/standalone/sdk/");
		expect(message).toContain(
			"Every service in services must be configured; omit services to get tools for the configured services only."
		);
		expect(message).not.toContain("doctor");
		expect(error.details).toMatchObject({ missing: ["mail", "sites"] });
	});

	test("connect has no tools and points at its MCP config", () => {
		const error = thrown(() => selectRyuTools(ryu, { services: ["connect"] }));
		expect(String(error.message)).toContain("ryu.connect.mcpConfig()");
		expect(error.service).toBe("connect");
	});

	test("a misspelt tool name is attributed to its prefix's service or to none", () => {
		const prefixed = thrown(() =>
			selectRyuTools(ryu, { include: ["notify_publsh"] })
		);
		expect(prefixed.service).toBe("notify");
		const unprefixed = thrown(() =>
			selectRyuTools(ryu, { exclude: ["notfy_publish"] })
		);
		expect(unprefixed.details).toMatchObject({ service: null });
	});

	test("an object-mode client is refused, so a failure never becomes data", async () => {
		const objectMode = new Ryu({
			env: NOTIFY_ENV,
			result: "object",
			fetch: () =>
				Promise.resolve(fixtureResponse("publish-rate-limited.json")),
		});
		const error = thrown(() => toAiSdkTools(objectMode as unknown as Ryu));
		expect(String(error.message)).toContain('result: "object"');
		const direct = await runRyuTool(
			objectMode as unknown as Ryu,
			tool("notify_list_events"),
			{}
		);
		expect(direct.data).toBeNull();
		expect(direct.error?.name).toBe("RyuConfigurationError");
	});

	test("ryuToolPassesFilter is the one read-only and include/exclude rule", () => {
		const publish = tool("notify_publish");
		const list = tool("notify_list_events");
		expect(ryuToolPassesFilter(publish, { readOnly: true })).toBe(false);
		expect(ryuToolPassesFilter(publish, { readOnly: false })).toBe(true);
		expect(ryuToolPassesFilter(list, { readOnly: true })).toBe(true);
		expect(
			ryuToolPassesFilter(list, { readOnly: true, exclude: [list.name] })
		).toBe(false);
		expect(
			ryuToolPassesFilter(list, { readOnly: true, include: [publish.name] })
		).toBe(false);
	});
});

describe("sites tools given a slug for siteId", () => {
	const notFound = () =>
		Response.json(
			{ error: { code: "not_found", message: "Site not found" } },
			{ status: 404 }
		);
	const cases: [string, Record<string, unknown>][] = [
		["sites_get", {}],
		["sites_deploy", { html: "<!doctype html><p>hi</p>", expectedRevision: 1 }],
		["sites_update_settings", { audience: "public", expectedRevision: 1 }],
	];

	const status = JSON.parse(
		readFileSync(
			resolve(import.meta.dir, "../../test/fixtures/sites/status.json"),
			"utf8"
		)
	) as { body: unknown };
	const sitesStub = (request: Recorded) =>
		request.url.endsWith("/api/sites/status")
			? Response.json(status.body)
			: notFound();

	test("a 404 for a slug-shaped siteId names the field in its hint", async () => {
		for (const [name, extra] of cases) {
			const { calls, fetch } = stubFetch(sitesStub);
			const ryu = new Ryu({ env: SITES_ENV, fetch, maxRetries: 0 });
			const result = await runRyuTool(ryu, tool(name), {
				siteId: "launch-notes",
				...extra,
			});
			expect({ name, status: result.error?.status }).toEqual({
				name,
				status: 404,
			});
			expect(result.error?.code).toBe("not_found");
			// The hinted copy keeps the subclass, as Python's with_ryu_error_fields does.
			expect(result.error).toBeInstanceOf(RyuNotFoundError);
			expect(result.error?.hint).toContain(
				"siteId takes the Site id from sites_list or sites_get, not its slug"
			);
			const json = toToolResultJson(result);
			expect(json.error?.message).toBe("Site not found");
			expect(json.error?.hint).toContain('"launch-notes"');
			expect(calls.at(-1)?.url).toContain("/api/sites/projects/launch-notes");
		}
	});

	test("deploy's status 404 (a wrong RYU_SITES_URL) gets no slug hint", async () => {
		const { fetch } = stubFetch(notFound);
		const ryu = new Ryu({ env: SITES_ENV, fetch, maxRetries: 0 });
		const result = await runRyuTool(ryu, tool("sites_deploy"), {
			siteId: "launch-notes",
			html: "<!doctype html><p>hi</p>",
			expectedRevision: 1,
		});
		expect(result.error?.status).toBe(404);
		expect(result.error?.hint ?? "").not.toContain("siteId takes");
	});

	test("a 404 for an id that cannot be a slug keeps no hint", async () => {
		for (const siteId of ["0b6f1c3e-9a7d-4c2b-8e1f-2d3c4b5a6f70", "site_1"]) {
			const { fetch } = stubFetch(notFound);
			const ryu = new Ryu({ env: SITES_ENV, fetch, maxRetries: 0 });
			const result = await runRyuTool(ryu, tool("sites_get"), { siteId });
			expect(result.error?.status).toBe(404);
			expect(result.error?.hint).toBeNull();
		}
	});
});
