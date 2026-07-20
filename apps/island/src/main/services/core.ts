// Main-process client for Ryu Core (:7980).
//
// All Core HTTP runs here, never in the renderer, because Core's CORS allowlist
// excludes Electron origins. Every method degrades gracefully: an unreachable
// Core resolves to an `{ available: false, reason }` result instead of throwing
// so the renderer never sees a rejected promise. The streaming chat path parses
// Core's AI SDK v6 SSE frames and forwards each part to a sink keyed by stream
// id, with abort support via an `AbortController` registry.

import { randomUUID } from "node:crypto";
import type { AcpConfig } from "../../shared/acp.ts";
import type {
	AcpConfigResult,
	AgentsResult,
	AvailabilityResult,
	ConversationsResult,
	CoreAgentSummary,
	CoreChatMessage,
	CoreChatStreamHandle,
	CoreChatStreamRequest,
	CoreCompletionsRequest,
	CoreCompletionsResult,
	CoreConversationSummary,
	CoreSpeakRequest,
	CoreSpeakResult,
	CoreStreamEndEvent,
	CoreStreamPartEvent,
	CoreToolCallRequest,
	CoreToolCallResult,
	CoreTranscribeResult,
	EngineModelsResult,
	SidecarStartResult,
	SidecarStatus,
	SidecarStatusResult,
} from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { SseDecoder } from "./sse.ts";

/** Short timeout for one-shot probes (health, status, tool calls). */
const PROBE_TIMEOUT_MS = 5000;
/** Longer timeout for the non-streaming completion request. */
const COMPLETION_TIMEOUT_MS = 60_000;
/** Timeout for a transcription round-trip (local STT can be slow on first run). */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Sinks the IPC layer wires to `webContents.send`. */
export interface StreamSink {
	end(event: CoreStreamEndEvent): void;
	part(event: CoreStreamPartEvent): void;
}

/** In-flight stream controllers keyed by stream id, for abort. */
const activeStreams = new Map<string, AbortController>();

function reasonFromError(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

/** Fetch with an abort-based timeout. Rethrows so callers can map to a reason. */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Probe `GET /api/health`. Resolves `{ available }` and never rejects. */
export async function health(): Promise<AvailabilityResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/health`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		return { available: true };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * Start a streamed chat run. Returns a handle immediately; parts and the
 * terminal event are delivered through `sink`. Aborting is done via
 * `abortStream(handle.streamId)`. Never rejects to the caller.
 */
export function chatStream(
	req: CoreChatStreamRequest,
	sink: StreamSink
): CoreChatStreamHandle {
	const streamId = randomUUID();
	const controller = new AbortController();
	activeStreams.set(streamId, controller);
	// Fire-and-forget: `runChatStream` swallows all errors and signals the
	// renderer through `sink.end`, so there is nothing to await or catch here.
	runChatStream(streamId, req, sink, controller).catch(() => {
		// Unreachable: `runChatStream` never rejects. Guard anyway.
	});
	return { streamId };
}

async function runChatStream(
	streamId: string,
	req: CoreChatStreamRequest,
	sink: StreamSink,
	controller: AbortController
): Promise<void> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetch(`${coreBaseUrl}/api/chat/stream`, {
			method: "POST",
			headers: coreHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(req),
			signal: controller.signal,
		});
		if (!(resp.ok && resp.body)) {
			finishStream(streamId, sink, {
				streamId,
				reason: "error",
				error: `core responded ${resp.status}`,
			});
			return;
		}
		await pumpStream(streamId, resp.body, sink);
		finishStream(streamId, sink, { streamId, reason: "done" });
	} catch (error) {
		if (controller.signal.aborted) {
			finishStream(streamId, sink, { streamId, reason: "aborted" });
			return;
		}
		finishStream(streamId, sink, {
			streamId,
			reason: "error",
			error: reasonFromError(error),
		});
	}
}

async function pumpStream(
	streamId: string,
	body: ReadableStream<Uint8Array>,
	sink: StreamSink
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	let done = false;
	while (!done) {
		const { value, done: streamDone } = await reader.read();
		if (streamDone) {
			break;
		}
		const chunk = decoder.decode(value, { stream: true });
		for (const event of sse.push(chunk)) {
			if (event.kind === "done") {
				done = true;
				break;
			}
			sink.part({ streamId, part: event.part });
		}
	}
	for (const event of sse.flush()) {
		if (event.kind === "part") {
			sink.part({ streamId, part: event.part });
		}
	}
}

function finishStream(
	streamId: string,
	sink: StreamSink,
	event: CoreStreamEndEvent
): void {
	if (!activeStreams.has(streamId)) {
		return;
	}
	activeStreams.delete(streamId);
	sink.end(event);
}

/** Abort an in-flight stream by id. No-op when the id is unknown. */
export function abortStream(streamId: string): void {
	const controller = activeStreams.get(streamId);
	if (controller) {
		controller.abort();
	}
}

/**
 * Non-streaming completion via `POST /v1/chat/completions`. With `model`
 * omitted Core routes to the local default (Gemma 4 E2B) through the gateway.
 */
export async function completions(
	req: CoreCompletionsRequest
): Promise<CoreCompletionsResult> {
	const { coreBaseUrl } = loadConfig();
	const body: Record<string, unknown> = { messages: req.messages };
	if (req.model) {
		body.model = req.model;
	}
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/v1/chat/completions`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify(body),
			},
			COMPLETION_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = data.choices?.[0]?.message?.content ?? "";
		return { available: true, text };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * Run a turn through a specific agent (`POST /api/chat/stream` with `agent_id`)
 * and accumulate the streamed `text-delta` parts into one string. Used by the
 * proactive suggestion engine when it is configured to route through an agent
 * (e.g. the flagship `ryu`) rather than the fast local completion. The turn is
 * NOT persisted (`persist: false`): a proactive suggestion is an ephemeral
 * background call, so it must not leave an orphan "App: …" conversation in the
 * store. `enable_long_term` stays false too. Never rejects to the caller.
 */
export async function runAgentText(
	agentId: string,
	messages: CoreChatMessage[]
): Promise<CoreCompletionsResult> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
	try {
		const resp = await fetch(`${coreBaseUrl}/api/chat/stream`, {
			method: "POST",
			headers: coreHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				agent_id: agentId,
				conversation_id: `island-proactive-${randomUUID()}`,
				enable_long_term: false,
				companion_source: true,
				persist: false,
				messages,
			} satisfies CoreChatStreamRequest),
			signal: controller.signal,
		});
		if (!(resp.ok && resp.body)) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const text = await accumulateStreamText(resp.body);
		return { available: true, text };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	} finally {
		clearTimeout(timer);
	}
}

/** Drain an AI SDK SSE body, concatenating every `text-delta` into one string. */
async function accumulateStreamText(
	body: ReadableStream<Uint8Array>
): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	let text = "";
	const append = (part: { type: string; delta?: unknown }): void => {
		if (part.type === "text-delta" && typeof part.delta === "string") {
			text += part.delta;
		}
	};
	let done = false;
	while (!done) {
		const { value, done: streamDone } = await reader.read();
		if (streamDone) {
			break;
		}
		const chunk = decoder.decode(value, { stream: true });
		for (const event of sse.push(chunk)) {
			if (event.kind === "done") {
				done = true;
				break;
			}
			append(event.part);
		}
	}
	for (const event of sse.flush()) {
		if (event.kind === "part") {
			append(event.part);
		}
	}
	return text;
}

/**
 * Synthesize speech via `POST /api/voice/speak`, returning the WAV bytes for the
 * renderer to play. Core routes the built-in `outetts` engine to `llama-tts` and
 * any other engine to the Ryu TTS sidecar. Never rejects to the caller.
 */
export async function speak(req: CoreSpeakRequest): Promise<CoreSpeakResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/voice/speak`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({
					text: req.text,
					engine: req.engine,
					voice: req.voice,
				}),
			},
			COMPLETION_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const audio = await resp.arrayBuffer();
		const mime = resp.headers.get("content-type") ?? "audio/wav";
		return { available: true, audio, mime };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * Transcribe captured WAV audio via `POST /api/voice/transcribe?engine=`. The
 * renderer cannot call Core directly (CORS), so it ships the WAV bytes here and
 * the main process builds the multipart upload. Never rejects to the caller.
 */
export async function transcribe(
	audio: ArrayBuffer,
	engine: string
): Promise<CoreTranscribeResult> {
	const { coreBaseUrl } = loadConfig();
	const query = engine ? `?engine=${encodeURIComponent(engine)}` : "";
	try {
		const form = new FormData();
		form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/voice/transcribe${query}`,
			// No explicit Content-Type: fetch sets the multipart boundary itself.
			{ method: "POST", headers: coreHeaders(), body: form },
			TRANSCRIBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { text?: string };
		return { available: true, text: data.text ?? "" };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Invoke an MCP tool via `POST /api/mcp/tools/call`. */
export async function callTool(
	req: CoreToolCallRequest
): Promise<CoreToolCallResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/mcp/tools/call`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({
					tool: req.tool,
					arguments: req.arguments,
					agent_id: req.agent_id,
				}),
			},
			PROBE_TIMEOUT_MS
		);
		const data = (await resp.json().catch(() => ({}))) as {
			ok?: boolean;
			output?: unknown;
			error?: string;
		};
		return {
			available: true,
			ok: data.ok ?? resp.ok,
			output: data.output,
			error: data.error,
		};
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Read sidecar statuses via `GET /api/sidecar/status`. */
export async function sidecarStatus(): Promise<SidecarStatusResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/sidecar/status`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { sidecars?: SidecarStatus[] };
		return { available: true, sidecars: data.sidecars ?? [] };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Start a named sidecar via `POST /api/sidecar/:name/start`. */
export async function sidecarStart(name: string): Promise<SidecarStartResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/sidecar/${encodeURIComponent(name)}/start`,
			{ method: "POST", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		const data = (await resp.json().catch(() => ({}))) as {
			success?: boolean;
			error?: string;
		};
		return {
			available: true,
			success: data.success ?? resp.ok,
			error: data.error,
		};
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** List installed agents via `GET /api/agents`. Never rejects to the caller. */
export async function agents(): Promise<AgentsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/agents`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			agents?: {
				built_in?: unknown;
				description?: unknown;
				engine?: unknown;
				id?: unknown;
				model?: unknown;
				name?: unknown;
				recommended?: unknown;
				transport?: unknown;
			}[];
		};
		const list: CoreAgentSummary[] = [];
		for (const a of data.agents ?? []) {
			if (typeof a.id !== "string") {
				continue;
			}
			list.push({
				id: a.id,
				name: typeof a.name === "string" ? a.name : a.id,
				description: typeof a.description === "string" ? a.description : null,
				recommended: a.recommended === true,
				transport: typeof a.transport === "string" ? a.transport : null,
				engine: typeof a.engine === "string" ? a.engine : null,
				model: typeof a.model === "string" ? a.model : null,
				builtIn: a.built_in === true || typeof a.transport === "string",
			});
		}
		return { available: true, agents: list };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Fetch an agent's ACP session config. Never rejects to the caller. */
export async function acpConfig(agentId: string): Promise<AcpConfigResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/agents/${encodeURIComponent(agentId)}/acp-config`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const config = (await resp.json()) as AcpConfig;
		return { available: true, config };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Per-engine chat model catalog from Core. Never rejects to the caller. */
export async function engineModels(): Promise<EngineModelsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/engines/models`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			models?: Record<string, { id: string; name: string }[]>;
		};
		return { available: true, models: data.models ?? {} };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** List recent conversations via `GET /api/conversations`. Never rejects. */
export async function conversations(): Promise<ConversationsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/conversations`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			conversations?: { id?: unknown; title?: unknown }[];
		};
		const list: CoreConversationSummary[] = [];
		for (const c of data.conversations ?? []) {
			if (typeof c.id !== "string") {
				continue;
			}
			list.push({
				id: c.id,
				title:
					typeof c.title === "string" && c.title.length > 0
						? c.title
						: "Untitled",
			});
		}
		return { available: true, conversations: list };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}
