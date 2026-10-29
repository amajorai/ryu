import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	getConversationFeedback,
	setMessageFeedback,
} from "./message-feedback.ts";

interface Recorded {
	body: unknown;
	method: string;
	path: string;
	token: string | null;
}

let status = 200;
let payload: unknown = {};
let calls: Recorded[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const text = await request.text();
		calls.push({
			path: new URL(request.url).pathname,
			method: request.method,
			token: request.headers.get("authorization"),
			body: text ? JSON.parse(text) : undefined,
		});
		return Response.json(payload, { status });
	},
});
afterAll(() => server.stop(true));
const target = { url: server.url.toString(), token: "fixture-node" };

beforeEach(() => {
	status = 200;
	payload = {};
	calls = [];
});

test("posts the vote and fallback flag to the encoded message feedback route and maps the capture flags", async () => {
	payload = {
		ok: true,
		rating: "down",
		reward_captured: true,
		memory_captured: false,
	};
	expect(
		await setMessageFeedback(target, "conv/1 ?", "msg#2", "down", true)
	).toEqual({
		ok: true,
		rating: "down",
		rewardCaptured: true,
		memoryCaptured: false,
	});
	expect(calls).toEqual([
		{
			path: "/api/conversations/conv%2F1%20%3F/messages/msg%232/feedback",
			method: "POST",
			token: "Bearer fixture-node",
			body: { rating: "down", allow_latest_fallback: true },
		},
	]);
});

test("a sparse response defaults ok to true, the rating to the requested one, and captures to false", async () => {
	payload = {};
	expect(await setMessageFeedback(target, "c", "m", "up")).toEqual({
		ok: true,
		rating: "up",
		rewardCaptured: false,
		memoryCaptured: false,
	});
	expect(calls[0]?.body).toEqual({
		rating: "up",
		allow_latest_fallback: false,
	});
	payload = { ok: false, rating: null };
	expect(await setMessageFeedback(target, "c", "m", null)).toEqual({
		ok: false,
		rating: null,
		rewardCaptured: false,
		memoryCaptured: false,
	});
	expect(calls[1]?.body).toEqual({
		rating: null,
		allow_latest_fallback: false,
	});
});

test("an HTTP failure, a malformed response or an unreachable node resolves null instead of throwing", async () => {
	status = 500;
	payload = { error: "boom" };
	expect(await setMessageFeedback(target, "c", "m", "up")).toBeNull();
	status = 200;
	payload = { rating: "sideways" };
	expect(await setMessageFeedback(target, "c", "m", "up")).toBeNull();
	const closed = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const deadUrl = closed.url.toString();
	closed.stop(true);
	expect(
		await setMessageFeedback({ url: deadUrl, token: null }, "c", "m", "up")
	).toBeNull();
});

test("conversation feedback returns the rating map from the encoded route", async () => {
	payload = { feedback: { m1: "up", m2: "down" } };
	expect(await getConversationFeedback(target, "conv/1")).toEqual({
		m1: "up",
		m2: "down",
	});
	expect(calls[0]).toMatchObject({
		path: "/api/conversations/conv%2F1/feedback",
		method: "GET",
	});
	payload = {};
	expect(await getConversationFeedback(target, "conv")).toEqual({});
});

test("conversation feedback resolves an empty map on failure or an unknown rating", async () => {
	status = 503;
	payload = { feedback: { m1: "up" } };
	expect(await getConversationFeedback(target, "conv")).toEqual({});
	status = 200;
	payload = { feedback: { m1: "up", m2: "meh" } };
	expect(await getConversationFeedback(target, "conv")).toEqual({});
});
