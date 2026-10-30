// Chat send: streams one turn from Core into the transcript, settling tool
// rows, usage and the turn receipt when it ends.

import { useCallback } from "react";
import {
	parseChatPermission,
	permissionToolDetail,
} from "../../core/chatPermission.ts";
import { parseChatQuestion } from "../../core/chatQuestion.ts";
import {
	type ChatStreamOptions,
	type ChatTurn,
	coalesceStreamDeltas,
	streamChat,
	type TurnUsage,
} from "../../core/chatStream.ts";
import {
	appendContinuationText,
	appendErrorPart,
	appendReasoningPart,
	appendTextPart,
	appendToolInputPart,
	appendToolOutputPart,
	asRecord,
	closeReasoningPart,
	readTodos,
	replaceTodoPart,
	settleRunningToolParts,
	type ToolSettleOutcome,
} from "../../core/chatTranscript.ts";
import { acpSlashCommandsFromData } from "../../core/contributions.ts";
import {
	type HerdrState,
	herdrErrorMessage,
	herdrReporter,
} from "../../core/herdr.ts";
import { humanizeError } from "../../core/native-errors.ts";
import { mergeUsage } from "../../core/turnReceipt.ts";
import {
	commandRouteKey,
	receiptRouteLabel,
	takeMessageId,
} from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";
import type { Message } from "./types.ts";

type UseChatSendDeps = Pick<
	ChatSurfaceContext,
	| "abortRef"
	| "activeToolsRef"
	| "buildOptions"
	| "clearTurnActivity"
	| "configuredModelRef"
	| "herdrTurn"
	| "messagesRef"
	| "pushPluginNote"
	| "recheckHealth"
	| "resumeRequestSequence"
	| "setActiveTool"
	| "setAdvertisedAcpCommands"
	| "setMessages"
	| "setOverlay"
	| "setStreamStartedAt"
	| "setStreaming"
	| "setTurnError"
	| "target"
	| "turnConversationRef"
>;

export function useChatSend(deps: UseChatSendDeps) {
	const {
		abortRef,
		activeToolsRef,
		buildOptions,
		clearTurnActivity,
		configuredModelRef,
		herdrTurn,
		messagesRef,
		pushPluginNote,
		recheckHealth,
		resumeRequestSequence,
		setActiveTool,
		setAdvertisedAcpCommands,
		setMessages,
		setOverlay,
		setStreamStartedAt,
		setStreaming,
		setTurnError,
		target,
		turnConversationRef,
	} = deps;
	const send = useCallback(
		(text: string, optionsOverride?: ChatStreamOptions) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				return;
			}
			resumeRequestSequence.current += 1;
			// A failed turn leaves an assistant message with no content (its error
			// lives in an `error` part); drop it so providers never see an empty
			// assistant turn and the error text never reaches the model.
			const priorTurns: ChatTurn[] = messagesRef.current
				.filter((m) => m.role !== "assistant" || m.content.trim() !== "")
				.map((m) => ({
					role: m.role,
					content: m.content,
				}));
			const turns: ChatTurn[] = [
				...priorTurns,
				{ role: "user", content: trimmed },
			];
			const options = optionsOverride ?? buildOptions();
			const routeKey = commandRouteKey(options);
			turnConversationRef.current = options.conversationId;

			const userMessageId = takeMessageId();
			const assistantMessageId = takeMessageId();
			setMessages((prev) => [
				...prev,
				{
					id: userMessageId,
					role: "user",
					content: trimmed,
					parts: [{ type: "text", text: trimmed }],
				},
				{ id: assistantMessageId, role: "assistant", content: "", parts: [] },
			]);
			setStreaming(true);
			setTurnError(null);
			activeToolsRef.current.clear();
			setActiveTool(null);
			setStreamStartedAt(Date.now());

			const controller = new AbortController();
			abortRef.current = controller;
			const ownsTurn = () => abortRef.current === controller;
			const acceptsEvent = () => ownsTurn() && !controller.signal.aborted;
			const updateTurnAssistant = (update: (message: Message) => Message) => {
				if (!acceptsEvent()) {
					return;
				}
				setMessages((previous) =>
					previous.map((message) =>
						message.id === assistantMessageId && message.role === "assistant"
							? update(message)
							: message
					)
				);
			};
			// Settled turns (done, error, or Esc abort) stamp the trailing reasoning
			// part and settle every still-running tool so no row keeps spinning.
			// This bypasses acceptsEvent() on purpose (an aborted turn must still
			// settle) but stays scoped to this turn's assistant message, so a
			// superseded turn never rewrites a newer turn's parts.
			const settleTurn = (outcome: ToolSettleOutcome, reason?: string) => {
				const now = Date.now();
				setMessages((previous) =>
					previous.map((message) =>
						message.id === assistantMessageId && message.role === "assistant"
							? {
									...message,
									parts: settleRunningToolParts(
										closeReasoningPart(message.parts, now),
										outcome,
										reason,
										now
									),
								}
							: message
					)
				);
			};
			// Esc and chat resets abort synchronously; settle in the same tick so
			// interrupted rows go static immediately instead of after the fetch
			// promise unwinds.
			controller.signal.addEventListener(
				"abort",
				() => settleTurn("interrupted"),
				{ once: true }
			);
			const startedAt = Date.now();
			// ACP re-sends its usage meter many times a turn; keep the latest
			// snapshot here and write it to the message only when the turn
			// settles, so usage never forces a transcript redraw mid-stream.
			let latestUsage: TurnUsage | undefined;
			let turnFailed = false;
			const stampUsage = () => {
				const usage = latestUsage;
				if (!usage) {
					return;
				}
				setMessages((previous) =>
					previous.map((message) =>
						message.id === assistantMessageId && message.role === "assistant"
							? { ...message, usage }
							: message
					)
				);
			};
			const stampReceipt = () => {
				const configured = configuredModelRef.current;
				const modelLabel =
					options.acpModel ??
					(configured &&
					!options.teamId &&
					configured.agentId === options.agentId
						? configured.model
						: undefined);
				const agentLabel = receiptRouteLabel(options);
				updateTurnAssistant((message) => ({
					...message,
					receipt: {
						elapsedMs: Date.now() - startedAt,
						...(agentLabel ? { agentLabel } : {}),
						...(modelLabel ? { modelLabel } : {}),
					},
				}));
			};
			controller.signal.addEventListener("abort", stampUsage, { once: true });
			// Set when Core starts a continuation turn in this response; its first
			// text opens a new paragraph instead of running into the last turn.
			let continuationPending = false;
			const appendToTurn = (delta: string) => {
				if (continuationPending) {
					continuationPending = false;
					updateTurnAssistant((message) => ({
						...message,
						...appendContinuationText(message, delta),
					}));
					return;
				}
				updateTurnAssistant((message) => ({
					...message,
					content: message.content + delta,
					parts: appendTextPart(message.parts, delta),
				}));
			};

			const turnId = Symbol("turn");
			let turnState: HerdrState | "closed" | null = null;
			let turnMessage: string | undefined;
			const reportTurn = (state: HerdrState, message?: string) => {
				if (
					turnState === "closed" ||
					(turnState === state && turnMessage === message)
				) {
					return;
				}
				turnState = state;
				turnMessage = message;
				herdrReporter?.update(
					turnId,
					{ focused: false, state, message, options },
					target.url
				);
			};
			herdrTurn.current = { id: turnId, report: reportTurn };
			reportTurn("working");
			const finishTurn = () => {
				turnState = "closed";
				herdrReporter?.remove(turnId);
				if (herdrTurn.current?.id === turnId) {
					herdrTurn.current = null;
				}
			};

			streamChat(
				target,
				turns,
				options,
				coalesceStreamDeltas({
					onAcpCommands: (data) => {
						if (!acceptsEvent()) {
							return;
						}
						const commands = acpSlashCommandsFromData(data);
						if (commands) {
							setAdvertisedAcpCommands((current) => ({
								...current,
								[routeKey]: commands,
							}));
						}
					},
					onTextDelta: appendToTurn,
					onTurnBoundary: () => {
						continuationPending = true;
					},
					onToolInput: (name, input, toolCallId) => {
						if (!acceptsEvent()) {
							return;
						}
						const activeTools = activeToolsRef.current;
						// Untracked calls share a key; their output clears every entry.
						const toolKey = toolCallId ?? "untracked";
						activeTools.delete(toolKey);
						activeTools.set(toolKey, name);
						setActiveTool(name);
						updateTurnAssistant((message) => ({
							...message,
							parts: appendToolInputPart(
								message.parts,
								name,
								asRecord(input),
								toolCallId
							),
						}));
						const question =
							name === "Question" ? parseChatQuestion(input) : null;
						if (question) {
							reportTurn("blocked", "Waiting for an answer");
							setOverlay({
								kind: "question",
								question,
								questionIndex: 0,
								selected: 0,
								answers: [],
								text: "",
							});
						}
					},
					onToolOutput: (status, output, toolCallId) => {
						if (!acceptsEvent()) {
							return;
						}
						const activeTools = activeToolsRef.current;
						if (toolCallId === undefined) {
							activeTools.clear();
						} else {
							activeTools.delete(toolCallId);
						}
						setActiveTool([...activeTools.values()].at(-1) ?? null);
						updateTurnAssistant((message) => ({
							...message,
							parts: appendToolOutputPart(
								message.parts,
								status,
								output,
								toolCallId
							),
						}));
					},
					onReasoningDelta: (delta) =>
						updateTurnAssistant((message) => ({
							...message,
							parts: appendReasoningPart(message.parts, delta),
						})),
					onTodo: (input) =>
						updateTurnAssistant((message) => ({
							...message,
							parts: replaceTodoPart(message.parts, readTodos(input)),
						})),
					onPluginNote: (text) => {
						if (acceptsEvent()) {
							pushPluginNote(text);
						}
					},
					onUsage: (usage) => {
						if (acceptsEvent()) {
							latestUsage = mergeUsage(latestUsage, usage);
						}
					},
					onPermission: (value) => {
						if (!acceptsEvent()) {
							return;
						}
						const permission = parseChatPermission(value);
						if (permission) {
							reportTurn("blocked", "Waiting for tool permission");
							setOverlay({
								kind: "permission",
								index: 0,
								permission,
								detail: permissionToolDetail(permission.toolCall),
							});
						}
					},
					onError: (message) => {
						if (!acceptsEvent()) {
							return;
						}
						turnFailed = true;
						const readable = humanizeError(message, { url: target.url });
						setTurnError(herdrErrorMessage(readable));
						// The error renders inline in the transcript; a toast would
						// only repeat it.
						updateTurnAssistant((current) => ({
							...current,
							parts: appendErrorPart(current.parts, readable),
						}));
						settleTurn("error", readable);
					},
					onDone: () => {
						/* finalize handled after the promise resolves */
					},
				}),
				controller.signal
			)
				.then(() => {
					finishTurn();
					if (!controller.signal.aborted) {
						stampUsage();
						if (!turnFailed) {
							stampReceipt();
						}
					}
					// A finish without tool output settles as done (grok's
					// finalizeActiveTurn); an abort already settled as interrupted.
					settleTurn(controller.signal.aborted ? "interrupted" : "success");
					if (ownsTurn()) {
						setStreaming(false);
						clearTurnActivity();
						abortRef.current = null;
					}
				})
				.catch((err) => {
					finishTurn();
					const readable = humanizeError(err, { url: target.url });
					if (!controller.signal.aborted && ownsTurn()) {
						setTurnError(herdrErrorMessage(readable));
					}
					if (!controller.signal.aborted) {
						stampUsage();
						updateTurnAssistant((current) => ({
							...current,
							parts: appendErrorPart(current.parts, readable),
						}));
					}
					settleTurn(
						controller.signal.aborted ? "interrupted" : "error",
						controller.signal.aborted ? undefined : readable
					);
					if (ownsTurn()) {
						setStreaming(false);
						clearTurnActivity();
						abortRef.current = null;
					}
					if (!controller.signal.aborted) {
						// A failed turn may mean Core went away; refresh shared health.
						recheckHealth?.();
					}
				});
		},
		[target, buildOptions, pushPluginNote, clearTurnActivity, recheckHealth]
	);
	return { send };
}
