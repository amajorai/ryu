import { describe, expect, test } from "bun:test";
import type { RyuRetryEvent } from "../config.ts";
import {
	isRyuError,
	messageWithoutHint,
	RyuAuthenticationError,
	RyuConfigurationError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuPaymentRequiredError,
	RyuPermissionError,
	RyuRateLimitError,
	RyuServerError,
	RyuUnavailableError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { CONNECT_ROUTES, CONNECT_SDK_ROUTES } from "./routes.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

type Respond = (request: Recorded) => Response | Promise<Response>;

function stubFetch(respond: Respond) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

const TOKEN = "connect_runtime_secret_0001";
const ENV = {
	RYU_CONNECT_API_KEY: TOKEN,
	RYU_CONNECT_URL: "http://127.0.0.1:8094",
};

function connectError(
	status: number,
	body: Record<string, unknown>,
	headers: Record<string, string> = {}
): Response {
	return Response.json(body, {
		headers: { "x-request-id": "req_connect_1", ...headers },
		status,
	});
}

async function rejection(promise: PromiseLike<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to reject");
}

const REPORT_PAGE_1 = {
	from: "2026-10-01T00:00:00.000Z",
	lines: [
		{
			at: "2026-10-01T09:14:03.120Z",
			transactionId: "log_a",
			usage: { kind: "toolCall" },
		},
	],
	nextCursor: "c1",
	ok: true,
	to: "2026-10-02T00:00:00.000Z",
	type: "usage.report",
	unresolved: [
		{
			at: "2026-10-01T08:00:00.000Z",
			reason: "expired",
			transactionId: "log_x",
		},
	],
};

const REPORT_PAGE_2 = {
	...REPORT_PAGE_1,
	lines: [
		{
			at: "2026-10-01T10:00:00.000Z",
			transactionId: "log_b",
			usage: { kind: "toolCall" },
		},
	],
	nextCursor: null,
	unresolved: [],
};

/** A Connect runtime stub routed by `METHOD /path`. */
function connectServer(): Respond {
	return (request) => {
		const url = new URL(request.url);
		switch (`${request.method} ${url.pathname}`) {
			case "GET /v1/skills":
				return Response.json({
					data: [
						{
							description: "Review identity boundaries",
							id: "passport-review",
							name: "passport-review",
						},
					],
					object: "list",
				});
			case "GET /v1/skills/passport%20review":
				return Response.json({
					description: "d",
					id: "passport review",
					instructions: "# Passport review\n",
					name: "passport review",
				});
			case "GET /v1/tools/search":
				return Response.json({
					data: [
						{
							description: "Echo input",
							id: "remote.echo",
							kind: "mcp",
							name: "remote.echo",
						},
					],
					object: "list",
					partial: true,
				});
			case "GET /v1/tools/describe":
				return Response.json({
					description: "Echo input",
					id: url.searchParams.get("id"),
					kind: "mcp",
					name: url.searchParams.get("id"),
					parameters: { type: "object" },
				});
			case "POST /v1/exec/tool":
				return Response.json({
					ok: true,
					result: { content: [{ text: "hi", type: "text" }] },
				});
			case "POST /v1/composio/execute":
				return Response.json({
					billingReceipt: { transactionId: "log_c" },
					data: { ok: true },
					successful: true,
				});
			case "GET /v1/usage":
				return Response.json(
					url.searchParams.get("cursor") === "c1"
						? REPORT_PAGE_2
						: REPORT_PAGE_1
				);
			default:
				return connectError(404, {
					code: "not_found",
					error: "Connect route not found",
					ok: false,
				});
		}
	};
}

describe("Connect routes", () => {
	test("no route is idempotent", () => {
		expect(CONNECT_ROUTES).toEqual({
			service: "connect",
			mount: "",
			idempotent: [],
		});
	});

	test("CONNECT_SDK_ROUTES lists every route the client calls", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		await ryu.connect.skills.list();
		await ryu.connect.skills.get("passport review");
		await ryu.connect.tools.search({ q: "echo" });
		await ryu.connect.tools.describe({ toolId: "remote.echo" });
		await ryu.connect.tools.exec({ toolId: "remote.echo" });
		await ryu.connect.composio.execute({ toolId: "SLACK_SEND_MESSAGE" });
		await ryu.connect.usage({
			from: "2026-10-01T00:00:00Z",
			to: "2026-10-02T00:00:00Z",
		});
		expect(
			calls.map((call) => ({
				method: call.method,
				path: new URL(call.url).pathname.replace(
					"/v1/skills/passport%20review",
					"/v1/skills/{skillId}"
				),
			}))
		).toEqual([...CONNECT_SDK_ROUTES]);
	});
});

describe("Connect requests", () => {
	test("every request carries the runtime bearer and no Idempotency-Key", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		await ryu.connect.skills.list();
		await ryu.connect.tools.exec({
			arguments: { message: "hi" },
			toolId: "remote.echo",
		});
		await ryu.connect.composio.execute({
			body: { channel: "#general", text: "hi" },
			toolId: "SLACK_SEND_MESSAGE",
		});
		await ryu.connect
			.with({ idempotencyKey: "caller-key" })
			.tools.exec({ toolId: "remote.echo" });
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
			expect(call.headers.get("idempotency-key")).toBeNull();
		}
	});

	test("skills, search and describe send the documented query", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		const skills = await ryu.connect.skills.list();
		expect(skills.data[0]?.id).toBe("passport-review");
		const skill = await ryu.connect.skills.get("passport review");
		expect(skill.instructions).toContain("# Passport review");
		const found = await ryu.connect.tools.search({
			kind: "mcp",
			limit: 5,
			q: "send a Slack message",
		});
		expect(found.partial).toBe(true);
		expect(found.data[0]?.id).toBe("remote.echo");
		const described = await ryu.connect.tools.describe({
			toolId: "remote.echo",
		});
		expect(described.parameters).toEqual({ type: "object" });
		expect(calls[1]?.url).toBe(
			"http://127.0.0.1:8094/v1/skills/passport%20review"
		);
		expect(new URL(calls[2]?.url ?? "").searchParams.toString()).toBe(
			"kind=mcp&limit=5&q=send+a+Slack+message"
		);
		expect(new URL(calls[3]?.url ?? "").searchParams.get("id")).toBe(
			"remote.echo"
		);
	});

	test("exec sends tool_id, arguments and kind tool", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		const result = await ryu.connect.tools.exec({
			arguments: { message: "REST" },
			toolId: "remote.echo",
		});
		expect(result.ok).toBe(true);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			arguments: { message: "REST" },
			kind: "tool",
			tool_id: "remote.echo",
		});
	});

	test("exec decodes the Gateway's 200 { ok: false, error } refusal", async () => {
		// Compatibility mode: apps/gateway/src/tools/exec.rs ExecToolResponse::err.
		const { calls, fetch } = stubFetch(() =>
			Response.json({
				error: "tool call denied (firewall Secret: aws)",
				ok: false,
			})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const refused = await ryu.connect.tools.exec({ toolId: "remote.echo" });
		expect(refused).toEqual({
			error: "tool call denied (firewall Secret: aws)",
			ok: false,
		});
		expect(refused.result).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	test("composio.execute sends the native body only", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		const executed = await ryu.connect.composio.execute({
			body: { channel: "#general", text: "hi" },
			expectedAccountId: "ca_123",
			toolId: "SLACK_SEND_MESSAGE",
		});
		expect(executed.successful).toBe(true);
		expect(executed.billingReceipt).toEqual({ transactionId: "log_c" });
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			body: { channel: "#general", text: "hi" },
			expectedAccountId: "ca_123",
			operation: "execute",
			toolId: "SLACK_SEND_MESSAGE",
		});
		await ryu.connect.composio.execute({ toolId: "GITHUB_GET_USER" });
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			operation: "execute",
			toolId: "GITHUB_GET_USER",
		});
	});

	test("usage reads one page; usage.iterate follows nextCursor", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		const window = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
		const page = await ryu.connect.usage({ ...window, limit: 1 });
		expect(page.nextCursor).toBe("c1");
		expect(page.unresolved).toHaveLength(1);
		const lines: string[] = [];
		for await (const line of ryu.connect.usage.iterate({
			...window,
			limit: 1,
		})) {
			lines.push(line.transactionId);
		}
		expect(lines).toEqual(["log_a", "log_b"]);
		expect(calls.map((call) => new URL(call.url).search)).toEqual([
			"?from=2026-10-01T00%3A00%3A00Z&limit=1&to=2026-10-02T00%3A00%3A00Z",
			"?from=2026-10-01T00%3A00%3A00Z&limit=1&to=2026-10-02T00%3A00%3A00Z",
			"?cursor=c1&from=2026-10-01T00%3A00%3A00Z&limit=1&to=2026-10-02T00%3A00%3A00Z",
		]);
		const first = await ryu.connect.usage
			.iterate({ ...window, maxItems: 1 })
			.collect();
		expect(first.map((line) => line.transactionId)).toEqual(["log_a"]);
	});

	test("usage() and usage.iterate() without a window name from and to before any request", async () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({ env: ENV, fetch });
		const usage = ryu.connect.usage as unknown as (
			query?: unknown
		) => Promise<unknown>;
		const error = await rejection(usage());
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.details).toEqual({ missing: ["from", "to"] });
		expect(
			(await rejection(usage({ from: "2026-10-01T00:00:00Z" }))).details
		).toEqual({ missing: ["to"] });
		const iterate = ryu.connect.usage.iterate as unknown as (
			query?: unknown
		) => AsyncIterable<unknown>;
		const drain = async () => {
			for await (const _line of iterate()) {
				// unreachable: the window is refused first
			}
		};
		await expect(drain()).rejects.toBeInstanceOf(RyuInvalidRequestError);
		await expect(
			rejection(ryu.connect.skills.get(".."))
		).resolves.toBeInstanceOf(RyuInvalidRequestError);
		expect(calls).toHaveLength(0);
	});

	test("mcp() points at /mcp with the bearer and makes no fetch call", () => {
		const { calls, fetch } = stubFetch(connectServer());
		const ryu = new Ryu({
			env: { ...ENV, RYU_CONNECT_URL: "https://connect.example.com/" },
			fetch,
		});
		expect(ryu.connect.mcp()).toEqual({
			headers: { Authorization: `Bearer ${TOKEN}` },
			type: "http",
			url: "https://connect.example.com/mcp",
		});
		expect(calls).toHaveLength(0);
	});

	test("mcp() throws a config error synchronously, in both result modes", () => {
		expect(() => new Ryu({ env: {} }).connect.mcp()).toThrow(
			RyuConfigurationError
		);
		expect(() => new Ryu({ env: {}, result: "object" }).connect.mcp()).toThrow(
			RyuConfigurationError
		);
	});

	test("Connect has no default URL", async () => {
		const ryu = new Ryu({ env: { RYU_CONNECT_API_KEY: TOKEN } });
		const error = await rejection(ryu.connect.skills.list());
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({ missing: ["RYU_CONNECT_URL"] });
	});
});

describe("Connect errors", () => {
	test("{ code, error, ok: false } maps code, message and the request id", async () => {
		const { fetch } = stubFetch(() =>
			connectError(401, {
				code: "unauthorized",
				error: "Bearer API token required",
				ok: false,
			})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(ryu.connect.skills.list());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.code).toBe("unauthorized");
		expect(messageWithoutHint(error)).toBe("Bearer API token required");
		expect(error.requestId).toBe("req_connect_1");
		expect(error.envelope).toBe("code-error");
	});

	test("a bare { code } maps to its code with a human message from the code table", async () => {
		const { fetch } = stubFetch(() =>
			connectError(403, { code: "tool_denied" })
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(
			ryu.connect.tools.describe({ toolId: "composio.X" })
		);
		expect(error).toBeInstanceOf(RyuPermissionError);
		expect(error.code).toBe("tool_denied");
		expect(messageWithoutHint(error)).toBe(
			"That tool (or its account) is not granted to this tenant."
		);
		// The message and the hint agree: a grant, not the key, is missing.
		expect(error.hint).toContain("a different key will not help");
		expect(error.envelope).toBe("code-error");
	});

	test("a 403 grant denial hints at the operator's grants, not the key's scopes", async () => {
		for (const [code, grant] of [
			["tool_denied", "that tool (or its account)"],
			["toolkit_denied", "that toolkit"],
			["connection_denied", "that Composio connection"],
		] as const) {
			const { fetch } = stubFetch(() =>
				connectError(403, {
					code,
					error: "The tool or account is not granted to this tenant",
					ok: false,
				})
			);
			const ryu = new Ryu({ env: ENV, fetch });
			const error = await rejection(
				ryu.connect.tools.exec({
					toolId: "composio.SLACK_SEND_MESSAGE",
					arguments: {},
				})
			);
			expect(error).toBeInstanceOf(RyuPermissionError);
			expect(error.code).toBe(code);
			expect(error.hint).toBe(
				`This Connect has not granted ${grant} to your tenant; Connect's tool search lists what it grants. The operator sets grants where Connect runs (allowedTools in RYU_CONNECT_MCP_SERVERS, or RYU_CONNECT_COMPOSIO_BINDINGS); a different key will not help.`
			);
			expect(error.docs).toBe(
				"https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"
			);
			expect(error.hint).not.toContain("scopes");
			expect(error.message).not.toContain(TOKEN);
		}
	});

	test("another Connect 403 gets no key-and-scopes hint", async () => {
		const { fetch } = stubFetch(() =>
			connectError(403, { code: "forbidden", error: "Forbidden", ok: false })
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(ryu.connect.skills.list());
		expect(error).toBeInstanceOf(RyuPermissionError);
		expect(error.hint).toBeNull();
	});

	test("retryAfterSeconds maps from the body", async () => {
		const { calls, fetch } = stubFetch(() =>
			connectError(
				429,
				{
					code: "rate_limited",
					error: "Composio call limit reached",
					ok: false,
					retryAfterSeconds: 120,
				},
				{ "retry-after": "120" }
			)
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetryDelayMs: 1000 });
		const error = await rejection(
			ryu.connect.composio.execute({ toolId: "SLACK_SEND_MESSAGE" })
		);
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.retryAfterSeconds).toBe(120);
		expect(calls).toHaveLength(1);
		const bodyOnly = stubFetch(() =>
			connectError(402, {
				code: "spend_limit_reached",
				error: "Premium spend cap reached",
				ok: false,
				retryAfterSeconds: 3600,
			})
		);
		const capped = await rejection(
			new Ryu({ env: ENV, fetch: bodyOnly.fetch }).connect.tools.exec({
				toolId: "composio.X",
			})
		);
		expect(capped).toBeInstanceOf(RyuPaymentRequiredError);
		expect(capped.retryAfterSeconds).toBe(3600);
		expect(capped.retryable).toBe(false);
		expect(bodyOnly.calls).toHaveLength(1);
	});

	test("a 502 on exec is not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			connectError(502, {
				code: "request_failed",
				error: "Connect request failed",
				ok: false,
			})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(
			ryu.connect.tools.exec({ toolId: "remote.echo" })
		);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.code).toBe("request_failed");
		expect(error.attempts).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test("execute is not retried on a 503 or a network failure", async () => {
		const unavailable = stubFetch(() =>
			connectError(503, { code: "provider_unavailable", ok: false })
		);
		const ryu = new Ryu({ env: ENV, fetch: unavailable.fetch });
		const error = await rejection(
			ryu.connect.composio.execute({ toolId: "SLACK_SEND_MESSAGE" })
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(unavailable.calls).toHaveLength(1);
		const offline = stubFetch(() => {
			throw new TypeError("connection reset");
		});
		const lost = await rejection(
			new Ryu({ env: ENV, fetch: offline.fetch }).connect.tools.exec({
				toolId: "remote.echo",
			})
		);
		expect(lost.code).toBe("connection_error");
		expect(offline.calls).toHaveLength(1);
	});

	test("reads are retried on a 5xx", async () => {
		let attempt = 0;
		const { calls, fetch } = stubFetch(() => {
			attempt += 1;
			return attempt === 1
				? connectError(503, { code: "tool_unavailable", ok: false })
				: Response.json({ data: [], object: "list" });
		});
		const retries: RyuRetryEvent[] = [];
		const ryu = new Ryu({
			env: ENV,
			fetch,
			hooks: { onRetry: (event) => retries.push(event) },
		});
		await ryu.connect.skills.list();
		expect(calls).toHaveLength(2);
		expect(retries[0]?.code).toBe("tool_unavailable");
	});

	test("configuration 503s are never retried, even on reads", async () => {
		const { calls, fetch } = stubFetch(() =>
			connectError(503, { code: "skills_unavailable", ok: false })
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const { error } = await ryu.connect.skills.list();
		expect(error?.code).toBe("skills_unavailable");
		expect(error?.retryable).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("400 invalid_request and 404 not_found map to their subclasses", async () => {
		const { fetch } = stubFetch((request) =>
			request.url.includes("/v1/usage")
				? connectError(400, {
						code: "invalid_request",
						error: "from must fall on a whole hour",
						ok: false,
					})
				: connectError(404, {
						code: "not_found",
						error: "Skill not found",
						ok: false,
					})
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const usage = await ryu.connect.usage({
			from: "2026-10-01T00:30:00Z",
			to: "2026-10-02T00:00:00Z",
		});
		expect(usage.error).toBeInstanceOf(RyuInvalidRequestError);
		expect(usage.error?.message).toBe("from must fall on a whole hour");
		const skill = await ryu.connect.skills.get("missing");
		expect(skill.error).toBeInstanceOf(RyuNotFoundError);
		expect(skill.error?.requestId).toBe("req_connect_1");
	});
});
