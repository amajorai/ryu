import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";
import { wireJsonSchema } from "./wire-json.ts";
// packages/client/src/agents.ts
//
// AgentsAPI: typed client for Core's agent endpoints (/api/agents) and the
// streaming chat endpoint (/api/chat/stream). This is the primary surface for
// embedding a Ryu Core agent in any TypeScript app.

import { buildHeaders, buildUrl, request } from "./request.ts";
import type {
	Agent,
	AgentCreateInput,
	AgentIdentityMode,
	AgentSummary,
	AgentUpdateInput,
	Message,
	RyuClientOptions,
	RyuResponseMode,
	StreamChunk,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Wire shapes (snake_case from Core)
// ---------------------------------------------------------------------------

const summaryWireSchema = z.object({
	created_at: z.string().nullish(),
	description: z.string().nullish(),
	engine: z.string().nullish(),
	id: z.string(),
	install_hint: z.string().nullish(),
	installed: z.boolean().nullish(),
	locked: z.boolean().nullish(),
	model: z.string().nullish(),
	name: z.string(),
	system_prompt: z.string().nullish(),
	title: z.string().nullish(),
	transport: z.string().nullish(),
	version: z.string().nullish(),
});
const personaValidation: z.ZodType<NonNullable<Agent["persona"]>> = z.object({
	display_name: z.string().nullable(),
	output_style_id: z.string().nullish(),
	tone: z.string().nullable(),
});
const personaSchema = z.custom<NonNullable<Agent["persona"]>>(
	(value) => personaValidation.safeParse(value).success
);
const recordWireSchema = z.object({
	built_in: z.boolean().optional(),
	created_at: z.string().nullish(),
	description: z.string().nullish(),
	engine: z.string().nullish(),
	id: z.string(),
	// A string, not an enum: an unknown mode must not fail the whole record;
	// `agentIdentityMode` maps it fail-closed instead.
	identity_mode: z.string().nullish(),
	// `null`/absent = unrestricted; `[]` = no accounts. Keep the distinction.
	account_access: z.array(z.string()).nullable().optional(),
	locked: z.boolean().optional(),
	model: z.string().nullish(),
	name: z.string(),
	persona: personaSchema.nullish(),
	system_prompt: z.string().nullish(),
	title: z.string().nullish(),
	tools: z.array(z.string()).optional(),
	updated_at: z.string().nullish(),
	version: z.string().optional(),
});
type AgentSummaryWire = z.infer<typeof summaryWireSchema>;
type AgentRecordWire = z.infer<typeof recordWireSchema>;
const agentListSchema = z.object({
	agents: z.array(summaryWireSchema).nullish(),
});
const agentDetailSchema = z.object({ agent: recordWireSchema });

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Normalize a wire identity mode. A missing value (a node from before identity
 * modes) reads as `managed`, Core's legacy default. An unknown value reads as
 * `individual`, the most restrictive mode, matching Core's fail-closed rule so
 * a client that echoes the mode back can never widen it to act as the user.
 */
export function agentIdentityMode(
	value: string | null | undefined
): AgentIdentityMode {
	if (value === "individual" || value === "mixed") {
		return value;
	}
	if (value === undefined || value === null || value === "") {
		return "managed";
	}
	return value === "managed" ? "managed" : "individual";
}

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
		title: a.title ?? "",
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
		title: a.title ?? "",
		persona: a.persona ?? null,
		identityMode: agentIdentityMode(a.identity_mode),
		accountAccess: a.account_access ?? null,
		tools: a.tools ?? [],
		builtIn: a.built_in ?? false,
		createdAt: a.created_at ?? null,
		updatedAt: a.updated_at ?? null,
		version: a.version ?? "1.0.0",
		locked: a.locked ?? false,
	};
}

interface AgentWriteBody {
	account_access?: string[] | null;
	description?: string | null;
	engine?: string | null;
	expected_updated_at?: string;
	identity_mode?: AgentIdentityMode;
	model?: string | null;
	name?: string;
	system_prompt?: string | null;
	title?: string;
	tools?: string[];
}

/**
 * Build a create/update body. Only fields the caller set are sent, so an
 * update leaves every other field unchanged. `accountAccess: null` is sent as
 * an explicit `null` because Core reads it as "clear to unrestricted", which
 * differs from omitting it.
 */
function toWriteBody(
	input: AgentCreateInput | AgentUpdateInput
): AgentWriteBody {
	const body: AgentWriteBody = {};
	if (input.name !== undefined) {
		body.name = input.name;
	}
	if (input.title !== undefined) {
		body.title = input.title;
	}
	if (input.description !== undefined) {
		body.description = input.description;
	}
	if (input.systemPrompt !== undefined) {
		body.system_prompt = input.systemPrompt;
	}
	if (input.engine !== undefined) {
		body.engine = input.engine;
	}
	if (input.model !== undefined) {
		body.model = input.model;
	}
	if (input.tools !== undefined) {
		body.tools = input.tools;
	}
	if (input.identityMode !== undefined) {
		body.identity_mode = input.identityMode;
	}
	if (input.accountAccess !== undefined) {
		body.account_access = input.accountAccess;
	}
	if ("expectedUpdatedAt" in input && input.expectedUpdatedAt !== undefined) {
		body.expected_updated_at = input.expectedUpdatedAt;
	}
	return body;
}

// ---------------------------------------------------------------------------
// SSE frame parsing
// ---------------------------------------------------------------------------

/** Sentinel returned by {@link parseSseFrame} to signal the stream is complete. */
const DONE_FRAME: StreamChunk = { type: "done" };

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
	const frameSchema = z.object({
		type: wireJsonSchema.optional(),
		delta: z.string().optional().catch(undefined),
		errorText: z.string().nullish().catch(null),
		error: z.string().nullish().catch(null),
		choices: z
			.array(
				z.object({
					delta: z
						.object({ content: z.string().nullish().catch(null) })
						.nullish()
						.catch(null),
				})
			)
			.nullish()
			.catch(null),
		content: z.string().nullish().catch(null),
	});
	let frame: z.infer<typeof frameSchema>;
	try {
		frame = frameSchema.parse(JSON.parse(data));
	} catch {
		return null;
	}
	if (frame.type === "text-delta") {
		return frame.delta ? { type: "text", content: frame.delta } : null;
	}
	if (frame.type === "error") {
		return {
			type: "error",
			content: frame.errorText ?? frame.error ?? "stream error",
		};
	}
	if (frame.type) {
		return null;
	}
	const content = frame.choices?.[0]?.delta?.content ?? frame.content;
	return content ? { type: "text", content } : null;
}

// ---------------------------------------------------------------------------
// API class
// ---------------------------------------------------------------------------

interface AgentStreamRequest {
	agent_id: string;
	messages: Message[];
	response_mode?: RyuResponseMode;
}

export interface AgentRunOptions {
	/**
	 * Most characters `run()` collects before it stops the stream and throws.
	 * Defaults to {@link MAX_AGENT_RUN_OUTPUT_CHARS}. `stream()` ignores it.
	 */
	maxOutputChars?: number;
	/** Use exact Ryu implementation vocabulary instead of everyday language. */
	responseMode?: RyuResponseMode;
	/** Cancels the request and ends the stream when aborted. */
	signal?: AbortSignal;
}

/** Default ceiling on the reply `AgentsAPI.run()` collects into one string. */
export const MAX_AGENT_RUN_OUTPUT_CHARS = 1_000_000;

export class AgentsAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	/** List all agents (built-in + custom). */
	async list(): Promise<AgentSummary[]> {
		const data = await request(
			this.options,
			"/api/agents",
			undefined,
			agentListSchema.parse
		);
		return (data.agents ?? []).map(toSummary);
	}

	/** Fetch a single agent by id. */
	async get(id: string): Promise<Agent> {
		const data = await request(
			this.options,
			`/api/agents/${id}`,
			undefined,
			agentDetailSchema.parse
		);
		return toAgent(data.agent);
	}

	/**
	 * Create a custom agent. Core assigns the id and returns the saved record.
	 *
	 * @example
	 * ```ts
	 * const agent = await client.agents.create({
	 *   name: "Researcher",
	 *   identityMode: "individual",
	 * });
	 * ```
	 */
	async create(input: AgentCreateInput): Promise<Agent> {
		const data = await request(
			this.options,
			"/api/agents",
			{ method: "POST", body: JSON.stringify(toWriteBody(input)) },
			agentDetailSchema.parse
		);
		return toAgent(data.agent);
	}

	/**
	 * Patch a custom agent. Omitted fields stay unchanged; pass
	 * `accountAccess: null` to clear the account allowlist back to
	 * unrestricted.
	 */
	async update(id: string, input: AgentUpdateInput): Promise<Agent> {
		const data = await request(
			this.options,
			`/api/agents/${encodeURIComponent(id)}`,
			{ method: "PUT", body: JSON.stringify(toWriteBody(input)) },
			agentDetailSchema.parse
		);
		return toAgent(data.agent);
	}

	/**
	 * Send a chat turn and collect the full response as a string.
	 * Uses the same streaming endpoint as stream() but buffers everything.
	 * Rejects when the stream carries an in-band error part (a failed turn), so
	 * a provider or pause failure is never returned as an empty/partial answer;
	 * use stream() to keep partial text.
	 */
	async run(
		id: string,
		messages: Message[],
		options?: AgentRunOptions
	): Promise<string> {
		const limit = options?.maxOutputChars ?? MAX_AGENT_RUN_OUTPUT_CHARS;
		let result = "";
		// Leaving the loop early (the throw below) cancels the stream's reader.
		for await (const chunk of this.stream(id, messages, options)) {
			if (chunk.type === "error") {
				throw new Error(
					`RyuClient: agent stream error: ${chunk.content ?? "stream error"}`
				);
			}
			if (chunk.type === "text" && chunk.content) {
				if (result.length + chunk.content.length > limit) {
					throw new Error(
						`RyuClient: agent reply exceeded ${limit} characters`
					);
				}
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
	async *stream(
		id: string,
		messages: Message[],
		options?: AgentRunOptions
	): AsyncGenerator<StreamChunk> {
		const url = buildUrl(this.options, "/api/chat/stream");
		const headers = buildHeaders(this.options);
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		const body: AgentStreamRequest = { agent_id: id, messages };
		if (options?.responseMode) {
			body.response_mode = options.responseMode;
		}
		const init: RequestInit = {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		};
		if (options?.signal) {
			init.signal = options.signal;
		}
		const resp = await fetchImpl(url, init);

		if (!(resp.ok && resp.body)) {
			const text = await resp.text().catch(() => resp.statusText);
			throw new Error(`RyuClient: stream failed (${resp.status}): ${text}`);
		}

		const reader = resp.body.getReader();
		const decoder = new SseFrameDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					decoder.finish();
					break;
				}
				for (const frame of decoder.push(value)) {
					const data = frame
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice("data:".length).trim())
						.join("\n");
					if (!data) {
						continue;
					}
					const chunk = parseSseFrame(data);
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
			decoder.finish();
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}

		yield { type: "done" };
	}
}
