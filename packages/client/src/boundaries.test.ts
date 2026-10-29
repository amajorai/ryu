import { afterEach, describe, expect, test } from "bun:test";
import { AgentsAPI } from "./agents.ts";
import { createBoxClient } from "./box.ts";
import {
	type ExecutionProfile,
	HarnessAPI,
	type HarnessRunEventEnvelope,
} from "./harness.ts";
import { MailAPI } from "./mail.ts";
import { createMessagingClient } from "./messaging.ts";
import { type NotificationEvent, NotifyAPI } from "./notify.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers) {
		server.stop(true);
	}
	servers.length = 0;
});
function serverFor(body: string) {
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response(body, {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}
const profile = {
	approval: "inherit",
	kind: "local",
	network: "inherit",
	sandbox: "inherit",
	worktreeIsolation: false,
} satisfies ExecutionProfile;
const event: NotificationEvent = {
	acknowledgedAt: null,
	actions: [],
	archivedAt: null,
	attachment: null,
	body: "",
	createdAt: "now",
	data: {},
	externalId: null,
	fingerprint: null,
	icon: null,
	id: "evt",
	level: "info",
	occurredAt: "now",
	priority: 3,
	project: null,
	recipient: null,
	response: null,
	source: "sdk",
	tags: [],
	title: "Ready",
	topic: null,
	type: "event",
	url: null,
};

describe("native client boundaries", () => {
	test("HTTP rejects malformed fields inside complete endpoint replies", async () => {
		const baseUrl = serverFor('{"agents":[{"id":"a","name":7}]}');
		await expect(new AgentsAPI({ baseUrl }).list()).rejects.toThrow();
		const boxUrl = serverFor('{"box":{"id":"b","status":"ready"}}');
		await expect(
			createBoxClient({ baseUrl: boxUrl, apiKey: "key" }).get("b")
		).rejects.toThrow();
		const messagingUrl = serverFor(
			'{"numbers":[{"id":"n","status":"active"}]}'
		);
		await expect(
			createMessagingClient({
				apiKey: "key",
				baseUrl: messagingUrl,
				organizationId: "6720a3c1f0e1d2c3b4a59600",
			}).numbers.list()
		).rejects.toThrow();
	});
	test("native Notify replies retain metadata, reserved own keys and wire field order", async () => {
		const data = JSON.parse('{"__proto__":{"kept":true},"overflow":1e400}');
		const reply = { future: "extension", event: { ...event, data } };
		const body = JSON.stringify(reply).replace(
			'"overflow":null',
			'"overflow":1e400'
		);
		const result = await new NotifyAPI({
			baseUrl: serverFor(body),
			apiKey: "key",
		}).publish({ title: "Ready" });
		expect(Object.keys(result)).toEqual(Object.keys(reply.event));
		expect(Object.hasOwn(result.data, "__proto__")).toBe(true);
		expect(result.data.overflow).toBe(Number.POSITIVE_INFINITY);
		expect(JSON.stringify(result)).toBe(JSON.stringify(reply.event));
	});
	test("malformed durable events are skipped before a complete terminal event", async () => {
		const common = {
			createdAt: "now",
			id: "evt",
			protocolVersion: "ryu.harness.v1",
			runId: "run",
			seq: 1,
			sessionId: "session",
		};
		const completed = {
			...common,
			type: "run_completed",
			output: JSON.parse('{"__proto__":{"kept":true}}'),
		} satisfies HarnessRunEventEnvelope;
		const payload = [
			{ ...common, type: "text_delta", delta: 7 },
			{ ...common, type: "run_started", executionProfile: profile },
			completed,
		];
		const baseUrl = serverFor(
			payload.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")
		);
		const events = [];
		for await (const item of new HarnessAPI({ baseUrl }).events("run")) {
			events.push(item);
		}
		expect(events.map((item) => item.type)).toEqual([
			"run_started",
			"run_completed",
		]);
		expect(events[1]).toEqual(completed);
		expect(JSON.stringify(events)).toBe(JSON.stringify(payload.slice(1)));
	});
	test("legacy Mail aliases retain complete projections and raw metadata", async () => {
		const response = {
			inbox: {
				id: 7,
				name: "Agent",
				address: "agent@example.com",
				provider: "imap",
				client_id: "client",
				pod_id: null,
				created_at: "created",
				metadata: JSON.parse(
					'{"__proto__":{"kept":true},"nested":[false,0,null]}'
				),
			},
		};
		const result = await new MailAPI({
			baseUrl: serverFor(JSON.stringify(response)),
		}).getInbox("id");
		expect(result).toEqual({
			address: "agent@example.com",
			agentId: null,
			clientId: "client",
			createdAt: "created",
			description: null,
			id: "7",
			metadata: response.inbox.metadata,
			name: "Agent",
			podId: null,
			provider: "imap",
			updatedAt: "created",
		});
		expect(Object.hasOwn(result.metadata, "__proto__")).toBe(true);
	});
});
