import { expect, it } from "bun:test";
import {
	announcementFeedSchema,
	announcementRecordSchema,
} from "./announcement-wire-contracts.ts";
import type { Announcement } from "./announcements.ts";

const announcement: Announcement = {
	blobColors: ["#abc"],
	body: null,
	color: null,
	createdAt: null,
	icon: null,
	iconUrl: null,
	id: "a",
	linkLabel: null,
	linkUrl: null,
	read: false,
	title: "Update",
	type: "card",
	visualCode: null,
	visualIcon: null,
	visualIconBackground: null,
	visualIconDither: { from: 12, to: "#def", direction: null },
	visualIconUrl: null,
};
it("validates the full control-plane view and preserves nested future JSON by identity", () => {
	const row = {
		...announcement,
		future: JSON.parse('{"__proto__":{"value":true}}'),
	};
	const rows = [row];
	const reply = { announcements: rows, future: { revision: 2 } };
	expect(announcementRecordSchema.parse(row)).toBe(row);
	expect(announcementFeedSchema.parse(reply)).toBe(reply);
	expect(announcementFeedSchema.parse(reply).announcements).toBe(rows);
	expect(
		announcementFeedSchema.parse(reply).announcements?.[0]?.visualIconDither
	).toBe(row.visualIconDither);
	expect(
		announcementRecordSchema.safeParse({ ...announcement, read: "false" })
			.success
	).toBe(false);
	expect(
		announcementRecordSchema.safeParse({ ...announcement, blobColors: [12] })
			.success
	).toBe(false);
	expect(
		announcementRecordSchema.safeParse({
			...announcement,
			visualIconDither: { from: false },
		}).success
	).toBe(false);
	expect(
		announcementRecordSchema.safeParse({ ...announcement, type: "banner" })
			.success
	).toBe(false);
	expect(announcementFeedSchema.parse({}).announcements ?? []).toEqual([]);
	expect(
		announcementFeedSchema.parse({ announcements: null }).announcements ?? []
	).toEqual([]);
});

it("preserves authenticated native HTTP feed/read/dismiss behavior and refusal messages", async () => {
	const { fetchAnnouncements, markAnnouncementRead, dismissAnnouncement } =
		await import("./announcements.ts");
	const originalFetch = globalThis.fetch;
	const originalStorage = globalThis.localStorage;
	const requests: Request[] = [];
	const values = new Map<string, string>([
		["ryu_session_token", "session-token"],
	]);
	const storage: Storage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
		clear: () => values.clear(),
		key: (index) => Array.from(values.keys())[index] ?? null,
		get length() {
			return values.size;
		},
	};
	globalThis.localStorage = storage;
	globalThis.fetch = Object.assign(
		async (...[input, init]: Parameters<typeof originalFetch>) => {
			const request = new Request(input, init);
			requests.push(request);
			return request.method === "GET"
				? Response.json({ announcements: [announcement] })
				: new Response("");
		},
		{ preconnect: originalFetch.preconnect }
	);
	try {
		expect(await fetchAnnouncements()).toEqual([announcement]);
		await markAnnouncementRead("a");
		await dismissAnnouncement("a");
		expect(
			requests.map((request) => [
				request.method,
				new URL(request.url).pathname,
				request.headers.get("authorization"),
				request.headers.get("content-type"),
			])
		).toEqual([
			["GET", "/api/announcements", "Bearer session-token", "application/json"],
			[
				"POST",
				"/api/announcements/a/read",
				"Bearer session-token",
				"application/json",
			],
			[
				"POST",
				"/api/announcements/a/dismiss",
				"Bearer session-token",
				"application/json",
			],
		]);
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof originalFetch>) =>
				new Response("refused", { status: 403 }),
			{ preconnect: originalFetch.preconnect }
		);
		await expect(fetchAnnouncements()).rejects.toThrow(
			"Failed to load announcements: 403"
		);
		await expect(markAnnouncementRead("a")).rejects.toThrow(
			"Failed to mark read: 403"
		);
		await expect(dismissAnnouncement("a")).rejects.toThrow(
			"Failed to dismiss: 403"
		);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.localStorage = originalStorage;
	}
});
