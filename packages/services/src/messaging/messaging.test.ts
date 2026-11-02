import { describe, expect, test } from "bun:test";
import { RyuConfigurationError } from "../errors.ts";
import { Ryu } from "../ryu.ts";
import {
	BASE,
	caught,
	ENV,
	MESSAGE,
	NOW,
	ORG,
	refusal,
	ryuObject,
	ryuWith,
	SETTINGS,
	SMS,
	STATUS,
	stubFetch,
} from "./messaging.test-helper.ts";
import { MESSAGING_CANONICAL_METHODS } from "./namespace.ts";

// ryu.messaging configuration, sends, and reads against a stubbed fetch. The
// refusal mapping is messaging-errors.test.ts; the lockstep with the server's
// router source is messaging-lockstep.test.ts.

describe("ryu.messaging configuration", () => {
	test("needs RYU_API_KEY and RYU_ORGANIZATION_ID, and names both", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({}));
		const ryu = new Ryu({ env: {}, fetch });
		const error = await caught(ryu.messaging.sms.send(SMS));
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({
			missing: ["RYU_API_KEY", "RYU_ORGANIZATION_ID"],
		});
		expect(error.hint).toContain("apiKey and organizationId");
		const keyOnly = new Ryu({ env: { RYU_API_KEY: "ryu_k" }, fetch });
		expect(
			(await caught(keyOnly.messaging.settings.get())).details as unknown
		).toEqual({ missing: ["RYU_ORGANIZATION_ID"] });
		expect(calls).toHaveLength(0);
	});

	test("status() needs no credentials and sends none without the full pair", async () => {
		const { calls, fetch } = stubFetch(() => Response.json(STATUS));
		const anonymous = new Ryu({ env: {}, fetch });
		const status = await anonymous.messaging.status();
		expect(status.configured).toBe(true);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("https://api.ryuhq.com/api/messaging/status");
		expect(calls[0]?.headers.has("x-api-key")).toBe(false);
		expect(calls[0]?.headers.has("authorization")).toBe(false);
		expect(calls[0]?.headers.has("x-ryu-organization")).toBe(false);
		// A key without an organization is still incomplete: status() sends neither.
		const keyOnly = new Ryu({ env: { RYU_API_KEY: "ryu_k" }, fetch });
		await keyOnly.messaging.status();
		expect(calls[1]?.headers.has("x-api-key")).toBe(false);
		// RYU_API_URL still applies.
		await new Ryu({
			env: { RYU_API_URL: "https://cp.example.com" },
			fetch,
		}).messaging.status();
		expect(calls[2]?.url).toBe("https://cp.example.com/api/messaging/status");
		// Configured clients keep sending their credentials, as before.
		await ryuWith(fetch).messaging.status();
		expect(calls[3]?.headers.get("x-api-key")).toBe(ENV.RYU_API_KEY);
		expect(calls[3]?.headers.get("x-ryu-organization")).toBe(ORG);
		// Object mode and the safe view take the same path.
		const safe = await anonymous.safe.messaging.status();
		expect(safe.error).toBeNull();
	});

	test("credential-free status() does not weaken any other method", async () => {
		const { calls, fetch } = stubFetch(() => Response.json(STATUS));
		const ryu = new Ryu({ env: {}, fetch });
		await ryu.messaging.status();
		for (const call of [
			() => ryu.messaging.settings.get(),
			() => ryu.messaging.quote({ channel: "sms", to: "+6591234567" } as never),
			() => ryu.messaging.sms.send(SMS),
			() => ryu.messaging.messages.list(),
		]) {
			const error = await caught(call());
			expect(error).toBeInstanceOf(RyuConfigurationError);
			expect(error.details).toEqual({
				missing: ["RYU_API_KEY", "RYU_ORGANIZATION_ID"],
			});
		}
		expect(calls).toHaveLength(1);
		expect(ryu.isConfigured("messaging")).toBe(false);
		// An invalid URL is still a configuration error, also for status().
		const badUrl = new Ryu({ env: { RYU_API_URL: "not a url" }, fetch });
		expect(await caught(badUrl.messaging.status())).toBeInstanceOf(
			RyuConfigurationError
		);
		expect(calls).toHaveLength(1);
	});

	test("messaging options win over the shared control-plane options and env", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ settings: SETTINGS })
		);
		const ryu = new Ryu({
			env: ENV,
			fetch,
			apiKey: "ryu_shared",
			messaging: {
				apiKey: "ryu_messaging_only",
				baseUrl: "https://cp.example.com",
				organizationId: "64a0000000000000000000b2",
			},
		});
		await ryu.messaging.settings.get();
		expect(calls[0]?.url).toBe(
			"https://cp.example.com/api/messaging/orgs/64a0000000000000000000b2/settings"
		);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_messaging_only");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe(
			"64a0000000000000000000b2"
		);
		expect(ryu.isConfigured("messaging")).toBe(true);
		expect(
			new Ryu({ env: { RYU_API_KEY: "k" } }).isConfigured("messaging")
		).toBe(false);
		// The same ryu_ key alone selects hosted Mail on the control plane.
		expect(new Ryu({ env: { RYU_API_KEY: "k" } }).isConfigured("mail")).toBe(
			true
		);
		expect(new Ryu({ env: {} }).isConfigured("mail")).toBe(false);
	});
});

describe("ryu.messaging sends", () => {
	test("sms.send posts to the org route with x-api-key, the organization and an auto key", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ message: MESSAGE }, { status: 202 })
		);
		const message = await ryuWith(fetch).messaging.sms.send(SMS);
		expect(message.id).toBe("msg_1");
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe(`${BASE}/sms`);
		expect(call?.headers.get("x-api-key")).toBe("ryu_messaging_secret");
		expect(call?.headers.get("authorization")).toBeNull();
		expect(call?.headers.get("x-ryu-organization")).toBe(ORG);
		expect(call?.headers.get("idempotency-key")).toMatch(/\S{8,}/);
		expect(JSON.parse(call?.body ?? "{}")).toEqual(SMS);
	});

	test("the key is stable across a retry", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(500, "internal_error", "Internal Server Error", {
						retryAfterSeconds: 0,
					})
				: Response.json({ message: MESSAGE }, { status: 202 })
		);
		const result = await ryuObject(fetch).messaging.sms.send(SMS);
		expect(result.error).toBeNull();
		expect(calls).toHaveLength(2);
		const first = calls[0]?.headers.get("idempotency-key");
		expect(first).toBeTruthy();
		expect(calls[1]?.headers.get("idempotency-key")).toBe(first ?? "");
		expect(result.meta?.attempts).toBe(2);
		expect(result.meta?.idempotencyKey).toBe(first ?? "");
	});

	test("the client's own key option and .with({ idempotencyKey }) are both sent", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ message: MESSAGE }, { status: 202 })
		);
		const ryu = ryuWith(fetch);
		await ryu.messaging.sms.send(SMS, { idempotencyKey: "order-1842-shipped" });
		await ryu.messaging
			.with({ idempotencyKey: "order-1843-shipped" })
			.voice.send({ from: "num_1", to: "+6591234567", text: "Hi" });
		expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"order-1842-shipped",
			"order-1843-shipped",
		]);
		expect(calls[1]?.url).toBe(`${BASE}/voice`);
	});

	test("numbers.buy carries a key; reads and label updates carry none", async () => {
		const NUMBER = {
			id: "num_1",
			organizationId: ORG,
			phoneNumber: null,
			isoCountryCode: "US",
			numberType: "TOLL_FREE",
			capabilities: ["SMS"],
			messageType: "TRANSACTIONAL",
			status: "pending",
			label: null,
			twoWayEnabled: false,
			registrationId: null,
			monthlyLeaseMicroUsd: 2_000_000,
			leasePeriod: 1,
			currentPeriodEndsAt: null,
			suspendedAt: null,
			graceEndsAt: null,
			releasedAt: null,
			error: null,
			createdAt: NOW,
			updatedAt: NOW,
		};
		const { calls, fetch } = stubFetch((request) =>
			request.method === "GET"
				? Response.json({ numbers: [NUMBER] })
				: Response.json({ number: NUMBER }, { status: 201 })
		);
		const ryu = ryuWith(fetch);
		await ryu.messaging.numbers.buy({
			capabilities: ["SMS"],
			isoCountryCode: "US",
			numberType: "TOLL_FREE",
		});
		await ryu.messaging.numbers.list({ status: "all" });
		await ryu.messaging.numbers.update("num_1", { label: "Support" });
		expect(calls.map((call) => [call.method, call.url])).toEqual([
			["POST", `${BASE}/numbers`],
			["GET", `${BASE}/numbers?status=all`],
			["PATCH", `${BASE}/numbers/num_1`],
		]);
		expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
		expect(calls[1]?.headers.get("idempotency-key")).toBeNull();
		expect(calls[2]?.headers.get("idempotency-key")).toBeNull();
	});
});

describe("ryu.messaging iterators and reads", () => {
	test("messages.iterate sends nextCursor back as cursor and keeps the filters", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			return cursor === null
				? Response.json({
						messages: [MESSAGE, { ...MESSAGE, id: "msg_2" }],
						nextCursor: "c2",
					})
				: Response.json({
						messages: [{ ...MESSAGE, id: "msg_3" }],
						nextCursor: null,
					});
		});
		const ids: string[] = [];
		for await (const message of ryuWith(fetch).messaging.messages.iterate({
			channel: "sms",
			limit: 2,
		})) {
			ids.push(message.id);
		}
		expect(ids).toEqual(["msg_1", "msg_2", "msg_3"]);
		expect(calls.map((call) => call.url)).toEqual([
			`${BASE}/messages?channel=sms&limit=2`,
			`${BASE}/messages?channel=sms&cursor=c2&limit=2`,
		]);
	});

	test("optOuts.iterate pages by nextToken and stops at maxItems", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const token = new URL(request.url).searchParams.get("nextToken");
			return Response.json({
				optOuts: [
					{
						phoneNumber: token === null ? "+15555550101" : "+15555550102",
						optedOutAt: NOW,
						endUserOptedOut: true,
					},
				],
				nextToken: token === null ? "t2" : null,
			});
		});
		const ryu = ryuWith(fetch);
		const all = await ryu.messaging.optOuts.iterate().collect();
		expect(all.map((entry) => entry.phoneNumber)).toEqual([
			"+15555550101",
			"+15555550102",
		]);
		expect(calls[1]?.url).toBe(`${BASE}/opt-outs?nextToken=t2`);
		const one = await ryu.messaging.optOuts.iterate({ maxItems: 1 }).collect();
		expect(one).toHaveLength(1);
	});

	test("optOuts.iterate follows nextToken past an empty page", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const token = new URL(request.url).searchParams.get("nextToken");
			if (token === null) {
				return Response.json({ optOuts: [], nextToken: "t2" });
			}
			if (token === "t2") {
				return Response.json({
					optOuts: [
						{
							phoneNumber: "+15555550102",
							optedOutAt: NOW,
							endUserOptedOut: true,
						},
					],
					nextToken: "t3",
				});
			}
			return Response.json({ optOuts: [], nextToken: null });
		});
		const all = await ryuWith(fetch).messaging.optOuts.iterate().collect();
		expect(all.map((entry) => entry.phoneNumber)).toEqual(["+15555550102"]);
		expect(calls.map((call) => new URL(call.url).search)).toEqual([
			"",
			"?nextToken=t2",
			"?nextToken=t3",
		]);
	});

	test("optOuts.iterate stops on a repeated token even when pages are empty", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ optOuts: [], nextToken: "same" })
		);
		const all = await ryuWith(fetch).messaging.optOuts.iterate().collect();
		expect(all).toEqual([]);
		expect(calls).toHaveLength(2);
	});

	test("an iterator page failure throws RyuError, also in object mode", async () => {
		const { fetch } = stubFetch(() =>
			refusal(400, "invalid_request", "invalid cursor")
		);
		const iterator = ryuObject(fetch)
			.messaging.messages.iterate()
			[Symbol.asyncIterator]();
		const error = await caught(iterator.next());
		expect(error.code).toBe("invalid_request");
	});

	test("status() and quote() call the service-level routes", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/status")
				? Response.json({
						apiVersion: "v1",
						configured: true,
						channels: { sms: true, mms: false, voice: true, whatsapp: false },
					})
				: Response.json({
						channel: "sms",
						credit: { availableMicroUsd: 5_000_000, heldMicroUsd: 0 },
						quote: {
							ceilingMicroUsd: 9000,
							encoding: "GSM",
							isoCountryCode: "SG",
							segments: 1,
						},
					})
		);
		const ryu = ryuWith(fetch);
		expect((await ryu.messaging.status()).apiVersion).toBe("v1");
		const quote = await ryu.messaging.quote({
			channel: "sms",
			to: "+6591234567",
			body: "Hi",
		});
		expect(quote.channel).toBe("sms");
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.ryuhq.com/api/messaging/status",
			`${BASE}/quote?channel=sms&to=%2B6591234567&body=Hi`,
		]);
	});

	test("every canonical method resolves on the namespace", () => {
		const client = new Ryu({ env: ENV }).messaging as unknown as Record<
			string,
			unknown
		>;
		for (const path of MESSAGING_CANONICAL_METHODS) {
			let target: unknown = client;
			for (const key of path.split(".")) {
				target = (target as Record<string, unknown>)[key];
			}
			expect({ path, type: typeof target }).toEqual({
				path,
				type: "function",
			});
		}
	});
});
