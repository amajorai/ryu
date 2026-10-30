// apps/desktop/src/lib/api/shadow-activity-chat.ts

import type { LiteralMessage } from "@ryu/i18n/react";
import { shadowFetch } from "./shadow-fetch.ts";
import {
	type ShadowActivityEvent,
	shadowActivityEventSchema,
} from "./shadow-schemas.ts";

/** A message in an activity-chat conversation (Shadow POST /agent). */
export interface ActivityChatMessage {
	content: string;
	role: "assistant" | "user";
}

/**
 * Stream a chat-over-your-activity turn from Shadow's `POST /agent` SSE endpoint.
 * Shadow runs an agent whose tools search the local timeline, OCR, and
 * transcripts, so answers are grounded in what you actually did. `onEvent`
 * receives each decoded SSE JSON payload; switch on `type`:
 * `text_delta{text}` (incremental), `final_answer{text}` (complete answer),
 * `tool_call{id,name,args}`, `tool_result{id,name,result,error}`,
 * `error{message}`. The stream ends by closing (no explicit done event), at
 * which point this resolves. Never throws for a missing Shadow; it calls
 * `onEvent` with an `error` event and returns instead.
 */
export async function streamActivityChat(
	message: string,
	history: ActivityChatMessage[],
	onEvent: (event: ShadowActivityEvent) => void,
	signal?: AbortSignal,
	tl?: LiteralMessage
): Promise<void> {
	let resp: Response;
	try {
		resp = await shadowFetch("/agent", {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				message,
				conversation_history: history.map((m) => ({
					role: m.role,
					content: m.content,
				})),
			}),
		});
	} catch {
		onEvent({ type: "error", message: "Shadow is not running." });
		return;
	}
	if (!(resp.ok && resp.body)) {
		onEvent({
			type: "error",
			message: tl
				? tl("Shadow returned {status}.", { status: resp.status })
				: `Shadow returned ${resp.status}.`,
		});
		return;
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// SSE frames are separated by a blank line; each `data:` line carries JSON.
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				for (const line of frame.split("\n")) {
					if (signal?.aborted) {
						return;
					}
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) {
						continue;
					}
					const payload = trimmed.slice(5).trim();
					if (!payload || payload === "[DONE]") {
						continue;
					}
					try {
						onEvent(shadowActivityEventSchema.parse(JSON.parse(payload)));
					} catch {
						// Non-JSON keepalive or partial; ignore.
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
