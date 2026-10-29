import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { RouteClaim } from "./rpc.ts";
import {
	asAppRequestArg,
	asBlueprintRequestArg,
	asNewsRequestArg,
	asReasoningRequestArg,
	asRlmRequestArg,
	asSafeActionsRequestArg,
	asSocialRequestArg,
	asSubtitlesRequestArg,
	asTuitionRequestArg,
	type Capability,
	dispatchRpc,
	type HostServices,
	nativeHapticsResultSchema,
	nativeLiveActivityResultSchema,
	nativeNotificationResultSchema,
	rpcJsonResponseSchema,
} from "./rpc.ts";

describe("generic HTTP transport contracts", () => {
	test("retains every JSON root and empty HTTP replies without cloning", () => {
		const values = [
			undefined,
			null,
			true,
			3,
			"reply",
			[1, null],
			{ future: { nested: [false] } },
			JSON.parse('{"__proto__":{"retained":true}}'),
		];
		for (const value of values) {
			expect(rpcJsonResponseSchema.parse(value)).toBe(value);
		}
	});
	test("refuses response values that cannot appear in a parsed HTTP JSON body", () => {
		const invalidPrototypeEntry = Object.defineProperty({}, "__proto__", {
			value: () => null,
		});
		for (const value of [
			() => null,
			Symbol("invalid"),
			3n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			{ invalid: undefined },
			[undefined],
			new Date(),
			invalidPrototypeEntry,
		]) {
			expect(rpcJsonResponseSchema.safeParse(value).success).toBe(false);
		}
	});
	test("validates mounted JSON bodies and retains the original body", () => {
		const parsers = [
			asAppRequestArg,
			asBlueprintRequestArg,
			asNewsRequestArg,
			asReasoningRequestArg,
			asRlmRequestArg,
			asSafeActionsRequestArg,
			asSocialRequestArg,
			asSubtitlesRequestArg,
			asTuitionRequestArg,
		];
		const body = { future: [true, null, { nested: "original" }] };
		for (const parse of parsers) {
			expect(parse({ body, path: "/status" })?.body).toBe(body);
			expect(parse({ body: { bad: undefined }, path: "/status" })).toBeNull();
			expect(parse({ body: new Date(), path: "/status" })).toBeNull();
		}
	});
	test("dispatches all ten forwarders with JSON or an empty response", async () => {
		const methods = [
			"app.request",
			"mail.request",
			"news.request",
			"social.request",
			"subtitles.request",
			"reasoning.request",
			"rlm.request",
			"tuition.request",
			"blueprint.request",
			"safeActions.request",
		];
		const capabilities: Set<Capability> = new Set([
			"app.http",
			"mail.crud",
			"news.crud",
			"social.crud",
			"subtitles.crud",
			"reasoning.check",
			"rlm.query",
			"tuition.crud",
			"blueprint.review",
			"safe-actions.manage",
		]);
		for (const value of [undefined, { future: [true, null] }]) {
			const reply = async () => value;
			const services: HostServices = {
				listAgents: async () => [],
				registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
				appRequest: reply,
				mailRequest: reply,
				newsRequest: reply,
				socialRequest: reply,
				subtitlesRequest: reply,
				reasoningRequest: reply,
				rlmRequest: reply,
				tuitionRequest: reply,
				blueprintRequest: reply,
				safeActionsRequest: reply,
			};
			for (const method of methods) {
				const path = method === "mail.request" ? "/api/mail/status" : "/status";
				expect(
					await dispatchRpc(method, [{ path }], capabilities, services)
				).toBe(value);
			}
		}
	});
});

test("native acknowledgement owners preserve metadata and reject false success", () => {
	const haptics = { signaled: true, future: "retained" } satisfies z.output<
		typeof nativeHapticsResultSchema
	> &
		Record<"future", string>;
	const notification = {
		id: "native-id",
		scheduled: true,
		future: "retained",
	} satisfies z.output<typeof nativeNotificationResultSchema> &
		Record<"future", string>;
	const activity = { updated: true, future: "retained" } satisfies z.output<
		typeof nativeLiveActivityResultSchema
	> &
		Record<"future", string>;
	expect(nativeHapticsResultSchema.parse(haptics)).toBe(haptics);
	expect(nativeNotificationResultSchema.parse(notification)).toBe(notification);
	expect(nativeLiveActivityResultSchema.parse(activity)).toBe(activity);
	expect(nativeHapticsResultSchema.safeParse({ signaled: false }).success).toBe(
		false
	);
	expect(
		nativeNotificationResultSchema.safeParse({ scheduled: true }).success
	).toBe(false);
	expect(
		nativeLiveActivityResultSchema.safeParse({ updated: false }).success
	).toBe(false);
});
