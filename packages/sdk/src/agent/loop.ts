/**
 * The autonomous agent loop for the Ryu SDK runtime.
 *
 * This is what `defineAgent` never had: a real multi-turn tool-calling loop that
 * runs in TypeScript. Each round calls the node's gateway with the resolved
 * tool definitions; if the model emits `tool_calls`, each is executed (local
 * runnable or Core `/api/mcp/tools/call`), results are fed back, and the loop
 * repeats until the model stops calling tools or `maxSteps` is reached.
 *
 * Emitted events mirror Core's `AcpEvent` categories (see cli/dev.ts) plus an
 * `auth_required` pause — when a remote tool returns Ryu's connection-required
 * envelope (first-run Gmail OAuth), the loop surfaces the connect URL and stops
 * instead of feeding the envelope back as a normal tool result.
 */

import {
	type AssistantMessage,
	callModelWithTools,
	type LoopMessage,
	type ModelUsage,
	type ToolCall,
} from "./model-call.ts";
import {
	type AgentTool,
	detectElicitation,
	executeTool,
	resolveToolDefs,
	type ToolExecContext,
} from "./tools.ts";

// ── Events ────────────────────────────────────────────────────────────────────

/** A streamed text fragment from the assistant. */
export interface AgentEventText {
	content: string;
	type: "text";
}

/** The model initiated a tool call. */
export interface AgentEventToolCall {
	id: string;
	input: unknown;
	name: string;
	type: "tool_call";
}

/** A tool finished (or failed with an error output the model can recover from). */
export interface AgentEventToolResult {
	id: string;
	name: string;
	output: unknown;
	type: "tool_result";
}

/** A remote tool needs an account connection — the loop paused. */
export interface AgentEventAuthRequired {
	message?: string;
	tool: string;
	type: "auth_required";
	url?: string;
}

/** A fatal loop error — the stream ends after this. */
export interface AgentEventError {
	message: string;
	type: "error";
}

/** Terminal event carrying the final text, step count, and aggregate usage. */
export interface AgentEventResult {
	steps: number;
	text: string;
	type: "result";
	usage?: ModelUsage;
}

/** Union of everything the loop yields. */
export type AgentEvent =
	| AgentEventAuthRequired
	| AgentEventError
	| AgentEventResult
	| AgentEventText
	| AgentEventToolCall
	| AgentEventToolResult;

// ── Config ────────────────────────────────────────────────────────────────────

/** Inputs for a single loop run. */
export interface LoopConfig {
	/** Gateway base URL for inference (the target node). */
	gatewayBaseUrl: string;
	/** Gateway bearer token. */
	gatewayToken?: string;
	/** Hard ceiling on model→tool rounds. */
	maxSteps: number;
	/** Seed transcript (system + user messages already assembled). */
	messages: LoopMessage[];
	/** Model id routed by the gateway. */
	model: string;
	/** Abort signal. */
	signal?: AbortSignal;
	/** Context for resolving + executing tools. */
	toolCtx: ToolExecContext;
	/** Tools keyed by model-facing name. */
	tools: Record<string, AgentTool>;
}

function safeParse(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return json;
	}
}

function addUsage(a: ModelUsage | undefined, b: ModelUsage | undefined) {
	if (!(a || b)) {
		return undefined;
	}
	return {
		promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
		completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
		totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
	};
}

/** Look at a tool output (object or JSON string) for the elicitation envelope. */
function findElicitation(output: unknown) {
	const direct = detectElicitation(output);
	if (direct) {
		return direct;
	}
	if (typeof output === "string") {
		return detectElicitation(safeParse(output));
	}
	return null;
}

/**
 * Run the autonomous loop, yielding events as they occur. The generator returns
 * after a terminal `result`, `auth_required`, or `error` event.
 */
export async function* runAgentLoop(
	config: LoopConfig
): AsyncGenerator<AgentEvent> {
	const messages = [...config.messages];
	let toolDefs: Awaited<ReturnType<typeof resolveToolDefs>>;
	try {
		toolDefs = await resolveToolDefs(config.tools, config.toolCtx);
	} catch (err) {
		yield { type: "error", message: describeError(err) };
		return;
	}

	let usage: ModelUsage | undefined;
	let lastText = "";

	for (let step = 1; step <= config.maxSteps; step++) {
		let result: Awaited<ReturnType<typeof callModelWithTools>>;
		try {
			result = await callModelWithTools({
				baseUrl: config.gatewayBaseUrl,
				token: config.gatewayToken,
				model: config.model,
				messages,
				tools: toolDefs.length > 0 ? toolDefs : undefined,
				toolChoice: toolDefs.length > 0 ? "auto" : undefined,
				signal: config.signal,
			});
		} catch (err) {
			yield { type: "error", message: describeError(err) };
			return;
		}

		usage = addUsage(usage, result.usage);
		const assistant: AssistantMessage = result.message;
		messages.push(assistant);

		if (assistant.content) {
			lastText = assistant.content;
			yield { type: "text", content: assistant.content };
		}

		const toolCalls = assistant.tool_calls ?? [];
		if (toolCalls.length === 0) {
			yield { type: "result", text: lastText, steps: step, usage };
			return;
		}

		const paused = yield* runToolCalls(toolCalls, messages, config);
		if (paused) {
			return;
		}
	}

	// Ran out of steps — surface what we have rather than hang.
	yield { type: "result", text: lastText, steps: config.maxSteps, usage };
}

/**
 * Execute the model's tool calls, appending results to `messages`. Yields
 * tool_call/tool_result/auth_required events. Returns `true` when the loop must
 * stop (an elicitation pause was surfaced).
 */
async function* runToolCalls(
	toolCalls: ToolCall[],
	messages: LoopMessage[],
	config: LoopConfig
): AsyncGenerator<AgentEvent, boolean> {
	for (const call of toolCalls) {
		const name = call.function.name;
		const input = safeParse(call.function.arguments);
		yield { type: "tool_call", id: call.id, name, input };

		let output: unknown;
		try {
			const res = await executeTool(
				name,
				call.function.arguments,
				config.tools,
				config.toolCtx
			);
			output = res.output;
		} catch (err) {
			// Recoverable: feed the error back so the model can adjust.
			const errPayload = { error: describeError(err) };
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(errPayload),
			});
			yield { type: "tool_result", id: call.id, name, output: errPayload };
			continue;
		}

		const elicitation = findElicitation(output);
		if (elicitation) {
			yield {
				type: "auth_required",
				tool: name,
				url: elicitation.url,
				message: elicitation.message,
			};
			return true;
		}

		messages.push({
			role: "tool",
			tool_call_id: call.id,
			content: typeof output === "string" ? output : JSON.stringify(output),
		});
		yield { type: "tool_result", id: call.id, name, output };
	}
	return false;
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
