// An AI SDK `ChatTransport` backed by the island's Core IPC bridge.
//
// Why a custom transport instead of `DefaultChatTransport`: all Core HTTP runs in
// the MAIN process (the renderer is cross-origin to Core, see main/ipc/core.ts).
// The renderer can't fetch `/api/chat/stream` itself.
//
// What it buys: the main process already forwards the raw parsed SSE objects —
// which ARE AI SDK `UIMessageChunk`s — over `core:streamPart`. Re-wrapping that
// event feed as a `ReadableStream<UIMessageChunk>` hands the island the exact
// same message pipeline the desktop chat runs on. Tool calls, reasoning, file
// parts, `data-*` widget parts and generated images all survive into
// `message.parts` instead of being flattened to a text string, which is what
// makes reusing the desktop message list possible at all.

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type {
	CoreChatStreamRequest,
	CoreStreamEndEvent,
	CoreStreamPartEvent,
	CoreUiMessage,
} from "../../shared/ipc.ts";
import { validateCoreUiChunkStream } from "./core-stream-boundary.ts";

/** Everything about a turn except its message history. */
export type IslandTurnRequest = Omit<CoreChatStreamRequest, "messages">;

export interface IslandChatTransportOptions {
	/**
	 * Assemble the per-turn request fields at send time (agent id, conversation
	 * id, `companion_source`, plugin flags, the ACP payload). Called once per
	 * turn so a picker changed between turns takes effect on the next one.
	 */
	getRequest: () => IslandTurnRequest;
	/**
	 * Server-only text for a given message id. Used for the screen-grounding
	 * preamble: the model sees the OCR context prepended, the transcript bubble
	 * keeps the clean text the user typed. Returning `undefined` sends the
	 * message unchanged.
	 */
	serverTextFor?: (messageId: string) => string | undefined;
}

/**
 * Map a UIMessage to the wire shape. Parts are forwarded verbatim — that is what
 * keeps prior tool calls in the model's view of the conversation on later turns.
 */
function toCoreMessage(
	message: UIMessage,
	serverText: string | undefined
): CoreUiMessage {
	const role = message.role;
	if (serverText === undefined) {
		return { id: message.id, role, parts: message.parts };
	}
	// Substituted text replaces the text parts; non-text parts (attached images)
	// are preserved so an image-plus-screen turn keeps both.
	const nonText = message.parts.filter((part) => part?.type !== "text");
	return {
		id: message.id,
		role,
		parts: [{ type: "text", text: serverText }, ...nonText],
	};
}

export function createIslandChatTransport(
	options: IslandChatTransportOptions
): ChatTransport<UIMessage> {
	const openStream = (
		body: CoreChatStreamRequest,
		abortSignal: AbortSignal | undefined
	): ReadableStream<UIMessageChunk> => {
		// The stream id only arrives when the `chatStream` invoke resolves, but
		// main may already be pushing parts by then. Subscribe first and hold
		// everything in `pending` until the id lands, then replay what was ours.
		// (Filtering on a null id would drop the first chunks of a fast reply.)
		let streamId: string | null = null;
		let pending: (CoreStreamPartEvent | CoreStreamEndEvent)[] = [];
		let settled = false;
		let offPart: () => void = () => {
			// replaced on subscribe
		};
		let offEnd: () => void = () => {
			// replaced on subscribe
		};

		const rawStream = new ReadableStream<CoreStreamPartEvent["part"]>({
			start(controller) {
				const cleanup = (): void => {
					offPart();
					offEnd();
				};

				const emitPart = (event: CoreStreamPartEvent): void => {
					controller.enqueue(event.part);
				};

				const emitEnd = (event: CoreStreamEndEvent): void => {
					if (settled) {
						return;
					}
					settled = true;
					cleanup();
					if (event.reason === "error") {
						controller.error(new Error(event.error ?? "Stream failed."));
						return;
					}
					// `aborted` closes cleanly: the AI SDK keeps whatever streamed so
					// far, matching a stopped fetch on the desktop.
					controller.close();
				};

				offPart = window.island.core.onStreamPart(
					(event: CoreStreamPartEvent) => {
						if (streamId === null) {
							pending.push(event);
							return;
						}
						if (event.streamId === streamId) {
							emitPart(event);
						}
					}
				);

				offEnd = window.island.core.onStreamEnd((event: CoreStreamEndEvent) => {
					if (streamId === null) {
						pending.push(event);
						return;
					}
					if (event.streamId === streamId) {
						emitEnd(event);
					}
				});

				window.island.core
					.chatStream(body)
					.then((handle) => {
						streamId = handle.streamId;
						const queued = pending;
						pending = [];
						for (const event of queued) {
							if (event.streamId !== streamId) {
								continue;
							}
							if ("part" in event) {
								emitPart(event);
							} else {
								emitEnd(event);
							}
						}
						// Abort requested before the id resolved: honour it now.
						if (abortSignal?.aborted) {
							window.island.core.abortStream(streamId).catch(() => {
								// Best effort; a finished stream aborts to a no-op.
							});
						}
					})
					.catch((error) => {
						if (settled) {
							return;
						}
						settled = true;
						cleanup();
						// A stop pressed before the request settled is not a failure:
						// close cleanly, or the user sees "Could not reach Core" for a
						// turn they cancelled themselves.
						if (abortSignal?.aborted) {
							controller.close();
							return;
						}
						const message =
							error instanceof Error ? error.message : String(error);
						controller.error(new Error(`Could not reach Core: ${message}`));
					});

				abortSignal?.addEventListener("abort", () => {
					// Only REQUEST the abort. Main tears down the fetch and emits the
					// terminal `streamEnd`, which closes this controller — closing it
					// here instead would leave the chat runtime waiting forever.
					if (streamId) {
						window.island.core.abortStream(streamId).catch(() => {
							// Best effort.
						});
					}
				});
			},
			cancel() {
				offPart();
				offEnd();
				if (streamId) {
					window.island.core.abortStream(streamId).catch(() => {
						// Best effort.
					});
				}
			},
		});
		return validateCoreUiChunkStream(rawStream);
	};

	return {
		sendMessages: ({ messages, abortSignal }) => {
			const body: CoreChatStreamRequest = {
				...options.getRequest(),
				messages: messages.map((message) =>
					toCoreMessage(message, options.serverTextFor?.(message.id))
				),
			};
			return Promise.resolve(openStream(body, abortSignal));
		},
		// The island holds no resumable turn: a closed window drops the stream, and
		// main owns no replay buffer. Null = "nothing to reconnect to".
		reconnectToStream: () => Promise.resolve(null),
	};
}
