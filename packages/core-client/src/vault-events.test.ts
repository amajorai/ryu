import { describe, expect, test } from "bun:test";
import {
	openVaultEventStream,
	parseVaultEventFrame,
	streamVaultAgentEvents,
	streamVaultEvents,
	type VaultEventMessage,
} from "./vault-events.ts";

const KV_WRITE = {
	seq: 9,
	at: "2026-01-01T00:00:00Z",
	type: "kv-write",
	action: "secret.update",
	environment: "dev",
	path: "/",
	name: "API_KEY",
	version: 3,
};

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

async function collect(
	stream: AsyncGenerator<VaultEventMessage>
): Promise<VaultEventMessage[]> {
	const messages: VaultEventMessage[] = [];
	for await (const message of stream) {
		messages.push(message);
	}
	return messages;
}

describe("parseVaultEventFrame", () => {
	test("parses a vault event and a lagged notice", () => {
		expect(
			parseVaultEventFrame(
				`event: vault\nid: 9\ndata: ${JSON.stringify(KV_WRITE)}`
			)
		).toEqual({ kind: "event", event: KV_WRITE });
		expect(parseVaultEventFrame('event: lagged\ndata: {"skipped":4}')).toEqual({
			kind: "lagged",
			skipped: 4,
		});
	});

	test("ignores keep-alives, other events, and malformed data", () => {
		expect(parseVaultEventFrame(":")).toBeNull();
		expect(parseVaultEventFrame("event: other\ndata: {}")).toBeNull();
		expect(parseVaultEventFrame("event: vault\ndata: not json")).toBeNull();
		expect(parseVaultEventFrame('event: vault\ndata: {"seq":"x"}')).toBeNull();
	});
});

describe("streamVaultEvents", () => {
	test("sends the filter and node bearer, and yields frames split across chunks", async () => {
		let seenUrl = "";
		let seenHeaders: Record<string, string> = {};
		const frame = `event: vault\ndata: ${JSON.stringify(KV_WRITE)}\n\n`;
		const fetcher = (url: string | URL | Request, init?: RequestInit) => {
			seenUrl = String(url);
			seenHeaders = init?.headers as Record<string, string>;
			return Promise.resolve(
				new Response(sseBody([":\n\n", frame.slice(0, 20), frame.slice(20)]), {
					headers: { "content-type": "text/event-stream" },
				})
			);
		};
		const messages = await collect(
			streamVaultEvents(
				{ url: "http://node/", token: "node-token", fetch: fetcher },
				{ environment: "dev", types: ["kv-write", "kv-delete"] }
			)
		);
		expect(messages).toEqual([{ kind: "event", event: KV_WRITE }]);
		expect(seenUrl).toBe(
			"http://node/api/vault/events?types=kv-write%2Ckv-delete&environment=dev"
		);
		expect(seenHeaders.Authorization).toBe("Bearer node-token");
		expect(seenHeaders.Accept).toBe("text/event-stream");
	});

	test("a refused subscription throws with the status", async () => {
		const fetcher = () =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
			);
		await expect(
			collect(
				streamVaultEvents({ url: "http://node", token: "t", fetch: fetcher })
			)
		).rejects.toMatchObject({ status: 403 });
	});
});

describe("streamVaultAgentEvents", () => {
	test("sends only the vault token header", async () => {
		let seenHeaders: Record<string, string> = {};
		let seenUrl = "";
		const fetcher = (url: string | URL | Request, init?: RequestInit) => {
			seenUrl = String(url);
			seenHeaders = init?.headers as Record<string, string>;
			return Promise.resolve(
				new Response(sseBody(['event: lagged\ndata: {"skipped":1}\n\n']))
			);
		};
		const messages = await collect(
			streamVaultAgentEvents({
				url: "http://node",
				vaultToken: "vt",
				fetch: fetcher,
			})
		);
		expect(messages).toEqual([{ kind: "lagged", skipped: 1 }]);
		expect(seenUrl).toBe("http://node/api/vault/agent/events");
		expect(seenHeaders["x-ryu-vault-token"]).toBe("vt");
		expect(seenHeaders.Authorization).toBeUndefined();
	});
});

describe("openVaultEventStream", () => {
	test("rejects a refused subscription before any frame is read", async () => {
		const fetcher = () =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
			);
		await expect(
			openVaultEventStream({ url: "http://node", token: "t", fetch: fetcher })
		).rejects.toMatchObject({ status: 401 });
	});
});
