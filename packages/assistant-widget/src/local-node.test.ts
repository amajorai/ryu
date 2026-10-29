import { describe, expect, test } from "bun:test";
import { SseFrameTooLargeError } from "@ryuhq/protocol/sse";

import {
	checkLocalNode,
	isLoopbackNodeUrl,
	normalizeNodeUrl,
	runLocalNodeChat,
	validateNodeUrl,
} from "./local-node.ts";

describe("local node bridge validation", () => {
	test("normalizes a loopback Core address", () => {
		expect(normalizeNodeUrl(" http://127.0.0.1:7980/ ")).toBe(
			"http://127.0.0.1:7980"
		);
		expect(isLoopbackNodeUrl("http://localhost:7980")).toBe(true);
	});

	test("rejects embedded credentials and untrusted remote nodes by default", () => {
		expect(() => normalizeNodeUrl("http://user:pass@localhost:7980")).toThrow(
			"embedded credentials"
		);
		expect(() => validateNodeUrl("https://node.example.com", false)).toThrow(
			"limited to this computer"
		);
		expect(validateNodeUrl("https://node.example.com", true)).toBe(
			"https://node.example.com"
		);
	});

	test("streams a non-persistent Core turn without sending cookies", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(
					[
						'data: {"type":"text-delta","delta":"local "}\n\n',
						'data: {"type":"text-delta","delta":"answer"}\n\n',
						"data: [DONE]\n\n",
					].join("")
				);
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			const deltas: string[] = [];
			const answer = await runLocalNodeChat(
				{ baseUrl: "http://127.0.0.1:7982", token: "node-token" },
				[{ content: "hello", role: "user" }],
				{ onDelta: (delta) => deltas.push(delta) }
			);
			expect(answer).toBe("local answer");
			expect(deltas).toEqual(["local ", "answer"]);
			expect(capturedUrl).toBe("http://127.0.0.1:7982/api/chat/stream");
			expect(capturedInit?.credentials).toBe("omit");
			expect(capturedInit?.headers).toMatchObject({
				Authorization: "Bearer node-token",
				"Content-Type": "application/json",
			});
			expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
				agent_id: "ryu",
				browser_surface: "website-assistant",
				persist: false,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("ignores malformed frames and reads compatibility deltas", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					[
						"data: {\n\n",
						"data: null\n\n",
						'data: {"type":"text-delta","delta":42}\n\n',
						'data: {"choices":[{"delta":{"content":"compatible "}}]}\n\n',
						'data: {"choices":[{"text":"answer"}]}\n\n',
						"data: [DONE]\n\n",
					].join("")
				),
			{ preconnect: originalFetch.preconnect }
		);
		try {
			expect(
				await runLocalNodeChat(
					{ baseUrl: "http://localhost:7980", token: null },
					[]
				)
			).toBe("compatible answer");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("preserves node error frames as rejected turns", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					'data: {"type":"error","errorText":"model unavailable"}\n\n'
				),
			{ preconnect: originalFetch.preconnect }
		);
		try {
			await expect(
				runLocalNodeChat({ baseUrl: "http://localhost:7980", token: null }, [])
			).rejects.toThrow("model unavailable");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not report a protected node as connected without its token", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/api/health")) {
					return new Response(JSON.stringify({ status: "ok" }), {
						status: 200,
					});
				}
				return new Response("unauthorized", { status: 401 });
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			await expect(
				checkLocalNode({
					baseUrl: "http://127.0.0.1:7980",
					token: null,
				})
			).rejects.toThrow("node rejected");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

interface StreamProbe {
	cancelled: boolean;
	pulls: number;
}

/** A response body that serves `chunks` one per pull and records cancellation. */
function probedStream(chunks: string[]): {
	body: ReadableStream<Uint8Array>;
	probe: StreamProbe;
} {
	const encoder = new TextEncoder();
	const probe: StreamProbe = { cancelled: false, pulls: 0 };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = chunks[probe.pulls];
			probe.pulls += 1;
			if (next === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(next));
		},
		cancel() {
			probe.cancelled = true;
		},
	});
	return { body, probe };
}

describe("local node chat stream bounds", () => {
	test("cancels a delimiter-free stream once its pending frame passes the bound", async () => {
		// 64 chunks of 8 KiB and no line ending: 512 KiB of one unterminated event.
		const chunks = [
			'data: {"type":"text-delta","delta":"',
			...Array.from({ length: 64 }, () => "x".repeat(8192)),
		];
		const { body, probe } = probedStream(chunks);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(async () => new Response(body), {
			preconnect: originalFetch.preconnect,
		});
		try {
			const deltas: string[] = [];
			await expect(
				runLocalNodeChat(
					{ baseUrl: "http://127.0.0.1:7982", token: null },
					[{ content: "hello", role: "user" }],
					{ onDelta: (delta) => deltas.push(delta) }
				)
			).rejects.toBeInstanceOf(SseFrameTooLargeError);
			expect(probe.cancelled).toBe(true);
			expect(probe.pulls).toBeLessThan(chunks.length);
			expect(deltas).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("decodes CRLF frames whose line endings are split across chunks", async () => {
		const frame = 'data: {"type":"text-delta","delta":"split"}\r\n\r\n';
		const cut = frame.indexOf("\r\n") + 1;
		const { body } = probedStream([
			frame.slice(0, cut),
			frame.slice(cut, cut + 2),
			frame.slice(cut + 2),
			"data: [DONE]\r\n\r\n",
		]);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(async () => new Response(body), {
			preconnect: originalFetch.preconnect,
		});
		try {
			expect(
				await runLocalNodeChat(
					{ baseUrl: "http://127.0.0.1:7982", token: null },
					[{ content: "hello", role: "user" }]
				)
			).toBe("split");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
