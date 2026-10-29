// Main-process client for Ryu Core (:7980).
//
// All Core HTTP runs here, never in the renderer, because Core's CORS allowlist
// excludes Electron origins. Every method degrades gracefully: an unreachable
// Core resolves to an `{ available: false, reason }` result instead of throwing
// so the renderer never sees a rejected promise. The streaming chat path parses
// Core's AI SDK v6 SSE frames and forwards each part to a sink keyed by stream
// id, with abort support via an `AbortController` registry.

import { randomUUID } from "node:crypto";
import { parseTranscriptionDetail } from "@ryuhq/core-client/voice";
import { z } from "zod";
import { acpConfigSchema } from "../../shared/acp.ts";
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
	CoreSpeechProcessingRequest,
	CoreSpeechProcessingResult,
	CoreStreamEndEvent,
	CoreStreamPartEvent,
	CoreToolCallRequest,
	CoreToolCallResult,
	CoreTranscribeOptions,
	CoreTranscribeResult,
	EngineModelsResult,
	SidecarStartResult,
	SidecarStatusResult,
} from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { withResponseDeadline } from "./response-deadline.ts";
import { accumulateStreamText, SseDecoder } from "./sse.ts";

const textResponseSchema = z.object({ text: z.string().catch("") });
const errorResponseSchema = z.object({ error: z.string().optional() });
const completionsResponseSchema = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({ content: z.string().optional() }).optional(),
			})
		)
		.optional(),
});
const toolResponseSchema = z.object({
	ok: z.boolean().optional(),
	output: z.json().optional(),
	error: z.string().optional(),
});
const sidecarsResponseSchema = z.object({
	sidecars: z
		.array(z.object({ name: z.string(), running: z.boolean() }))
		.optional(),
});
const sidecarStartSchema = z.object({
	success: z.boolean().optional(),
	error: z.string().optional(),
});
const agentResponseSchema = z.object({
	id: z.string(),
	name: z.string().optional().catch(undefined),
	description: z.string().nullable().catch(null),
	engine: z.string().nullable().catch(null),
	model: z.string().nullable().catch(null),
	transport: z.string().nullable().catch(null),
	built_in: z.boolean().catch(false),
	recommended: z.boolean().catch(false),
});
const agentsResponseSchema = z.object({
	agents: z.array(agentResponseSchema.nullable().catch(null)).optional(),
});
const modelCatalogSchema = z.object({
	models: z
		.record(z.string(), z.array(z.object({ id: z.string(), name: z.string() })))
		.optional(),
});
const conversationResponseSchema = z.object({
	id: z.string(),
	title: z.string().min(1).catch("Untitled"),
});
const conversationsResponseSchema = z.object({
	conversations: z
		.array(conversationResponseSchema.nullable().catch(null))
		.optional(),
});
/** Short timeout for one-shot probes (health, status, tool calls). */
const PROBE_TIMEOUT_MS = 5000;
/** Longer timeout for the non-streaming completion request. */
const COMPLETION_TIMEOUT_MS = 60_000;
/** Timeout for a transcription round-trip (local STT can be slow on first run). */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Timeout for the first Speech Processing call while llama.cpp warms. */
const SPEECH_PROCESSING_TIMEOUT_MS = 120_000;

/** Sinks the IPC layer wires to `webContents.send`. */
export interface StreamSink {
	end(event: CoreStreamEndEvent): void;
	part(event: CoreStreamPartEvent): void;
}

/** One in-flight chat stream, keyed by stream id for abort. */
interface ActiveStream {
	controller: AbortController;
	/**
	 * The persisted conversation the turn runs in, or `undefined` for a turn Core
	 * does not persist. Core drives a persisted turn independently of this
	 * request, so aborting it must also cancel the turn there.
	 */
	conversationId?: string;
}

/** In-flight streams keyed by stream id, for abort. */
const activeStreams = new Map<string, ActiveStream>();

const coreFailureSchema = z
	.union([z.instanceof(DOMException), z.instanceof(Error)])
	.catch(new Error("unreachable"));

function reasonFromError(error: z.infer<typeof coreFailureSchema>): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

/** Probe `GET /api/health`. Resolves `{ available }` and never rejects. */
export async function health(): Promise<AvailabilityResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<AvailabilityResult>(
			`${coreBaseUrl}/api/health`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				return { available: true };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
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
	activeStreams.set(streamId, {
		controller,
		conversationId:
			req.persist === false ? undefined : req.conversation_id || undefined,
	});
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
			error: reasonFromError(coreFailureSchema.parse(error)),
		});
	} finally {
		controller.abort();
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
	try {
		while (!done) {
			const { value, done: streamDone } = await reader.read();
			if (streamDone) {
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			// An oversized frame throws here, before any of its parts reach IPC.
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
	} finally {
		sse.flush();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
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

/**
 * Stop an in-flight stream by id: cancel its turn on Core (a persisted turn keeps
 * running there after its request is aborted), then abort the request. No-op
 * when the id is unknown or the stream already finished.
 */
export function abortStream(streamId: string): void {
	const stream = activeStreams.get(streamId);
	if (!stream) {
		return;
	}
	if (stream.conversationId) {
		cancelChatTurn(stream.conversationId).catch(() => {
			// Best effort: the request abort below still stops this client.
		});
		// Both the stop control and the stream's cancel can land here; cancel once.
		stream.conversationId = undefined;
	}
	stream.controller.abort();
}

/** Ask Core to stop a conversation's in-flight turn (`POST /api/chat/cancel`). */
async function cancelChatTurn(conversationId: string): Promise<void> {
	const { coreBaseUrl } = loadConfig();
	await withResponseDeadline(
		`${coreBaseUrl}/api/chat/cancel`,
		{
			method: "POST",
			headers: coreHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ conversation_id: conversationId }),
		},
		PROBE_TIMEOUT_MS,
		async (resp) => {
			await resp.body?.cancel();
		}
	);
}

/**
 * Non-streaming completion via `POST /v1/chat/completions`. With `model`
 * omitted Core routes to the local default (Gemma 4 E2B) through the gateway.
 */
export async function completions(
	req: CoreCompletionsRequest
): Promise<CoreCompletionsResult> {
	const { coreBaseUrl } = loadConfig();
	const body: CoreCompletionsRequest = { messages: req.messages };
	if (req.model) {
		body.model = req.model;
	}
	try {
		return await withResponseDeadline<CoreCompletionsResult>(
			`${coreBaseUrl}/v1/chat/completions`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify(body),
			},
			COMPLETION_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = completionsResponseSchema.parse(await resp.json());
				const text = data.choices?.[0]?.message?.content ?? "";
				return { available: true, text };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
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
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

/**
 * Synthesize speech via `POST /api/voice/speak`, returning the WAV bytes for the
 * renderer to play. Core routes the built-in `outetts` engine to `llama-tts` and
 * any other engine to the Ryu TTS sidecar. Never rejects to the caller.
 */
export async function speak(req: CoreSpeakRequest): Promise<CoreSpeakResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CoreSpeakResult>(
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
			COMPLETION_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const audio = await resp.arrayBuffer();
				const mime = resp.headers.get("content-type") ?? "audio/wav";
				return { available: true, audio, mime };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

const transcribeOptionsSchema = z
	.object({
		detailed: z.boolean().optional().catch(undefined),
		filename: z
			.string()
			.trim()
			.min(1)
			.max(255)
			.regex(/^[^\\/\r\n"]+$/)
			.optional()
			.catch(undefined),
	})
	.catch(() => ({}));

/** Normalize renderer-supplied transcribe options; unknown or unsafe fields drop. */
export function transcribeOptions(raw: unknown): CoreTranscribeOptions {
	const parsed = transcribeOptionsSchema.parse(raw ?? {});
	const options: CoreTranscribeOptions = {};
	if (parsed.detailed !== undefined) {
		options.detailed = parsed.detailed;
	}
	if (parsed.filename !== undefined) {
		options.filename = parsed.filename;
	}
	return options;
}

/**
 * Transcribe captured WAV audio via `POST /api/voice/transcribe?engine=`. The
 * renderer cannot call Core directly (CORS), so it ships the WAV bytes here and
 * the main process builds the multipart upload. An empty engine omits `?engine=`
 * so Core uses its default. `detailed` also returns Core's timed segments.
 * Never rejects to the caller.
 */
export async function transcribe(
	audio: ArrayBuffer,
	engine: string,
	options: CoreTranscribeOptions = {}
): Promise<CoreTranscribeResult> {
	const { coreBaseUrl } = loadConfig();
	const selectedEngine = engine.trim();
	const query = selectedEngine
		? `?engine=${encodeURIComponent(selectedEngine)}`
		: "";
	const filename = options.filename ?? "audio.wav";
	try {
		const form = new FormData();
		form.append("file", new Blob([audio], { type: "audio/wav" }), filename);
		return await withResponseDeadline<CoreTranscribeResult>(
			`${coreBaseUrl}/api/voice/transcribe${query}`,
			// No explicit Content-Type: fetch sets the multipart boundary itself.
			{ method: "POST", headers: coreHeaders(), body: form },
			TRANSCRIBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					const data = errorResponseSchema
						.catch(() => ({}))
						.parse(await resp.json().catch(() => ({})));
					return {
						available: false,
						reason: data.error ?? `core responded ${resp.status}`,
					};
				}
				const body: unknown = await resp.json();
				if (options.detailed) {
					const detail = parseTranscriptionDetail(body);
					return { available: true, text: detail.text, detail };
				}
				const data = textResponseSchema.parse(body);
				return { available: true, text: data.text ?? "" };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/**
 * Clean one raw transcript via Core's Speech Processing layer. The Island main
 * process calls this only when Dictation cleanup is enabled; the renderer never
 * talks to Core directly. Never rejects to the caller.
 */
export async function processSpeechText(
	req: CoreSpeechProcessingRequest
): Promise<CoreSpeechProcessingResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CoreSpeechProcessingResult>(
			`${coreBaseUrl}/api/voice/speech-processing`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify(req),
			},
			SPEECH_PROCESSING_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					const data = errorResponseSchema.parse(
						await resp.json().catch(() => ({}))
					);
					return {
						available: false,
						reason: data.error ?? `core responded ${resp.status}`,
					};
				}
				const data = textResponseSchema.parse(await resp.json());
				return { available: true, text: data.text ?? "" };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** Invoke an MCP tool via `POST /api/mcp/tools/call`. */
export async function callTool(
	req: CoreToolCallRequest
): Promise<CoreToolCallResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CoreToolCallResult>(
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
			PROBE_TIMEOUT_MS,
			async (resp) => {
				const data = toolResponseSchema.parse(
					await resp.json().catch(() => ({}))
				);
				return {
					available: true,
					ok: data.ok ?? resp.ok,
					output: data.output,
					error: data.error,
				};
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** Read sidecar statuses via `GET /api/sidecar/status`. */
export async function sidecarStatus(): Promise<SidecarStatusResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<SidecarStatusResult>(
			`${coreBaseUrl}/api/sidecar/status`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = sidecarsResponseSchema.parse(await resp.json());
				return { available: true, sidecars: data.sidecars ?? [] };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** Start a named sidecar via `POST /api/sidecar/:name/start`. */
export async function sidecarStart(name: string): Promise<SidecarStartResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<SidecarStartResult>(
			`${coreBaseUrl}/api/sidecar/${encodeURIComponent(name)}/start`,
			{ method: "POST", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				const data = sidecarStartSchema.parse(
					await resp.json().catch(() => ({}))
				);
				return {
					available: true,
					success: data.success ?? resp.ok,
					error: data.error,
				};
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** List installed agents via `GET /api/agents`. Never rejects to the caller. */
export async function agents(): Promise<AgentsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<AgentsResult>(
			`${coreBaseUrl}/api/agents`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = agentsResponseSchema.parse(await resp.json());
				const list: CoreAgentSummary[] = (data.agents ?? []).flatMap((agent) =>
					agent
						? [
								{
									id: agent.id,
									name: agent.name ?? agent.id,
									description: agent.description,
									recommended: agent.recommended,
									transport: agent.transport,
									engine: agent.engine,
									model: agent.model,
									builtIn: agent.built_in || agent.transport !== null,
								},
							]
						: []
				);
				return { available: true, agents: list };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** Fetch an agent's ACP session config. Never rejects to the caller. */
export async function acpConfig(agentId: string): Promise<AcpConfigResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<AcpConfigResult>(
			`${coreBaseUrl}/api/agents/${encodeURIComponent(agentId)}/acp-config`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const config = acpConfigSchema.parse(await resp.json());
				return { available: true, config };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** Per-engine chat model catalog from Core. Never rejects to the caller. */
export async function engineModels(): Promise<EngineModelsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<EngineModelsResult>(
			`${coreBaseUrl}/api/engines/models`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = modelCatalogSchema.parse(await resp.json());
				return { available: true, models: data.models ?? {} };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}

/** List recent conversations via `GET /api/conversations`. Never rejects. */
export async function conversations(): Promise<ConversationsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<ConversationsResult>(
			`${coreBaseUrl}/api/conversations`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = conversationsResponseSchema.parse(await resp.json());
				const list: CoreConversationSummary[] = (
					data.conversations ?? []
				).flatMap((conversation) => (conversation ? [conversation] : []));
				return { available: true, conversations: list };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(coreFailureSchema.parse(error)),
		};
	}
}
