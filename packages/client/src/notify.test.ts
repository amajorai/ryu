import { describe, expect, test } from "bun:test";
import {
	createNotifyClient,
	type NotificationEvent,
	type NotifyActivity,
	NotifyAPI,
	type NotifyStreamItem,
} from "./notify.ts";

function notification(id: string, title: string): NotificationEvent {
	return {
		acknowledgedAt: null,
		actions: [],
		archivedAt: null,
		attachment: null,
		body: "",
		createdAt: "2026-09-01T00:00:00Z",
		data: {},
		externalId: null,
		fingerprint: null,
		icon: null,
		id,
		level: "info",
		occurredAt: "2026-09-01T00:00:00Z",
		priority: 3,
		project: null,
		recipient: null,
		response: null,
		source: "deploy",
		tags: [],
		title,
		topic: null,
		type: "event",
		url: null,
	};
}
function activity(id: string, title: string): NotifyActivity {
	return {
		accent: null,
		createdAt: "2026-09-01T00:00:00Z",
		data: {},
		endedAt: null,
		expiresAt: null,
		id,
		progress: null,
		recipient: null,
		sequence: 1,
		status: "running",
		symbol: null,
		title,
		topic: null,
		updatedAt: "2026-09-01T00:00:00Z",
	};
}
describe("NotifyAPI", () => {
	test("keeps the standalone API key and idempotency key separate", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const client = createNotifyClient({
			apiKey: "notify-secret",
			baseUrl: "https://notify.example/",
			fetch: async (input, init) => {
				seenUrl = String(input);
				seenInit = init;
				return Response.json({
					event: notification("evt_1", "Deploy ready"),
				});
			},
		});

		const event = await client.publish(
			{ source: "deploy", title: "Deploy ready" },
			"deploy-1"
		);
		expect(seenUrl).toBe("https://notify.example/v1/events");
		const headers = new Headers(seenInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer notify-secret");
		expect(headers.get("idempotency-key")).toBe("deploy-1");
		expect(event.id).toBe("evt_1");
	});

	test("publishes an ntfy-compatible text topic with metadata headers", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async (input, init) => {
				seenUrl = String(input);
				seenInit = init;
				return Response.json({ event: notification("evt_topic", "Build") });
			},
		});
		await client.publishTopic(
			"builds/nightly",
			"Nightly is green",
			{ priority: 5, tags: ["white_check_mark", "nightly"], title: "Build" },
			"nightly-1"
		);
		expect(seenUrl).toBe("https://notify.example/v1/topics/builds%2Fnightly");
		expect(seenInit?.body).toBe("Nightly is green");
		const headers = new Headers(seenInit?.headers);
		expect(headers.get("content-type")).toContain("text/plain");
		expect(headers.get("priority")).toBe("5");
		expect(headers.get("tags")).toBe("white_check_mark,nightly");
		expect(headers.get("idempotency-key")).toBe("nightly-1");
	});

	test("sends topic text outside Latin-1 as RFC 2047 words and ASCII JSON", async () => {
		let seenInit: RequestInit | undefined;
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async (_input, init) => {
				seenInit = init;
				return Response.json({ event: notification("evt_topic", "Build") });
			},
		});
		const word = (text: string) =>
			`=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
		await client.publishTopic("builds", "Ready", {
			actions: [{ label: "打开 🚀", url: "https://example.test/run" }],
			click: "https://example.test/部署",
			tags: ["生产", "canary"],
			title: "部署完成 ✅",
		});
		const headers = new Headers(seenInit?.headers);
		expect(headers.get("title")).toBe(word("部署完成 ✅"));
		expect(headers.get("tags")).toBe(word("生产,canary"));
		expect(headers.get("click")).toBe(word("https://example.test/部署"));
		const actions = headers.get("actions") ?? "";
		expect(actions).toBe(
			'[{"label":"\\u6253\\u5f00 \\ud83d\\ude80","url":"https://example.test/run"}]'
		);
		expect(JSON.parse(actions)).toEqual([
			{ label: "打开 🚀", url: "https://example.test/run" },
		]);
		await client.publishTopic("builds", "Ready", {
			tags: ["prod"],
			title: "Déploiement",
		});
		const latin1 = new Headers(seenInit?.headers);
		expect(latin1.get("title")).toBe("Déploiement");
		expect(latin1.get("tags")).toBe("prod");
		await expect(
			client.publishTopic("builds", "Ready", { title: "部署\n完成" })
		).rejects.toThrow(TypeError);
	});

	test("wraps text containing `=?` so Notify stores it literally", async () => {
		let seenInit: RequestInit | undefined;
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async (_input, init) => {
				seenInit = init;
				return Response.json({ event: notification("evt_topic", "Build") });
			},
		});
		const word = (text: string) =>
			`=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
		for (const title of [
			"=?UTF-8?B?aGk=?=",
			"=?ISO-8859-1?Q?caf=E9?=",
			"Price =?x?Q?y?=",
			"部署 =?UTF-8?B?aGk=?=",
		]) {
			await client.publishTopic("builds", "Ready", {
				click: `https://example.test/?q=${title}`,
				tags: [title],
				title,
			});
			const headers = new Headers(seenInit?.headers);
			expect(headers.get("title")).toBe(word(title));
			expect(headers.get("tags")).toBe(word(title));
			expect(headers.get("click")).toBe(
				word(`https://example.test/?q=${title}`)
			);
		}
		await expect(
			client.publishTopic("builds", "Ready", { title: "a\ud800b" })
		).rejects.toThrow(TypeError);
	});

	test("updates preferences with PATCH so omitted fields are kept", async () => {
		let seenInit: RequestInit | undefined;
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async (_input, init) => {
				seenInit = init;
				return Response.json({
					preferences: {
						muted: true,
						quietHours: { end: "07:00", start: "22:00", timezone: "UTC" },
						recipient: "ops",
						updatedAt: "2026-09-01T00:00:00Z",
					},
				});
			},
		});
		const preferences = await client.updatePreferences({
			muted: true,
			recipient: "ops",
		});
		expect(seenInit?.method).toBe("PATCH");
		expect(seenInit?.body).toBe(
			JSON.stringify({ muted: true, recipient: "ops" })
		);
		expect(preferences.quietHours).toEqual({
			end: "07:00",
			start: "22:00",
			timezone: "UTC",
		});
	});

	test("reads the callback preview and accepts servers that omit it", async () => {
		const pending = {
			callbackUrl: "https://deploy.example/callback?token=capability",
			expiresAt: null,
			prompt: "Ship?",
			respondedAt: null,
			status: "pending" as const,
			type: "approval" as const,
			value: null,
		};
		const responses = [
			{ ...pending, callbackUrlPreview: "https://deploy.example/…" },
			pending,
		];
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async () =>
				Response.json({
					event: {
						...notification("evt_1", "Approve"),
						response: responses.shift(),
					},
				}),
		});
		expect((await client.getEvent("evt_1")).response?.callbackUrlPreview).toBe(
			"https://deploy.example/…"
		);
		const older = await client.getEvent("evt_1");
		expect(older.response?.callbackUrlPreview).toBeUndefined();
		expect(older.response?.callbackUrl).toBe(pending.callbackUrl);
	});

	test("reads a tenant usage report for whole hours", async () => {
		let seenUrl = "";
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async (input) => {
				seenUrl = String(input);
				return Response.json({
					from: "2026-10-01T00:00:00.000Z",
					meters: { events: 1234 },
					ok: true,
					requestId: "req_1",
					to: "2026-10-01T01:00:00.000Z",
					type: "usage.report",
				});
			},
		});
		const report = await client.usage({
			from: new Date("2026-10-01T00:00:00Z"),
			to: "2026-10-01T01:00:00Z",
		});
		const url = new URL(seenUrl);
		expect(url.pathname).toBe("/v1/usage");
		expect(url.searchParams.get("from")).toBe("2026-10-01T00:00:00.000Z");
		expect(url.searchParams.get("to")).toBe("2026-10-01T01:00:00Z");
		expect(report.meters.events).toBe(1234);
		expect(report.to).toBe("2026-10-01T01:00:00.000Z");
	});

	test("parses notification and activity SSE frames", async () => {
		const encoded = new TextEncoder().encode(
			": ryu-notify\n\n" +
				`event: notification\nid: evt_1\ndata: ${JSON.stringify(notification("evt_1", "Ready"))}\n\n` +
				`event: activity\nid: act_1\ndata: ${JSON.stringify(activity("act_1", "Deploy"))}\n\n`
		);
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(encoded);
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } }
				),
		});
		const items: NotifyStreamItem[] = [];
		for await (const item of client.stream({ topic: "deploy" })) {
			items.push(item);
		}
		expect(items).toEqual([
			{
				event: notification("evt_1", "Ready"),
				id: "evt_1",
				type: "notification",
			},
			{
				activity: activity("act_1", "Deploy"),
				id: "act_1",
				type: "activity",
			},
		]);
	});
});
