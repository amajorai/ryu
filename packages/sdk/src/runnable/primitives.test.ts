/**
 * Tests for the composable primitive surface (program §6b).
 *
 * These verify the SDK-side contract WITHOUT a live Core node: a fake transport
 * records which op each primitive method routes to, so we assert the vocabulary
 * mirror (bridge/direct/broker + method/path/capability) matches `rpc.ts`.
 */

import { describe, expect, it } from "bun:test";
import { PluginManifestSchema, validateManifestStrict } from "../manifest.ts";
import { defineAgent } from "./agent.ts";
import {
	createPrimitives,
	httpPrimitiveTransport,
	PRIMITIVE_BINDINGS,
	type PrimitiveTransport,
} from "./primitives.ts";

interface Call {
	body: unknown;
	op: "bridge" | "direct" | "capability";
	target: string;
}

function recordingTransport(): {
	transport: PrimitiveTransport;
	calls: Call[];
} {
	const calls: Call[] = [];
	const transport: PrimitiveTransport = {
		bridge(method, args) {
			calls.push({ op: "bridge", target: method, body: args });
			return Promise.resolve("bridge-ok");
		},
		direct(path, body) {
			calls.push({ op: "direct", target: path, body });
			return Promise.resolve(["direct-ok"]);
		},
		capability(cap, body) {
			calls.push({ op: "capability", target: cap, body });
			return Promise.resolve([]);
		},
	};
	return { transport, calls };
}

describe("createPrimitives — transport routing mirrors rpc.ts", () => {
	it("engines.complete routes through the bridge model.complete family", async () => {
		const { transport, calls } = recordingTransport();
		const p = createPrimitives(transport);
		await p.engines.complete({ prompt: "hi", modelPrefKey: "chat" });
		expect(calls).toHaveLength(1);
		const [call] = calls;
		if (!call) {
			throw new Error("expected one call");
		}
		expect(call.op).toBe("bridge");
		expect(call.target).toBe("model.complete");
		// camelCase modelPrefKey lowers to the snake_case wire key.
		expect(call.body).toMatchObject({ prompt: "hi", model_pref_key: "chat" });
	});

	it("media primitives route host-direct to their Core endpoints", async () => {
		const { transport, calls } = recordingTransport();
		const p = createPrimitives(transport);
		await p.image.generate({ prompt: "a cat" });
		await p.tts.speak({ text: "hello" });
		await p.stt.transcribe({ audio: "data:audio/wav;base64,AAAA" });
		expect(calls.map((c) => `${c.op}:${c.target}`)).toEqual([
			"direct:/api/images/generate",
			"direct:/api/voice/speak",
			"direct:/api/voice/transcribe",
		]);
	});

	it("stt.transcribe over the real HTTP transport uploads a multipart `file` (not JSON)", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fetchImpl = ((url: string, init: RequestInit) => {
			seen = { url, init };
			return Promise.resolve(
				new Response(JSON.stringify({ text: "  hello world  " }), {
					headers: { "content-type": "application/json" },
				})
			);
		}) as unknown as typeof fetch;

		const transport = httpPrimitiveTransport({
			nodeUrl: "http://127.0.0.1:7980",
			token: "t0k",
			fetchImpl,
		});
		const p = createPrimitives(transport);
		const text = await p.stt.transcribe({
			audio: "data:audio/wav;base64,QUFBQQ==",
			filename: "clip.wav",
		});

		// The transcript is parsed from Core's `{ text }` JSON and trimmed.
		expect(text).toBe("hello world");
		if (!seen) {
			throw new Error("expected a fetch call");
		}
		expect(seen.url).toBe("http://127.0.0.1:7980/api/voice/transcribe");
		// A JSON body would guarantee a 400 from Core's Multipart extractor.
		const { body, headers } = seen.init;
		expect(body).toBeInstanceOf(FormData);
		const file = (body as FormData).get("file");
		expect(file).toBeInstanceOf(Blob);
		// No JSON content-type — FormData must set its own multipart boundary.
		const ct = new Headers(headers).get("content-type") ?? "";
		expect(ct.includes("application/json")).toBe(false);
	});

	it("tts.speak over the real HTTP transport returns a data: URL from audio/wav bytes", async () => {
		let sentBody: unknown;
		const fetchImpl = ((_url: string, init: RequestInit) => {
			sentBody = init.body;
			return Promise.resolve(
				new Response(new Uint8Array([1, 2, 3, 4]), {
					headers: { "content-type": "audio/wav" },
				})
			);
		}) as unknown as typeof fetch;

		const transport = httpPrimitiveTransport({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl,
		});
		const p = createPrimitives(transport);
		const url = await p.tts.speak({ text: "hi", voice: "alto" });

		// JSON in (not FormData), data: URL out — the shipped type contract.
		expect(typeof sentBody).toBe("string");
		expect(JSON.parse(sentBody as string)).toMatchObject({
			text: "hi",
			voice: "alto",
		});
		expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
	});

	it("broker-backed primitives POST to the capability broker (@requires-grant)", async () => {
		const { transport, calls } = recordingTransport();
		const p = createPrimitives(transport);
		await p.rag.retrieve({ query: "q" });
		await p.memory.recall({ query: "q" });
		await p.realtime.broadcast({ room: "r", event: "e" });
		await p.durable.checkpoint({ key: "k", state: {} });
		await p.engines.embed({ input: "x" });
		expect(calls.map((c) => c.target)).toEqual([
			"rag",
			"memory",
			"realtime",
			"durable",
			"engines",
		]);
		expect(calls.every((c) => c.op === "capability")).toBe(true);
		// The broker body carries the discriminating op + input.
		const [ragCall] = calls;
		if (!ragCall) {
			throw new Error("expected a rag call");
		}
		expect(ragCall.body).toMatchObject({ op: "retrieve" });
	});

	it("every declared primitive has a binding entry (no silent drift)", () => {
		const expected = [
			"engines.complete",
			"engines.embed",
			"image.generate",
			"tts.speak",
			"stt.transcribe",
			"rag.retrieve",
			"rag.embed",
			"rag.rerank",
			"memory.recall",
			"memory.store",
			"realtime.broadcast",
			"realtime.subscribe",
			"durable.checkpoint",
			"durable.resume",
		];
		for (const key of expected) {
			expect(PRIMITIVE_BINDINGS[key]).toBeDefined();
		}
	});
});

describe("defineAgent — composable slots lower to a valid manifest", () => {
	it("classic signature is unchanged (back-compat)", async () => {
		let seen = "";
		const a = defineAgent<{ q: string }, string>({
			id: "agent-classic",
			name: "Classic",
			run({ q }, ctx) {
				seen = q;
				return ctx.gateway
					.chat([{ role: "user", content: q }])
					.then((r) => r.content);
			},
		});
		expect(a.kind).toBe("agent");
		expect(a.card.capabilities).toEqual([]);
		const ctx = {
			gateway: {
				chat: () => Promise.resolve({ content: "ok", finishReason: null }),
				async *stream() {
					/* unused */
				},
			},
		};
		const out = await a.run({ q: "hello" }, ctx);
		expect(seen).toBe("hello");
		expect(out).toBe("ok");
	});

	it("slots lower to requires.capabilities + persona/model config", () => {
		const cmo = defineAgent({
			id: "agent-cmo",
			name: "CMO",
			chat: { model: "gpt-4o", persona: "You are a CMO." },
			rag: true,
			memory: { minVersion: "1.2.0" },
			tts: "com.acme.elevenlabs",
		});
		expect(cmo.card.model).toBe("gpt-4o");
		expect(cmo.card.persona).toBe("You are a CMO.");
		expect(cmo.card.capabilities).toEqual([
			{ capability: "rag" },
			{ capability: "memory", min_version: "1.2.0" },
			{ capability: "tts" },
		]);
		expect(cmo.card.providers.tts).toBe("com.acme.elevenlabs");

		const manifest = cmo.toManifest({ id: "com.acme.cmo", version: "1.0.0" });
		// Lowered manifest must pass the SDK's authoring schema…
		expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
		expect(manifest.requires?.capabilities).toEqual([
			{ capability: "rag" },
			{ capability: "memory", min_version: "1.2.0" },
			{ capability: "tts" },
		]);
		const [agentMeta] = manifest.runnables;
		if (!agentMeta) {
			throw new Error("expected a lowered agent runnable");
		}
		expect(agentMeta.kind).toBe("agent");
		expect(agentMeta.config).toMatchObject({
			model: "gpt-4o",
			persona: "You are a CMO.",
			capability_providers: { tts: "com.acme.elevenlabs" },
		});
		// …and Core-strict validation (native addon when present; skip otherwise).
		try {
			validateManifestStrict(JSON.stringify(manifest));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!message.includes("@ryuhq/sdk-native")) {
				throw err;
			}
		}
	});

	it("a slot-only agent synthesizes a chat-slot default run", async () => {
		const bot = defineAgent({
			id: "agent-bot",
			name: "Bot",
			chat: { persona: "Be terse." },
		});
		const messages: { role: string; content: string }[] = [];
		const ctx = {
			gateway: {
				chat: (m: { role: string; content: string }[]) => {
					messages.push(...m);
					return Promise.resolve({ content: "reply", finishReason: null });
				},
				async *stream() {
					/* unused */
				},
			},
		};
		const out = await bot.run("ping", ctx);
		expect(out).toBe("reply");
		expect(messages[0]).toEqual({ role: "system", content: "Be terse." });
		expect(messages[1]).toEqual({ role: "user", content: "ping" });
	});
});
