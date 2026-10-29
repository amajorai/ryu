import { describe, expect, test } from "bun:test";
import {
	type AppNotification,
	ackNotification,
	listMentionTargetUsers,
	listNotifications,
	redactConnectSuggestionEvent,
	redactConnectSuggestionNotifications,
	streamUserNotifications,
	type UserNotificationEvent,
} from "./notifications.ts";

describe("listMentionTargetUsers", () => {
	test("normalizes the scoped roster and keeps optional avatar data", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					users: [
						{
							email: "ada@example.test",
							image: "https://cdn.example.test/ada.webp",
							name: "Ada Lovelace",
							role: "member",
							userId: "user-ada",
						},
					],
				});
			},
		});
		try {
			expect(
				await listMentionTargetUsers({
					token: null,
					url: server.url.toString(),
				})
			).toEqual([
				{
					email: "ada@example.test",
					id: "user-ada",
					image: "https://cdn.example.test/ada.webp",
					name: "Ada Lovelace",
					role: "member",
				},
			]);
		} finally {
			await server.stop(true);
		}
	});
	test("fails closed when the node cannot resolve a roster", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({ error: "unavailable" }, { status: 503 });
			},
		});
		try {
			expect(
				await listMentionTargetUsers({
					token: null,
					url: server.url.toString(),
				})
			).toEqual([]);
		} finally {
			await server.stop(true);
		}
	});
});

describe("Streaming suggestion privacy", () => {
	const suggestion: AppNotification = {
		ack_required: false,
		acked: false,
		body: "Reset code 683474 is valid for 30 minutes",
		created_at: "2026-09-29T00:00:00Z",
		id: "ntf_connect_sensitive-event",
		level: "info",
		node_id: "private-node",
		read_at: null,
		source_app_id: "@ryu/island",
		title: "Password reset requested",
		user_id: "user-1",
		workflow_run_id: "run-sensitive",
	};

	test("redacts cached Connect suggestion details while Streaming is active", () => {
		const [redacted] = redactConnectSuggestionNotifications([suggestion], true);
		expect(redacted).toMatchObject({
			body: "A connected-app event was hidden during Streaming. Review it in the source app when you’re ready.",
			node_id: null,
			title: "Private connected-app activity",
			workflow_run_id: null,
		});
		expect(redacted?.body).not.toContain("683474");
	});

	test("keeps notifications unchanged outside Streaming", () => {
		expect(redactConnectSuggestionNotifications([suggestion], false)).toEqual([
			suggestion,
		]);
	});

	test("redacts a queued Island notification event before showing a toast", () => {
		const event: UserNotificationEvent = {
			body: suggestion.body,
			level: "info",
			notification_id: suggestion.id,
			source_app_id: suggestion.source_app_id,
			title: suggestion.title,
		};
		const redacted = redactConnectSuggestionEvent(event, true);
		expect(redacted.title).toBe("Private connected-app activity");
		expect(redacted.body).not.toContain("683474");
	});
});

test("uses the selected node for inbox queries and acknowledgements with legacy empty replies", async () => {
	let reply = "{}";
	const received: { path: string; method: string; body: string }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			received.push({
				path: url.pathname + url.search,
				method: request.method,
				body: await request.text(),
			});
			return new Response(reply, {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	try {
		const target = { token: null, url: server.url.toString() };
		expect(await listNotifications(target, "user +", 7, true)).toEqual([]);
		expect(await ackNotification(target, "gate")).toBe(false);
		reply = '{"resumed":true}';
		expect(await ackNotification(target, "gate")).toBe(true);
		reply = '{"notifications":null}';
		expect(await listNotifications(target, "user")).toEqual([]);
		reply = '{"notifications":[{"id":"partial"}]}';
		await expect(listNotifications(target, "user")).rejects.toThrow();
		expect(received.slice(0, 2)).toEqual([
			{
				path: "/api/notifications?user_id=user+%2B&limit=7&archived=true",
				method: "GET",
				body: "",
			},
			{ path: "/api/notifications/gate/ack", method: "POST", body: "" },
		]);
	} finally {
		await server.stop(true);
	}
});
test("keeps permissive roster normalization and the null-row whole-roster fallback", async () => {
	let users =
		'[4,[],{"userId":" u ","email":" ada@example.test ","name":" ","image":false,"role":null}]';
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response(`{"users":${users}}`, {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	try {
		const target = { token: null, url: server.url.toString() };
		expect(await listMentionTargetUsers(target)).toEqual([
			{
				id: "u",
				email: "ada@example.test",
				name: "ada",
				image: null,
				role: null,
			},
		]);
		users = '[{"userId":"u"},null]';
		expect(await listMentionTargetUsers(target)).toEqual([]);
	} finally {
		await server.stop(true);
	}
});
test("decodes native multi-line SSE frames, ignores invalid frames and retains future event metadata", async () => {
	const body =
		': heartbeat\n\ndata: {"title":1,"level":"info"}\n\ndata: {"title":"Réçu",\ndata: "level":"future","target_user_id":"user","future":{"__proto__":{"overflow":1e400}}}\n\ndata: {"title":"Next","level":"info"}\n\n';
	const bytes = new TextEncoder().encode(body);
	const received: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			received.push(
				new URL(request.url).pathname + new URL(request.url).search
			);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (let offset = 0; offset < bytes.length; offset += 7) {
							controller.enqueue(bytes.slice(offset, offset + 7));
						}
						controller.close();
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	try {
		const events: UserNotificationEvent[] = [];
		await streamUserNotifications(
			{ token: null, url: server.url.toString() },
			"user +",
			(event) => {
				events.push(event);
			}
		);
		expect(events).toEqual([
			JSON.parse(
				'{"title":"Réçu","level":"future","target_user_id":"user","future":{"__proto__":{"overflow":1e400}}}'
			),
			{ title: "Next", level: "info" },
		]);
		expect(received).toEqual(["/api/notifications/stream?user_id=user+%2B"]);
	} finally {
		await server.stop(true);
	}
});
