import { afterEach, describe, expect, test } from "bun:test";
import {
	INTERACTIVE_PAIRING_CAPABILITIES,
	type PairingPoll,
	pollPairing,
	startPairing,
} from "./pairing.ts";
import type { HttpFixtureBody } from "./test-support/http-fixture.ts";
import { parseJsonRequestBody } from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

interface CapturedRequest {
	body: HttpFixtureBody | undefined;
	url: string;
}

function respondOnce(payload: HttpFixtureBody, status = 200): CapturedRequest {
	const captured: CapturedRequest = { body: undefined, url: "" };
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			captured.url = String(input);
			captured.body = parseJsonRequestBody(init?.body);
			return Response.json(payload, { status });
		},
		{ preconnect: realFetch.preconnect }
	);
	return captured;
}

describe("startPairing", () => {
	test("requests the fixed interactive scope set explicitly", async () => {
		const captured = respondOnce({
			device_code: `pdc_${"a".repeat(64)}`,
			expires_in: 600,
			interval: 5,
			user_code: "ABC-DEF",
		});

		await startPairing("http://127.0.0.1:7980/", "Ryu Web");

		expect(captured.url).toBe("http://127.0.0.1:7980/api/pair/code");
		expect(captured.body).toEqual({
			client_name: "Ryu Web",
			requested_constraints: {},
			requested_scopes: [...INTERACTIVE_PAIRING_CAPABILITIES],
		});
	});

	test("never requests administrative capabilities", () => {
		expect(INTERACTIVE_PAIRING_CAPABILITIES).not.toContain("agents:manage");
		expect(INTERACTIVE_PAIRING_CAPABILITIES).not.toContain("workflows:manage");
		expect(INTERACTIVE_PAIRING_CAPABILITIES).not.toContain("plugins:manage");
		expect(INTERACTIVE_PAIRING_CAPABILITIES).not.toContain("auth:manage");
	});

	test("rejects a malformed Core response at the network boundary", async () => {
		respondOnce({ device_code: "secret" });
		await expect(
			startPairing("http://127.0.0.1:7980", "Ryu Web")
		).rejects.toThrow("Core returned an invalid pairing response");
	});

	for (const [name, value] of [
		["negative expiry", { expires_in: -1, interval: 5 }],
		["zero interval", { expires_in: 600, interval: 0 }],
		["oversized interval", { expires_in: 600, interval: 2 ** 31 }],
	] as const) {
		test(`rejects ${name}`, async () => {
			respondOnce({
				device_code: `pdc_${"a".repeat(64)}`,
				user_code: "ABC-DEF",
				...value,
			});
			await expect(
				startPairing("http://127.0.0.1:7980", "Ryu Web")
			).rejects.toThrow("Core returned an invalid pairing response");
		});
	}
});

describe("pollPairing", () => {
	test("returns an approved token", async () => {
		respondOnce({ token: "ryup_secret" });
		await expect(
			pollPairing("http://127.0.0.1:7980", "device-secret")
		).resolves.toEqual({ status: "approved", token: "ryup_secret" });
	});

	test("maps terminal and pending device-grant errors", async () => {
		for (const [error, status] of [
			["authorization_pending", "pending"],
			["access_denied", "denied"],
			["expired_token", "expired"],
		] satisfies ReadonlyArray<readonly [string, PairingPoll["status"]]>) {
			respondOnce({ error });
			const result = await pollPairing(
				"http://127.0.0.1:7980",
				"device-secret"
			);
			expect(result.status).toBe(status);
		}
	});
});
