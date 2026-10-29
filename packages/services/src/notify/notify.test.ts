import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	type NotificationEvent,
	type NotifyActivity,
	NotifyAPI,
	type NotifyDelivery,
	type NotifyDestination,
	type NotifyEventList,
	type NotifyGroup,
	type NotifyPreferences,
	type NotifySilence,
	type NotifyStreamItem,
} from "@ryuhq/client";
import {
	isRyuError,
	RyuAbortError,
	RyuAuthenticationError,
	RyuConfigurationError,
	RyuConflictError,
	type RyuError,
	RyuInvalidRequestError,
	RyuPaymentRequiredError,
	RyuRateLimitError,
	RyuResponseValidationError,
} from "../errors.ts";
import type { Paginated } from "../pagination.ts";
import type { RyuResult, Safe } from "../result.ts";
import { Ryu } from "../ryu.ts";
import { isNotifyErrorCode, NOTIFY_ERROR_CODES } from "./codes.ts";
import {
	DEFAULT_APPROVAL_TIMEOUT_MS,
	MAX_APPROVAL_DURATION_MS,
	MIN_APPROVAL_POLL_INTERVAL_MS,
	requestApproval,
} from "./helpers.ts";
import { iterateEvents, NOTIFY_MAX_PAGE_SIZE } from "./iterate.ts";
import {
	NOTIFY_CANONICAL_METHODS,
	NOTIFY_DEPRECATED_ALIASES,
	NOTIFY_TOP_LEVEL_METHODS,
	type NotifyDeprecatedAlias,
	type NotifyNamespace,
} from "./namespace.ts";
import { NOTIFY_ROUTES } from "./routes.ts";

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

const ENV = {
	RYU_NOTIFY_API_KEY: "notify_tenant_secret",
	RYU_NOTIFY_URL: "http://127.0.0.1:8092",
};

function event(
	id: string,
	overrides: Partial<NotificationEvent> = {}
): NotificationEvent {
	return {
		acknowledgedAt: null,
		actions: [],
		archivedAt: null,
		attachment: null,
		body: "",
		createdAt: "2026-10-01T00:00:00.000Z",
		data: {},
		externalId: null,
		fingerprint: null,
		icon: null,
		id,
		level: "info",
		occurredAt: "2026-10-01T00:00:00.000Z",
		priority: 3,
		project: null,
		recipient: null,
		response: null,
		source: "api",
		tags: [],
		title: "Deploy finished",
		topic: null,
		type: "notification",
		url: null,
		...overrides,
	};
}

function pending(id: string, status = "pending", value: string | null = null) {
	return event(id, {
		response: {
			callbackUrl: null,
			callbackUrlPreview: null,
			expiresAt: "2026-10-01T00:10:00.000Z",
			prompt: "Ship v2?",
			respondedAt: status === "pending" ? null : "2026-10-01T00:01:00.000Z",
			status: status as NonNullable<NotificationEvent["response"]>["status"],
			type: "approval",
			value,
		},
	});
}

function eventBody(value: NotificationEvent, extra: object = {}) {
	return { event: value, ok: true, requestId: "req_1", ...extra };
}

function notifyError(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {}
): Response {
	return Response.json(
		{
			code,
			error: { code, message, requestId: "req_err", status },
			message,
			ok: false,
			requestId: "req_err",
			status,
			type: "notify.error",
		},
		{ headers: { "x-request-id": "req_err", ...headers }, status }
	);
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

describe("route table", () => {
	test("publish routes take an optional key; activities require one", () => {
		expect(NOTIFY_ROUTES.mount).toBe("");
		expect(NOTIFY_ROUTES.replayedBodyField).toBe("idempotent");
		expect(
			NOTIFY_ROUTES.idempotent.map(
				(route) => `${route.method} ${route.path} ${String(route.required)}`
			)
		).toEqual([
			"POST /v1/events false",
			"POST /v1/topics/{topic} false",
			"POST /v1/activities true",
		]);
	});
});

describe("codes", () => {
	test("isNotifyErrorCode knows every listed code and nothing else", () => {
		for (const code of NOTIFY_ERROR_CODES) {
			expect(isNotifyErrorCode(code)).toBe(true);
		}
		expect(isNotifyErrorCode("quota_exceeded")).toBe(false);
	});
});

describe("publish", () => {
	test("sends Bearer and an auto Idempotency-Key to the configured origin", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1"), { idempotent: false }), {
				status: 201,
			})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const published = await ryu.notify.publish({
			title: "Deploy finished",
			level: "success",
		});
		expect(published.id).toBe("evt_1");
		const [call] = calls;
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe("http://127.0.0.1:8092/v1/events");
		expect(call?.headers.get("authorization")).toBe(
			"Bearer notify_tenant_secret"
		);
		expect(call?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
		expect(JSON.parse(call?.body ?? "{}")).toEqual({
			level: "success",
			title: "Deploy finished",
		});
	});

	test(".with({ idempotencyKey }) wins and is reported in meta", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1")), { status: 201 })
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const result = await ryu.notify
			.with({ idempotencyKey: "deploy-4821" })
			.publish({ title: "Deployed" });
		expect(calls[0]?.headers.get("idempotency-key")).toBe("deploy-4821");
		expect(result.meta?.idempotencyKey).toBe("deploy-4821");
		expect(result.meta?.status).toBe(201);
		expect(result.meta?.replayed).toBe(false);
	});

	test("a replay is reported from the body's idempotent flag", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1"), { idempotent: true }))
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, meta } = await ryu.notify.publish({ title: "x" });
		expect(data?.id).toBe("evt_1");
		expect(meta?.replayed).toBe(true);
	});

	test("topics.publish gets a key; reads and acknowledgements do not", async () => {
		const { calls, fetch } = stubFetch((request) => {
			if (request.method === "GET" && request.url.endsWith("/v1/events")) {
				return Response.json({ events: [], nextCursor: null });
			}
			return Response.json(eventBody(event("evt_1")));
		});
		const ryu = new Ryu({ env: ENV, fetch });
		await ryu.notify.topics.publish("deployments", "Canary live");
		await ryu.notify.events.list();
		await ryu.notify.events.get("evt_1");
		await ryu.notify.events.acknowledge("evt_1");
		expect(
			calls.map((call) => [
				`${call.method} ${new URL(call.url).pathname}`,
				call.headers.has("idempotency-key"),
			])
		).toEqual([
			["POST /v1/topics/deployments", true],
			["GET /v1/events", false],
			["GET /v1/events/evt_1", false],
			["POST /v1/events/evt_1/ack", false],
		]);
	});

	test("topics.publish sends text outside Latin-1 as RFC 2047 words", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1")))
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const options = { tags: ["生产"], title: "部署完成 ✅" };
		const canonical = await ryu.notify.topics.publish(
			"deploys",
			"Ready",
			options
		);
		await ryu.safe.notify.publishTopic("deploys", "Ready", options);
		expect(canonical.error).toBeNull();
		const word = (text: string) =>
			`=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
		expect(
			calls.map((call) => [call.headers.get("title"), call.headers.get("tags")])
		).toEqual([
			[word("部署完成 ✅"), word("生产")],
			[word("部署完成 ✅"), word("生产")],
		]);
	});

	test("topics.publish wraps text containing `=?` so it round-trips", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1")))
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const title = "Use =?UTF-8?B?aGk=?= in titles";
		const published = await ryu.notify.topics.publish("deploys", "Ready", {
			title,
		});
		expect(published.error).toBeNull();
		expect(calls[0]?.headers.get("title")).toBe(
			`=?UTF-8?B?${Buffer.from(title, "utf8").toString("base64")}?=`
		);
	});

	test("activities.create keeps the caller's required key", async () => {
		const activity = {
			accent: null,
			createdAt: "2026-10-01T00:00:00.000Z",
			data: {},
			endedAt: null,
			expiresAt: null,
			id: "act_1",
			progress: null,
			recipient: null,
			sequence: 0,
			status: "running",
			symbol: null,
			title: "Build",
			topic: null,
			updatedAt: "2026-10-01T00:00:00.000Z",
		};
		const { calls, fetch } = stubFetch(() =>
			Response.json({ activity, idempotent: false, ok: true }, { status: 201 })
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const created = await ryu.notify.activities.create(
			{ title: "Build" },
			"build-77"
		);
		expect(created.id).toBe("act_1");
		expect(calls[0]?.headers.get("idempotency-key")).toBe("build-77");
	});
});

describe("errors", () => {
	test("409 idempotency_conflict is a RyuConflictError and is not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			notifyError(
				409,
				"idempotency_conflict",
				"Idempotency-Key was reused with a different request."
			)
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(ryu.notify.publish({ title: "x" }));
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.code).toBe("idempotency_conflict");
		expect(error.envelope).toBe("ryu-service");
		expect(error.requestId).toBe("req_err");
		expect(calls).toHaveLength(1);
	});

	test("429 rate_limited is retried after Retry-After with the same key", async () => {
		let attempt = 0;
		const { calls, fetch } = stubFetch(() => {
			attempt += 1;
			return attempt === 1
				? notifyError(429, "rate_limited", "Slow down.", { "retry-after": "0" })
				: Response.json(eventBody(event("evt_1")), { status: 201 });
		});
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, meta } = await ryu.notify.publish({ title: "x" });
		expect(data?.id).toBe("evt_1");
		expect(meta?.attempts).toBe(2);
		expect(calls[0]?.headers.get("idempotency-key")).toBe(
			calls[1]?.headers.get("idempotency-key") ?? "missing"
		);
	});

	test("429 too_many_streams and 402 insufficient_credits are never retried", async () => {
		const streams = stubFetch(() =>
			notifyError(429, "too_many_streams", "Too many open event streams.", {
				"retry-after": "0",
			})
		);
		const ryu = new Ryu({ env: ENV, fetch: streams.fetch });
		const tooMany = await rejection(ryu.notify.events.list());
		expect(tooMany).toBeInstanceOf(RyuRateLimitError);
		expect(tooMany.retryable).toBe(false);
		expect(streams.calls).toHaveLength(1);

		const credits = stubFetch(() =>
			notifyError(402, "insufficient_credits", "Add credits.")
		);
		const billed = new Ryu({ env: ENV, fetch: credits.fetch });
		const refused = await rejection(billed.notify.publish({ title: "x" }));
		expect(refused).toBeInstanceOf(RyuPaymentRequiredError);
		expect(refused.code).toBe("insufficient_credits");
		expect(credits.calls).toHaveLength(1);
	});

	test("401 unauthorized keeps Notify's code", async () => {
		const { fetch } = stubFetch(() =>
			notifyError(401, "unauthorized", "Missing or invalid API key.")
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(ryu.notify.events.get("evt_1"));
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.code).toBe("unauthorized");
		expect(error.hint).toContain("RYU_NOTIFY_API_KEY");
	});

	test("a refused connection names the origin and RYU_NOTIFY_URL in its hint", async () => {
		const fetch = () => Promise.reject(new TypeError("Unable to connect."));
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 0 });
		const error = await rejection(ryu.notify.events.list());
		expect(error.code).toBe("connection_error");
		expect(error.hint).toContain(new URL(ENV.RYU_NOTIFY_URL).origin);
		expect(error.hint).toContain("RYU_NOTIFY_URL");
	});

	test("a missing key is a RyuConfigurationError naming it, with no request", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({}));
		const ryu = new Ryu({ env: {}, fetch });
		const error = await rejection(ryu.notify.events.get("evt_1"));
		expect(error).toBeInstanceOf(RyuConfigurationError);
		// The URL defaults to hosted Notify; its key is provisioned by Ryu.
		expect(error.details).toEqual({
			missing: ["RYU_NOTIFY_API_KEY"],
		});
		expect(calls).toHaveLength(0);
		expect(error.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/sdk/notify"
		);
	});

	test("defaults to the hosted Notify origin when RYU_NOTIFY_URL is unset", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1")))
		);
		const ryu = new Ryu({ env: { RYU_NOTIFY_API_KEY: "ntf_k" }, fetch });
		await ryu.notify.events.get("evt_1");
		expect(new URL(calls[0]?.url ?? "").origin).toBe(
			"https://notify.ryuhq.com"
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer ntf_k");
	});

	test("an RFC 9457 Notify error maps code, message, request id and details", async () => {
		const { fetch } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						type: "https://docs.ryuhq.com/docs/standalone/notify-api#invalid_request",
						title: "Bad Request",
						status: 400,
						detail: "title is required.",
						instance: "/v1/events",
						code: "invalid_request",
						docs: "https://docs.ryuhq.com/docs/standalone/notify-api#invalid_request",
						error: {
							code: "invalid_request",
							details: { field: "title" },
							message: "title is required.",
							requestId: "req_problem",
							status: 400,
						},
						message: "title is required.",
						ok: false,
						requestId: "req_problem",
					}),
					{
						status: 400,
						headers: { "content-type": "application/problem+json" },
					}
				)
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const { error } = await ryu.notify.publish({ title: "x" });
		expect(error?.envelope).toBe("problem+json");
		expect(error?.code).toBe("invalid_request");
		expect(error?.message).toBe("title is required.");
		expect(error?.requestId).toBe("req_problem");
		expect(error?.details).toEqual({ field: "title" });
		expect(error?.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/notify-api#invalid_request"
		);
	});

	test("the control-plane RYU_API_KEY is never sent to Notify", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1")))
		);
		const ryu = new Ryu({
			env: { ...ENV, RYU_API_KEY: "ryu_control_plane_secret" },
			fetch,
		});
		await ryu.notify.events.get("evt_1");
		const headers = [...(calls[0]?.headers.entries() ?? [])].flat().join(" ");
		expect(headers).not.toContain("ryu_control_plane_secret");
	});
});

describe("events group", () => {
	test("list, get and acknowledge delegate to the client", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.method === "GET" && new URL(request.url).pathname === "/v1/events"
				? Response.json({ events: [event("evt_1")], nextCursor: null })
				: Response.json(eventBody(event("evt_1")))
		);
		const ryu = new Ryu({ env: ENV, fetch });
		expect((await ryu.notify.events.list({ limit: 5 })).events).toHaveLength(1);
		expect((await ryu.notify.events.get("evt_1")).id).toBe("evt_1");
		expect((await ryu.notify.events.acknowledge("evt_1")).id).toBe("evt_1");
		expect(
			calls.map(
				(call) =>
					`${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`
			)
		).toEqual([
			"GET /v1/events?limit=5",
			"GET /v1/events/evt_1",
			"POST /v1/events/evt_1/ack",
		]);
	});

	test("safe.notify.events.get resolves to { data, error, meta }", async () => {
		const { fetch } = stubFetch(() =>
			notifyError(404, "not_found", "Event not found.")
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const result = await ryu.safe.notify.events.get("missing");
		expect(result.data).toBeNull();
		expect(result.error?.code).toBe("not_found");
		expect(result.meta?.status).toBe(404);
	});

	test("iterate follows nextCursor as before, keeps filters, and honours maxItems", async () => {
		const pages: Record<string, unknown> = {
			"": { events: [event("e1"), event("e2")], nextCursor: "c1" },
			c1: { events: [event("e3")], nextCursor: "c2" },
			c2: { events: [event("e4")], nextCursor: null },
		};
		const { calls, fetch } = stubFetch((request) => {
			const before = new URL(request.url).searchParams.get("before") ?? "";
			return Response.json(pages[before]);
		});
		const ryu = new Ryu({ env: ENV, fetch });
		const ids: string[] = [];
		for await (const item of ryu.notify.events.iterate({
			level: "error",
			limit: 2,
		})) {
			ids.push(item.id);
		}
		expect(ids).toEqual(["e1", "e2", "e3", "e4"]);
		expect(
			calls.map((call) => new URL(call.url).searchParams.toString())
		).toEqual([
			"level=error&limit=2",
			"level=error&limit=2&before=c1",
			"level=error&limit=2&before=c2",
		]);

		const capped = await ryu.notify.events.iterate({ maxItems: 3 }).collect();
		expect(capped.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);
	});

	test("iterate throws RyuError even in object mode", async () => {
		const { fetch } = stubFetch(() =>
			notifyError(400, "invalid_cursor", "The cursor is invalid.")
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const iterator = ryu.notify.events.iterate()[Symbol.asyncIterator]();
		const error = await rejection(iterator.next());
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_cursor");
	});

	test("iterateEvents stops on an empty page and exposes pages()", async () => {
		const listEvents = async (options: { before?: string } = {}) =>
			options.before === undefined
				? { events: [event("e1")], nextCursor: "c1" }
				: { events: [], nextCursor: "c2" };
		const pages = [];
		for await (const page of iterateEvents({ listEvents }).pages()) {
			pages.push(page.events.length);
		}
		expect(pages).toEqual([1, 0]);
		expect(NOTIFY_MAX_PAGE_SIZE).toBe(100);
	});

	test("stream yields parsed notification frames", async () => {
		const frame = `event: notification\nid: evt_1\ndata: ${JSON.stringify(event("evt_1"))}\n\n`;
		const { calls, fetch } = stubFetch(
			() =>
				new Response(frame, {
					headers: { "content-type": "text/event-stream" },
				})
		);
		const ryu = new Ryu({ env: ENV, fetch });
		const items = [];
		for await (const item of ryu.notify.events.stream({ topic: "deploys" })) {
			items.push(item);
		}
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("notification");
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:8092/v1/events/stream?topic=deploys"
		);
	});
});

/** Sample arguments for each deprecated alias (and so for its canonical method). */
const ALIAS_ARGS: Record<NotifyDeprecatedAlias, unknown[]> = {
	acknowledge: ["evt_1"],
	archive: ["evt_1"],
	cancelResponse: ["evt_1"],
	createActivity: [{ progress: 0.5, title: "Build" }, "build-1"],
	createDestination: [
		{ kind: "webhook", name: "Ops", url: "https://hooks.example.com/notify" },
	],
	createSilence: [{ expiresAt: "2026-10-02T00:00:00.000Z", topic: "deploys" }],
	deleteDestination: ["dst_1"],
	deleteSilence: ["sil_1"],
	endActivity: ["act_1", 3],
	getActivity: ["act_1"],
	getEvent: ["evt_1"],
	getPreferences: ["ops"],
	listActivities: [{ limit: 5, topic: "deploys" }],
	listDeliveries: [{ limit: 5 }],
	listDestinations: [],
	listEvents: [{ level: "error", limit: 5 }],
	listGroups: [5],
	listSilences: [],
	listTopics: [5],
	publishTopic: ["deployments", "Canary live", { title: "Canary" }, "topic-1"],
	respond: ["evt_1", { status: "approved", value: "ok" }],
	retryDelivery: ["dlv_1"],
	stream: [{ topic: "deploys" }],
	testDestination: ["dst_1"],
	unarchive: ["evt_1"],
	updateActivity: ["act_1", { progress: 0.9 }, 4],
	updateDestination: ["dst_1", { enabled: false }],
	updatePreferences: [{ muted: true }],
};

type AnyMethod = (...args: unknown[]) => unknown;

/** `ryu.notify` (or its object-mode form) walked along a dotted path. */
function methodAt(root: unknown, path: string): AnyMethod {
	let target: unknown = root;
	for (const key of path.split(".")) {
		target = (target as Record<string, unknown>)[key];
	}
	return target as AnyMethod;
}

/** Runs a call to completion, ignoring its (expected) failure. */
async function settle(value: unknown): Promise<void> {
	try {
		if (typeof value === "object" && value !== null && "then" in value) {
			await value;
			return;
		}
		const iterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator]();
		await iterator.next();
	} catch {
		// The stub answers 404; only the request matters here.
	}
}

/** The parts of a request both spellings must agree on. */
function wire(call: Recorded) {
	return {
		accept: call.headers.get("accept"),
		authorization: call.headers.get("authorization"),
		body: call.body,
		contentType: call.headers.get("content-type"),
		hasIdempotencyKey: call.headers.has("idempotency-key"),
		idempotencyKey: call.headers.get("idempotency-key"),
		method: call.method,
		title: call.headers.get("title"),
		url: call.url,
	};
}

describe("resource namespaces", () => {
	test("every NotifyAPI method has a canonical home or stays top level", () => {
		const placed = new Set<string>([
			...Object.values(NOTIFY_CANONICAL_METHODS),
			...NOTIFY_TOP_LEVEL_METHODS,
		]);
		// `private` client helpers sit on the prototype but are not API.
		const internals = new Set(["constructor", "fetch", "requestOptions"]);
		const methods = Object.getOwnPropertyNames(NotifyAPI.prototype).filter(
			(name) =>
				!internals.has(name) &&
				typeof Reflect.get(NotifyAPI.prototype, name) === "function"
		);
		expect(methods.filter((name) => !placed.has(name))).toEqual([]);
		expect(
			[...placed].filter((name) => !methods.includes(name)).sort()
		).toEqual([]);
		// One canonical path per client method, so the reverse map is lossless.
		expect(Object.keys(NOTIFY_DEPRECATED_ALIASES).sort()).toEqual(
			Object.values(NOTIFY_CANONICAL_METHODS).sort()
		);
	});

	test("every canonical path resolves to a function on ryu.notify", () => {
		const ryu = new Ryu({
			env: ENV,
			fetch: () => Promise.reject(new Error("no request")),
		});
		for (const path of [
			...Object.keys(NOTIFY_CANONICAL_METHODS),
			"events.iterate",
			"requestApproval",
			...NOTIFY_TOP_LEVEL_METHODS,
		]) {
			expect({ path, type: typeof methodAt(ryu.notify, path) }).toEqual({
				path,
				type: "function",
			});
		}
	});

	test("every deprecated alias sends the same request as its canonical method", async () => {
		const aliases = Object.entries(NOTIFY_DEPRECATED_ALIASES) as [
			NotifyDeprecatedAlias,
			string,
		][];
		for (const [alias, canonical] of aliases) {
			const { calls, fetch } = stubFetch(() =>
				notifyError(404, "not_found", "Not found.")
			);
			const ryu = new Ryu({ env: ENV, fetch });
			const args = ALIAS_ARGS[alias];
			await settle(methodAt(ryu.notify, alias)(...args));
			await settle(methodAt(ryu.notify, canonical)(...args));
			expect({ alias, calls: calls.length }).toEqual({ alias, calls: 2 });
			const [flat, nested] = calls.map(wire);
			expect({ alias, wire: nested }).toEqual({ alias, wire: flat });
		}
	});

	test("an auto Idempotency-Key is added for both spellings of topics.publish", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(eventBody(event("evt_1")))
		);
		const ryu = new Ryu({ env: ENV, fetch });
		await ryu.notify.publishTopic("deployments", "Canary live");
		await ryu.notify.topics.publish("deployments", "Canary live");
		const keys = calls.map((call) => call.headers.get("idempotency-key"));
		expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
		expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/u);
		expect(keys[0]).not.toBe(keys[1]);
	});

	test("object mode reports meta on a canonical call", async () => {
		const activity = {
			accent: null,
			createdAt: "2026-10-01T00:00:00.000Z",
			data: {},
			endedAt: null,
			expiresAt: null,
			id: "act_1",
			progress: 0.5,
			recipient: null,
			sequence: 0,
			status: "running",
			symbol: null,
			title: "Build",
			topic: null,
			updatedAt: "2026-10-01T00:00:00.000Z",
		};
		const { fetch } = stubFetch(() =>
			Response.json(
				{ activity, idempotent: true, ok: true },
				{ headers: { "x-request-id": "req_act" }, status: 201 }
			)
		);
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, error, meta } = await ryu.notify.activities.create(
			{ title: "Build" },
			"build-77"
		);
		expect(error).toBeNull();
		expect(data?.id).toBe("act_1");
		expect(meta).toMatchObject({
			attempts: 1,
			idempotencyKey: "build-77",
			replayed: true,
			requestId: "req_act",
			status: 201,
		});
	});

	test("object mode, ryu.safe and .with() work for both spellings", async () => {
		const { calls, fetch } = stubFetch(() =>
			notifyError(404, "not_found", "Destination not found.")
		);
		const objects = new Ryu({ env: ENV, fetch, result: "object" });
		const canonical = await objects.notify.destinations.delete("dst_1");
		const flat = await objects.notify.deleteDestination("dst_1");
		expect(canonical.error?.code).toBe("not_found");
		expect(flat.error?.code).toBe("not_found");
		expect(canonical.meta?.status).toBe(404);

		const throwing = new Ryu({ env: ENV, fetch });
		const safe = await throwing.safe.notify.silences.delete("sil_1");
		expect(safe.error?.code).toBe("not_found");
		const bound = await rejection(
			throwing.notify
				.with({ headers: { "x-trace": "t1" } })
				.preferences.update({ muted: true })
		);
		expect(bound.code).toBe("not_found");
		expect(calls.at(-1)?.headers.get("x-trace")).toBe("t1");
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/destinations/dst_1",
			"/v1/destinations/dst_1",
			"/v1/silences/sil_1",
			"/v1/preferences",
		]);
	});

	test("Safe projections of the resource namespaces", () => {
		const throwing = new Ryu({ env: ENV });
		const objects = new Ryu({ env: ENV, result: "object" });
		expectTypeOf(throwing.notify.topics.list).returns.toEqualTypeOf<
			Promise<Array<{ count: number; topic: string }>>
		>();
		expectTypeOf(objects.notify.topics.publish).returns.toEqualTypeOf<
			Promise<RyuResult<NotificationEvent>>
		>();
		expectTypeOf(objects.notify.events.archive).returns.toEqualTypeOf<
			Promise<RyuResult<NotificationEvent>>
		>();
		expectTypeOf(objects.notify.events.stream).returns.toEqualTypeOf<
			AsyncGenerator<NotifyStreamItem>
		>();
		expectTypeOf(objects.notify.events.iterate).returns.toEqualTypeOf<
			Paginated<NotificationEvent, NotifyEventList>
		>();
		expectTypeOf(objects.notify.activities.create).returns.toEqualTypeOf<
			Promise<RyuResult<NotifyActivity>>
		>();
		expectTypeOf(objects.notify.activities.create).parameters.toEqualTypeOf<
			Parameters<typeof throwing.notify.createActivity>
		>();
		expectTypeOf(objects.notify.destinations.delete).returns.toEqualTypeOf<
			Promise<RyuResult<void>>
		>();
		expectTypeOf(objects.notify.destinations.test).returns.toEqualTypeOf<
			Promise<RyuResult<{ status: number }>>
		>();
		expectTypeOf(objects.notify.deliveries.retry).returns.toEqualTypeOf<
			Promise<RyuResult<NotifyDelivery>>
		>();
		expectTypeOf(objects.notify.preferences.get).returns.toEqualTypeOf<
			Promise<RyuResult<NotifyPreferences>>
		>();
		expectTypeOf(objects.notify.silences.create).returns.toEqualTypeOf<
			Promise<RyuResult<NotifySilence>>
		>();
		expectTypeOf(objects.notify.groups.list).returns.toEqualTypeOf<
			Promise<RyuResult<NotifyGroup[]>>
		>();
		expectTypeOf(throwing.safe.notify.silences.list).returns.toEqualTypeOf<
			Promise<RyuResult<NotifySilence[]>>
		>();
		expectTypeOf(
			objects.notify.with({}).destinations.list
		).returns.toEqualTypeOf<Promise<RyuResult<NotifyDestination[]>>>();
		expectTypeOf<Safe<NotifyNamespace>["listEvents"]>().toEqualTypeOf<
			Safe<NotifyNamespace>["events"]["list"]
		>();
		expect(true).toBe(true);
	});
});

/** A fake client for the helper: `publish` returns `published`, then each `getEvent` the next item. */
function approvalClient(
	published: NotificationEvent,
	polls: NotificationEvent[]
) {
	const publishCalls: { input: unknown; key: string | undefined }[] = [];
	let pollCount = 0;
	return {
		client: {
			getEvent: (id: string) => {
				if (id !== published.id) {
					return Promise.reject(new Error(`unexpected event ${id}`));
				}
				const next = polls[Math.min(pollCount, polls.length - 1)];
				pollCount += 1;
				return Promise.resolve(next as NotificationEvent);
			},
			publish: (input: unknown, key?: string) => {
				publishCalls.push({ input, key });
				return Promise.resolve(published);
			},
		},
		polls: () => pollCount,
		publishCalls,
	};
}

/** A manual clock whose sleep advances time instead of waiting. */
function manualClock(start = Date.parse("2026-10-01T00:00:00.000Z")) {
	let current = start;
	const sleeps: number[] = [];
	return {
		now: () => current,
		sleep: (ms: number) => {
			sleeps.push(ms);
			current += ms;
			return Promise.resolve();
		},
		sleeps,
	};
}

describe("requestApproval helper", () => {
	test("publishes an approval with expiresAt at the deadline, then polls until answered", async () => {
		const clock = manualClock();
		const fake = approvalClient(pending("evt_a"), [
			pending("evt_a"),
			pending("evt_a", "approved", "ok"),
		]);
		const published: string[] = [];
		const result = await requestApproval(
			fake.client,
			{
				title: "Ship v2?",
				prompt: "Ship build 184?",
				timeoutMs: 60_000,
				callbackUrl: "https://deploy.example.com/notify",
				callbackSecret: "callback-secret",
			},
			{
				idempotencyKey: "approve-184",
				pollIntervalMs: 1000,
				onPublished: (value) => published.push(value.id),
			},
			clock
		);
		expect(result).toMatchObject({
			approved: true,
			status: "approved",
			timedOut: false,
			value: "ok",
		});
		expect(published).toEqual(["evt_a"]);
		expect(fake.polls()).toBe(2);
		expect(clock.sleeps).toEqual([1000, 1000]);
		expect(fake.publishCalls).toEqual([
			{
				input: {
					title: "Ship v2?",
					response: {
						type: "approval",
						expiresAt: "2026-10-01T00:01:00.000Z",
						prompt: "Ship build 184?",
						callbackUrl: "https://deploy.example.com/notify",
						callbackSecret: "callback-secret",
					},
				},
				key: "approve-184",
			},
		]);
	});

	test("denied and no are answers, not approvals", async () => {
		for (const status of ["denied", "no"]) {
			const fake = approvalClient(pending("evt_d"), [pending("evt_d", status)]);
			const result = await requestApproval(
				fake.client,
				{ title: "x", responseType: status === "no" ? "yes_no" : "approval" },
				{},
				manualClock()
			);
			expect(result.approved).toBe(false);
			expect(result.timedOut).toBe(false);
			expect(result.status).toBe(status as "denied");
		}
	});

	test("an already answered replay settles without polling", async () => {
		const fake = approvalClient(pending("evt_r", "yes"), []);
		const result = await requestApproval(
			fake.client,
			{ title: "x" },
			{},
			manualClock()
		);
		expect(result.approved).toBe(true);
		expect(fake.polls()).toBe(0);
	});

	test("an expired response times out", async () => {
		const fake = approvalClient(pending("evt_e"), [
			pending("evt_e", "expired"),
		]);
		const result = await requestApproval(
			fake.client,
			{ title: "x", timeoutMs: 5000 },
			{},
			manualClock()
		);
		expect(result).toMatchObject({
			approved: false,
			status: "expired",
			timedOut: true,
		});
	});

	test("still pending at the deadline: one last read, then timedOut", async () => {
		const clock = manualClock();
		const fake = approvalClient(pending("evt_p"), [pending("evt_p")]);
		const result = await requestApproval(
			fake.client,
			{ title: "x", timeoutMs: 2500 },
			{ pollIntervalMs: 1000 },
			clock
		);
		expect(result).toMatchObject({ status: "pending", timedOut: true });
		// 1000 + 1000 + the 500 left before the deadline.
		expect(clock.sleeps).toEqual([1000, 1000, 500]);
		expect(fake.polls()).toBe(3);
	});

	test("waitMs stops waiting while the request stays open", async () => {
		const clock = manualClock();
		const fake = approvalClient(pending("evt_w"), [pending("evt_w")]);
		const result = await requestApproval(
			fake.client,
			{ title: "x", timeoutMs: 600_000 },
			{ pollIntervalMs: 1000, waitMs: 2500 },
			clock
		);
		expect(result).toMatchObject({
			approved: false,
			status: "pending",
			timedOut: false,
			value: null,
		});
		expect(result.event.id).toBe("evt_w");
		expect(clock.sleeps).toEqual([1000, 1000, 500]);
		const sent = fake.publishCalls[0]?.input as {
			response: { expiresAt: string };
		};
		// The request itself still expires at timeoutMs, not at waitMs.
		expect(Date.parse(sent.response.expiresAt)).toBe(
			Date.parse("2026-10-01T00:00:00.000Z") + 600_000
		);
	});

	test("waitMs at or past timeoutMs changes nothing; a bad waitMs is rejected", async () => {
		const clock = manualClock();
		const fake = approvalClient(pending("evt_v"), [pending("evt_v")]);
		const result = await requestApproval(
			fake.client,
			{ title: "x", timeoutMs: 1500 },
			{ pollIntervalMs: 1000, waitMs: 60_000 },
			clock
		);
		expect(result).toMatchObject({ status: "pending", timedOut: true });
		expect(clock.sleeps).toEqual([1000, 500]);
		const error = await rejection(
			requestApproval(fake.client, { title: "x" }, { waitMs: 0 }, manualClock())
		);
		expect(error.code).toBe("invalid_timeout");
	});

	test("defaults: 10 minute timeout, poll interval clamped to the minimum", async () => {
		const clock = manualClock();
		const fake = approvalClient(pending("evt_m"), [
			pending("evt_m", "approved"),
		]);
		await requestApproval(
			fake.client,
			{ title: "x" },
			{ pollIntervalMs: 1 },
			clock
		);
		expect(clock.sleeps).toEqual([MIN_APPROVAL_POLL_INTERVAL_MS]);
		const sent = fake.publishCalls[0]?.input as {
			response: { expiresAt: string };
		};
		expect(Date.parse(sent.response.expiresAt)).toBe(
			Date.parse("2026-10-01T00:00:00.000Z") + DEFAULT_APPROVAL_TIMEOUT_MS
		);
	});

	test("rejects a bad timeout or response type before publishing", async () => {
		const fake = approvalClient(pending("evt_x"), []);
		for (const input of [
			{ title: "x", timeoutMs: 0 },
			{ title: "x", timeoutMs: Number.NaN },
			{ title: "x", responseType: "text" as "approval" },
		]) {
			const error = await rejection(
				requestApproval(fake.client, input, {}, manualClock())
			);
			expect(error).toBeInstanceOf(RyuInvalidRequestError);
			expect(error.status).toBe(0);
		}
		expect(fake.publishCalls).toHaveLength(0);
	});

	test("rejects timeouts and poll intervals beyond what timers can hold", async () => {
		const fake = approvalClient(pending("evt_y"), []);
		const cases: [{ title: string; timeoutMs?: number }, object][] = [
			[{ title: "x", timeoutMs: 1e16 }, {}],
			[{ title: "x", timeoutMs: MAX_APPROVAL_DURATION_MS + 1 }, {}],
			[{ title: "x" }, { pollIntervalMs: MAX_APPROVAL_DURATION_MS + 1 }],
		];
		for (const [input, options] of cases) {
			const error = await rejection(
				requestApproval(fake.client, input, options, manualClock())
			);
			expect(error).toBeInstanceOf(RyuInvalidRequestError);
			expect(error.code).toBe("invalid_timeout");
		}
		expect(fake.publishCalls).toHaveLength(0);
	});

	test("the largest timeout is accepted and sent as expiresAt", async () => {
		const fake = approvalClient(pending("evt_z", "approved"), []);
		const result = await requestApproval(
			fake.client,
			{ title: "x", timeoutMs: MAX_APPROVAL_DURATION_MS },
			{},
			manualClock()
		);
		expect(result.approved).toBe(true);
		const sent = fake.publishCalls[0]?.input as {
			response: { expiresAt: string };
		};
		expect(Date.parse(sent.response.expiresAt)).toBe(
			Date.parse("2026-10-01T00:00:00.000Z") + MAX_APPROVAL_DURATION_MS
		);
	});

	test("an event without a response is an invalid response", async () => {
		const fake = approvalClient(event("evt_n"), []);
		const error = await rejection(
			requestApproval(fake.client, { title: "x" }, {}, manualClock())
		);
		expect(error).toBeInstanceOf(RyuResponseValidationError);
	});

	test("an aborted signal stops before publishing", async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = approvalClient(pending("evt_s"), []);
		await expect(
			requestApproval(
				fake.client,
				{ title: "x" },
				{},
				{ callSignal: controller.signal }
			)
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fake.publishCalls).toHaveLength(0);
	});
});

describe("ryu.notify.requestApproval", () => {
	test("publishes through the facade with one key and polls events.get", async () => {
		let polls = 0;
		const { calls, fetch } = stubFetch((request) => {
			if (request.method === "POST") {
				return Response.json(
					eventBody(pending("evt_f"), { idempotent: false }),
					{
						status: 201,
					}
				);
			}
			polls += 1;
			return Response.json(
				eventBody(polls === 1 ? pending("evt_f", "approved") : pending("evt_f"))
			);
		});
		const ryu = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, error, meta } = await ryu.notify
			.with({ idempotencyKey: "approve-ship-v2" })
			.requestApproval(
				{ title: "Ship v2?", timeoutMs: 60_000 },
				{ pollIntervalMs: MIN_APPROVAL_POLL_INTERVAL_MS }
			);
		expect(error).toBeNull();
		expect(data?.approved).toBe(true);
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual(["POST /v1/events", "GET /v1/events/evt_f"]);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("approve-ship-v2");
		const body = JSON.parse(calls[0]?.body ?? "{}") as {
			response: { type: string; expiresAt: string };
		};
		expect(body.response.type).toBe("approval");
		expect(Number.isNaN(Date.parse(body.response.expiresAt))).toBe(false);
		// meta describes the last response: the poll.
		expect(meta?.status).toBe(200);
	});

	test("a signal bound with .with() aborts the wait as RyuAbortError", async () => {
		const controller = new AbortController();
		const { fetch } = stubFetch((request) => {
			if (request.method === "POST") {
				queueMicrotask(() => controller.abort());
				return Response.json(eventBody(pending("evt_g")), { status: 201 });
			}
			return Response.json(eventBody(pending("evt_g")));
		});
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(
			ryu.notify
				.with({ signal: controller.signal })
				.requestApproval({ title: "x", timeoutMs: 60_000 })
		);
		expect(error).toBeInstanceOf(RyuAbortError);
	});

	test("an options signal cancels an in-flight publish as RyuAbortError", async () => {
		const controller = new AbortController();
		let sawSignal = false;
		const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("the publish carried no signal"));
					return;
				}
				sawSignal = true;
				signal.addEventListener(
					"abort",
					() => reject(signal.reason ?? new Error("aborted")),
					{ once: true }
				);
				queueMicrotask(() => controller.abort());
			});
		const ryu = new Ryu({ env: ENV, fetch });
		const started = Date.now();
		const error = await rejection(
			ryu.notify.requestApproval(
				{ title: "x", timeoutMs: 60_000 },
				{ signal: controller.signal }
			)
		);
		expect(sawSignal).toBe(true);
		expect(error).toBeInstanceOf(RyuAbortError);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test("an options signal cancels an in-flight poll", async () => {
		const controller = new AbortController();
		let polls = 0;
		const fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				return Promise.resolve(
					Response.json(eventBody(pending("evt_p")), { status: 201 })
				);
			}
			polls += 1;
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				signal?.addEventListener(
					"abort",
					() => reject(signal.reason ?? new Error("aborted")),
					{ once: true }
				);
				queueMicrotask(() => controller.abort());
			});
		};
		const ryu = new Ryu({ env: ENV, fetch });
		const error = await rejection(
			ryu.notify.requestApproval(
				{ title: "x", timeoutMs: 60_000 },
				{
					pollIntervalMs: MIN_APPROVAL_POLL_INTERVAL_MS,
					signal: controller.signal,
				}
			)
		);
		expect(polls).toBe(1);
		expect(error).toBeInstanceOf(RyuAbortError);
	});
});
