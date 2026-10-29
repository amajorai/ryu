import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	readWebhookSecret,
	toWebhookSecretRead,
	toWebhookSecretWrite,
	writeWebhookSecret,
} from "./webhooks.ts";

describe("webhook secret bridge replies", () => {
	it("checks a secretGet reply", () => {
		expect(toWebhookSecretRead({ secret: null })).toEqual({ secret: null });
		expect(toWebhookSecretRead({ secret: "s3cret" })).toEqual({
			secret: "s3cret",
		});
		expect(() => toWebhookSecretRead({})).toThrow();
		expect(() => toWebhookSecretRead(null)).toThrow();
	});

	it("checks a secretSet reply", () => {
		expect(toWebhookSecretWrite({ secret: "minted" })).toEqual({
			secret: "minted",
		});
		expect(() => toWebhookSecretWrite({})).toThrow();
		expect(() => toWebhookSecretWrite({ secret: null })).toThrow();
		expect(() => toWebhookSecretWrite({ secret: "" })).toThrow();
	});
});

interface ReceivedRequest {
	body: string;
	method: string;
	path: string;
}

const received: ReceivedRequest[] = [];
let bridgeReply = (): Response => Response.json({ result: { secret: "s" } });

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		received.push({ body: await request.text(), method: request.method, path });
		return path.endsWith("/host")
			? bridgeReply()
			: Response.json({ secret: "legacy-secret" });
	},
});
const target = {
	token: "fixture-node",
	url: `http://127.0.0.1:${server.port}`,
};
const APP = "@example/hooks";
const BRIDGE_PATH = `/api/plugins/${encodeURIComponent(APP)}/host`;

beforeEach(() => {
	received.length = 0;
	bridgeReply = () => Response.json({ result: { secret: "s" } });
});
afterAll(() => {
	server.stop(true);
});

describe("webhook secrets through the bridge", () => {
	it("reads and writes through Core's bridge methods", async () => {
		expect(await readWebhookSecret(target, APP, "wf-1")).toEqual({
			secret: "s",
		});
		expect(await writeWebhookSecret(target, APP, "wf-1")).toEqual({
			secret: "s",
		});
		await writeWebhookSecret(target, APP, "wf-1", "chosen-secret-0123");
		expect(received.map((entry) => entry.path)).toEqual([
			BRIDGE_PATH,
			BRIDGE_PATH,
			BRIDGE_PATH,
		]);
		expect(received.map((entry) => JSON.parse(entry.body))).toEqual([
			{ method: "webhooks.secretGet", args: { id: "wf-1" } },
			{ method: "webhooks.secretSet", args: { id: "wf-1" } },
			{
				method: "webhooks.secretSet",
				args: { id: "wf-1", secret: "chosen-secret-0123" },
			},
		]);
	});

	it("surfaces a refusal without a host-direct request", async () => {
		bridgeReply = () =>
			Response.json(
				{
					error: {
						code: "denied",
						message: "insufficient permissions: workflow.edit",
					},
				},
				{ status: 403 }
			);
		await expect(readWebhookSecret(target, APP, "wf-1")).rejects.toThrow(
			"insufficient permissions: workflow.edit"
		);
		await expect(
			writeWebhookSecret(target, APP, "wf-1", "chosen-secret-0123")
		).rejects.toThrow("insufficient permissions: workflow.edit");
		expect(received.map((entry) => entry.path)).toEqual([
			BRIDGE_PATH,
			BRIDGE_PATH,
		]);
	});

	it("falls back host-direct only on an older Core without the method", async () => {
		bridgeReply = () =>
			Response.json(
				{
					error: {
						code: "invalid_args",
						message: "unknown host method 'webhooks.secretGet'",
					},
				},
				{ status: 400 }
			);
		expect(await readWebhookSecret(target, APP, "wf-1")).toEqual({
			secret: "legacy-secret",
		});
		expect(received.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			`POST ${BRIDGE_PATH}`,
			"GET /api/webhooks/wf-1/secret",
		]);
	});

	it("writes host-direct only on an older Core without secretSet", async () => {
		bridgeReply = () =>
			Response.json(
				{
					error: {
						code: "invalid_args",
						message: "unknown host method 'webhooks.secretSet'",
					},
				},
				{ status: 400 }
			);
		// Generate (Core mints the secret), then save a chosen one.
		expect(await writeWebhookSecret(target, APP, "wf-1")).toEqual({
			secret: "legacy-secret",
		});
		expect(
			await writeWebhookSecret(target, APP, "wf-1", "chosen-secret-0123")
		).toEqual({ secret: "legacy-secret" });
		expect(received.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			`POST ${BRIDGE_PATH}`,
			"POST /api/webhooks/wf-1/secret",
			`POST ${BRIDGE_PATH}`,
			"POST /api/webhooks/wf-1/secret",
		]);
		expect(JSON.parse(received[1]?.body ?? "null")).toEqual({});
		expect(JSON.parse(received[3]?.body ?? "null")).toEqual({
			secret: "chosen-secret-0123",
		});
	});

	it("never falls back on another method's unknown-method reply", async () => {
		bridgeReply = () =>
			Response.json(
				{
					error: {
						code: "invalid_args",
						message: "unknown host method 'webhooks.secretGet'",
					},
				},
				{ status: 400 }
			);
		await expect(
			writeWebhookSecret(target, APP, "wf-1", "chosen-secret-0123")
		).rejects.toThrow("unknown host method 'webhooks.secretGet'");
		expect(received.map((entry) => entry.path)).toEqual([BRIDGE_PATH]);
	});
});
