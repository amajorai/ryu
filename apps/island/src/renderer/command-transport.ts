// Binds the `window.island` IPC bridge to @ryu/command's injected `ChatStreamFn`
// for the island's command surface.
//
// The shared ChatView (rendered inside the @ryu/blocks command-bar shell) owns no
// network, so it calls this to start a turn. We start the stream over IPC, then
// filter the global part/end events by the returned stream id and forward them to
// the view's handlers. This mirrors the (now-retired) apps/command transport, but
// talks to Core through `window.island.core` instead of `window.command.core`.

import type {
	ChatMessage,
	ChatStreamFn,
	ChatStreamHandle,
	ChatStreamHandlers,
} from "@ryu/command/types";
import type { CoreStreamEndEvent, CoreStreamPartEvent } from "../shared/ipc.ts";

export interface CommandTransportOptions {
	/** Agent to route to (`null` = Core's default local model). */
	agentId: string | null;
	/** Conversation id so turns persist server-side as one thread. */
	conversationId: string;
}

function toCoreMessages(messages: ChatMessage[]) {
	return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Create a `ChatStreamFn` bound to the given agent + conversation. */
export function createCommandTransport(
	options: CommandTransportOptions
): ChatStreamFn {
	return (messages, handlers: ChatStreamHandlers): ChatStreamHandle => {
		let streamId: string | null = null;
		let settled = false;
		let offPart: () => void = () => {
			// replaced below once subscribed
		};
		let offEnd: () => void = () => {
			// replaced below once subscribed
		};

		const cleanup = (): void => {
			offPart();
			offEnd();
		};

		offPart = window.island.core.onStreamPart((event: CoreStreamPartEvent) => {
			if (event.streamId !== streamId) {
				return;
			}
			const { part } = event;
			if (part.type === "text-delta" && typeof part.delta === "string") {
				handlers.onDelta(part.delta);
			} else if (
				part.type === "error" &&
				typeof (part as { errorText?: unknown }).errorText === "string"
			) {
				handlers.onError((part as { errorText: string }).errorText);
			}
		});

		offEnd = window.island.core.onStreamEnd((event: CoreStreamEndEvent) => {
			if (event.streamId !== streamId || settled) {
				return;
			}
			settled = true;
			cleanup();
			if (event.reason === "error") {
				handlers.onError(event.error ?? "Stream failed.");
			} else {
				handlers.onDone();
			}
		});

		// True when abort() was called before the stream id resolved, so we can
		// abort as soon as it lands.
		let abortRequested = false;

		window.island.core
			.chatStream({
				agent_id: options.agentId ?? undefined,
				conversation_id: options.conversationId,
				enable_long_term: false,
				messages: toCoreMessages(messages),
			})
			.then((handle) => {
				streamId = handle.streamId;
				if (abortRequested) {
					window.island.core.abortStream(streamId).catch(() => {
						// Abort is best-effort.
					});
				}
			})
			.catch((error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				handlers.onError(
					error instanceof Error ? error.message : "Could not reach Core."
				);
			});

		return {
			// Only REQUEST the abort. Main aborts the in-flight fetch and emits a
			// terminal `streamEnd`, which the persistent `offEnd` handler above turns
			// into `onDone()` + cleanup. Tearing the listeners down here would drop
			// that terminal event and wedge the view (it would never clear its
			// `sending`/`streaming` state).
			abort: (): void => {
				abortRequested = true;
				if (streamId) {
					window.island.core.abortStream(streamId).catch(() => {
						// Abort is best-effort.
					});
				}
			},
		};
	};
}
