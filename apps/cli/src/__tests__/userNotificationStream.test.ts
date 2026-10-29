import { expect, test } from "bun:test";
import {
	streamUserNotifications,
	type UserNotificationEvent,
} from "../core/userNotificationStream.ts";

test("verified-user stream forwards only matching and broadcast notification frames", async () => {
	let requestedUrl = "";
	const events: UserNotificationEvent[] = [];
	const frames = [
		`data: ${JSON.stringify({ title: "Other", target_user_id: "other" })}\n\n`,
		`data: ${JSON.stringify({ title: "Mentioned", target_user_id: "ada", notification_id: "n-1", body: "Review this" })}\n\n`,
		`data: ${JSON.stringify({ title: "Broadcast", level: "warning" })}\n\n`,
	];
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			const combined = encoder.encode(frames.join(""));
			controller.enqueue(combined.slice(0, 37));
			controller.enqueue(combined.slice(37));
			controller.close();
		},
	});
	const target = {
		url: "http://node:7980",
		token: "node-token",
		fetch: async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return new Response(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	};

	await streamUserNotifications(target, "ada", (event) => events.push(event));

	expect(new URL(requestedUrl).searchParams.get("user_id")).toBe("ada");
	expect(events).toEqual([
		{
			title: "Mentioned",
			body: "Review this",
			level: undefined,
			notification_id: "n-1",
			target_user_id: "ada",
		},
		{
			title: "Broadcast",
			body: null,
			level: "warning",
			notification_id: null,
			target_user_id: null,
		},
	]);
});

test("verified managed-node stream relies on Core identity filtering and rejects connect failures", async () => {
	const requested: Array<RequestInfo | URL> = [];
	const target = {
		url: "https://node.example",
		token: null,
		userJwt: "verified-user-jwt",
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			requested.push(input);
			expect(new Headers(init?.headers).get("x-ryu-user-jwt")).toBe(
				"verified-user-jwt"
			);
			return new Response(null, { status: 401 });
		},
	};

	await expect(
		streamUserNotifications(target, null, () => undefined)
	).rejects.toThrow("notifications stream failed: 401");
	expect(String(requested[0])).toBe(
		"https://node.example/api/notifications/stream"
	);
});
