import { afterEach, describe, expect, it } from "bun:test";
import { recordQuestEvent } from "./quest-events.ts";
import {
	createFetchFixture,
	parseJsonRequestBody,
} from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("recordQuestEvent", () => {
	it("sends the typed event and calling surface with the control-plane bearer", async () => {
		interface CapturedQuestRequest {
			body?: RequestInit["body"];
			headers?: HeadersInit;
			method?: string;
			url?: string;
		}
		let captured: CapturedQuestRequest = {};
		globalThis.fetch = createFetchFixture(async (input, init) => {
			captured = {
				body: init?.body,
				headers: init?.headers,
				method: init?.method,
				url: String(input),
			};
			return Response.json({
				accepted: true,
				event: "referral_sync",
				ok: true,
				referralStatus: "reconciled",
				surface: "mobile",
			});
		});

		const result = await recordQuestEvent(
			{
				token: "better-auth-token",
				url: "https://app.example.test",
				userJwt: null,
			},
			"referral_sync",
			"mobile"
		);

		expect(captured.url).toBe("https://app.example.test/api/quests/events");
		expect(captured.method).toBe("POST");
		expect(captured.headers).toMatchObject({
			Authorization: "Bearer better-auth-token",
			"Content-Type": "application/json",
		});
		expect(parseJsonRequestBody(captured.body)).toEqual({
			event: "referral_sync",
			surface: "mobile",
		});
		expect(result.referralStatus).toBe("reconciled");
	});
});
