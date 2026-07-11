// Hand-rolled streaming client for Core's chat endpoint, the TS port of
// apps/cli/src/chat.rs (stream_chat, ~112-244). core-client/chat only exposes the
// endpoint URL + auth headers (the desktop drives it through the AI SDK transport),
// so the TUI owns the SSE read loop. The wire frames are AI SDK v6 UI Message
// Stream SSE: newline-delimited `data: {json}` with a `type` discriminator
//   text-delta            -> delta text chunk
//   tool-input-available  -> a tool call (surface "[tool: name]")
//   tool-output-available -> a tool result (surface "[tool status]")
//   error                 -> stream error
//   finish / [DONE]       -> end of stream
//   data-plugin_note      -> out-of-band note from a Core server-side plugin
//                            turn-hook (goal/proof/double-check); .data.text is
//                            surfaced separately, NOT appended to the transcript
// Request body mirrors the Rust exactly: messages carry content as an array of
// {type:"text", text} parts, plus optional agent_id / conversation_id / acp_model
// / team_id / plugin_flags.

import { chatHeaders, chatStreamUrl } from "@ryuhq/core-client/chat";
import type { ApiTarget } from "@ryuhq/core-client/client";

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
	content: string;
	role: ChatRole;
}

/** Per-turn routing options (mirrors apps/cli's ChatOptions). */
export interface ChatStreamOptions {
	/** ACP session model override for this turn (/model <id>). */
	acpModel?: string;
	/** Agent to route to; omit to let Core pick its default. */
	agentId?: string;
	/** Stable per-chat id sent on every turn so Core persists the conversation;
	 * the server-side plugin turn-hooks (goal/proof/double-check) and sessions all
	 * key off it. */
	conversationId?: string;
	/** Per-turn plugin toggles forwarded as `plugin_flags`; Core's turn-hooks read
	 * them (e.g. `{ "io.ryu.double-check": true }` to arm the review hook). */
	pluginFlags?: Record<string, boolean>;
	/** Route the turn to a team instead of a single agent (/team <id>). */
	teamId?: string;
}

export interface ChatStreamHandlers {
	/** The stream finished (finish frame or [DONE] or body end). */
	onDone: () => void;
	/** A stream-level error. After this the stream is finished. */
	onError: (message: string) => void;
	/** A text delta from the assistant. */
	onTextDelta: (delta: string) => void;
	/** A tool call started (the agent's tool loop). */
	onToolInput?: (toolName: string) => void;
	/** A tool result arrived (status string when present). */
	onToolOutput?: (status: string) => void;
	/** An out-of-band note from a Core plugin turn-hook (goal/proof/double-check). */
	onPluginNote?: (text: string) => void;
}

const TRAILING_CR = /\r$/;

interface WireFrame {
	data?: { text?: string };
	delta?: string;
	errorText?: string;
	output?: { status?: string };
	toolName?: string;
	type?: string;
}

const buildBody = (
	turns: ChatTurn[],
	options: ChatStreamOptions
): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		messages: turns.map((turn) => ({
			role: turn.role,
			content: [{ type: "text", text: turn.content }],
		})),
	};
	if (options.agentId) {
		body.agent_id = options.agentId;
	}
	if (options.conversationId) {
		body.conversation_id = options.conversationId;
	}
	if (options.acpModel) {
		body.acp_model = options.acpModel;
	}
	if (options.teamId) {
		body.team_id = options.teamId;
	}
	if (options.pluginFlags && Object.keys(options.pluginFlags).length > 0) {
		body.plugin_flags = options.pluginFlags;
	}
	return body;
};

// Dispatch one already-parsed frame. Returns true when the stream is finished.
const dispatchFrame = (
	frame: WireFrame,
	handlers: ChatStreamHandlers
): boolean => {
	switch (frame.type) {
		case "text-delta": {
			if (typeof frame.delta === "string") {
				handlers.onTextDelta(frame.delta);
			}
			return false;
		}
		case "tool-input-available": {
			handlers.onToolInput?.(frame.toolName ?? "tool");
			return false;
		}
		case "tool-output-available": {
			const status = frame.output?.status;
			if (status) {
				handlers.onToolOutput?.(status);
			}
			return false;
		}
		case "data-plugin_note": {
			const text = frame.data?.text;
			if (text) {
				handlers.onPluginNote?.(text);
			}
			return false;
		}
		case "error": {
			handlers.onError(frame.errorText ?? "stream error");
			return true;
		}
		case "finish": {
			handlers.onDone();
			return true;
		}
		default: {
			// start, text-start, text-end, tool-input-start, etc. - ignored.
			return false;
		}
	}
};

// Parse complete `\n`-terminated lines out of `buffer`, dispatching each data
// frame. Returns { rest, done } where rest is the unconsumed tail.
const drainBuffer = (
	buffer: string,
	handlers: ChatStreamHandlers
): { rest: string; done: boolean } => {
	let start = 0;
	let newline = buffer.indexOf("\n", start);
	while (newline !== -1) {
		const line = buffer.slice(start, newline).replace(TRAILING_CR, "");
		start = newline + 1;
		const data = line.startsWith("data: ") ? line.slice(6) : null;
		if (data && data.length > 0) {
			if (data === "[DONE]") {
				handlers.onDone();
				return { rest: "", done: true };
			}
			let frame: WireFrame | null = null;
			try {
				frame = JSON.parse(data) as WireFrame;
			} catch {
				frame = null;
			}
			if (frame && dispatchFrame(frame, handlers)) {
				return { rest: "", done: true };
			}
		}
		newline = buffer.indexOf("\n", start);
	}
	return { rest: buffer.slice(start), done: false };
};

/** Stream one assistant turn. Resolves when the stream finishes (the handlers
 * have already received every event). Honors `signal` for cancellation. */
export async function streamChat(
	target: ApiTarget,
	turns: ChatTurn[],
	options: ChatStreamOptions,
	handlers: ChatStreamHandlers,
	signal?: AbortSignal
): Promise<void> {
	let response: Response;
	try {
		response = await fetch(chatStreamUrl(target), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...chatHeaders(target) },
			body: JSON.stringify(buildBody(turns, options)),
			signal,
		});
	} catch (err) {
		handlers.onError(err instanceof Error ? err.message : String(err));
		return;
	}

	if (!response.ok) {
		handlers.onError(`HTTP ${response.status}`);
		return;
	}
	if (!response.body) {
		handlers.onDone();
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const result = drainBuffer(buffer, handlers);
			buffer = result.rest;
			if (result.done) {
				return;
			}
		}
	} catch (err) {
		if (signal?.aborted) {
			return;
		}
		handlers.onError(err instanceof Error ? err.message : String(err));
		return;
	}

	handlers.onDone();
}
