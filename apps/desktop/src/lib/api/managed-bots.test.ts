import { expect, test } from "bun:test";
import { ApiError } from "./client.ts";
import {
	beginManagedBotPairing,
	cancelManagedBotPairing,
	classifyPairError,
	classifyStatusError,
	confirmManagedBot,
	getManagedBotStatus,
	managedBotPairingSchema,
	managedBotStatusSchema,
} from "./managed-bots.ts";

test("classifies genuine native errors and arbitrary thrown values without treating an expired nonce as an unsupported feature", () => {
	const unavailable = new ApiError("/pair", 501);
	expect(classifyPairError(unavailable).kind).toBe("unsupported");
	expect(classifyStatusError(unavailable).kind).toBe("unsupported");
	const missing = new ApiError("/pair", 404);
	expect(classifyPairError(missing).kind).toBe("unsupported");
	expect(classifyStatusError(missing)).toEqual({
		kind: "expired",
		message: "That pairing link is no longer valid.",
	});
	const unsupported = new ApiError("/pair", 503, "managed_bots_unavailable");
	expect(classifyPairError(unsupported).kind).toBe("unsupported");
	expect(classifyStatusError(unsupported).kind).toBe("unsupported");
	for (const classify of [classifyPairError, classifyStatusError]) {
		expect(classify(new Error("offline"))).toEqual({
			kind: "unreachable",
			message: "offline",
		});
		expect(classify(new ApiError("/pair", 503, "manager down"))).toEqual({
			kind: "unreachable",
			message: "manager down",
		});
		expect(classify(new ApiError("/pair", 503))).toEqual({
			kind: "unreachable",
			message: "The pairing service answered 503. Try again in a moment.",
		});
		for (const thrown of [
			null,
			undefined,
			7,
			"offline",
			{ status: 501 },
			{ message: "spoof" },
		]) {
			expect(classify(thrown)).toEqual({
				kind: "unreachable",
				message: "Could not reach the pairing service.",
			});
		}
	}
});
test("validates complete pairing/status replies while preserving original future metadata", () => {
	const pairing = {
		nonce: "nonce",
		deep_link: "https://t.me/bot?start=mb_nonce",
		expires_at: "later",
		status: "waiting",
		future: JSON.parse('{"__proto__":{"number":1e400}}'),
	};
	expect(Object.is(managedBotPairingSchema.parse(pairing), pairing)).toBe(true);
	for (const reply of [
		{ status: "waiting" },
		{
			status: "confirm",
			bot_id: 7,
			bot_username: "bot",
			owner_telegram_user_id: null,
		},
		{ status: "ready", bot_id: 7, bot_username: "bot", channel_id: "channel" },
	]) {
		expect(Object.is(managedBotStatusSchema.parse(reply), reply)).toBe(true);
	}
	for (const reply of [
		{ status: "confirm" },
		{ status: "ready", bot_id: "7", bot_username: "bot" },
		{ status: "future" },
	]) {
		expect(managedBotStatusSchema.safeParse(reply).success).toBe(false);
	}
	expect(managedBotPairingSchema.safeParse({ nonce: "partial" }).success).toBe(
		false
	);
});
test("forwards public nonces to the exact node-local pair/poll/confirm/cancel routes and keeps private secrets out of requests", async () => {
	const calls: { path: string; method: string; body: string }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push({ path, method: request.method, body: await request.text() });
			if (path.endsWith("/pair")) {
				return Response.json({
					nonce: "public",
					deep_link: "https://t.me/bot",
					expires_at: "later",
				});
			}
			if (request.method === "DELETE") {
				return Response.json({ status: "cancelled", manager_forgot: true });
			}
			return Response.json({
				status: "ready",
				channel_id: "channel",
				bot_id: 7,
				bot_username: "bot",
			});
		},
	});
	try {
		const target = { token: null, url: server.url.toString() };
		expect(
			(await beginManagedBotPairing(target, { name: "Bot", enabled: false }))
				.nonce
		).toBe("public");
		expect((await getManagedBotStatus(target, "public /+")).status).toBe(
			"ready"
		);
		expect((await confirmManagedBot(target, "public /+")).status).toBe("ready");
		expect(await cancelManagedBotPairing(target, "public /+")).toEqual({
			status: "cancelled",
			manager_forgot: true,
		});
		expect(calls).toEqual([
			{
				path: "/api/channels/managed-bot/pair",
				method: "POST",
				body: '{"name":"Bot","enabled":false}',
			},
			{
				path: "/api/channels/managed-bot/public%20%2F%2B",
				method: "GET",
				body: "",
			},
			{
				path: "/api/channels/managed-bot/public%20%2F%2B/confirm",
				method: "POST",
				body: "",
			},
			{
				path: "/api/channels/managed-bot/public%20%2F%2B",
				method: "DELETE",
				body: "",
			},
		]);
	} finally {
		await server.stop(true);
	}
});
