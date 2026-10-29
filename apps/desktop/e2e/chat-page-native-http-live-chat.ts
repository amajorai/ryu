import { LIVE_SUGGESTED_TASK } from "./chat-page-native-http-state.ts";

type NodeId = "a" | "b";
export function createLiveChatFixture(browserOrigin: string) {
	const armed = new Set<string>();
	// A chat the browser has not minted an id for yet (a temporary chat's draft)
	// cannot be armed by id: the next stream request on the computer is armed.
	const armedNext = new Map<NodeId, { suggestTask: boolean }>();
	// A turn Core is already running when a tab asks to reattach to it: the resume
	// route serves it once, as the whole turn replayed from its first chunk. Until
	// then, and once it has been served, the route answers 404 like an idle Core.
	const armedResume = new Map<string, { suggestTask: boolean }>();
	// Armed turns that call `tasks.suggest` before they answer, as an agent does
	// mid-turn: the call is complete while the turn is still running.
	const suggesting = new Set<string>();
	const reasoning = new Map<string, string>();
	const live = new Map<
		string,
		{
			record: LiveChatRecord;
			close: () => void;
			answerNow?: () => boolean;
			finishAnswer?: () => boolean;
			finish?: () => boolean;
		}
	>();
	const records: LiveChatRecord[] = [];
	const key = (node: NodeId, conversationId: string) =>
		`${node}:${conversationId}`;
	function reset() {
		for (const entry of live.values()) {
			entry.close();
		}
		live.clear();
		armed.clear();
		armedNext.clear();
		armedResume.clear();
		suggesting.clear();
		reasoning.clear();
		records.length = 0;
	}
	const fixture = {
		arm(
			node: NodeId,
			conversationId: string,
			options: { suggestTask?: boolean } = {}
		) {
			armed.add(key(node, conversationId));
			if (options.suggestTask) {
				suggesting.add(key(node, conversationId));
			}
		},
		armNext(node: NodeId, options: { suggestTask?: boolean } = {}) {
			armedNext.set(node, { suggestTask: options.suggestTask === true });
		},
		armResume(
			node: NodeId,
			conversationId: string,
			options: { suggestTask?: boolean } = {}
		) {
			armedResume.set(key(node, conversationId), {
				suggestTask: options.suggestTask === true,
			});
		},
		// Whether a stream for this conversation has been served on this computer,
		// which is what makes a minted id one the fixture can finish.
		started(node: NodeId, conversationId: string) {
			return records.some(
				(record) =>
					record.node === node && record.conversationId === conversationId
			);
		},
		armReasoning(node: NodeId, conversationId: string, turnId: string) {
			armed.add(key(node, conversationId));
			reasoning.set(key(node, conversationId), turnId);
		},
		answerNow(node: NodeId, conversationId: string, turnId: string) {
			const entry = live.get(key(node, conversationId));
			if (
				!entry ||
				entry.record.turnId !== turnId ||
				entry.record.networkClosed
			) {
				return {
					status: 404,
					body: { error: "no supported in-flight turn was found" },
				};
			}
			if (!entry.answerNow?.()) {
				return {
					status: 409,
					body: { error: "Answer now is already in progress" },
				};
			}
			return {
				status: 200,
				body: { accepted: true, action: "answer_now", strategy: "native" },
			};
		},
		finishAnswer(node: NodeId, conversationId: string, turnId: string) {
			const entry = live.get(key(node, conversationId));
			return (
				entry?.record.turnId === turnId && (entry.finishAnswer?.() ?? false)
			);
		},
		// Completes the current ordinary (non-reasoning) live turn the way a
		// provider does: the open text part ends, the turn finishes and the SSE
		// closes. Only the newest stream for this node and conversation can finish.
		finish(node: NodeId, conversationId: string) {
			return live.get(key(node, conversationId))?.finish?.() ?? false;
		},
		snapshot: () => records.map((record) => ({ ...record })),
		reset,
		close: () => {
			for (const entry of live.values()) {
				entry.close();
			}
		},
		cancel(node: NodeId, conversationId: string) {
			const entry = live.get(key(node, conversationId));
			if (!entry || entry.record.executionCancelled || entry.record.completed) {
				return false;
			}
			// Server execution cancellation is independently observed from transport
			// disconnection: closing here would manufacture the client's abort evidence.
			entry.record.executionCancelled = true;
			return true;
		},
		start(
			node: NodeId,
			requestId: number,
			conversationId: string,
			request: Request,
			resumed?: { suggestTask: boolean }
		): Response | null {
			const resource = key(node, conversationId);
			if (resumed) {
				if (resumed.suggestTask) {
					suggesting.add(resource);
				}
			} else if (!armed.delete(resource)) {
				const next = armedNext.get(node);
				if (!next) {
					return null;
				}
				armedNext.delete(node);
				if (next.suggestTask) {
					suggesting.add(resource);
				}
			}
			const turnId = reasoning.get(resource);
			reasoning.delete(resource);
			const suggestsTask = suggesting.delete(resource);
			const prior = live.get(resource);
			if (prior) {
				prior.close();
				live.delete(resource);
			}
			const record: LiveChatRecord = {
				requestId,
				node,
				conversationId,
				requestAborted: false,
				readerCancelled: false,
				networkClosed: false,
				executionCancelled: false,
				fixtureClosed: false,
				...(resumed ? { resumed: true } : {}),
			};
			if (turnId) {
				Object.assign(record, {
					turnId,
					answerNowAccepted: false,
					completed: false,
				});
			}
			records.push(record);
			let close = () => {};
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					let closed = false;
					const abort = () => {
						record.requestAborted = true;
						stop();
					};
					function stop() {
						if (closed) {
							return;
						}
						closed = true;
						record.networkClosed = true;
						request.signal.removeEventListener("abort", abort);
						try {
							controller.close();
						} catch {}
					}
					close = () => {
						if (closed) {
							return;
						}
						record.fixtureClosed = true;
						stop();
					};
					request.signal.addEventListener("abort", abort, { once: true });
					const startedAtMs = Date.now() - 3000;
					const descriptor = (phase: "reasoning" | "answering") => ({
						type: "data-ryu-turn-control",
						data: {
							turnId,
							strategy: "native",
							phase,
							startedAtMs,
							effort: "low",
						},
					});
					const write = (chunks: unknown[]) =>
						controller.enqueue(
							new TextEncoder().encode(
								chunks
									.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
									.join("")
							)
						);
					write(
						turnId
							? [
									{ type: "start", messageId: `live-${requestId}` },
									descriptor("reasoning"),
									{ type: "reasoning-start", id: "owned-reasoning" },
									{
										type: "reasoning-delta",
										id: "owned-reasoning",
										delta: "Owned native reasoning is active.",
									},
								]
							: [
									{ type: "start", messageId: `live-${requestId}` },
									...(suggestsTask
										? [
												{
													type: "tool-input-available",
													toolCallId: LIVE_SUGGESTED_TASK.callId,
													toolName: "tasks.suggest",
													input: {
														description: LIVE_SUGGESTED_TASK.description,
														prompt: LIVE_SUGGESTED_TASK.prompt,
														title: LIVE_SUGGESTED_TASK.title,
													},
												},
												{
													type: "tool-output-available",
													toolCallId: LIVE_SUGGESTED_TASK.callId,
													output: { ok: true },
												},
											]
										: []),
									{ type: "text-start", id: "live-text" },
									{
										type: "text-delta",
										id: "live-text",
										delta: "Owned live response in progress.",
									},
								]
					);
					live.set(resource, {
						record,
						close,
						...(turnId
							? {
									answerNow: () => {
										if (record.answerNowAccepted) {
											return false;
										}
										record.answerNowAccepted = true;
										return true;
									},
									finishAnswer: () => {
										if (closed || !record.answerNowAccepted) {
											return false;
										}
										write([
											{ type: "reasoning-end", id: "owned-reasoning" },
											descriptor("answering"),
											{ type: "text-start", id: "owned-answer" },
											{
												type: "text-delta",
												id: "owned-answer",
												delta: "Owned native answer continued.",
											},
											{ type: "text-end", id: "owned-answer" },
											{ type: "finish", finishReason: "stop" },
										]);
										controller.enqueue(
											new TextEncoder().encode("data: [DONE]\n\n")
										);
										record.completed = true;
										stop();
										return true;
									},
								}
							: {
									finish: () => {
										if (closed) {
											return false;
										}
										write([
											{ type: "text-end", id: "live-text" },
											{ type: "finish", finishReason: "stop" },
										]);
										controller.enqueue(
											new TextEncoder().encode("data: [DONE]\n\n")
										);
										record.completed = true;
										stop();
										return true;
									},
								}),
					});
					if (request.signal.aborted) {
						abort();
					}
				},
				cancel() {
					record.readerCancelled = true;
					record.networkClosed = true;
					close();
					record.fixtureClosed = false;
				},
			});
			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"x-vercel-ai-ui-message-stream": "v1",
					// Core states that a resume replays the whole turn.
					...(resumed ? { "x-ryu-resume-replay": "full" } : {}),
					"cache-control": "no-cache",
					"access-control-allow-origin": browserOrigin,
					"access-control-allow-credentials": "true",
					vary: "Origin",
				},
			});
		},
		// What `GET /api/chat/stream/resume/:id` serves: the armed running turn,
		// once, or `null` (the route's 404) when Core has none for the conversation.
		resume(
			node: NodeId,
			requestId: number,
			conversationId: string,
			request: Request
		): Response | null {
			const resource = key(node, conversationId);
			const running = armedResume.get(resource);
			if (!running) {
				return null;
			}
			armedResume.delete(resource);
			return fixture.start(node, requestId, conversationId, request, running);
		},
	};
	return fixture;
}
export interface LiveChatRecord {
	answerNowAccepted?: boolean;
	completed?: boolean;
	conversationId: string;
	executionCancelled: boolean;
	fixtureClosed: boolean;
	networkClosed: boolean;
	node: NodeId;
	readerCancelled: boolean;
	requestAborted: boolean;
	requestId: number;
	// Served by the resume route, not as the answer to a send.
	resumed?: true;
	turnId?: string;
}
