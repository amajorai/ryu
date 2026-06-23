// packages/client/src/agents.ts
//
// AgentsAPI: typed client for Core's agent endpoints (/api/agents) and the
// streaming chat endpoint (/api/chat/stream). This is the primary surface for
// embedding a Ryu Core agent in any TypeScript app.

import { buildHeaders, buildUrl, request } from "./request";
import type {
	Agent,
	AgentSummary,
	Message,
	RyuClientOptions,
	StreamChunk,
} from "./types";

// ---------------------------------------------------------------------------
// Wire shapes (snake_case from Core)
// ---------------------------------------------------------------------------

interface AgentSummaryWire {
	created_at?: string | null;
	description?: string | null;
	engine?: string | null;
	id: string;
	install_hint?: string | null;
	installed?: boolean | null;
	locked?: boolean | null;
	model?: string | null;
	name: string;
	system_prompt?: string | null;
	transport?: string | null;
	version?: string | null;
}

interface AgentRecordWire {
	built_in?: boolean;
	created_at?: string | null;
	description?: string | null;
	engine?: string | null;
	id: string;
	locked?: boolean;
	model?: string | null;
	name: string;
	system_prompt?: string | null;
	tools?: string[];
	updated_at?: string | null;
	version?: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toSummary(a: AgentSummaryWire): AgentSummary {
	return {
		id: a.id,
		name: a.name,
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine: a.engine ?? null,
		model: a.model ?? null,
		installed: a.installed ?? null,
		installHint: a.install_hint ?? null,
		builtIn: a.transport != null,
		createdAt: a.created_at ?? null,
		version: a.version ?? null,
		locked: a.locked ?? false,
	};
}

function toAgent(a: AgentRecordWire): Agent {
	return {
		id: a.id,
		name: a.name,
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine: a.engine ?? null,
		model: a.model ?? null,
		tools: a.tools ?? [],
		builtIn: a.built_in ?? false,
		createdAt: a.created_at ?? null,
		updatedAt: a.updated_at ?? null,
		version: a.version ?? "1.0.0",
		locked: a.locked ?? false,
	};
}

// ---------------------------------------------------------------------------
// SSE frame parsing
// ---------------------------------------------------------------------------

/** Sentinel returned by {@link parseSseFrame} to signal the stream is complete. */
const DONE_FRAME = { type: "done" } as const;

/**
 * Parse one decoded SSE `data:` payload into a {@link StreamChunk}.
 *
 * Returns `DONE_FRAME` for the `[DONE]` terminator, a chunk for text/error
 * frames, or `null` for structural/unknown frames that produce no output.
 */
function parseSseFrame(data: string): StreamChunk | null {
	if (data === "[DONE]") {
		return DONE_FRAME;
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(data) as Record<string, unknown>;
	} catch {
		return null; // Ignore malformed SSE lines.
	}
	const type = parsed.type as string | undefined;
	// AI SDK v6 UI Message Stream: text arrives as `text-delta` parts.
	if (type === "text-delta") {
		const delta = parsed.delta as string | undefined;
		return delta ? { type: "text", content: delta } : null;
	}
	// AI SDK error part: surface the message so the caller can react.
	if (type === "error") {
		const errorText = (parsed.errorText ?? parsed.error) as string | undefined;
		return { type: "error", content: errorText ?? "stream error" };
	}
	// Structural parts (start, text-start, tool-*, finish, ...) produce no text.
	if (type) {
		return null;
	}
	// Fallback: OpenAI-style delta for non-Core OpenAI-compatible endpoints.
	const choices = parsed.choices as
		| Array<{ delta?: { content?: string } }>
		| undefined;
	const content =
		choices?.[0]?.delta?.content ?? (parsed.content as string | undefined);
	return content ? { type: "text", content } : null;
}

// ---------------------------------------------------------------------------
// API class
// ---------------------------------------------------------------------------

export class AgentsAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	/** List all agents (built-in + custom). */
	async list(): Promise<AgentSummary[]> {
		const data = await request<{ agents?: AgentSummaryWire[] }>(
			this.options,
			"/api/agents"
		);
		return (data.agents ?? []).map(toSummary);
	}

	/** Fetch a single agent by id. */
	async get(id: string): Promise<Agent> {
		const data = await request<{ agent: AgentRecordWire }>(
			this.options,
			`/api/agents/${id}`
		);
		return toAgent(data.agent);
	}

	/**
	 * Send a chat turn and collect the full response as a string.
	 * Uses the same streaming endpoint as stream() but buffers everything.
	 */
	async run(id: string, messages: Message[]): Promise<string> {
		let result = "";
		for await (const chunk of this.stream(id, messages)) {
			if (chunk.type === "text" && chunk.content) {
				result += chunk.content;
			}
		}
		return result;
	}

	/**
	 * Stream a chat turn with an agent, yielding StreamChunk values as they
	 * arrive from Core's SSE stream.
	 *
	 * Core emits the AI SDK v6 UI Message Stream protocol: each SSE frame is a
	 * `data:` line carrying a JSON object with a `type` discriminator. We surface
	 * the `text-delta` parts as text chunks and treat `[DONE]` / `error` parts
	 * accordingly. An OpenAI-style `choices[].delta.content` shape is also handled
	 * as a fallback for non-Core OpenAI-compatible endpoints.
	 *
	 * @example
	 * ```ts
	 * for await (const chunk of client.agents.stream("pi", messages)) {
	 *   if (chunk.type === "text") process.stdout.write(chunk.content ?? "");
	 * }
	 * ```
	 */
	async *stream(id: string, messages: Message[]): AsyncGenerator<StreamChunk> {
		const url = buildUrl(this.options, "/api/chat/stream");
		const headers = buildHeaders(this.options);
		const resp = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ agent_id: id, messages }),
		});

		if (!(resp.ok && resp.body)) {
			const text = await resp.text().catch(() => resp.statusText);
			throw new Error(`RyuClient: stream failed (${resp.status}): ${text}`);
		}

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const chunk = parseSseFrame(line.slice(6).trim());
					if (!chunk) {
						continue;
					}
					if (chunk.type === "done") {
						yield chunk;
						return;
					}
					yield chunk;
				}
			}
		} finally {
			reader.releaseLock();
		}

		yield { type: "done" };
	}
}
