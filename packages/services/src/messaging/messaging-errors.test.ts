import { describe, expect, test } from "bun:test";
import { MessagingError } from "@ryuhq/client";
import {
	RyuAuthenticationError,
	RyuPaymentRequiredError,
	RyuPermissionError,
	RyuRateLimitError,
	RyuRedirectError,
	RyuServerError,
	toRyuError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import {
	BASE,
	caught,
	ENV,
	MESSAGE,
	refusal,
	ryuObject,
	ryuWith,
	SETTINGS,
	SMS,
	stubFetch,
} from "./messaging.test-helper.ts";
import { MESSAGING_DOCS, messagingErrorRecord } from "./namespace.ts";

// A Messaging refusal, rendered exactly as the server's
// `messagingErrorResponse` renders it (messaging.test-helper.ts `refusal`),
// becomes the matching RyuError.

describe("MessagingError becomes RyuError", () => {
	test("402 insufficient_credits keeps code, details, request id and the client error as cause", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(
				402,
				"insufficient_credits",
				"This organization's available credit does not cover this charge. Add credits and retry.",
				{ details: { availableMicroUsd: 1200, requiredMicroUsd: 8400 } }
			)
		);
		const error = await caught(ryuWith(fetch).messaging.sms.send(SMS));
		expect(error).toBeInstanceOf(RyuPaymentRequiredError);
		expect(error.service).toBe("messaging");
		expect(error.code).toBe("insufficient_credits");
		expect(error.envelope).toBe("messaging");
		expect(error.details).toEqual({
			availableMicroUsd: 1200,
			requiredMicroUsd: 8400,
		});
		expect(error.requestId).toBe("req_insufficient_credits");
		expect(error.retryable).toBe(false);
		expect(error.cause).toBeInstanceOf(MessagingError);
		expect(error.method).toBe("POST");
		expect(error.url).toBe(`${BASE}/sms`);
		expect(error.idempotencyKey).toBe(
			calls[0]?.headers.get("idempotency-key") ?? ""
		);
		expect(calls).toHaveLength(1);
	});

	test("502 outcome_unknown is never retried and carries the stored message", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(
				502,
				"outcome_unknown",
				"AWS End User Messaging did not confirm this send, so it may have been sent; check this message before sending it again",
				{ details: { messageRecord: { ...MESSAGE, status: "unresolved" } } }
			)
		);
		const error = await caught(ryuWith(fetch).messaging.sms.send(SMS));
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.code).toBe("outcome_unknown");
		expect(error.retryable).toBe(false);
		expect(error.attempts).toBe(1);
		expect(messagingErrorRecord(error)?.status).toBe("unresolved");
		expect(messagingErrorRecord(new Error("x"))).toBeNull();
	});

	test("502 provider_refused is sent once, is not retryable, and keeps the first record", async () => {
		// The server releases the key's claim on a refusal, so a same-key retry
		// would run a whole new send (another row, another send-rate unit).
		const { calls, fetch } = stubFetch((_request, index) =>
			refusal(
				502,
				"provider_refused",
				"AWS End User Messaging refused this send; nothing was charged",
				{
					details: {
						messageRecord: {
							...MESSAGE,
							id: `msg_${index}`,
							status: "refused",
						},
					},
				}
			)
		);
		const error = await caught(
			ryuWith(fetch).messaging.sms.send(SMS, { idempotencyKey: "k1" })
		);
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.code).toBe("provider_refused");
		expect(error.retryable).toBe(false);
		expect(error.attempts).toBe(1);
		expect(messagingErrorRecord(error)?.id).toBe("msg_0");
		expect(messagingErrorRecord(error)?.status).toBe("refused");
	});

	test("502 media_upload_failed is retried with the same key as a fresh attempt", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(
						502,
						"media_upload_failed",
						"the media could not be staged for sending; nothing was sent or charged"
					)
				: Response.json({ message: MESSAGE }, { status: 202 })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		const message = await ryu.messaging.mms.send(
			{
				from: "num_1",
				to: "+6591234567",
				media: { base64: "AAAA", contentType: "image/png" },
			},
			{ idempotencyKey: "k2" }
		);
		expect(message.id).toBe("msg_1");
		expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"k2",
			"k2",
		]);
	});

	test("settings.update (PUT) is never replayed after a 5xx, so a created secret is not lost", async () => {
		// The first PUT may have created the secret before its reply was lost (a
		// 502 from a proxy). A replay would answer without the secret, so the
		// route table lists the PUT as non-replay-safe and the error surfaces.
		const { calls, fetch } = stubFetch(() =>
			refusal(502, "bad_gateway", "Bad Gateway", { retryAfterSeconds: 0 })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 2 });
		const error = await caught(
			ryu.messaging.settings.update({
				webhookUrl: "https://example.com/hooks/messaging",
			})
		);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(calls.map((call) => call.method)).toEqual(["PUT"]);
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("settings.update (PUT) is not replayed after a network error either", async () => {
		const { calls, fetch } = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const ryu = new Ryu({
			env: ENV,
			fetch,
			maxRetries: 2,
			maxRetryDelayMs: 5000,
		});
		const error = await caught(
			ryu.messaging.settings.update({
				webhookUrl: "https://example.com/hooks/messaging",
			})
		);
		expect(error.code).toBe("connection_error");
		expect(calls).toHaveLength(1);
	});

	test("settings.update (PUT) is still retried on a 429 that names a wait", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(429, "rate_limited", "Slow down", { retryAfterSeconds: 0 })
				: Response.json({
						settings: {
							...SETTINGS,
							webhookUrl: "https://example.com/hooks/messaging",
							webhookSecretSet: true,
						},
						webhookSecret: "whsec_once",
					})
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		const reply = await ryu.messaging.settings.update({
			webhookUrl: "https://example.com/hooks/messaging",
		});
		expect(calls.map((call) => call.method)).toEqual(["PUT", "PUT"]);
		expect(reply.webhookSecret).toBe("whsec_once");
	});

	test("settings.get (GET) on the same path is still retried", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(502, "bad_gateway", "Bad Gateway")
				: Response.json({ settings: SETTINGS })
		);
		const ryu = new Ryu({
			env: ENV,
			fetch,
			maxRetries: 1,
			maxRetryDelayMs: 5000,
		});
		await ryu.messaging.settings.get();
		expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
	});

	test("optOuts.remove (DELETE) is retried on a 502", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(
						502,
						"provider_error",
						"AWS End User Messaging did not answer; retry later"
					)
				: Response.json({ deleted: true })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		await ryu.messaging.optOuts.remove("+15555550101");
		expect(calls.map((call) => call.method)).toEqual(["DELETE", "DELETE"]);
		expect(calls[1]?.url).toBe(`${BASE}/opt-outs/%2B15555550101`);
	});

	test("409 outcome_unknown on a replayed key is not retried either", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(409, "outcome_unknown", "the first request's outcome is unknown")
		);
		const error = await caught(
			ryuWith(fetch).messaging.mms.send({
				from: "num_1",
				to: "+6591234567",
				media: { base64: "AAAA", contentType: "image/png" },
			})
		);
		expect(error.code).toBe("outcome_unknown");
		expect(calls).toHaveLength(1);
	});

	test("a 429 puts limit and window in details and surfaces a wait longer than maxRetryDelayMs", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(
				429,
				"send_rate_limited",
				"this organization reached its 1000 sends per hour limit",
				{ details: { limit: 1000, window: "hour" }, retryAfterSeconds: 1800 }
			)
		);
		const error = await caught(ryuWith(fetch).messaging.sms.send(SMS));
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.code).toBe("send_rate_limited");
		expect(error.details).toEqual({ limit: 1000, window: "hour" });
		expect(error.retryAfterSeconds).toBe(1800);
	});

	test("a short 429 wait is retried with the same key", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(429, "send_rate_limited", "per minute", {
						details: { limit: 60, window: "minute" },
						retryAfterSeconds: 0,
					})
				: Response.json({ message: MESSAGE }, { status: 202 })
		);
		await ryuWith(fetch).messaging.sms.send(SMS);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.headers.get("idempotency-key")).toBe(
			calls[0]?.headers.get("idempotency-key") ?? ""
		);
	});

	test("403 feature_disabled and the 404 rollout gate get the early-access hint", async () => {
		const disabled = stubFetch(() =>
			refusal(
				403,
				"feature_disabled",
				"Ryu Messaging is disabled for this organization"
			)
		);
		const featureError = await caught(
			ryuWith(disabled.fetch).messaging.numbers.list()
		);
		expect(featureError).toBeInstanceOf(RyuPermissionError);
		expect(featureError.hint).toContain("Ryu Messaging feature is off");
		expect(featureError.docs).toBe(MESSAGING_DOCS);

		const gated = stubFetch(() =>
			refusal(
				404,
				"not_found",
				"Ryu Messaging is not available for this organization"
			)
		);
		const gateError = await caught(ryuWith(gated.fetch).messaging.status());
		expect(gateError.hint).toContain("early access");

		const missing = stubFetch(() =>
			refusal(404, "not_found", "message not found")
		);
		const missingError = await caught(
			ryuWith(missing.fetch).messaging.messages.get("nope")
		);
		expect(missingError.hint).toBeNull();
	});

	test("a 401 keeps WWW-Authenticate and names both credential env vars", async () => {
		const { fetch } = stubFetch(() =>
			refusal(401, "unauthenticated", "invalid API key", {
				headers: { "www-authenticate": 'Bearer realm="ryu"' },
			})
		);
		const error = await caught(ryuWith(fetch).messaging.settings.get());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.authChallenge).toBe('Bearer realm="ryu"');
		expect(error.hint).toContain("RYU_API_KEY and RYU_ORGANIZATION_ID");
	});

	test("a reply without the {error, message} body maps by status", async () => {
		const { fetch } = stubFetch(
			() => new Response("upstream down", { status: 503 })
		);
		const error = await caught(ryuWith(fetch).messaging.settings.get());
		expect(error.code).toBe("service_unavailable");
		expect(error.envelope).toBe("text");
	});

	test("a redirect is refused and never followed", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.redirect("https://evil.example.com/steal?k=1", 302)
		);
		const error = await caught(ryuWith(fetch).messaging.settings.get());
		expect(error).toBeInstanceOf(RyuRedirectError);
		expect(error.code).toBe("redirect_refused");
		expect(calls).toHaveLength(1);
	});

	test("toRyuError converts a bare MessagingError", () => {
		const error = toRyuError(
			new MessagingError({
				code: "price_changed",
				details: { actualMicroUsd: 2_500_000 },
				message: "AWS quoted a higher monthly price",
				retryAfterSeconds: null,
				status: 409,
			}),
			"messaging"
		);
		expect(error.code).toBe("price_changed");
		expect(error.status).toBe(409);
		expect(error.details).toEqual({ actualMicroUsd: 2_500_000 });
	});

	test("object mode resolves to { data, error, meta }", async () => {
		const { fetch } = stubFetch(() =>
			refusal(422, "recipient_opted_out", "the recipient opted out")
		);
		const result = await ryuObject(fetch).messaging.sms.send(SMS);
		expect(result.data).toBeNull();
		expect(result.error?.code).toBe("recipient_opted_out");
		expect(result.meta?.status).toBe(422);
		expect(result.meta?.requestId).toBe("req_recipient_opted_out");
	});
});
