import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { vaultHydrated } from "@/lib/auth-client.ts";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	claimActivationReward,
	saveOnboardingSource,
} from "./onboarding-activation.ts";

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;

// Importing the auth client starts its vault hydration, which waits for the
// Tauri bridge before migrating a legacy session token. Let it finish before a
// test installs a session in storage, or its background profile lookup lands
// in whichever test's fetch fixture happens to be live at that moment.
await vaultHydrated;

describe("onboarding activation API", () => {
	beforeEach(() => {
		globalThis.localStorage = {
			getItem: () => "test-token",
			setItem: () => undefined,
			removeItem: () => undefined,
			clear: () => undefined,
			key: () => null,
			length: 0,
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalStorage;
	});

	test("sends the acquisition source through the account route", async () => {
		let request: RequestInit | undefined;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (_input, init) => {
				request = init;
				return Response.json({ source: "podcast" });
			}
		);

		await saveOnboardingSource("podcast");

		expect(request?.method).toBe("PATCH");
		expect(request?.body).toBe(JSON.stringify({ source: "podcast" }));
	});

	test("returns the server reward without accepting a client amount", async () => {
		let requestBody = "";
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (_input, init) => {
				requestBody = String(init?.body ?? "");
				return Response.json({
					amountMicroUsd: 500_000,
					completed: 1,
					granted: true,
					remaining: 19,
				});
			}
		);

		await expect(
			claimActivationReward({ appSlug: "chorus", connectionId: "connection-1" })
		).resolves.toEqual({
			amountMicroUsd: 500_000,
			completed: 1,
			granted: true,
			remaining: 19,
		});
		expect(requestBody).toBe(
			JSON.stringify({ appSlug: "chorus", connectionId: "connection-1" })
		);
	});
});
