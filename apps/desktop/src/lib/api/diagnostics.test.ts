// apps/desktop/src/lib/api/diagnostics.test.ts
//
// `sendDiagnosticsTestSpan` against a real loopback HTTP server that speaks
// Core's `POST /api/diagnostics/otlp/test-span` contract (apps/core
// `diagnostics_otlp_test_span`): 200 `{ ok: true, span, endpoint }`, 409 for a
// refused request (export off, no endpoint, invalid endpoint) and 502 for a
// failed flush, both `{ ok: false, error }`. Nothing is stubbed: the typed
// client, the request choke point and its error mapping all run for real, so
// the cases assert the result the Privacy page turns into a toast.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { ApiError } from "./client.ts";
import { sendDiagnosticsTestSpan } from "./diagnostics.ts";

interface Reply {
	body?: string;
	status: number;
}
interface Seen {
	authorization: string | null;
	body: string;
	method: string;
	path: string;
}

const TOKEN = "diagnostics-test-token";
const OWN_ENDPOINT = "https://collector.example.test";
let reply: Reply = { status: 200 };
let seen: Seen[] = [];

const core = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		seen.push({
			authorization: request.headers.get("authorization"),
			body: await request.text(),
			method: request.method,
			path: new URL(request.url).pathname,
		});
		return new Response(reply.body ?? "", {
			headers: { "content-type": "application/json" },
			status: reply.status,
		});
	},
});
const target = { token: TOKEN, url: core.url.origin, userJwt: null };

function replyWith(status: number, body?: unknown) {
	reply = {
		body: body === undefined ? undefined : JSON.stringify(body),
		status,
	};
}

beforeEach(() => {
	reply = { status: 200 };
	seen = [];
});
afterAll(() => {
	core.stop(true);
});

describe("sendDiagnosticsTestSpan against Core's test-span route", () => {
	it("POSTs once with no body and the node's bearer, and resolves Core's endpoint on a 200", async () => {
		replyWith(200, { ok: true, span: "ryu.test", endpoint: OWN_ENDPOINT });
		expect(await sendDiagnosticsTestSpan(target)).toEqual({
			ok: true,
			endpoint: OWN_ENDPOINT,
		});
		expect(seen).toEqual([
			{
				authorization: `Bearer ${TOKEN}`,
				body: "",
				method: "POST",
				path: "/api/diagnostics/otlp/test-span",
			},
		]);
	});

	it.each([
		["an empty object", {}],
		["ok false", { ok: false, span: "ryu.test", endpoint: OWN_ENDPOINT }],
		["no endpoint", { ok: true, span: "ryu.test" }],
		["no span", { ok: true, endpoint: OWN_ENDPOINT }],
		["a numeric endpoint", { ok: true, span: "ryu.test", endpoint: 7 }],
		["an array", [{ ok: true, span: "ryu.test", endpoint: OWN_ENDPOINT }]],
	])("reports an unexpected 200 body (%s) as a failure instead of a success", async (_name, body) => {
		replyWith(200, body);
		expect(await sendDiagnosticsTestSpan(target)).toEqual({
			ok: false,
			status: 200,
			message: "Core returned an unexpected test-span response.",
		});
	});

	it("reports an empty 200 body as the same unexpected-response failure", async () => {
		replyWith(200);
		expect(await sendDiagnosticsTestSpan(target)).toEqual({
			ok: false,
			status: 200,
			message: "Core returned an unexpected test-span response.",
		});
	});

	it.each([
		[
			"a 409 refusal because export consent is off",
			409,
			{
				ok: false,
				error:
					"diagnostics export is off (or the endpoint changed; restart Core to apply it)",
			},
			"diagnostics export is off (or the endpoint changed; restart Core to apply it)",
		],
		[
			"a 409 refusal because no endpoint is configured",
			409,
			{ ok: false, error: "no OTLP endpoint is configured" },
			"no OTLP endpoint is configured",
		],
		[
			"a 502 failed flush",
			502,
			{
				ok: false,
				error: "export to the OTLP endpoint failed: connection refused",
			},
			"export to the OTLP endpoint failed: connection refused",
		],
		[
			"a structured error envelope",
			409,
			{ error: { code: "otlp_refused", message: "Refused by the exporter." } },
			"Refused by the exporter.",
		],
		[
			"a 404 that carries Core's own message",
			404,
			{ error: "no such route here" },
			"no such route here",
		],
	])("maps %s to a failure carrying Core's message and status", async (_name, status, body, message) => {
		replyWith(status, body);
		expect(await sendDiagnosticsTestSpan(target)).toEqual({
			ok: false,
			status,
			message,
		});
	});

	it("says an older Core is too old when the route is a bare 404", async () => {
		replyWith(404);
		expect(await sendDiagnosticsTestSpan(target)).toEqual({
			ok: false,
			status: 404,
			message: "This Core is too old to send a test span.",
		});
	});

	it.each([
		[500, "Core answered 500."],
		[401, "Core answered 401."],
		[503, "Core answered 503."],
	])("falls back to the status when a %i carries no message", async (status, message) => {
		replyWith(status);
		expect(await sendDiagnosticsTestSpan(target)).toEqual({
			ok: false,
			status,
			message,
		});
	});

	it("does not treat a non-ApiError as a Core refusal: an unreachable Core rejects", async () => {
		const closed = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("never reached"),
		});
		const unreachable = {
			token: TOKEN,
			url: closed.url.origin,
			userJwt: null,
		};
		closed.stop(true);
		let caught: unknown;
		try {
			await sendDiagnosticsTestSpan(unreachable);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		expect(caught).not.toBeInstanceOf(ApiError);
		expect(seen).toEqual([]);
	});

	it("rejects a 200 that is not JSON rather than reporting a result", async () => {
		reply = { body: "<html>index</html>", status: 200 };
		let caught: unknown;
		try {
			await sendDiagnosticsTestSpan(target);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ApiError);
		expect((caught as Error).message).toContain("not JSON");
	});
});
