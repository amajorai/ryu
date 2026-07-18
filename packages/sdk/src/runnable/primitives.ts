/**
 * Composable primitive-client surface for the Ryu SDK runtime context.
 *
 * Now that each capability is its own crate with a clean trait
 * (`crates/ryu-rag`, `crates/ryu-memory`, `crates/ryu-realtime`,
 * `crates/ryu-durable`, `crates/ryu-engines`, `crates/ryu-tts`,
 * `crates/ryu-stt`, `crates/ryu-image`), the SDK exposes each as a typed,
 * **gateway-mandatory** client on `RunnableContext`: `ctx.rag.retrieve()`,
 * `ctx.memory.recall()`, `ctx.engines.complete()`, and so on. An agent composes
 * the same building blocks a developer does — the DX payoff of decomposition
 * (program §6b).
 *
 * These clients are **thin typed wrappers** over the EXISTING host transport
 * families — they invent NO new backend endpoints. The method names and grants
 * mirror the canonical vocabulary in
 * `packages/app-host/src/rpc.ts` (`METHOD_CAPABILITY` / `GRANT_CAPABILITY`); the
 * arg/result shapes mirror the `RpcServices` signatures there. We MIRROR that
 * vocabulary rather than importing it: `@ryuhq/sdk` is a published package and
 * `@ryu/app-host` is a desktop-host package in a disjoint lane.
 *
 * Three real transport shapes exist in `rpc.ts`, so the transport exposes three
 * ops (all reach a Core node the host holds the token for):
 *   - `bridge`  → the `PluginHookBridge` families (`POST /api/plugins/:id/host`,
 *                 `{ method, args }`) — e.g. `model.complete` → `host.sideModel`.
 *   - `direct`  → host-direct Core data-path calls the host makes on the frame's
 *                 behalf (`POST /api/images/generate`, `/api/voice/speak`,
 *                 `/api/voice/transcribe`).
 *   - `capability` → the capability broker (`POST /api/host/capability/:cap`) for
 *                 caps that have no rpc family yet (rag/memory/realtime/durable/
 *                 engines.embed). These are marked `@requires-grant`: the caller
 *                 must DECLARE the edge in `requires.capabilities` and hold the
 *                 bound provider's grant, else Core fails closed (404/403).
 */

import { assertAllowedEgressUrl } from "../model/gateway.ts";

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * Low-level dispatcher a primitive client uses to reach a Core node. Injected
 * so the SDK stays transport-agnostic (the same seam as `ctx.gateway`); a
 * default HTTP implementation is {@link httpPrimitiveTransport}.
 */
export interface PrimitiveTransport {
	/**
	 * Invoke a `PluginHookBridge` family method (`POST /api/plugins/:id/host`).
	 * `method` is the exact `rpc.ts` `METHOD_CAPABILITY` key (e.g.
	 * `"model.complete"`); the host maps it to the closed `host.*` bridge path.
	 */
	bridge(method: string, args: unknown): Promise<unknown>;
	/**
	 * Invoke an abstract capability through the broker
	 * (`POST /api/host/capability/:cap`). `@requires-grant`: the caller must have
	 * declared `requires.capabilities: [{ capability: cap }]` and hold the bound
	 * provider's grant, or Core fails closed.
	 */
	capability(cap: string, body: unknown): Promise<unknown>;
	/**
	 * Invoke a host-direct Core data-path endpoint (`POST {path}`). Used for the
	 * media families the host reaches directly (`/api/images/generate`,
	 * `/api/voice/speak`, `/api/voice/transcribe`) rather than via the bridge.
	 *
	 * The two voice endpoints do NOT speak plain JSON-in/JSON-out — a real Core
	 * node requires a multipart `file` upload for transcription and streams raw
	 * `audio/wav` bytes back from synthesis. The default {@link httpPrimitiveTransport}
	 * therefore reshapes those two calls (mirroring the desktop host's `rpc.ts`):
	 *   - `/api/voice/transcribe` — `{ audio: data-URL, filename? }` → multipart
	 *     `file` upload; resolves to the transcript `string`.
	 *   - `/api/voice/speak` — JSON in; resolves to a renderable `data:` audio URL
	 *     built from the returned `audio/wav` bytes.
	 * Every other path is a straight JSON round-trip.
	 */
	direct(path: string, body: unknown): Promise<unknown>;
}

// ── Data-URL <-> bytes (voice media reshaping, no external deps) ────────────────

/** Decode a `data:` URL into its raw bytes + declared media type. */
function dataUrlToBytes(dataUrl: string): {
	bytes: Uint8Array;
	mediaType: string;
} {
	const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
	if (!match) {
		throw new Error(
			"stt.transcribe expects an `audio` value that is a data: URL (data:<mime>;base64,<data>)"
		);
	}
	const mediaType = match[1] || "application/octet-stream";
	const isBase64 = Boolean(match[2]);
	const payload = match[3] ?? "";
	if (isBase64) {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return { bytes, mediaType };
	}
	return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mediaType };
}

/** Encode raw bytes as a `data:<mediaType>;base64,...` URL. */
function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
	let binary = "";
	// Chunk to stay well under the argument-count ceiling of String.fromCharCode.
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return `data:${mediaType};base64,${btoa(binary)}`;
}

/** Options for {@link httpPrimitiveTransport}. */
export interface HttpPrimitiveTransportOptions {
	/** Injectable `fetch` (defaults to the global). */
	fetchImpl?: typeof fetch;
	/**
	 * Core **node** base URL (no trailing slash) — NEVER a direct provider. The
	 * URL is validated against the direct-provider egress blocklist so every
	 * primitive call stays governed (the gateway-mandatory rule).
	 */
	nodeUrl: string;
	/**
	 * The calling plugin's reverse-domain id. REQUIRED for the `bridge` op —
	 * `/api/plugins/:id/host` authenticates this id and gates on its
	 * Gateway-approved grants. Omit only if the caller never uses bridge-backed
	 * primitives (`ctx.engines.complete`).
	 */
	pluginId?: string;
	/** Node bearer token forwarded on every call. */
	token?: string;
}

/**
 * A default HTTP {@link PrimitiveTransport} targeting a Core node. Validates
 * `nodeUrl` against the direct-provider egress blocklist at construction, so a
 * mis-pointed transport can never route a primitive call at a raw provider.
 */
export function httpPrimitiveTransport(
	options: HttpPrimitiveTransportOptions
): PrimitiveTransport {
	const base = options.nodeUrl.replace(/\/+$/, "");
	// Gateway-mandatory: reject a direct-provider base URL. A Core node URL
	// (e.g. http://127.0.0.1:7980) passes; api.openai.com et al. throw.
	assertAllowedEgressUrl(base);
	const doFetch = options.fetchImpl ?? fetch;

	const authHeader = (): Record<string, string> =>
		options.token ? { authorization: `Bearer ${options.token}` } : {};

	const failDetail = async (path: string, res: Response): Promise<Error> => {
		const detail = await res.text().catch(() => "");
		return new Error(
			`Ryu primitive call ${path} failed: ${res.status} ${res.statusText}${
				detail ? ` — ${detail}` : ""
			}`
		);
	};

	const post = async (path: string, body: unknown): Promise<unknown> => {
		const res = await doFetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeader() },
			body: JSON.stringify(body ?? {}),
		});
		if (!res.ok) {
			throw await failDetail(path, res);
		}
		const text = await res.text();
		return text ? (JSON.parse(text) as unknown) : undefined;
	};

	// `/api/voice/transcribe` — Core's Axum handler requires a multipart upload
	// with a `file` field, NOT a JSON body. Convert the caller's data: URL into a
	// `file` part (letting fetch set the multipart boundary) and return the text.
	const transcribeDirect = async (body: unknown): Promise<string> => {
		const input = (body ?? {}) as { audio?: string; filename?: string };
		if (!input.audio) {
			throw new Error(
				"stt.transcribe requires an `audio` data: URL (the recorded audio)"
			);
		}
		const { bytes, mediaType } = dataUrlToBytes(input.audio);
		const form = new FormData();
		form.append(
			"file",
			new Blob([bytes], { type: mediaType || "audio/wav" }),
			input.filename ?? "recording.wav"
		);
		// No JSON content-type here — FormData sets its own multipart boundary.
		const res = await doFetch(`${base}/api/voice/transcribe`, {
			method: "POST",
			headers: authHeader(),
			body: form,
		});
		if (!res.ok) {
			throw await failDetail("/api/voice/transcribe", res);
		}
		const parsed = (await res.json()) as { text?: string };
		return (parsed.text ?? "").trim();
	};

	// `/api/voice/speak` — Core streams raw `audio/wav` bytes back (not JSON, not a
	// data: URL). Convert the response to a renderable data: URL, as the desktop
	// host's rpc.ts does, so the shipped type contract ("returns a data: URL") holds.
	const speakDirect = async (body: unknown): Promise<string> => {
		const res = await doFetch(`${base}/api/voice/speak`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeader() },
			body: JSON.stringify(body ?? {}),
		});
		if (!res.ok) {
			throw await failDetail("/api/voice/speak", res);
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		const mediaType = res.headers.get("content-type") || "audio/wav";
		return bytesToDataUrl(bytes, mediaType);
	};

	// `/api/images/generate` — Core returns an OpenAI-style envelope
	// (`{ data: [{ url? , b64_json? }] }`, `apps/core/src/server/media.rs`), NOT a
	// bare array of strings. Unwrap each item to a renderable URL: a direct `url`
	// if present, else a `data:image/png;base64,<b64_json>` URL — so the shipped
	// `Promise<string[]>` contract holds.
	const generateImageDirect = async (body: unknown): Promise<string[]> => {
		const res = await doFetch(`${base}/api/images/generate`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeader() },
			body: JSON.stringify(body ?? {}),
		});
		if (!res.ok) {
			throw await failDetail("/api/images/generate", res);
		}
		const parsed = (await res.json()) as {
			data?: Array<{ url?: string; b64_json?: string }>;
		};
		return (parsed.data ?? []).map((item) =>
			item.url
				? item.url
				: `data:image/png;base64,${item.b64_json ?? ""}`
		);
	};

	return {
		bridge(method, args) {
			if (!options.pluginId) {
				return Promise.reject(
					new Error(
						`bridge primitive "${method}" requires a pluginId (the /api/plugins/:id/host caller identity)`
					)
				);
			}
			return post(`/api/plugins/${options.pluginId}/host`, { method, args });
		},
		direct(path, body) {
			if (path === "/api/voice/transcribe") {
				return transcribeDirect(body);
			}
			if (path === "/api/voice/speak") {
				return speakDirect(body);
			}
			if (path === "/api/images/generate") {
				return generateImageDirect(body);
			}
			return post(path, body);
		},
		capability(cap, body) {
			return post(`/api/host/capability/${cap}`, body);
		},
	};
}

// ── Primitive → transport binding (the single drift-point) ─────────────────────

/**
 * How one primitive method reaches Core. This is the SDK's single mirror of the
 * `rpc.ts` `METHOD_CAPABILITY` / `GRANT_CAPABILITY` maps — keep it in lockstep
 * with that canonical source. `bridge`/`direct` families exist today;
 * `broker` families are `@requires-grant` (declared capability edge).
 */
export type PrimitiveBinding =
	| {
			readonly transport: "bridge";
			/** Exact `rpc.ts` method key (e.g. `"model.complete"`). */
			readonly method: string;
			/** Gateway grant that unlocks it (`GRANT_CAPABILITY` inverse). */
			readonly grant: string;
	  }
	| {
			readonly transport: "direct";
			/** Core data-path endpoint the host calls directly. */
			readonly path: string;
			/** Gateway grant that unlocks it. */
			readonly grant: string;
	  }
	| {
			readonly transport: "broker";
			/** Abstract capability name (the broker `:cap` segment + the
			 *  `requires.capabilities` edge the caller must declare). */
			readonly capability: string;
	  };

/**
 * The binding for every primitive method, keyed `"<namespace>.<method>"`.
 * Mirrors `rpc.ts`; the ONLY place primitive→endpoint knowledge lives.
 */
export const PRIMITIVE_BINDINGS: Record<string, PrimitiveBinding> = {
	// Bridge families (existing `PluginHookBridge`).
	"engines.complete": {
		transport: "bridge",
		method: "model.complete",
		grant: "hook:side-model",
	},
	// Host-direct media data-path (the host holds the node token; returns data: URLs).
	"image.generate": {
		transport: "direct",
		path: "/api/images/generate",
		grant: "media:generate",
	},
	"tts.speak": {
		transport: "direct",
		path: "/api/voice/speak",
		grant: "media:generate",
	},
	"stt.transcribe": {
		transport: "direct",
		path: "/api/voice/transcribe",
		grant: "media:transcribe",
	},
	// Broker capabilities — no rpc family yet (@requires-grant).
	"rag.retrieve": { transport: "broker", capability: "rag" },
	"rag.embed": { transport: "broker", capability: "rag" },
	"rag.rerank": { transport: "broker", capability: "rag" },
	"memory.recall": { transport: "broker", capability: "memory" },
	"memory.store": { transport: "broker", capability: "memory" },
	"realtime.broadcast": { transport: "broker", capability: "realtime" },
	"realtime.subscribe": { transport: "broker", capability: "realtime" },
	"durable.checkpoint": { transport: "broker", capability: "durable" },
	"durable.resume": { transport: "broker", capability: "durable" },
	"engines.embed": { transport: "broker", capability: "engines" },
};

// ── Typed primitive clients (shapes mirror the crate traits) ───────────────────

/** One retrieved chunk (`crates/ryu-rag` `RagChunk`). */
export interface RagChunk {
	id: string;
	metadata?: Record<string, unknown>;
	score: number;
	source?: string;
	text: string;
}

/** One rerank result (`crates/ryu-rag` reranker trait). */
export interface RagRerankResult {
	document: string;
	index: number;
	score: number;
}

/** RAG primitive — retrieval, embedding, reranking (`crates/ryu-rag`). */
export interface RagClient {
	/** Embed text into vectors. `@requires-grant rag`. */
	embed(input: {
		input: string | string[];
		model?: string;
	}): Promise<number[][]>;
	/** Rerank `documents` against `query`. `@requires-grant rag`. */
	rerank(input: {
		query: string;
		documents: string[];
		topK?: number;
		model?: string;
	}): Promise<RagRerankResult[]>;
	/** Vector/GraphRAG retrieval for `query`. `@requires-grant rag`. */
	retrieve(input: {
		query: string;
		topK?: number;
		spaceId?: string;
		filter?: Record<string, unknown>;
	}): Promise<RagChunk[]>;
}

/** One recalled memory (`crates/ryu-memory` `MemoryItem`). */
export interface MemoryItem {
	category?: string;
	content: string;
	id: string;
	importance?: number;
	level?: string;
	score?: number;
	tags?: string[];
}

/** Memory primitive — recall + store (`crates/ryu-memory`). */
export interface MemoryClient {
	/** Semantic recall across the readable scope levels. `@requires-grant memory`. */
	recall(input: {
		query: string;
		levels?: string[];
		limit?: number;
	}): Promise<MemoryItem[]>;
	/** Persist a memory. `@requires-grant memory`. */
	store(input: {
		content: string;
		level?: string;
		category?: string;
		importance?: number;
		tags?: string[];
	}): Promise<{ id: string }>;
}

/**
 * A realtime subscription handle. The broker is a unary POST, so `subscribe`
 * cannot stream today — it returns a handle (the crate's typed event contract
 * grows a live channel later). Honest shape over a promised-but-unbacked stream.
 */
export interface RealtimeSubscription {
	room: string;
	subscriptionId: string;
}

/** Realtime primitive — typed room events (`crates/ryu-realtime`). */
export interface RealtimeClient {
	/** Broadcast a typed event to a room. `@requires-grant realtime`. */
	broadcast(input: {
		room: string;
		event: string;
		payload?: unknown;
	}): Promise<void>;
	/** Open a subscription handle for a room. `@requires-grant realtime`. */
	subscribe(input: { room: string }): Promise<RealtimeSubscription>;
}

/** Durable primitive — checkpoint + resume (`crates/ryu-durable`). */
export interface DurableClient {
	/** Persist a checkpoint; returns a resume token. `@requires-grant durable`. */
	checkpoint(input: {
		key: string;
		state: unknown;
	}): Promise<{ token: string }>;
	/** Resume from a checkpoint token (`null` when unknown). `@requires-grant durable`. */
	resume(input: { token: string }): Promise<{ state: unknown } | null>;
}

/** Engines primitive — completion + embedding (`crates/ryu-engines`). */
export interface EnginesClient {
	/**
	 * Tool-less one-shot completion (bridge `model.complete` → `host.sideModel`,
	 * Gateway-routed). Grant `hook:side-model`.
	 */
	complete(input: {
		prompt: string;
		system?: string;
		model?: string;
		modelPrefKey?: string;
		effort?: string;
	}): Promise<string>;
	/** Embed text into vectors. `@requires-grant engines`. */
	embed(input: {
		input: string | string[];
		model?: string;
	}): Promise<number[][]>;
}

/** TTS primitive — speech synthesis (`crates/ryu-tts`). */
export interface TtsClient {
	/**
	 * Synthesize speech (host-direct `/api/voice/speak`, Gateway-governed).
	 * Returns a renderable `data:` audio URL. Grant `media:generate`.
	 */
	speak(input: {
		text: string;
		engine?: string;
		voice?: string;
		speed?: number;
		language?: string;
	}): Promise<string>;
}

/** STT primitive — transcription (`crates/ryu-stt`). */
export interface SttClient {
	/**
	 * Transcribe an audio `data:` URL (host-direct `/api/voice/transcribe`).
	 * Returns the text. Grant `media:transcribe`.
	 */
	transcribe(input: { audio: string; filename?: string }): Promise<string>;
}

/** Image primitive — generation (`crates/ryu-image`). */
export interface ImageClient {
	/**
	 * Generate image(s) from a prompt (host-direct `/api/images/generate`,
	 * Gateway-governed). Returns renderable `data:` URLs. Grant `media:generate`.
	 */
	generate(input: {
		prompt: string;
		count?: number;
		size?: string;
		provider?: string;
		model?: string;
	}): Promise<string[]>;
}

/**
 * The composable primitive bundle mounted on {@link RunnableContext}. Every
 * client routes through the Gateway (bridge/direct/broker all reach a governed
 * Core node) — the same "what runs vs what is allowed" split as `ctx.gateway`.
 */
export interface RyuPrimitives {
	durable: DurableClient;
	engines: EnginesClient;
	image: ImageClient;
	memory: MemoryClient;
	rag: RagClient;
	realtime: RealtimeClient;
	stt: SttClient;
	tts: TtsClient;
}

// ── Factory ────────────────────────────────────────────────────────────────

/** Route a broker-backed primitive call. `op` discriminates the provider verb. */
function brokerCall(
	transport: PrimitiveTransport,
	cap: string,
	op: string,
	input: unknown
): Promise<unknown> {
	return transport.capability(cap, { op, input });
}

/**
 * Build the typed {@link RyuPrimitives} bundle over a {@link PrimitiveTransport}.
 * Each method is a thin wrapper: bridge/direct families forward to the existing
 * endpoints; broker families POST to `/api/host/capability/:cap` (`@requires-grant`).
 */
export function createPrimitives(transport: PrimitiveTransport): RyuPrimitives {
	return {
		rag: {
			retrieve: (input) =>
				brokerCall(transport, "rag", "retrieve", input) as Promise<RagChunk[]>,
			embed: (input) =>
				brokerCall(transport, "rag", "embed", input) as Promise<number[][]>,
			rerank: (input) =>
				brokerCall(transport, "rag", "rerank", input) as Promise<
					RagRerankResult[]
				>,
		},
		memory: {
			recall: (input) =>
				brokerCall(transport, "memory", "recall", input) as Promise<
					MemoryItem[]
				>,
			store: (input) =>
				brokerCall(transport, "memory", "store", input) as Promise<{
					id: string;
				}>,
		},
		realtime: {
			broadcast: (input) =>
				brokerCall(transport, "realtime", "broadcast", input).then(
					() => undefined
				),
			subscribe: (input) =>
				brokerCall(
					transport,
					"realtime",
					"subscribe",
					input
				) as Promise<RealtimeSubscription>,
		},
		durable: {
			checkpoint: (input) =>
				brokerCall(transport, "durable", "checkpoint", input) as Promise<{
					token: string;
				}>,
			resume: (input) =>
				brokerCall(transport, "durable", "resume", input) as Promise<{
					state: unknown;
				} | null>,
		},
		engines: {
			// Bridge family: model.complete → host.sideModel (wire keys are snake_case).
			complete: (input) =>
				transport.bridge("model.complete", {
					prompt: input.prompt,
					system: input.system,
					model: input.model,
					model_pref_key: input.modelPrefKey,
					effort: input.effort,
				}) as Promise<string>,
			embed: (input) =>
				brokerCall(transport, "engines", "embed", input) as Promise<number[][]>,
		},
		tts: {
			speak: (input) =>
				transport.direct("/api/voice/speak", input) as Promise<string>,
		},
		stt: {
			transcribe: (input) =>
				transport.direct("/api/voice/transcribe", input) as Promise<string>,
		},
		image: {
			generate: (input) =>
				transport.direct("/api/images/generate", input) as Promise<string[]>,
		},
	};
}
