import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	fetchGatewayPhoneCallTranscript,
	guideGatewayPhoneCall,
	purchaseGatewayPhoneNumber,
	searchGatewayPhoneNumbers,
	startGatewayPhoneCall,
	verifyGatewayCallerId,
} from "./gateway.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const originalFetch = globalThis.fetch;
const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "node-token",
	userJwt: "user-jwt",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Gateway phone-call client", () => {
	test("search encodes number filters and carries the node and user credentials", async () => {
		let requestUrl = "";
		let requestHeaders: HeadersInit | undefined;
		globalThis.fetch = createFetchFixture(async (input, init) => {
			requestUrl = String(input);
			requestHeaders = init?.headers;
			return new Response(JSON.stringify({ numbers: [] }), { status: 200 });
		});

		await searchGatewayPhoneNumbers(target, "US", "415");

		expect(requestUrl).toBe(
			"http://127.0.0.1:7980/api/gateway/phone-calls/numbers/available?countryCode=US&areaCode=415"
		);
		expect(new Headers(requestHeaders).get("Authorization")).toBe(
			"Bearer node-token"
		);
		expect(new Headers(requestHeaders).get("x-ryu-user-jwt")).toBe("user-jwt");
	});

	test("start sends the caller's explicit line, destination, and goal", async () => {
		let requestBody = "";
		globalThis.fetch = createFetchFixture(async (_input, init) => {
			requestBody = String(init?.body);
			return new Response(
				JSON.stringify({
					callSid: "CA123",
					idempotencyKey: "call-request-0001",
					conversationId: "phone_abc",
					status: "queued",
				}),
				{ status: 201 }
			);
		});

		const result = await startGatewayPhoneCall(target, {
			idempotencyKey: "call-request-0001",
			lineId: "personal",
			to: "+14155550123",
			goal: "Confirm my appointment",
		});

		expect(JSON.parse(requestBody)).toEqual({
			idempotencyKey: "call-request-0001",
			lineId: "personal",
			to: "+14155550123",
			goal: "Confirm my appointment",
		});
		expect(result.callSid).toBe("CA123");
	});

	test("live guidance uses the encoded Call SID path", async () => {
		let requestUrl = "";
		globalThis.fetch = createFetchFixture(async (input) => {
			requestUrl = String(input);
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		await guideGatewayPhoneCall(
			target,
			"CA123",
			"Ask whether Friday is available"
		);

		expect(requestUrl).toBe(
			"http://127.0.0.1:7980/api/gateway/phone-calls/CA123/control"
		);
	});

	test("transcript reads go through the owner-only Core route", async () => {
		let requestUrl = "";
		globalThis.fetch = createFetchFixture(async (input) => {
			requestUrl = String(input);
			return new Response(
				JSON.stringify({ conversationId: "phone_123", messages: [] }),
				{ status: 200 }
			);
		});

		const result = await fetchGatewayPhoneCallTranscript(target, "CA123");

		expect(requestUrl).toBe(
			"http://127.0.0.1:7980/api/gateway/phone-calls/CA123/transcript"
		);
		expect(result.conversationId).toBe("phone_123");
	});

	test("number purchase and caller-ID verification use distinct explicit endpoints", async () => {
		const requests: Array<{ body: string; url: string }> = [];
		globalThis.fetch = createFetchFixture(async (input, init) => {
			requests.push({ url: String(input), body: String(init?.body) });
			return new Response(
				JSON.stringify(
					String(input).includes("caller-id-verifications")
						? {
								callSid: "CA123",
								phoneNumber: "+14155550100",
								validationCode: "native-code",
							}
						: {
								phoneNumber: "+14155550123",
								sid: "PN123",
								voiceUrl: "https://voice.example/answer",
							}
				),
				{ status: 201 }
			);
		});

		await purchaseGatewayPhoneNumber(target, "+14155550123");
		await verifyGatewayCallerId(target, "+14155550100");

		expect(requests.map((request) => request.url)).toEqual([
			"http://127.0.0.1:7980/api/gateway/phone-calls/numbers",
			"http://127.0.0.1:7980/api/gateway/phone-calls/caller-id-verifications",
		]);
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
			phoneNumber: "+14155550123",
		});
		expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
			phoneNumber: "+14155550100",
		});
	});
});
