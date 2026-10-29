import { describe, expect, expectTypeOf, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RyuRetryEvent } from "../config.ts";
import {
	isRyuError,
	messageWithoutHint,
	RyuAuthenticationError,
	RyuConfigurationError,
	RyuConflictError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuPaymentRequiredError,
	RyuPermissionError,
	RyuRateLimitError,
	RyuResponseValidationError,
	RyuServerError,
	RyuUnavailableError,
} from "../errors.ts";
import type { RyuResult } from "../result.ts";
import { Ryu } from "../ryu.ts";
import { untilDone } from "./client.ts";
import {
	type GatewayChatCompletion,
	type GatewayChatCompletionChunk,
	gatewayUpstreamStatus,
	refineGatewayError,
} from "./namespace.ts";
import { GATEWAY_ROUTES, GATEWAY_SDK_ROUTES } from "./routes.ts";

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

const TOKEN = "gw_relay_secret_0123456789";
const ENV = { RYU_GATEWAY_TOKEN: TOKEN };

/** The JSON envelope `GatewayError::into_response` writes (apps/gateway/src/error.rs). */
function gatewayError(
	status: number,
	code: string,
	message: string,
	extra: {
		retryAfter?: number;
		resetAt?: number;
		upstreamStatus?: number;
	} = {},
	headers: Record<string, string> = {}
): Response {
	const error: Record<string, unknown> = { code, message, type: code };
	if (extra.retryAfter !== undefined) {
		error.retry_after = extra.retryAfter;
	}
	if (extra.resetAt !== undefined) {
		error.reset_at = extra.resetAt;
	}
	if (extra.upstreamStatus !== undefined) {
		error.upstream_status = extra.upstreamStatus;
	}
	return Response.json({ error }, { headers, status });
}

const COMPLETION = {
	choices: [
		{
			finish_reason: "stop",
			index: 0,
			message: { content: "Hello there.", role: "assistant" },
		},
	],
	created: 1_790_000_000,
	id: "chatcmpl-1",
	model: "openai/gpt-4o-mini",
	object: "chat.completion",
	usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 },
};

function chunk(content: string | null, finish: string | null = null) {
	return {
		choices: [
			{
				delta: content === null ? {} : { content },
				finish_reason: finish,
				index: 0,
			},
		],
		id: "chatcmpl-1",
		model: "openai/gpt-4o-mini",
		object: "chat.completion.chunk",
	};
}

function sseBody(parts: readonly string[]): {
	body: ReadableStream<Uint8Array>;
	cancelled: () => boolean;
} {
	const encoder = new TextEncoder();
	let index = 0;
	let wasCancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const part = parts[index];
			index += 1;
			if (part === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(part));
		},
		cancel() {
			wasCancelled = true;
		},
	});
	return { body, cancelled: () => wasCancelled };
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

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) {
		items.push(item);
	}
	return items;
}

describe("Gateway routes", () => {
	test("no route is idempotent, so no POST carries a key or is replayed", () => {
		expect(GATEWAY_ROUTES).toEqual({
			service: "gateway",
			mount: "",
			idempotent: [],
		});
	});

	test("GATEWAY_SDK_ROUTES lists every route the client calls", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/health") {
				return Response.json({ status: "ok", version: "1.2.3" });
			}
			if (path === "/v1/auth/status") {
				return Response.json({
					admin: false,
					authenticated: true,
					trustedForwarder: false,
				});
			}
			if (path === "/v1/models") {
				return Response.json({ data: [], object: "list" });
			}
			if (path === "/v1/embeddings") {
				return Response.json({ data: [], object: "list" });
			}
			return Response.json(COMPLETION);
		});
		const ryu = new Ryu({ env: ENV, fetch });
		await ryu.gateway.health();
		await ryu.gateway.auth.status();
		await ryu.gateway.models.list();
		await ryu.gateway.chat.completions.create({
			messages: [{ content: "hi", role: "user" }],
			model: "m",
		});
		await ryu.gateway.embeddings.create({ input: "x", model: "e" });
		expect(
			calls.map((call) => ({
				method: call.method,
				path: new URL(call.url).pathname,
			}))
		).toEqual([...GATEWAY_SDK_ROUTES]);
	});
});

describe("Gateway requests", () => {
	test("defaults to the local Gateway and sends the token as a bearer", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ data: [{ id: "openai/gpt-4o-mini" }], object: "list" })
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const models = await ryu.gateway.models.list();
		expect(models.data[0]?.id).toBe("openai/gpt-4o-mini");
		expect(calls[0]?.url).toBe("http://127.0.0.1:7981/v1/models");
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("RYU_GATEWAY_URL wins over the default; no token sends no credential", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ status: "ok", version: "1.2.3" })
		);
		const ryu = new Ryu({
			env: { RYU_GATEWAY_URL: "http://gateway.example.com:9000/" },
			fetch,
		});
		const health = await ryu.gateway.health();
		expect(health).toEqual({ status: "ok", version: "1.2.3" });
		expect(calls[0]?.url).toBe("http://gateway.example.com:9000/health");
		expect(calls[0]?.headers.get("authorization")).toBeNull();
	});

	test("chat completions send the body with stream false and decode the reply", async () => {
		const { calls, fetch } = stubFetch(() => Response.json(COMPLETION));
		const ryu = new Ryu({ env: ENV, fetch });
		const completion = await ryu.gateway.chat.completions.create({
			messages: [{ content: "hi", role: "user" }],
			model: "openai/gpt-4o-mini",
			temperature: 0.2,
		});
		expect(completion.choices[0]?.message.content).toBe("Hello there.");
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			messages: [{ content: "hi", role: "user" }],
			model: "openai/gpt-4o-mini",
			stream: false,
			temperature: 0.2,
		});
		expect(calls[0]?.headers.get("content-type")).toBe("application/json");
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("embeddings and auth status decode", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/v1/embeddings")
				? Response.json({
						data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
						model: "openai/text-embedding-3-small",
						object: "list",
					})
				: Response.json({
						admin: true,
						authenticated: true,
						trustedForwarder: false,
					})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const embedded = await ryu.gateway.embeddings.create({
			input: ["a", "b"],
			model: "openai/text-embedding-3-small",
		});
		expect(embedded.data[0]?.embedding).toEqual([0.1, 0.2]);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			input: ["a", "b"],
			model: "openai/text-embedding-3-small",
		});
		expect((await ryu.gateway.auth.status()).admin).toBe(true);
	});

	test("a malformed 2xx body is a RyuResponseValidationError", async () => {
		const { fetch } = stubFetch(() => Response.json({ object: "list" }));
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(ryu.gateway.models.list());
		expect(error).toBeInstanceOf(RyuResponseValidationError);
	});

	test("openAICompatible makes no fetch call", () => {
		const { calls, fetch } = stubFetch(() => Response.json({}));
		const ryu = new Ryu({
			env: { ...ENV, RYU_GATEWAY_URL: "http://127.0.0.1:7981/" },
			fetch,
		});
		expect(ryu.gateway.openAICompatible()).toEqual({
			apiKey: TOKEN,
			baseURL: "http://127.0.0.1:7981/v1",
		});
		expect(new Ryu({ env: {}, fetch }).gateway.openAICompatible()).toEqual({
			apiKey: "",
			baseURL: "http://127.0.0.1:7981/v1",
		});
		expect(
			new Ryu({ env: ENV, fetch, result: "object" }).gateway.openAICompatible()
		).toEqual({ apiKey: TOKEN, baseURL: "http://127.0.0.1:7981/v1" });
		expect(calls).toHaveLength(0);
	});

	test("openAICompatible throws a config error synchronously, in both result modes", () => {
		const env = { RYU_GATEWAY_URL: "not a url" };
		expect(() => new Ryu({ env }).gateway.openAICompatible()).toThrow(
			RyuConfigurationError
		);
		expect(() =>
			new Ryu({ env, result: "object" }).gateway.openAICompatible()
		).toThrow(RyuConfigurationError);
	});

	test("object mode resolves to { data, error, meta }", async () => {
		const { fetch } = stubFetch((request) =>
			request.url.endsWith("/v1/models")
				? Response.json(
						{ data: [{ id: "m" }], object: "list" },
						{ headers: { "x-request-id": "req_gw_1" } }
					)
				: gatewayError(401, "invalid_api_key", "Invalid API key")
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const ok = await ryu.gateway.models.list();
		expect(ok.error).toBeNull();
		expect(ok.data?.data[0]?.id).toBe("m");
		expect(ok.meta?.requestId).toBe("req_gw_1");
		const failed = await ryu.gateway.auth.status();
		expect(failed.data).toBeNull();
		expect(failed.error).toBeInstanceOf(RyuAuthenticationError);
		expect(failed.error?.code).toBe("invalid_api_key");
	});
});

describe("Gateway errors", () => {
	// The status/type/code table of `status_and_code_mapping_is_stable_per_variant`
	// in apps/gateway/src/error.rs.
	const CASES: readonly [
		number,
		string,
		string,
		new (...args: never[]) => RyuError,
	][] = [
		[401, "invalid_api_key", "bad key", RyuAuthenticationError],
		[
			429,
			"rate_limit_exceeded",
			"Rate limit exceeded. Please retry after a moment.",
			RyuRateLimitError,
		],
		[403, "policy_violation", "ssn", RyuPermissionError],
		[404, "model_not_found", "gpt-9", RyuNotFoundError],
		[
			502,
			"provider_error",
			"Upstream provider request failed.",
			RyuServerError,
		],
		[
			429,
			"provider_rate_limited",
			"Upstream provider rate limit reached. Please retry after a moment.",
			RyuRateLimitError,
		],
		[
			402,
			"provider_payment_required",
			"Upstream provider payment is required.",
			RyuPaymentRequiredError,
		],
		[503, "circuit_open", "openai", RyuUnavailableError],
		[503, "engine_overloaded", "queue full", RyuUnavailableError],
		[
			402,
			"budget_exceeded",
			"Charged spend budget exceeded for this period.",
			RyuPaymentRequiredError,
		],
		[
			402,
			"insufficient_credits",
			"organization credit balance exhausted",
			RyuPaymentRequiredError,
		],
		[
			503,
			"credit_accounting_unavailable",
			"credit accounting is temporarily unavailable",
			RyuUnavailableError,
		],
		[
			503,
			"all_providers_unavailable",
			"All configured providers are currently unavailable.",
			RyuUnavailableError,
		],
		[400, "invalid_request_error", "nope", RyuInvalidRequestError],
		[
			409,
			"config_revision_conflict",
			"Configuration changed; refresh before saving.",
			RyuConflictError,
		],
		[500, "internal_error", "An internal error occurred.", RyuServerError],
	];

	test("every GatewayError body maps to the RyuError with its code", async () => {
		for (const [status, code, message, ErrorClass] of CASES) {
			const { fetch } = stubFetch(() => gatewayError(status, code, message));
			const ryu = new Ryu({ env: ENV, fetch, maxRetries: 0 });
			const error = await rejection(ryu.gateway.models.list());
			expect(error).toBeInstanceOf(ErrorClass);
			expect(error.status).toBe(status);
			expect(error.code).toBe(code);
			expect(messageWithoutHint(error)).toBe(message);
			expect(error.envelope).toBe("openai");
			expect(error.service).toBe("gateway");
			expect(JSON.stringify(error.toJSON())).not.toContain(TOKEN);
		}
	});

	test("an error keeps the Gateway's x-request-id as requestId", async () => {
		// apps/gateway/src/api/http_conventions.rs sends x-request-id on every
		// response, errors included.
		const { fetch } = stubFetch(() =>
			gatewayError(
				404,
				"model_not_found",
				"gpt-9",
				{},
				{ "x-request-id": "req_gw_err_1" }
			)
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 0 });
		const error = await rejection(ryu.gateway.models.list());
		expect(error.requestId).toBe("req_gw_err_1");
	});

	test("a 502 provider_error on POST is not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(502, "provider_error", "Upstream provider request failed.")
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(
			ryu.gateway.chat.completions.create({
				messages: [{ content: "hi", role: "user" }],
				model: "m",
			})
		);
		expect(error.code).toBe("provider_error");
		expect(error.attempts).toBe(1);
		expect(calls).toHaveLength(1);
		const embeddings = stubFetch(() =>
			gatewayError(503, "all_providers_unavailable", "down")
		);
		await rejection(
			new Ryu({ env: ENV, fetch: embeddings.fetch }).gateway.embeddings.create({
				input: "x",
				model: "e",
			})
		);
		expect(embeddings.calls).toHaveLength(1);
	});

	test("a GET is retried on a 5xx", async () => {
		let attempt = 0;
		const { calls, fetch } = stubFetch(() => {
			attempt += 1;
			return attempt === 1
				? gatewayError(503, "circuit_open", "openai")
				: Response.json({ data: [], object: "list" });
		});
		const retries: RyuRetryEvent[] = [];
		const ryu = new Ryu({
			env: ENV,
			fetch,
			hooks: { onRetry: (event) => retries.push(event) },
		});
		await ryu.gateway.models.list();
		expect(calls).toHaveLength(2);
		expect(retries[0]?.code).toBe("circuit_open");
	});

	test("provider_rate_limited on POST is retried, honouring the body's retry_after", async () => {
		let attempt = 0;
		const { calls, fetch } = stubFetch(() => {
			attempt += 1;
			return attempt === 1
				? gatewayError(429, "provider_rate_limited", "busy", {
						retryAfter: 0,
						resetAt: 1_900_000_000,
					})
				: Response.json(COMPLETION);
		});
		const retries: RyuRetryEvent[] = [];
		const ryu = new Ryu({
			env: ENV,
			fetch,
			hooks: { onRetry: (event) => retries.push(event) },
		});
		const completion = await ryu.gateway.chat.completions.create({
			messages: [{ content: "hi", role: "user" }],
			model: "m",
		});
		expect(completion.id).toBe("chatcmpl-1");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body).toBe(calls[0]?.body ?? "");
		expect(retries).toEqual([
			expect.objectContaining({
				code: "provider_rate_limited",
				delayMs: 0,
				method: "POST",
				status: 429,
			}),
		]);
	});

	test("a retry_after longer than maxRetryDelayMs is surfaced, not waited for", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(
				429,
				"provider_rate_limited",
				"busy",
				{ retryAfter: 42, resetAt: 1_900_000_000 },
				{ "retry-after": "42" }
			)
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetryDelayMs: 1000 });
		const error = await rejection(
			ryu.gateway.chat.completions.create({
				messages: [{ content: "hi", role: "user" }],
				model: "m",
			})
		);
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.code).toBe("provider_rate_limited");
		expect(error.retryAfterSeconds).toBe(42);
	});

	test("the Gateway's own 429 without a retry hint is not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(
				429,
				"rate_limit_exceeded",
				"Rate limit exceeded. Please retry after a moment."
			)
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(ryu.gateway.models.list());
		expect(error.code).toBe("rate_limit_exceeded");
		expect(calls).toHaveLength(1);
	});
});

describe("Gateway streaming", () => {
	test("parses SSE chunks split across reads and stops on [DONE]", async () => {
		const frames = `data: ${JSON.stringify(chunk("Hel"))}\n\ndata: ${JSON.stringify(
			chunk("lo")
		)}\n\ndata: ${JSON.stringify(chunk(null, "stop"))}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(
			chunk("after done")
		)}\n\n`;
		const parts = [frames.slice(0, 17), frames.slice(17, 60), frames.slice(60)];
		const stream = sseBody(parts);
		const { calls, fetch } = stubFetch(
			() =>
				new Response(stream.body, {
					headers: { "content-type": "text/event-stream" },
				})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const chunks = await collect(
			ryu.gateway.chat.completions.create({
				messages: [{ content: "hi", role: "user" }],
				model: "openai/gpt-4o-mini",
				stream: true,
			})
		);
		expect(
			chunks.map((item) => item.choices[0]?.delta.content ?? null)
		).toEqual(["Hel", "lo", null]);
		expect(chunks[2]?.choices[0]?.finish_reason).toBe("stop");
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(JSON.parse(calls[0]?.body ?? "{}").stream).toBe(true);
	});

	test("stream() sends stream: true and keeps a usage-only chunk", async () => {
		const usage = {
			choices: [],
			usage: { completion_tokens: 2, prompt_tokens: 1, total_tokens: 3 },
		};
		const stream = sseBody([
			`data: ${JSON.stringify(chunk("x"))}\r\n\r\n`,
			`data: ${JSON.stringify(usage)}\r\n\r\ndata: [DONE]\r\n\r\n`,
		]);
		const { calls, fetch } = stubFetch(() => new Response(stream.body));
		const ryu = new Ryu({ env: ENV, fetch });
		const chunks = await collect(
			ryu.gateway.chat.completions.stream({
				messages: [{ content: "hi", role: "user" }],
				model: "m",
				stream: false,
			})
		);
		expect(chunks).toHaveLength(2);
		expect(chunks[1]?.usage?.total_tokens).toBe(3);
		expect(JSON.parse(calls[0]?.body ?? "{}").stream).toBe(true);
	});

	test("an error frame inside the stream raises a RyuError", async () => {
		const stream = sseBody([
			`data: ${JSON.stringify(chunk("partial"))}\n\n`,
			`data: ${JSON.stringify({
				error: { code: "provider_error", message: "Upstream failed." },
			})}\n\n`,
		]);
		const { fetch } = stubFetch(() => new Response(stream.body));
		const ryu = new Ryu({ env: ENV, fetch });
		const seen: GatewayChatCompletionChunk[] = [];
		const error = await rejection(
			(async () => {
				for await (const item of ryu.gateway.chat.completions.stream({
					messages: [],
					model: "m",
				})) {
					seen.push(item);
				}
			})()
		);
		expect(seen).toHaveLength(1);
		expect(error.code).toBe("provider_error");
		expect(error.service).toBe("gateway");
	});

	test("a streamed request is one attempt, even on a hinted 429", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(
				429,
				"provider_rate_limited",
				"busy",
				{ retryAfter: 0 },
				{ "retry-after": "0" }
			)
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(
			collect(
				ryu.gateway.chat.completions.create({
					messages: [],
					model: "m",
					stream: true,
				})
			)
		);
		expect(error.code).toBe("provider_rate_limited");
		expect(calls).toHaveLength(1);
	});

	test("untilDone cancels the rest of the body at [DONE]", async () => {
		const stream = sseBody([
			'data: {"a":1}\n\n',
			"data: [DONE]\n\n",
			'data: {"b":2}\n\n',
		]);
		const text = await new Response(untilDone(stream.body)).text();
		expect(text).toBe('data: {"a":1}\n\n');
		expect(stream.cancelled()).toBe(true);
	});

	test("untilDone keeps a final frame without a trailing blank line", async () => {
		const stream = sseBody(['data: {"a":1}\n\ndata: {"b":2}']);
		const text = await new Response(untilDone(stream.body)).text();
		expect(text).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
	});
});

describe("Gateway types", () => {
	test("create is overloaded on stream; object mode keeps the promise form", () => {
		// Type-only: these functions are never called, so nothing is sent.
		const ryu = new Ryu({ env: {} });
		const plain = () =>
			ryu.gateway.chat.completions.create({ messages: [], model: "m" });
		const streamed = () =>
			ryu.gateway.chat.completions.create({
				messages: [],
				model: "m",
				stream: true,
			});
		expectTypeOf(plain).returns.toEqualTypeOf<Promise<GatewayChatCompletion>>();
		expectTypeOf(streamed).returns.toEqualTypeOf<
			AsyncGenerator<GatewayChatCompletionChunk>
		>();
		const objects = new Ryu({ env: {}, result: "object" });
		expectTypeOf(objects.gateway.models.list).returns.toEqualTypeOf<
			Promise<RyuResult<Awaited<ReturnType<Ryu["gateway"]["models"]["list"]>>>>
		>();
		expectTypeOf(objects.gateway.chat.completions.stream).returns.toEqualTypeOf<
			AsyncGenerator<GatewayChatCompletionChunk>
		>();
		expect(true).toBe(true);
	});
});

describe("Gateway error.upstream_status", () => {
	const UPSTREAM = "Upstream provider request failed.";

	test("a 502 provider_error with an upstream 4xx is final and exposes upstreamStatus", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(
				502,
				"provider_error",
				UPSTREAM,
				{ upstreamStatus: 400 },
				{ "retry-after": "0" }
			)
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 2 });
		// A GET is replay-safe, so only upstream_status stops the retry.
		const error = await rejection(ryu.gateway.models.list());
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.status).toBe(502);
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(false);
		expect(error.details).toEqual({ upstreamStatus: 400 });
		expect(error.attempts).toBe(1);
		expect(calls).toHaveLength(1);
		expect(error.toJSON().details).toEqual({ upstreamStatus: 400 });
	});

	test("an upstream 401 on a chat completion is reported the same way", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(502, "provider_error", UPSTREAM, { upstreamStatus: 401 })
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const result = await ryu.gateway.chat.completions.create({
			messages: [{ content: "hi", role: "user" }],
			model: "m",
		});
		expect(result.error?.details).toEqual({ upstreamStatus: 401 });
		expect(result.error?.retryable).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("an upstream 5xx keeps today's behaviour: retryable, and a GET is retried", async () => {
		let attempt = 0;
		const { calls, fetch } = stubFetch(() => {
			attempt += 1;
			return attempt === 1
				? gatewayError(
						502,
						"provider_error",
						UPSTREAM,
						{ upstreamStatus: 503 },
						{ "retry-after": "0" }
					)
				: Response.json({ data: [], object: "list" });
		});
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 2 });
		await ryu.gateway.models.list();
		expect(calls).toHaveLength(2);
		const post = stubFetch(() =>
			gatewayError(502, "provider_error", UPSTREAM, { upstreamStatus: 500 })
		);
		const error = await rejection(
			new Ryu({ env: ENV, fetch: post.fetch }).gateway.embeddings.create({
				input: "x",
				model: "m",
			})
		);
		expect(error.retryable).toBe(true);
		expect(error.details).toEqual({ upstreamStatus: 500 });
		// A POST is still never replayed on a 5xx.
		expect(post.calls).toHaveLength(1);
	});

	for (const upstreamStatus of [408, 425, 429]) {
		test(`an upstream ${upstreamStatus} stays retryable: a GET is retried and upstreamStatus is exposed`, async () => {
			let attempt = 0;
			const { calls, fetch } = stubFetch(() => {
				attempt += 1;
				return attempt === 1
					? gatewayError(
							502,
							"provider_error",
							UPSTREAM,
							{ upstreamStatus },
							{ "retry-after": "0" }
						)
					: Response.json({ data: [], object: "list" });
			});
			const ryu = new Ryu({ env: ENV, fetch, maxRetries: 2 });
			await ryu.gateway.models.list();
			expect(calls).toHaveLength(2);
			const final = stubFetch(() =>
				gatewayError(502, "provider_error", UPSTREAM, { upstreamStatus })
			);
			const error = await rejection(
				new Ryu({ env: ENV, fetch: final.fetch }).gateway.embeddings.create({
					input: "x",
					model: "m",
				})
			);
			expect(error.retryable).toBe(true);
			expect(error.details).toEqual({ upstreamStatus });
			// A POST is still never replayed on a 5xx.
			expect(final.calls).toHaveLength(1);
		});
	}

	test("without upstream_status nothing changes", async () => {
		const { calls, fetch } = stubFetch(() =>
			gatewayError(502, "provider_error", UPSTREAM, {}, { "retry-after": "0" })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		const error = await rejection(ryu.gateway.models.list());
		expect(error.retryable).toBe(true);
		expect(error.details).toBeNull();
		expect(calls).toHaveLength(2);
	});

	test("gatewayUpstreamStatus reads only an integer HTTP error status", () => {
		expect(gatewayUpstreamStatus({ error: { upstream_status: 429 } })).toBe(
			429
		);
		for (const body of [
			undefined,
			null,
			"text",
			{ error: "x" },
			{ error: { upstream_status: "400" } },
			{ error: { upstream_status: 200 } },
			{ error: { upstream_status: 600 } },
			{ error: { upstream_status: 400.5 } },
			{ upstream_status: 400 },
		]) {
			expect(gatewayUpstreamStatus(body)).toBeNull();
		}
	});

	test("refineGatewayError keeps existing details and the error's class", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "provider_error",
						details: { provider: "openai" },
						message: UPSTREAM,
						type: "provider_error",
						upstream_status: 404,
					},
				},
				{ status: 502 }
			)
		);
		const error = await rejection(
			new Ryu({ env: ENV, fetch }).gateway.models.list()
		);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.details).toEqual({ provider: "openai", upstreamStatus: 404 });
		const unchanged = refineGatewayError(error, { error: {} });
		expect(unchanged).toBe(error);
	});

	test("the Gateway emits error.upstream_status on provider failures", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../../../../apps/gateway/src/error.rs"),
			"utf8"
		);
		expect(source).toContain(
			'body["error"]["upstream_status"] = json!(status);'
		);
		expect(source).toContain('"provider_error"');
	});
});
