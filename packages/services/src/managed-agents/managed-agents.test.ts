import { describe, expect, test } from "bun:test";
import type { ManagedAgentEvent } from "@ryuhq/client";
import {
	RyuAuthenticationError,
	RyuConfigurationError,
	RyuConflictError,
	type RyuError,
	RyuPermissionError,
	RyuUnavailableError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { MANAGED_AGENTS_PREVIEW_DOCS } from "./codes.ts";
import {
	isTerminalStatusEvent,
	isTurnEndEvent,
	type ManagedAgentToolApprovalContext,
	pendingToolApprovals,
	toolApprovalIdempotencyKey,
} from "./helpers.ts";
import { decorateManagedAgentsError } from "./namespace.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(
	respond: (request: Recorded, index: number) => Response | Promise<Response>
) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request: Recorded = {
			body: typeof init?.body === "string" ? init.body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		calls.push(request);
		return respond(request, calls.length - 1);
	};
	return { calls, fetch };
}

const MA_ENV = { RYU_API_KEY: "ryu_test_key", RYU_ORGANIZATION_ID: "org_1" };
const BASE = "https://api.ryuhq.com/api/v1/managed-agents";
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
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

function agent(id: string) {
	return {
		id,
		name: `Agent ${id}`,
		description: null,
		model: "model-1",
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
}

function session(status: string, stopReason: string | null = null) {
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
		stopReason,
		pendingToolUseIds: [],
		lastError: null,
		headSeq: 4,
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

function userMessage(seq: number, text: string) {
	return {
		...envelope(seq),
		type: "user.message",
		content: [{ type: "text", text }],
	};
}

function agentMessage(seq: number, text: string) {
	return {
		...envelope(seq),
		type: "agent.message",
		content: [{ type: "text", text }],
	};
}

function statusEvent(
	seq: number,
	status: string,
	options: {
		detail?: string | null;
		inputSeq?: number | null;
		stopReason?: string | null;
	} = {}
) {
	return {
		...envelope(seq),
		type: "session.status",
		status,
		stopReason: options.stopReason ?? null,
		pendingToolUseIds: [],
		detail: options.detail ?? null,
		inputSeq: options.inputSeq ?? null,
	};
}

function sse(events: readonly object[]): Response {
	const body = events
		.map((event) => {
			const { seq } = event as { seq: number };
			return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
		})
		.join("");
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function maError(
	status: number,
	code: string,
	headers: Record<string, string> = {}
): Response {
	return Response.json(
		{ error: { code, message: `said ${code}`, requestId: `req_${code}` } },
		{ headers: { "X-Request-ID": `req_${code}`, ...headers }, status }
	);
}

function eventsPage(headSeq: number): Response {
	return Response.json({ data: [], hasMore: false, nextAfter: 0, headSeq });
}

/** A follow server: `GET /events` answers the head, `GET /stream` the log. */
function followServer(headSeq: number, log: readonly object[]) {
	return stubFetch((request) =>
		request.url.includes("/stream") ? sse(log) : eventsPage(headSeq)
	);
}

async function followSeqs(
	ryu: Ryu,
	options: Parameters<Ryu["managedAgents"]["sessions"]["follow"]>[1] = {}
): Promise<number[]> {
	const seqs: number[] = [];
	for await (const event of ryu.managedAgents.sessions.follow(
		"msess_1",
		options
	)) {
		seqs.push(event.seq);
	}
	return seqs;
}

async function rejection(promise: PromiseLike<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		return error as RyuError;
	}
	throw new Error("expected the call to fail");
}

describe("Managed Agents wire", () => {
	test("sends x-api-key and X-Ryu-Organization, and never Authorization", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ data: [agent("magt_1")], nextCursor: null })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const page = await ryu.managedAgents.agents.list({ limit: 1 });
		expect(page.data[0]?.id).toBe("magt_1");
		expect(calls[0]?.url).toBe(`${BASE}/agents?limit=1`);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_test_key");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe("org_1");
		expect(calls[0]?.headers.has("authorization")).toBe(false);
	});

	test("adds an auto Idempotency-Key that matches the server grammar and reuses it after 409 idempotency_in_progress", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? maError(409, "idempotency_in_progress", { "Retry-After": "0" })
				: Response.json(session("pending"), { status: 201 })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const created = await ryu.managedAgents.sessions.create({
			agentId: "magt_1",
			environmentId: "menv_1",
		});
		expect(created.id).toBe("msess_1");
		expect(calls).toHaveLength(2);
		const first = calls[0]?.headers.get("idempotency-key");
		expect(first).toMatch(KEY_PATTERN);
		expect(calls[1]?.headers.get("idempotency-key")).toBe(first ?? "");
	});

	test("never adds a key to a write outside the route table", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(session("canceled"), { status: 202 })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		await ryu.managedAgents.sessions.cancel("msess_1");
		expect(calls[0]?.headers.has("idempotency-key")).toBe(false);
	});

	test("does not retry 503 managed_agents_disabled and adds the preview hint", async () => {
		const { calls, fetch } = stubFetch(() =>
			maError(503, "managed_agents_disabled", { "Retry-After": "1" })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(ryu.managedAgents.sessions.get("msess_1"));
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("managed_agents_disabled");
		expect(error.requestId).toBe("req_managed_agents_disabled");
		expect(error.hint).toContain(MANAGED_AGENTS_PREVIEW_DOCS);
		expect(error.docs).toBe(MANAGED_AGENTS_PREVIEW_DOCS);
		expect(error.method).toBe("GET");
		expect(error.url).toBe(`${BASE}/sessions/msess_1`);
		expect(error.envelope).toBe("managed-agents");
		expect(calls).toHaveLength(1);
	});

	test("maps 403 feature_disabled to RyuPermissionError with the preview hint, in object mode too", async () => {
		const { calls, fetch } = stubFetch(() => maError(403, "feature_disabled"));
		const ryu = new Ryu({ env: MA_ENV, fetch, result: "object" });
		const { data, error } = await ryu.managedAgents.agents.list();
		expect(data).toBeNull();
		expect(error).toBeInstanceOf(RyuPermissionError);
		expect(error?.code).toBe("feature_disabled");
		expect(error?.hint).toContain("Organization > Features");
		expect(calls).toHaveLength(1);
	});

	test("a preview-off error keeps the caller's key, the rate limit and the request", async () => {
		const { fetch } = stubFetch(() =>
			maError(503, "managed_agents_disabled", {
				RateLimit: '"default";r=99;t=30',
				"RateLimit-Policy": '"default";q=100;w=60',
			})
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents
				.with({ idempotencyKey: "create-session-0001" })
				.sessions.create({ agentId: "magt_1", environmentId: "menv_1" })
		);
		expect(error.code).toBe("managed_agents_disabled");
		expect(error.hint).toContain(MANAGED_AGENTS_PREVIEW_DOCS);
		expect(error.idempotencyKey).toBe("create-session-0001");
		expect(error.method).toBe("POST");
		expect(error.url).toBe(`${BASE}/sessions`);
		expect(error.rateLimit?.limit).toBe(100);
	});

	test("a preview-off error on a write keeps the auto key and the attempt count", async () => {
		const { calls, fetch } = stubFetch(() => maError(403, "feature_disabled"));
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents.sessions.create({
				agentId: "magt_1",
				environmentId: "menv_1",
			})
		);
		expect(error.hint).toContain(MANAGED_AGENTS_PREVIEW_DOCS);
		expect(error.idempotencyKey).toBe(
			calls[0]?.headers.get("idempotency-key") ?? "missing"
		);
		expect(error.attempts).toBe(1);
	});

	test("a 401 carries the WWW-Authenticate challenge", async () => {
		const { fetch } = stubFetch(() =>
			maError(401, "unauthenticated", {
				"WWW-Authenticate": 'Bearer realm="ryu"',
			})
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(ryu.managedAgents.agents.list());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.authChallenge).toBe('Bearer realm="ryu"');
	});

	test("decorateManagedAgentsError adds the hint only to preview-off Managed Agents errors", () => {
		const off = new RyuUnavailableError({
			service: "managedAgents",
			status: 503,
			code: "managed_agents_disabled",
			message: "off",
			envelope: "managed-agents",
		});
		expect(decorateManagedAgentsError(off).hint).toContain("preview");
		const other = new RyuConflictError({
			service: "managedAgents",
			status: 409,
			code: "version_conflict",
			message: "conflict",
			envelope: "managed-agents",
		});
		expect(decorateManagedAgentsError(other)).toBe(other);
	});

	test("other errors keep the facade's request context and carry no hint", async () => {
		const { fetch } = stubFetch(() => maError(409, "version_conflict"));
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents
				.with({ idempotencyKey: "update-agent-000001" })
				.agents.update("magt_1", { name: "x" })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.code).toBe("version_conflict");
		expect(error.hint).toBeNull();
		expect(error.idempotencyKey).toBe("update-agent-000001");
		expect(error.method).toBe("PATCH");
	});
});

describe("iterators", () => {
	test("agents.iterate follows nextCursor across 2 pages and keeps filters", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.includes("cursor=")
				? Response.json({ data: [agent("magt_3")], nextCursor: null })
				: Response.json({
						data: [agent("magt_1"), agent("magt_2")],
						nextCursor: "c_2",
					})
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const ids: string[] = [];
		for await (const item of ryu.managedAgents.agents.iterate({
			includeArchived: true,
			limit: 2,
		})) {
			ids.push(item.id);
		}
		expect(ids).toEqual(["magt_1", "magt_2", "magt_3"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe(`${BASE}/agents?includeArchived=true&limit=2`);
		expect(calls[1]?.url).toBe(
			`${BASE}/agents?cursor=c_2&includeArchived=true&limit=2`
		);
	});

	test("sessions.iterate collects up to maxItems and environments.iterate pages", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.includes("/environments")
				? Response.json({ data: [], nextCursor: null })
				: Response.json({
						data: [session("idle"), session("idle")],
						nextCursor: "c_next",
					})
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const sessions = await ryu.managedAgents.sessions
			.iterate({ maxItems: 1, status: "idle" })
			.collect();
		expect(sessions).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}/sessions?status=idle`);
		const environments = await ryu.managedAgents.environments
			.iterate()
			.collect();
		expect(environments).toEqual([]);
	});

	test("an iterator page error is a RyuError with the preview hint", async () => {
		const { fetch } = stubFetch(() => maError(503, "managed_agents_disabled"));
		const ryu = new Ryu({ env: MA_ENV, fetch, result: "object" });
		const error = await rejection(
			ryu.managedAgents.sessions.iterate().collect()
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.hint).toContain("preview");
	});
});

describe("streams", () => {
	const unauthenticated = () =>
		maError(401, "unauthenticated", {
			"WWW-Authenticate": 'Bearer realm="ryu"',
		});

	test("a 401 on sessions.stream throws RyuAuthenticationError after exactly one fetch", async () => {
		const { calls, fetch } = stubFetch(unauthenticated);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const consume = async () => {
			for await (const _event of ryu.managedAgents.sessions.stream("msess_1")) {
				// unreachable
			}
		};
		const error = await rejection(consume());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.code).toBe("unauthenticated");
		expect(calls).toHaveLength(1);
	});

	test("a 401 on sessions.follow makes exactly one fetch too", async () => {
		const { calls, fetch } = stubFetch(unauthenticated);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const consume = async () => {
			for await (const _event of ryu.managedAgents.sessions.follow("msess_1")) {
				// unreachable
			}
		};
		const error = await rejection(consume());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(calls).toHaveLength(1);
	});

	test("a 503 managed_agents_disabled on a stream carries the hint and is not reconnected", async () => {
		const { calls, fetch } = stubFetch(() =>
			maError(503, "managed_agents_disabled")
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const consume = async () => {
			for await (const _event of ryu.managedAgents.sessions.stream("msess_1")) {
				// unreachable
			}
		};
		const error = await rejection(consume());
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.hint).toContain(MANAGED_AGENTS_PREVIEW_DOCS);
		expect(error.url).toBe(`${BASE}/sessions/msess_1/stream`);
		expect(calls).toHaveLength(1);
	});

	test("sessions.follow stops at the idle status that answers the last input", async () => {
		const { calls, fetch } = followServer(2, [
			userMessage(1, "Hi"),
			userMessage(2, "And then?"),
			statusEvent(3, "idle", { inputSeq: 1, stopReason: "end_turn" }),
			agentMessage(4, "Hello"),
			statusEvent(5, "idle", { inputSeq: 2, stopReason: "end_turn" }),
			agentMessage(6, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu, { after: 0 })).toEqual([1, 2, 3, 4, 5]);
		expect(calls[0]?.url).toBe(
			`${BASE}/sessions/msess_1/events?after=0&limit=1`
		);
		expect(calls[1]?.headers.get("accept")).toContain("text/event-stream");
	});

	test("sessions.follow from 0 skips an earlier turn's idle and waits for the latest turn", async () => {
		const { fetch } = followServer(3, [
			userMessage(1, "First"),
			statusEvent(2, "idle", { inputSeq: 1, stopReason: "end_turn" }),
			userMessage(3, "Second"),
			agentMessage(4, "Answer"),
			statusEvent(5, "idle", { inputSeq: 3, stopReason: "end_turn" }),
			agentMessage(6, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu)).toEqual([1, 2, 3, 4, 5]);
	});

	test("sessions.follow skips the provisioned idle of a session created without a message", async () => {
		const { fetch } = followServer(2, [
			statusEvent(1, "idle", { detail: "provisioned" }),
			userMessage(2, "Hi"),
			statusEvent(3, "running", { inputSeq: 2 }),
			agentMessage(4, "Hello"),
			statusEvent(5, "idle", { inputSeq: 2, stopReason: "end_turn" }),
			agentMessage(6, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu)).toEqual([1, 2, 3, 4, 5]);
	});

	test("sessions.follow stops at the head when the latest turn is already answered", async () => {
		const { fetch } = followServer(3, [
			userMessage(1, "Hi"),
			statusEvent(2, "idle", { inputSeq: 1, stopReason: "end_turn" }),
			{ ...agentMessage(3, "usage-like trailer") },
			agentMessage(4, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu)).toEqual([1, 2, 3]);
	});

	test("sessions.follow with headSeq skips the head read", async () => {
		const { calls, fetch } = followServer(99, [
			userMessage(1, "Hi"),
			statusEvent(2, "idle", { inputSeq: 1, stopReason: "end_turn" }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu, { headSeq: 1 })).toEqual([1, 2]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}/sessions/msess_1/stream`);
	});

	test('sessions.follow with until: "terminal" reads the head and follows past idle', async () => {
		const { calls, fetch } = followServer(1, [
			userMessage(1, "Hi"),
			statusEvent(2, "idle", { inputSeq: 1, stopReason: "end_turn" }),
			statusEvent(3, "completed", { inputSeq: 1 }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu, { until: "terminal" })).toEqual([1, 2, 3]);
		expect(calls.map((call) => call.url)).toEqual([
			`${BASE}/sessions/msess_1/events?after=0&limit=1`,
			`${BASE}/sessions/msess_1/stream`,
		]);
	});
});

describe("sessions.run", () => {
	test("creates with the message, follows until the turn ends, then re-reads", async () => {
		const { calls, fetch } = stubFetch((request) => {
			if (request.method === "POST") {
				return Response.json(session("pending"), { status: 201 });
			}
			if (request.url.endsWith("/stream")) {
				return sse([
					userMessage(1, "Summarize"),
					statusEvent(2, "running"),
					agentMessage(3, "First."),
					agentMessage(4, "Second."),
					statusEvent(5, "idle", { inputSeq: 1, stopReason: "end_turn" }),
				]);
			}
			return Response.json(session("idle", "end_turn"));
		});
		const ryu = new Ryu({ env: MA_ENV, fetch, result: "object" });
		const seen: string[] = [];
		const { data, error, meta } = await ryu.managedAgents
			.with({ idempotencyKey: "run-ticket-0000001" })
			.sessions.run(
				{ agentId: "magt_1", environmentId: "menv_1", message: "Summarize" },
				{ onEvent: (event) => seen.push(event.type) }
			);
		expect(error).toBeNull();
		expect(data?.text).toBe("First.\n\nSecond.");
		expect(data?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(data?.session.status).toBe("idle");
		expect(seen).toHaveLength(5);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("run-ticket-0000001");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			agentId: "magt_1",
			environmentId: "menv_1",
			initialEvents: [
				{
					type: "user.message",
					content: [{ type: "text", text: "Summarize" }],
				},
			],
		});
		expect(calls[1]?.url).toBe(`${BASE}/sessions/msess_1/stream`);
		expect(meta?.status).toBe(200);
	});

	test('until: "terminal" keeps following past idle to the terminal status', async () => {
		const { fetch } = stubFetch((request) => {
			if (request.method === "POST") {
				return Response.json(session("pending"), { status: 201 });
			}
			if (request.url.endsWith("/stream")) {
				return sse([
					userMessage(1, "Go"),
					statusEvent(2, "idle", { inputSeq: 1, stopReason: "end_turn" }),
					statusEvent(3, "completed", { inputSeq: 1 }),
				]);
			}
			return Response.json(session("completed"));
		});
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(
			{ agentId: "magt_1", environmentId: "menv_1", message: "Go" },
			{ until: "terminal" }
		);
		expect(run.events.map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(run.session.status).toBe("completed");
		expect(run.text).toBe("");
	});

	test("its signal aborts the create request itself", async () => {
		const controller = new AbortController();
		let createSignal: AbortSignal | null = null;
		const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				createSignal = init?.signal ?? null;
				createSignal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError"))
				);
				controller.abort();
			});
		const ryu = new Ryu({ env: MA_ENV, fetch, maxRetries: 0 });
		const error = await rejection(
			ryu.managedAgents.sessions.run(
				{ agentId: "magt_1", environmentId: "menv_1", message: "Hi" },
				{ signal: controller.signal }
			)
		);
		expect(error.name).toBe("RyuAbortError");
		expect((createSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	test("a failed create rejects without streaming", async () => {
		const { calls, fetch } = stubFetch(() => maError(409, "agent_archived"));
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents.sessions.run({
				agentId: "magt_1",
				environmentId: "menv_1",
			})
		);
		expect(error.code).toBe("agent_archived");
		expect(calls).toHaveLength(1);
	});
});

describe("turn detection", () => {
	const asEvent = (value: object) => value as ManagedAgentEvent;

	test("idle ends the turn only once it covers the last input", () => {
		expect(isTurnEndEvent(asEvent(statusEvent(3, "idle")), 0)).toBe(true);
		expect(
			isTurnEndEvent(asEvent(statusEvent(3, "idle", { inputSeq: 1 })), 2)
		).toBe(false);
		expect(
			isTurnEndEvent(asEvent(statusEvent(4, "idle", { inputSeq: 2 })), 2)
		).toBe(true);
		expect(isTurnEndEvent(asEvent(statusEvent(4, "running")), 0)).toBe(false);
		expect(isTurnEndEvent(asEvent(agentMessage(4, "x")), 0)).toBe(false);
	});

	test("a provisioned idle ends the turn only before any input", () => {
		const provisioned = asEvent(
			statusEvent(2, "idle", { detail: "provisioned", inputSeq: 3 })
		);
		expect(isTurnEndEvent(provisioned, 0)).toBe(true);
		expect(isTurnEndEvent(provisioned, 3)).toBe(false);
	});

	test("without inputSeq a stop reason marks the end of a turn", () => {
		expect(
			isTurnEndEvent(
				asEvent(statusEvent(3, "idle", { stopReason: "end_turn" })),
				2
			)
		).toBe(true);
		expect(isTurnEndEvent(asEvent(statusEvent(3, "idle")), 2)).toBe(false);
	});

	test("terminal statuses", () => {
		for (const status of ["completed", "failed", "canceled"]) {
			expect(isTerminalStatusEvent(asEvent(statusEvent(1, status)))).toBe(true);
		}
		expect(isTerminalStatusEvent(asEvent(statusEvent(1, "idle")))).toBe(false);
	});
});

const TOOL_USE_ID = `mtool_${"a".repeat(32)}`;
const OTHER_TOOL_USE_ID = `mtool_${"b".repeat(32)}`;
const FUTURE = "2099-01-01T00:00:00.000Z";

function toolUse(seq: number, toolUseId = TOOL_USE_ID) {
	return {
		...envelope(seq),
		type: "agent.tool_use",
		toolUseId,
		name: "bash",
		input: { command: "rm -rf build" },
		inputTruncated: false,
		source: "builtin",
		server: null,
	};
}

function approvalRequest(
	seq: number,
	toolUseId = TOOL_USE_ID,
	expiresAt = FUTURE
) {
	return {
		...envelope(seq),
		type: "agent.tool_approval_request",
		toolUseId,
		name: "bash",
		source: "builtin",
		server: null,
		expiresAt,
	};
}

function approvalAnswer(
	seq: number,
	decision: "allow" | "deny",
	message: string | null = null,
	toolUseId = TOOL_USE_ID
) {
	return {
		...envelope(seq),
		type: "user.tool_approval",
		toolUseId,
		decision,
		message,
	};
}

function requiresAction(
	seq: number,
	pending: string[],
	inputSeq: number | null = 1
) {
	return {
		...statusEvent(seq, "idle", { inputSeq, stopReason: "requires_action" }),
		pendingToolUseIds: pending,
	};
}

/**
 * A session server for approvals: `POST /sessions` creates, `POST /events`
 * appends a `user.tool_approval` at seq 7 echoing the request body, the
 * stream serves `log`, and `GET /sessions/{id}` re-reads.
 */
function approvalServer(
	log: readonly object[],
	answer: (request: Recorded) => Response = (request) => {
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
					approvalAnswer(
						7,
						event?.decision ?? "allow",
						event?.message ?? null,
						event?.toolUseId
					),
				],
			},
			{ status: 202 }
		);
	}
) {
	return stubFetch((request) => {
		if (request.method === "POST" && request.url.endsWith("/events")) {
			return answer(request);
		}
		if (request.method === "POST") {
			return Response.json(session("pending"), { status: 201 });
		}
		if (request.url.endsWith("/stream")) {
			return sse(log);
		}
		if (request.url.includes("/events?")) {
			return eventsPage(1);
		}
		return Response.json(session("idle", "end_turn"));
	});
}

const RUN_INPUT = {
	agentId: "magt_1",
	environmentId: "menv_1",
	message: "Clean up",
};

describe("tool approvals: approveTool and denyTool", () => {
	test("approveTool appends user.tool_approval allow with a derived Idempotency-Key", async () => {
		const { calls, fetch } = approvalServer([]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const answer = await ryu.managedAgents.sessions.approveTool(
			"msess_1",
			TOOL_USE_ID
		);
		expect(answer.type).toBe("user.tool_approval");
		expect(answer.decision).toBe("allow");
		expect(answer.seq).toBe(7);
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
		const key = calls[0]?.headers.get("idempotency-key");
		expect(key).toBe(`tool-approval-allow-${TOOL_USE_ID}`);
		expect(key).toMatch(KEY_PATTERN);
	});

	test("denyTool sends the message, and a retry of the same answer sends the same key", async () => {
		const { calls, fetch } = approvalServer([]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const first = await ryu.managedAgents.sessions.denyTool(
			"msess_1",
			TOOL_USE_ID,
			{ message: "Do not delete build output." }
		);
		await ryu.managedAgents.sessions.denyTool("msess_1", TOOL_USE_ID, {
			message: "Do not delete build output.",
		});
		expect(first.decision).toBe("deny");
		expect(first.message).toBe("Do not delete build output.");
		expect(JSON.parse(calls[0]?.body ?? "{}").events[0]).toMatchObject({
			decision: "deny",
			message: "Do not delete build output.",
		});
		expect(calls[0]?.headers.get("idempotency-key")).toBe(
			toolApprovalIdempotencyKey(
				TOOL_USE_ID,
				"deny",
				"Do not delete build output."
			) ?? "missing"
		);
		expect(calls[0]?.headers.get("idempotency-key")).toMatch(
			new RegExp(`^tool-approval-deny-${TOOL_USE_ID}-m[0-9a-f]{8}$`, "u")
		);
		expect(calls[1]?.headers.get("idempotency-key")).toBe(
			calls[0]?.headers.get("idempotency-key") ?? "missing"
		);
	});

	test("an explicit idempotencyKey and a .with() key win over the derived one", async () => {
		const { calls, fetch } = approvalServer([]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		await ryu.managedAgents.sessions.approveTool("msess_1", TOOL_USE_ID, {
			idempotencyKey: "approve-explicit-0001",
		});
		await ryu.managedAgents
			.with({ idempotencyKey: "approve-bound-000001" })
			.sessions.approveTool("msess_1", TOOL_USE_ID);
		expect(calls[0]?.headers.get("idempotency-key")).toBe(
			"approve-explicit-0001"
		);
		expect(calls[1]?.headers.get("idempotency-key")).toBe(
			"approve-bound-000001"
		);
	});

	test("an already answered request is a RyuConflictError, and object mode returns it", async () => {
		const { fetch } = stubFetch(() =>
			maError(409, "tool_result_already_submitted")
		);
		const thrown = await rejection(
			new Ryu({ env: MA_ENV, fetch }).managedAgents.sessions.approveTool(
				"msess_1",
				TOOL_USE_ID
			)
		);
		expect(thrown).toBeInstanceOf(RyuConflictError);
		expect(thrown.code).toBe("tool_result_already_submitted");
		expect(thrown.idempotencyKey).toBe(`tool-approval-allow-${TOOL_USE_ID}`);
		const { data, error } = await new Ryu({
			env: MA_ENV,
			fetch,
			result: "object",
		}).managedAgents.sessions.denyTool("msess_1", TOOL_USE_ID);
		expect(data).toBeNull();
		expect(error?.code).toBe("tool_result_already_submitted");
	});

	test("toolApprovalIdempotencyKey falls back to the SDK's random key for an id that cannot form one", async () => {
		expect(toolApprovalIdempotencyKey("bad id!", "allow")).toBeUndefined();
		const { calls, fetch } = approvalServer([]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		await ryu.managedAgents.sessions.approveTool("msess_1", "bad id!");
		const key = calls[0]?.headers.get("idempotency-key") ?? "";
		expect(key).toMatch(KEY_PATTERN);
		expect(key).not.toContain("tool-approval");
	});
});

describe("tool approvals: run and follow", () => {
	test("without onToolApproval, run stops at requires_action, answers nothing and reports pendingApprovals", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			statusEvent(2, "running", { inputSeq: 1 }),
			toolUse(3),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
			agentMessage(6, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT);
		expect(run.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(run.pendingApprovals.map((request) => request.toolUseId)).toEqual([
			TOOL_USE_ID,
		]);
		expect(run.pendingApprovals[0]?.expiresAt).toBe(FUTURE);
		expect(
			calls.filter(
				(call) => call.url.endsWith("/events") && call.method === "POST"
			)
		).toHaveLength(0);
	});

	test("onToolApproval allow: the handler sees the request and the tool input, the answer is sent, and the run continues", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			toolUse(3),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
			approvalAnswer(7, "allow"),
			agentMessage(8, "Done."),
			statusEvent(9, "idle", { inputSeq: 7, stopReason: "end_turn" }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const seen: ManagedAgentToolApprovalContext[] = [];
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: (context) => {
				seen.push(context);
				return "allow";
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.sessionId).toBe("msess_1");
		expect(seen[0]?.request.name).toBe("bash");
		expect(seen[0]?.toolUse?.input).toEqual({ command: "rm -rf build" });
		const answer = calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/events")
		);
		expect(JSON.parse(answer?.body ?? "{}").events[0]).toMatchObject({
			type: "user.tool_approval",
			decision: "allow",
			toolUseId: TOOL_USE_ID,
		});
		expect(answer?.headers.get("idempotency-key")).toBe(
			`tool-approval-allow-${TOOL_USE_ID}`
		);
		expect(run.events.map((event) => event.seq)).toEqual([1, 3, 4, 5, 7, 8, 9]);
		expect(run.text).toBe("Done.");
		expect(run.pendingApprovals).toEqual([]);
	});

	test("a run's bound key goes to the create only; the answer keeps its derived key", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
			approvalAnswer(7, "allow"),
			statusEvent(9, "idle", { inputSeq: 7, stopReason: "end_turn" }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		await ryu.managedAgents
			.with({ idempotencyKey: "run-approval-000001" })
			.sessions.run(RUN_INPUT, { onToolApproval: () => "allow" });
		const posts = calls.filter((call) => call.method === "POST");
		expect(posts.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"run-approval-000001",
			`tool-approval-allow-${TOOL_USE_ID}`,
		]);
	});

	test("onToolApproval may deny with a message, asynchronously", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
			approvalAnswer(7, "deny", "Not on main."),
			statusEvent(9, "idle", { inputSeq: 7, stopReason: "end_turn" }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: async () => {
				await Promise.resolve();
				return { decision: "deny", message: "Not on main." };
			},
		});
		const answer = calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/events")
		);
		expect(JSON.parse(answer?.body ?? "{}").events[0]).toMatchObject({
			decision: "deny",
			message: "Not on main.",
		});
		expect(run.events.at(-1)?.seq).toBe(9);
	});

	test("onToolApproval returning undefined leaves the request open", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
			agentMessage(6, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: () => {
				asked += 1;
				return undefined;
			},
		});
		expect(asked).toBe(1);
		expect(run.pendingApprovals).toHaveLength(1);
		expect(calls.filter((call) => call.url.endsWith("/events"))).toHaveLength(
			0
		);
	});

	test("follow never asks about a replayed request whose answer (or timeout denial) is in the log", async () => {
		const { calls, fetch } = followServer(8, [
			userMessage(1, "Clean up"),
			approvalRequest(2),
			requiresAction(3, [TOOL_USE_ID]),
			approvalAnswer(4, "allow"),
			approvalRequest(5, OTHER_TOOL_USE_ID, "2000-01-01T00:00:00.000Z"),
			requiresAction(6, [OTHER_TOOL_USE_ID], 4),
			approvalAnswer(7, "deny", "timed out", OTHER_TOOL_USE_ID),
			statusEvent(8, "idle", { inputSeq: 7, stopReason: "end_turn" }),
			agentMessage(9, "never read"),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		expect(
			await followSeqs(ryu, {
				onToolApproval: () => {
					asked += 1;
					return "allow";
				},
			})
		).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(asked).toBe(0);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
	});

	test("an open request past its expiresAt by the local clock is still asked about (the server decides expiry)", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4, TOOL_USE_ID, "2000-01-01T00:00:00.000Z"),
			requiresAction(5, [TOOL_USE_ID]),
			approvalAnswer(7, "allow"),
			statusEvent(9, "idle", { inputSeq: 7, stopReason: "end_turn" }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: () => {
				asked += 1;
				return "allow";
			},
		});
		expect(asked).toBe(1);
		expect(
			calls.filter(
				(call) => call.method === "POST" && call.url.endsWith("/events")
			)
		).toHaveLength(1);
	});

	test('follow with onToolApproval and until: "terminal" reads the head first', async () => {
		const { calls, fetch } = followServer(2, [
			userMessage(1, "Clean up"),
			approvalRequest(2),
			requiresAction(3, [TOOL_USE_ID]),
			statusEvent(4, "canceled", { inputSeq: 1 }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		const consume = async () => {
			for await (const _event of ryu.managedAgents.sessions.follow("msess_1", {
				until: "terminal",
				onToolApproval: () => {
					asked += 1;
					return undefined;
				},
			})) {
				// drain
			}
		};
		await consume();
		expect(calls[0]?.url).toBe(
			`${BASE}/sessions/msess_1/events?after=0&limit=1`
		);
		expect(asked).toBe(1);
	});

	test("a 409 unknown_tool_use answer (expired or answered elsewhere) is not an error", async () => {
		const { fetch } = approvalServer(
			[
				userMessage(1, "Clean up"),
				approvalRequest(4),
				requiresAction(5, [TOOL_USE_ID]),
				approvalAnswer(6, "deny", "timed out"),
				statusEvent(9, "idle", { inputSeq: 6, stopReason: "end_turn" }),
			],
			() => maError(409, "unknown_tool_use")
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: () => "allow",
		});
		expect(run.events.at(-1)?.seq).toBe(9);
		expect(run.pendingApprovals).toEqual([]);
	});

	test("any other answer error fails the run", async () => {
		const { fetch } = approvalServer(
			[userMessage(1, "Clean up"), approvalRequest(4)],
			() => maError(409, "session_closed")
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents.sessions.run(RUN_INPUT, {
				onToolApproval: () => "allow",
			})
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.code).toBe("session_closed");
	});

	test("an invalid decision is a RyuConfigurationError and nothing is sent", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents.sessions.run(RUN_INPUT, {
				onToolApproval: () => "yes" as unknown as "allow",
			})
		);
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.code).toBe("invalid_tool_approval_decision");
		expect(calls.filter((call) => call.url.endsWith("/events"))).toHaveLength(
			0
		);
	});

	test("without inputSeq (an older server), a requires_action idle this follow answered does not end the turn", async () => {
		const { fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID], null),
			agentMessage(8, "Done."),
			statusEvent(9, "idle", { stopReason: "end_turn" }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: () => "allow",
		});
		expect(run.text).toBe("Done.");
	});
});

/**
 * A log server for resumed follows: `GET /events?types=…` pages the log
 * filtered to those types, `GET /events?…limit=1` answers `head`, the stream
 * serves the log after `Last-Event-ID`, and `POST /events` appends the answer
 * at `head + 1`.
 */
function logServer(
	log: readonly { seq: number; type: string }[],
	head: number,
	answer?: (request: Recorded) => Response
) {
	return stubFetch((request) => {
		const url = new URL(request.url);
		if (request.method === "POST") {
			if (answer) {
				return answer(request);
			}
			const sent = JSON.parse(request.body ?? "{}") as {
				events: { decision: "allow" | "deny"; toolUseId: string }[];
			};
			const [event] = sent.events;
			return Response.json(
				{
					data: [
						approvalAnswer(
							head + 1,
							event?.decision ?? "allow",
							null,
							event?.toolUseId
						),
					],
				},
				{ status: 202 }
			);
		}
		if (url.pathname.endsWith("/stream")) {
			const after = Number(request.headers.get("last-event-id") ?? "0");
			return sse(log.filter((event) => event.seq > after));
		}
		const types = url.searchParams.get("types");
		if (types !== null) {
			const wanted = new Set(types.split(","));
			const after = Number(url.searchParams.get("after") ?? "0");
			const data = log.filter(
				(event) => event.seq > after && wanted.has(event.type)
			);
			return Response.json({
				data,
				hasMore: false,
				nextAfter: data.at(-1)?.seq ?? after,
				headSeq: head,
			});
		}
		return eventsPage(head);
	});
}

describe("tool approvals: stopping and resuming", () => {
	test('without onToolApproval, until: "terminal" stops at the requires_action idle and reports the request', async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			toolUse(3),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
			approvalAnswer(6, "deny", "timed out"),
			statusEvent(8, "completed", { inputSeq: 6 }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			until: "terminal",
		});
		expect(run.events.map((event) => event.seq)).toEqual([1, 3, 4, 5]);
		expect(run.pendingApprovals.map((request) => request.toolUseId)).toEqual([
			TOOL_USE_ID,
		]);
		expect(
			calls.some(
				(call) => call.method === "POST" && call.url.endsWith("/events")
			)
		).toBe(false);
	});

	test('until: "terminal" ignores a replayed requires_action idle that was answered later', async () => {
		const { fetch } = followServer(7, [
			userMessage(1, "Clean up"),
			approvalRequest(2),
			requiresAction(3, [TOOL_USE_ID]),
			approvalAnswer(4, "allow"),
			statusEvent(5, "running", { inputSeq: 4 }),
			statusEvent(6, "idle", { inputSeq: 4, stopReason: "end_turn" }),
			statusEvent(7, "completed", { inputSeq: 4 }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu, { until: "terminal" })).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		]);
	});

	test('a handler that returns undefined stops an until: "terminal" follow at the requires_action idle', async () => {
		const { fetch } = followServer(1, [
			userMessage(1, "Clean up"),
			approvalRequest(2),
			requiresAction(3, [TOOL_USE_ID]),
			statusEvent(4, "canceled", { inputSeq: 1 }),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		expect(
			await followSeqs(ryu, {
				until: "terminal",
				onToolApproval: () => {
					asked += 1;
					return undefined;
				},
			})
		).toEqual([1, 2, 3]);
		expect(asked).toBe(1);
	});

	test("follow({ after: head, onToolApproval }) answers a request opened before after", async () => {
		const { calls, fetch } = logServer(
			[
				userMessage(1, "Clean up"),
				toolUse(2),
				approvalRequest(3),
				requiresAction(4, [TOOL_USE_ID]),
				approvalAnswer(5, "allow"),
				agentMessage(6, "Done."),
				statusEvent(7, "idle", { inputSeq: 5, stopReason: "end_turn" }),
			],
			4
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const seen: ManagedAgentToolApprovalContext[] = [];
		const seqs = await followSeqs(ryu, {
			after: 4,
			onToolApproval: (context) => {
				seen.push(context);
				return "allow";
			},
		});
		expect(seen.map((context) => context.request.seq)).toEqual([3]);
		expect(seen[0]?.toolUse?.input).toEqual({ command: "rm -rf build" });
		expect(seqs).toEqual([5, 6, 7]);
		const seed = new URL(calls[0]?.url ?? "");
		expect(seed.searchParams.get("types")?.split(",")).toContain(
			"agent.tool_approval_request"
		);
		expect(
			calls
				.filter((call) => call.method === "POST")
				.map((call) => call.headers.get("idempotency-key"))
		).toEqual([`tool-approval-allow-${TOOL_USE_ID}`]);
	});

	test("follow with after between the request and the head still asks about it", async () => {
		const { fetch } = logServer(
			[
				userMessage(1, "Clean up"),
				approvalRequest(2),
				requiresAction(3, [TOOL_USE_ID]),
				approvalAnswer(4, "deny"),
				statusEvent(5, "idle", { inputSeq: 4, stopReason: "end_turn" }),
			],
			3
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		const seqs = await followSeqs(ryu, {
			after: 2,
			onToolApproval: () => {
				asked += 1;
				return "deny";
			},
		});
		expect(asked).toBe(1);
		expect(seqs).toEqual([3, 4, 5]);
	});

	test("follow({ after: head }) without a handler stops at once when an approval waits", async () => {
		const { calls, fetch } = logServer(
			[
				userMessage(1, "Clean up"),
				approvalRequest(2),
				requiresAction(3, [TOOL_USE_ID]),
			],
			3
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		expect(await followSeqs(ryu, { after: 3, until: "terminal" })).toEqual([]);
		expect(calls.some((call) => call.url.endsWith("/stream"))).toBe(false);
	});

	test("a seeded request abandoned by an interrupted idle is not asked about", async () => {
		const { fetch } = logServer(
			[
				userMessage(1, "Clean up"),
				approvalRequest(2),
				requiresAction(3, [TOOL_USE_ID]),
				{ ...envelope(4), type: "user.interrupt" },
				statusEvent(5, "idle", { inputSeq: 4, stopReason: "interrupted" }),
				userMessage(6, "Something else"),
				statusEvent(7, "idle", { inputSeq: 6, stopReason: "end_turn" }),
			],
			5
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		let asked = 0;
		expect(
			await followSeqs(ryu, {
				after: 5,
				onToolApproval: () => {
					asked += 1;
					return "allow";
				},
			})
		).toEqual([6, 7]);
		expect(asked).toBe(0);
	});
});

describe("tool approvals: answer keys and errors", () => {
	test("a derived key that gets 409 unknown_tool_use is retried once with a fresh key", async () => {
		const { calls, fetch } = approvalServer([], (request) =>
			request.headers.get("idempotency-key")?.startsWith("tool-approval-")
				? maError(409, "unknown_tool_use", { "Idempotent-Replayed": "true" })
				: Response.json({ data: [approvalAnswer(7, "allow")] }, { status: 202 })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const answer = await ryu.managedAgents.sessions.approveTool(
			"msess_1",
			TOOL_USE_ID
		);
		expect(answer.seq).toBe(7);
		const keys = calls.map((call) => call.headers.get("idempotency-key"));
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(`tool-approval-allow-${TOOL_USE_ID}`);
		expect(keys[1]).toMatch(KEY_PATTERN);
		expect(keys[1]).not.toBe(keys[0]);
	});

	test("a genuinely unknown id fails after the one retry; an explicit key is never retried", async () => {
		const { calls, fetch } = stubFetch(() => maError(409, "unknown_tool_use"));
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(
			ryu.managedAgents.sessions.denyTool("msess_1", TOOL_USE_ID)
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.code).toBe("unknown_tool_use");
		expect(calls).toHaveLength(2);
		await rejection(
			ryu.managedAgents.sessions.denyTool("msess_1", TOOL_USE_ID, {
				idempotencyKey: "deny-explicit-000001",
			})
		);
		expect(calls).toHaveLength(3);
	});

	test("the derived key covers the message: same message, same key; another message, another key", () => {
		const plain = toolApprovalIdempotencyKey(TOOL_USE_ID, "deny");
		const first = toolApprovalIdempotencyKey(TOOL_USE_ID, "deny", "No.");
		expect(plain).toBe(`tool-approval-deny-${TOOL_USE_ID}`);
		expect(first).toBe(toolApprovalIdempotencyKey(TOOL_USE_ID, "deny", "No."));
		expect(first).not.toBe(
			toolApprovalIdempotencyKey(TOOL_USE_ID, "deny", "Not on main.")
		);
		expect(first).not.toBe(plain);
		expect(first).toMatch(KEY_PATTERN);
	});

	test("respondToApproval sends the same derived key as approveTool / denyTool", async () => {
		const { calls, fetch } = approvalServer([]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const answer = await ryu.managedAgents.sessions.respondToApproval(
			"msess_1",
			TOOL_USE_ID,
			"deny",
			{ message: "No." }
		);
		expect(answer.type).toBe("user.tool_approval");
		expect(calls[0]?.headers.get("idempotency-key")).toBe(
			toolApprovalIdempotencyKey(TOOL_USE_ID, "deny", "No.") ?? "missing"
		);
	});

	test("in a follow, 409 idempotency_key_reused counts as already answered", async () => {
		const { fetch } = approvalServer(
			[
				userMessage(1, "Clean up"),
				approvalRequest(4),
				requiresAction(5, [TOOL_USE_ID]),
				approvalAnswer(6, "deny", "other message"),
				statusEvent(9, "idle", { inputSeq: 6, stopReason: "end_turn" }),
			],
			() => maError(409, "idempotency_key_reused")
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const run = await ryu.managedAgents.sessions.run(RUN_INPUT, {
			onToolApproval: () => ({ decision: "deny", message: "mine" }),
		});
		expect(run.events.at(-1)?.seq).toBe(9);
	});

	test("a handler that throws fails the run with tool_approval_handler_failed and keeps the cause", async () => {
		const { calls, fetch } = approvalServer([
			userMessage(1, "Clean up"),
			approvalRequest(4),
			requiresAction(5, [TOOL_USE_ID]),
		]);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const cause = new TypeError("prompt is not a function");
		const error = await rejection(
			ryu.managedAgents.sessions.run(RUN_INPUT, {
				onToolApproval: () => {
					throw cause;
				},
			})
		);
		expect(error.code).toBe("tool_approval_handler_failed");
		expect(error.message).toContain("prompt is not a function");
		expect(error.cause).toBe(cause);
		expect(
			calls.some(
				(call) => call.method === "POST" && call.url.endsWith("/events")
			)
		).toBe(false);
	});
});

describe("pendingToolApprovals", () => {
	const asEvents = (values: object[]) => values as ManagedAgentEvent[];

	test("drops answered requests", () => {
		expect(
			pendingToolApprovals(
				asEvents([
					approvalRequest(1),
					approvalRequest(2, OTHER_TOOL_USE_ID),
					approvalAnswer(3, "allow"),
				])
			).map((request) => request.toolUseId)
		).toEqual([OTHER_TOOL_USE_ID]);
	});

	test("an interrupt alone abandons nothing; the interrupted idle that answers it does", () => {
		const interrupt = { ...envelope(2), type: "user.interrupt" };
		expect(
			pendingToolApprovals(asEvents([approvalRequest(1), interrupt])).map(
				(request) => request.toolUseId
			)
		).toEqual([TOOL_USE_ID]);
		// An interrupted idle that still lists pending ids, or answers another input, keeps it.
		expect(
			pendingToolApprovals(
				asEvents([
					approvalRequest(1),
					interrupt,
					{
						...statusEvent(3, "idle", {
							inputSeq: 2,
							stopReason: "interrupted",
						}),
						pendingToolUseIds: [TOOL_USE_ID],
					},
					statusEvent(4, "idle", { inputSeq: 9, stopReason: "interrupted" }),
				])
			)
		).toHaveLength(1);
		expect(
			pendingToolApprovals(
				asEvents([
					approvalRequest(1),
					interrupt,
					statusEvent(3, "idle", { inputSeq: 2, stopReason: "interrupted" }),
					approvalRequest(4, OTHER_TOOL_USE_ID),
				])
			).map((request) => request.toolUseId)
		).toEqual([OTHER_TOOL_USE_ID]);
	});
});
