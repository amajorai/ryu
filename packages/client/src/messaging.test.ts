import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
	createMessagingClient,
	isKnownMessagingWebhookEvent,
	MESSAGING_REDIRECT_ERROR_CODE,
	MESSAGING_UNKNOWN_ERROR_CODE,
	type MessagingAPI,
	MessagingError,
	type MessagingMessage,
	type MessagingNumber,
	type MessagingQuote,
	type MessagingSettings,
	type MessagingUnknownWebhookEvent,
	type MessagingWebhookEvent,
	MessagingWebhookVerificationError,
	type MessagingWhatsAppSender,
	messagingErrorMessageRecord,
	verifyMessagingWebhook,
} from "./messaging.ts";
import { installFetch } from "./test-fetch.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const API_KEY = "ryu_test_key_0123456789";
const ORG = "6720a3c1f0e1d2c3b4a59600";
const ORG_PATH = `/api/messaging/orgs/${ORG}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const message: MessagingMessage = {
	absorbedMicroUsd: 0,
	body: "Your code is 1234",
	bodyType: "text",
	channel: "sms",
	chargedMicroUsd: 0,
	chargeState: "held",
	createdAt: "2026-10-20T00:00:00.000Z",
	direction: "outbound",
	encoding: "GSM",
	error: null,
	estimated: false,
	from: "+12065550100",
	hasMedia: false,
	heldMicroUsd: 8830,
	id: "0b9f6a52-3f0c-4a4e-9b8e-2d6f0c3c1a10",
	isoCountryCode: "US",
	metadata: { order: "1234" },
	numberId: "num_1",
	organizationId: ORG,
	priceMicroUsd: null,
	providerMessageId: "aws-message-1",
	providerStatus: null,
	providerStatusDescription: null,
	segments: 1,
	status: "accepted",
	template: null,
	to: "+12065550123",
	ttlSeconds: 259_200,
	updatedAt: "2026-10-20T00:00:00.000Z",
	whatsappSenderId: null,
};

const number: MessagingNumber = {
	capabilities: ["SMS", "VOICE"],
	createdAt: "2026-10-20T00:00:00.000Z",
	currentPeriodEndsAt: "2026-11-19T00:00:00.000Z",
	error: null,
	graceEndsAt: null,
	id: "num_1",
	isoCountryCode: "US",
	label: "Support",
	leasePeriod: 0,
	messageType: "TRANSACTIONAL",
	monthlyLeaseMicroUsd: 2_000_000,
	numberType: "TOLL_FREE",
	organizationId: ORG,
	phoneNumber: "+18885550100",
	registrationId: null,
	releasedAt: null,
	status: "active",
	suspendedAt: null,
	twoWayEnabled: true,
	updatedAt: "2026-10-20T00:00:00.000Z",
};

const sender: MessagingWhatsAppSender = {
	createdAt: "2026-10-20T00:00:00.000Z",
	dedicatedWaba: true,
	displayPhoneNumber: "+65 8000 0000",
	id: "sender_1",
	label: null,
	organizationId: ORG,
	status: "active",
	updatedAt: "2026-10-20T00:00:00.000Z",
	wabaId: "waba-1",
};

const settings: MessagingSettings = {
	allowedCountries: ["SG", "US"],
	dailySendLimit: null,
	defaultDailySendLimit: 1000,
	organizationId: ORG,
	webhookSecretSet: true,
	webhookUrl: "https://hooks.example.com/ryu",
};

const credit = { availableMicroUsd: 5_000_000, heldMicroUsd: 8830 };

interface Seen {
	body: unknown;
	headers: Headers;
	method: string;
	url: URL;
}

/** Install a fetch that records every request and answers with `reply`. */
function capture(
	reply: unknown,
	init: { headers?: Record<string, string>; status?: number } = {}
): Seen[] {
	const seen: Seen[] = [];
	installFetch(async (input, requestInit) => {
		seen.push({
			body:
				typeof requestInit?.body === "string"
					? JSON.parse(requestInit.body)
					: undefined,
			headers: new Headers(requestInit?.headers),
			method: requestInit?.method ?? "GET",
			url: new URL(String(input)),
		});
		return new Response(
			typeof reply === "string" ? reply : JSON.stringify(reply),
			{
				headers: { "Content-Type": "application/json", ...init.headers },
				status: init.status ?? 200,
			}
		);
	});
	return seen;
}

function client(): MessagingAPI {
	return createMessagingClient({
		apiKey: API_KEY,
		baseUrl: "https://api.ryu.test/",
		organizationId: ORG,
	});
}

/** The single request sent; throws when there were none or several. */
function only(seen: Seen[]): Seen {
	const [first] = seen;
	if (!first || seen.length !== 1) {
		throw new Error(`expected one request, saw ${seen.length}`);
	}
	return first;
}

describe("Messaging client transport", () => {
	test("sends the API key and organization, and generates an Idempotency-Key for a send", async () => {
		const seen = capture({ message });
		const result = await client().sms.send({
			body: "Your code is 1234",
			from: "num_1",
			metadata: { order: "1234" },
			to: "+12065550123",
		});
		expect(result).toEqual(message);
		const request = only(seen);
		expect(request.method).toBe("POST");
		expect(request.url.href).toBe(`https://api.ryu.test${ORG_PATH}/sms`);
		expect(request.headers.get("x-api-key")).toBe(API_KEY);
		expect(request.headers.get("X-Ryu-Organization")).toBe(ORG);
		expect(request.headers.get("Content-Type")).toBe("application/json");
		expect(request.headers.get("Idempotency-Key")).toMatch(UUID);
		expect(request.body).toEqual({
			body: "Your code is 1234",
			from: "num_1",
			metadata: { order: "1234" },
			to: "+12065550123",
		});
	});

	test("uses the caller's Idempotency-Key and a fresh key for each unkeyed send", async () => {
		const seen = capture({ message });
		const messaging = client();
		await messaging.sms.send(
			{ body: "hi", from: "num_1", to: "+12065550123" },
			{ idempotencyKey: "order-1234-sms" }
		);
		await messaging.sms.send({ body: "hi", from: "num_1", to: "+12065550123" });
		await messaging.sms.send({ body: "hi", from: "num_1", to: "+12065550123" });
		const keys = seen.map((entry) => entry.headers.get("Idempotency-Key"));
		expect(keys[0]).toBe("order-1234-sms");
		expect(keys[1]).toMatch(UUID);
		expect(keys[2]).toMatch(UUID);
		expect(keys[1]).not.toBe(keys[2]);
	});

	test("number purchases carry an Idempotency-Key; reads and plain writes do not", async () => {
		const bought = capture({ number }, { status: 201 });
		const result = await client().numbers.buy({
			capabilities: ["SMS", "VOICE"],
			isoCountryCode: "US",
			label: "Support",
			numberType: "TOLL_FREE",
		});
		expect(result).toEqual(number);
		const buy = only(bought);
		expect(buy.url.pathname).toBe(`${ORG_PATH}/numbers`);
		expect(buy.headers.get("Idempotency-Key")).toMatch(UUID);

		const listed = capture({ numbers: [number] });
		expect(await client().numbers.list()).toEqual([number]);
		expect(only(listed).headers.has("Idempotency-Key")).toBe(false);
		expect(only(listed).headers.has("Content-Type")).toBe(false);
		expect(only(listed).url.search).toBe("");
		const history = capture({ numbers: [number] });
		await client().numbers.list({ status: "all" });
		expect(only(history).url.search).toBe("?status=all");
	});

	test("maps every resource method to its route", async () => {
		const cases: [
			string,
			(messaging: MessagingAPI) => Promise<unknown>,
			unknown,
			string,
			string,
			unknown,
		][] = [
			[
				"status",
				(m) => m.status(),
				{
					apiVersion: "v1",
					channels: { mms: false, sms: true, voice: true, whatsapp: true },
					configured: true,
				},
				"GET",
				"/api/messaging/status",
				undefined,
			],
			[
				"numbers.quote",
				(m) => m.numbers.quote({ country: "US", type: "TOLL_FREE" }),
				{
					credit,
					isoCountryCode: "US",
					numberType: "TOLL_FREE",
					quote: {
						ceilingMicroUsd: 2_000_000,
						monthlyLeaseMicroUsd: 2_000_000,
						setupFeeMicroUsd: 0,
					},
				},
				"GET",
				`${ORG_PATH}/numbers/quote?country=US&type=TOLL_FREE`,
				undefined,
			],
			[
				"numbers.update",
				(m) => m.numbers.update("num 1", { label: null }),
				{ number },
				"PATCH",
				`${ORG_PATH}/numbers/num%201`,
				{ label: null },
			],
			[
				"numbers.release",
				(m) => m.numbers.release("num_1"),
				{ number: { ...number, status: "released" } },
				"DELETE",
				`${ORG_PATH}/numbers/num_1`,
				undefined,
			],
			[
				"mms.send",
				(m) =>
					m.mms.send({
						from: "num_1",
						media: { base64: "aGk=", contentType: "image/png" },
						to: "+12065550123",
					}),
				{ message: { ...message, bodyType: "media", channel: "mms" } },
				"POST",
				`${ORG_PATH}/mms`,
				{
					from: "num_1",
					media: { base64: "aGk=", contentType: "image/png" },
					to: "+12065550123",
				},
			],
			[
				"voice.send",
				(m) =>
					m.voice.send({
						from: "num_1",
						text: "Your code is 1 2 3 4",
						to: "+12065550123",
					}),
				{ message: { ...message, channel: "voice", encoding: null } },
				"POST",
				`${ORG_PATH}/voice`,
				{ from: "num_1", text: "Your code is 1 2 3 4", to: "+12065550123" },
			],
			[
				"whatsapp.send",
				(m) =>
					m.whatsapp.send({
						senderId: "sender_1",
						template: { language: "en_US", name: "order_ready" },
						to: "+6580000001",
					}),
				{
					message: {
						...message,
						bodyType: "template",
						channel: "whatsapp",
						template: { language: "en_US", name: "order_ready" },
					},
				},
				"POST",
				`${ORG_PATH}/whatsapp`,
				{
					senderId: "sender_1",
					template: { language: "en_US", name: "order_ready" },
					to: "+6580000001",
				},
			],
			[
				"whatsapp.senders",
				(m) => m.whatsapp.senders(),
				{ senders: [sender] },
				"GET",
				`${ORG_PATH}/whatsapp/senders`,
				undefined,
			],
			[
				"whatsapp.templates.list",
				(m) => m.whatsapp.templates.list("sender_1", { nextToken: "t2" }),
				{
					nextToken: null,
					templates: [
						{
							category: "UTILITY",
							language: "en_US",
							metaTemplateId: "123",
							name: "order_ready",
							qualityScore: null,
							status: "APPROVED",
						},
					],
				},
				"GET",
				`${ORG_PATH}/whatsapp/senders/sender_1/templates?nextToken=t2`,
				undefined,
			],
			[
				"whatsapp.templates.create",
				(m) =>
					m.whatsapp.templates.create("sender_1", {
						category: "UTILITY",
						name: "order_ready",
					}),
				{
					template: {
						category: "UTILITY",
						metaTemplateId: "123",
						status: "PENDING",
					},
				},
				"POST",
				`${ORG_PATH}/whatsapp/senders/sender_1/templates`,
				{ definition: { category: "UTILITY", name: "order_ready" } },
			],
			[
				"messages.list",
				(m) =>
					m.messages.list({
						channel: "sms",
						cursor: "eyJhdCI6MX0",
						direction: "outbound",
						limit: 25,
						status: "delivered",
					}),
				{ messages: [message], nextCursor: "next" },
				"GET",
				`${ORG_PATH}/messages?channel=sms&cursor=eyJhdCI6MX0&direction=outbound&limit=25&status=delivered`,
				undefined,
			],
			[
				"messages.get",
				(m) => m.messages.get(message.id),
				{ message },
				"GET",
				`${ORG_PATH}/messages/${message.id}`,
				undefined,
			],
			[
				"optOuts.list",
				(m) => m.optOuts.list(),
				{
					nextToken: null,
					optOuts: [
						{
							endUserOptedOut: true,
							optedOutAt: "2026-10-19T00:00:00.000Z",
							phoneNumber: "+12065550123",
						},
					],
				},
				"GET",
				`${ORG_PATH}/opt-outs`,
				undefined,
			],
			[
				"optOuts.add",
				(m) => m.optOuts.add("+12065550123"),
				{ optOut: { phoneNumber: "+12065550123" } },
				"POST",
				`${ORG_PATH}/opt-outs`,
				{ phoneNumber: "+12065550123" },
			],
			[
				"optOuts.remove",
				(m) => m.optOuts.remove("+12065550123"),
				{ deleted: true },
				"DELETE",
				`${ORG_PATH}/opt-outs/%2B12065550123`,
				undefined,
			],
			[
				"settings.get",
				(m) => m.settings.get(),
				{ settings },
				"GET",
				`${ORG_PATH}/settings`,
				undefined,
			],
			[
				"settings.update",
				(m) =>
					m.settings.update({
						allowedCountries: ["SG"],
						webhookUrl: "https://hooks.example.com/ryu",
					}),
				{ settings, webhookSecret: "whsec_c2VjcmV0" },
				"PUT",
				`${ORG_PATH}/settings`,
				{
					allowedCountries: ["SG"],
					webhookUrl: "https://hooks.example.com/ryu",
				},
			],
			[
				"settings.rotateWebhookSecret",
				(m) => m.settings.rotateWebhookSecret(),
				{ settings, webhookSecret: "whsec_c2VjcmV0" },
				"POST",
				`${ORG_PATH}/settings/webhook-secret/rotate`,
				undefined,
			],
		];
		for (const [name, call, reply, method, path, body] of cases) {
			const seen = capture(reply);
			const result = await call(client());
			const request = only(seen);
			expect([name, request.method]).toEqual([name, method]);
			expect([name, `${request.url.pathname}${request.url.search}`]).toEqual([
				name,
				path,
			]);
			expect([name, request.body]).toEqual([name, body]);
			expect([name, request.headers.has("Idempotency-Key")]).toEqual([
				name,
				name.endsWith(".send"),
			]);
			expect([name, request.headers.get("x-api-key")]).toEqual([name, API_KEY]);
			if (name !== "optOuts.remove") {
				expect(result).toBeDefined();
			}
		}
	});

	test("quote sends the channel inputs as query parameters", async () => {
		const reply: MessagingQuote = {
			channel: "voice",
			credit,
			quote: {
				ceilingMicroUsd: 39_000,
				estimatedMinutes: 2,
				isoCountryCode: "US",
				perMinuteMicroUsd: 19_500,
			},
		};
		const seen = capture(reply);
		const result = await client().quote({
			body: "<speak>Hello</speak>",
			bodyType: "ssml",
			channel: "voice",
			to: "+12065550123",
		});
		expect(result).toEqual(reply);
		const request = only(seen);
		expect(request.url.pathname).toBe(`${ORG_PATH}/quote`);
		expect(Object.fromEntries(request.url.searchParams)).toEqual({
			body: "<speak>Hello</speak>",
			bodyType: "ssml",
			channel: "voice",
			to: "+12065550123",
		});
	});

	test("replies keep fields the server adds later", async () => {
		capture({ message: { ...message, futureField: "kept" } });
		const result = await client().messages.get(message.id);
		expect(result).toEqual({ ...message, futureField: "kept" } as never);
	});

	test("malformed replies are rejected", async () => {
		capture({ message: { ...message, status: "teleported" } });
		await expect(client().messages.get(message.id)).rejects.toThrow();
		capture({ numbers: [{ ...number, monthlyLeaseMicroUsd: 1.5 }] });
		await expect(client().numbers.list()).rejects.toThrow();
		capture({ channel: "sms", credit, quote: { ceilingMicroUsd: 1 } });
		await expect(
			client().quote({ body: "hi", channel: "sms", to: "+12065550123" })
		).rejects.toThrow();
	});
});

describe("Messaging client errors", () => {
	test("a refusal carries its stable code, details and Retry-After", async () => {
		capture(
			{
				availableMicroUsd: 10,
				error: "insufficient_credits",
				message: "Add credits and retry.",
				requiredMicroUsd: 8830,
			},
			{ headers: { "Retry-After": "30" }, status: 402 }
		);
		const error = await client()
			.sms.send({ body: "hi", from: "num_1", to: "+12065550123" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MessagingError);
		if (!(error instanceof MessagingError)) {
			throw new Error("expected a MessagingError");
		}
		expect(error.status).toBe(402);
		expect(error.code).toBe("insufficient_credits");
		expect(error.message).toBe("Add credits and retry.");
		expect(error.details).toEqual({
			availableMicroUsd: 10,
			requiredMicroUsd: 8830,
		});
		expect(error.retryAfterSeconds).toBe(30);
	});

	test("an unconfirmed send carries its stored message record", async () => {
		capture(
			{
				error: "outcome_unknown",
				message: "AWS End User Messaging did not confirm this send",
				messageRecord: { ...message, status: "unresolved" },
			},
			{ status: 502 }
		);
		const error = await client()
			.sms.send({ body: "hi", from: "num_1", to: "+12065550123" })
			.catch((caught: unknown) => caught);
		if (!(error instanceof MessagingError)) {
			throw new Error("expected a MessagingError");
		}
		expect(error.message).toBe(
			"AWS End User Messaging did not confirm this send"
		);
		expect(messagingErrorMessageRecord(error)).toEqual({
			...message,
			status: "unresolved",
		});
		capture({ error: "insufficient_credits", message: "no" }, { status: 402 });
		const other = await client()
			.sms.send({ body: "hi", from: "num_1", to: "+12065550123" })
			.catch((caught: unknown) => caught);
		if (!(other instanceof MessagingError)) {
			throw new Error("expected a MessagingError");
		}
		expect(messagingErrorMessageRecord(other)).toBeNull();
	});

	test("a reply without the error body is unknown_error with an excerpt", async () => {
		capture("<html>Bad gateway</html>", { status: 502 });
		const error = await client()
			.messages.get("m")
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MessagingError);
		if (!(error instanceof MessagingError)) {
			throw new Error("expected a MessagingError");
		}
		expect(error.code).toBe(MESSAGING_UNKNOWN_ERROR_CODE);
		expect(error.status).toBe(502);
		expect(error.message).toContain("Bad gateway");
	});

	test("never follows a redirect, so the API key stays on the configured origin", async () => {
		let seenRedirect: RequestRedirect | undefined;
		installFetch(async (_input, init) => {
			seenRedirect = init?.redirect;
			return Response.redirect("https://evil.example/steal?x=1", 302);
		});
		const error = await client()
			.status()
			.catch((caught: unknown) => caught);
		expect(seenRedirect).toBe("manual");
		expect(error).toBeInstanceOf(MessagingError);
		if (!(error instanceof MessagingError)) {
			throw new Error("expected a MessagingError");
		}
		expect(error.code).toBe(MESSAGING_REDIRECT_ERROR_CODE);
		expect(error.details).toEqual({ location: "https://evil.example" });
	});
});

describe("verifyMessagingWebhook", () => {
	const key = randomBytes(24);
	const secret = `whsec_${key.toString("base64")}`;
	const now = new Date("2026-10-20T00:00:00.000Z");
	const timestamp = String(Math.floor(now.getTime() / 1000));

	/** Signs the way the server does (Standard Webhooks, as Mail signs). */
	function sign(id: string, at: string, body: string, signingKey = key) {
		return `v1,${createHmac("sha256", signingKey).update(`${id}.${at}.${body}`).digest("base64")}`;
	}

	function delivery(event: object, id = "evt_1") {
		const body = JSON.stringify(event);
		return {
			body,
			headers: {
				"content-type": "application/json",
				"webhook-id": id,
				"webhook-signature": sign(id, timestamp, body),
				"webhook-timestamp": timestamp,
			},
		};
	}

	const delivered: MessagingWebhookEvent = {
		data: { message: { ...message, status: "delivered" } },
		event_id: "evt_1",
		event_type: "message.delivered",
		type: "event",
	};

	test("returns a verified, typed event", async () => {
		const { body, headers } = delivery(delivered);
		const event = await verifyMessagingWebhook(secret, headers, body, { now });
		expect(event).toEqual(delivered);
		expect(isKnownMessagingWebhookEvent(event)).toBe(true);
		if (
			isKnownMessagingWebhookEvent(event) &&
			event.event_type === "message.delivered"
		) {
			expect(event.data.message.status).toBe("delivered");
		}
	});

	test("accepts Headers, svix-* copies, byte bodies and rotated signature lists", async () => {
		const { body, headers } = delivery(delivered);
		const stale = sign("evt_1", timestamp, body, randomBytes(24));
		const svix = new Headers({
			"svix-id": headers["webhook-id"],
			"svix-signature": `${stale} ${headers["webhook-signature"]}`,
			"svix-timestamp": timestamp,
		});
		const event = await verifyMessagingWebhook(
			secret,
			svix,
			new TextEncoder().encode(body),
			{ now }
		);
		expect(event.event_id).toBe("evt_1");
	});

	test("an unknown event type verifies and is reported as unknown", async () => {
		const future: MessagingUnknownWebhookEvent = {
			data: { sender: { id: "sender_1" } },
			event_id: "evt_2",
			event_type: "sender.disabled",
			type: "event",
		};
		const { body, headers } = delivery(future, "evt_2");
		const event = await verifyMessagingWebhook(secret, headers, body, { now });
		expect(event).toEqual(future);
		expect(isKnownMessagingWebhookEvent(event)).toBe(false);
	});

	async function reason(
		promise: Promise<unknown>
	): Promise<string | undefined> {
		const error = await promise.catch((caught: unknown) => caught);
		return error instanceof MessagingWebhookVerificationError
			? error.reason
			: undefined;
	}

	test("refuses forged, tampered, stale and malformed deliveries", async () => {
		const { body, headers } = delivery(delivered);
		expect(
			await reason(
				verifyMessagingWebhook(
					`whsec_${randomBytes(24).toString("base64")}`,
					headers,
					body,
					{ now }
				)
			)
		).toBe("invalid_signature");
		expect(
			await reason(
				verifyMessagingWebhook(secret, headers, body.replace("+1", "+4"), {
					now,
				})
			)
		).toBe("invalid_signature");
		expect(
			await reason(
				verifyMessagingWebhook(secret, headers, body, {
					now: new Date(now.getTime() + 301_000),
				})
			)
		).toBe("timestamp_out_of_range");
		expect(
			await reason(
				verifyMessagingWebhook(
					secret,
					{ "webhook-id": "evt_1", "webhook-timestamp": timestamp },
					body,
					{ now }
				)
			)
		).toBe("missing_headers");
		expect(
			await reason(
				verifyMessagingWebhook("whsec_not base64!", headers, body, { now })
			)
		).toBe("invalid_secret");
		const malformed = delivery({
			...delivered,
			data: { message: { ...message, status: "teleported" } },
		});
		expect(
			await reason(
				verifyMessagingWebhook(secret, malformed.headers, malformed.body, {
					now,
				})
			)
		).toBe("invalid_payload");
	});
});
