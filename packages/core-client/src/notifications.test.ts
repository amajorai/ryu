import { afterEach, describe, expect, test } from "bun:test";
import {
	appNotificationSchema,
	appNotificationsSchema,
	listMentionTargetUsers,
	notificationAckReplySchema,
	notificationsListReplySchema,
	userNotificationEventSchema,
} from "./notifications.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const originalFetch = globalThis.fetch;
const target = {
	token: "node-token",
	url: "http://127.0.0.1:7980",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("listMentionTargetUsers", () => {
	test("normalizes the organization roster for a picker", async () => {
		globalThis.fetch = createFetchFixture(() =>
			Promise.resolve(
				Response.json({
					users: [
						{
							email: "ada@example.test",
							image: "https://cdn.example.test/ada.webp",
							name: "Ada Lovelace",
							role: "member",
							userId: "user-ada",
						},
					],
				})
			)
		);

		expect(await listMentionTargetUsers(target)).toEqual([
			{
				email: "ada@example.test",
				id: "user-ada",
				image: "https://cdn.example.test/ada.webp",
				name: "Ada Lovelace",
				role: "member",
			},
		]);
	});

	test("fails closed when the organization roster is unavailable", async () => {
		globalThis.fetch = createFetchFixture(() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
			)
		);

		expect(await listMentionTargetUsers(target)).toEqual([]);
	});
});

const notification = {
	ack_required: false,
	acked: false,
	created_at: "now",
	id: "notification",
	level: "future-level",
	title: "Title",
	user_id: "user",
};
test("preserves complete inbox and event records, nullable legacy fields and future JSON metadata", () => {
	for (const metadata of [
		null,
		true,
		"future",
		[1, null],
		JSON.parse('{"__proto__":{"value":1e400}}'),
	]) {
		const row = {
			...notification,
			archived_at: null,
			source_app_id: "app",
			future: metadata,
		};
		const rows = [row];
		expect(Object.is(appNotificationSchema.parse(row), row)).toBe(true);
		expect(Object.is(appNotificationsSchema.parse(rows), rows)).toBe(true);
		const event = {
			title: "Title",
			level: "future",
			body: null,
			target_user_id: "user",
			future: metadata,
		};
		expect(Object.is(userNotificationEventSchema.parse(event), event)).toBe(
			true
		);
		expect(JSON.stringify(userNotificationEventSchema.parse(event))).toBe(
			JSON.stringify(event)
		);
	}
});
test("rejects malformed required inbox fields and stream payloads before exposing typed values", () => {
	for (const field of [
		"ack_required",
		"acked",
		"created_at",
		"id",
		"level",
		"title",
		"user_id",
	]) {
		expect(
			appNotificationSchema.safeParse({ ...notification, [field]: undefined })
				.success
		).toBe(false);
	}
	for (const payload of [
		null,
		[],
		{ title: 1, level: "info" },
		{ title: "Title" },
		{ title: "Title", level: "info", body: 4 },
		{ title: "Title", level: "info", extra: new Date() },
	]) {
		expect(userNotificationEventSchema.safeParse(payload).success).toBe(false);
	}
	const invalid = JSON.parse('{"__proto__":null}');
	Object.defineProperty(invalid, "__proto__", {
		enumerable: true,
		value: undefined,
	});
	expect(
		appNotificationSchema.safeParse({ ...notification, future: invalid })
			.success
	).toBe(false);
});
test("retains missing/null envelope fallbacks without weakening available fields", () => {
	for (const reply of [{}, { notifications: null }, { notifications: [] }]) {
		expect(Object.is(notificationsListReplySchema.parse(reply), reply)).toBe(
			true
		);
	}
	for (const reply of [
		{},
		{ resumed: null },
		{ resumed: false },
		{ ok: true, resumed: true },
	]) {
		expect(Object.is(notificationAckReplySchema.parse(reply), reply)).toBe(
			true
		);
	}
	expect(notificationAckReplySchema.safeParse({ resumed: "yes" }).success).toBe(
		false
	);
	expect(
		notificationsListReplySchema.safeParse({ notifications: [{}] }).success
	).toBe(false);
});
