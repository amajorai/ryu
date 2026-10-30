import { extractMemoryCitations } from "@ryu/blocks/desktop/agent-elements/memory-citations.ts";
import { isMessageReactionAction } from "@ryu/blocks/desktop/agent-elements/message-action-types.ts";
import type {
	ContributedMessageAction,
	MessageActionContext,
	MessageActionRuntimeState,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { observeConversationMessageEvent } from "@ryuhq/core-client/conversation-message-event.ts";
import type { RealtimeHandlers } from "@ryuhq/core-client/realtime.ts";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentUiStateHost } from "@/src/hooks/useAgentUiStateHost.ts";
import { isMergedHistoryId } from "@/src/hooks/useMergedAgentThreads.ts";
import { useMessageReactions } from "@/src/hooks/useMessageReactions.ts";
import { useMessageReadReceipts } from "@/src/hooks/useMessageReadReceipts.ts";
import {
	parseConversationContextHandoffFrame,
	parseConversationModelSelectionFrame,
} from "@/src/lib/api/conversation-model-selection.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import { observeChatPresence } from "@/src/lib/realtime/chat-presence-observation.ts";
import { getRealtimeUserId } from "@/src/lib/realtime/jwt.ts";
import { isRealtimeMessageEcho } from "@/src/lib/realtime/message-origin.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import {
	mergeContextHandoffs,
	mergeConversationModelChanges,
	realtimeEventInputSchema,
	reuseUnchangedActionStates,
} from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPermissionsAndLinks } from "./ChatPage.permissions-links.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatRealtimeRoomInput = ReturnType<
	typeof useChatComposerResources
> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatPermissionsAndLinks>;

// A message's memory citations, kept per message object so an unchanged
// message yields the same array on every streamed chunk.
const memoryCitationsByMessageObject = new WeakMap<
	UIMessage,
	ReturnType<typeof extractMemoryCitations>
>();
function memoryCitationsOf(
	message: UIMessage
): ReturnType<typeof extractMemoryCitations> {
	const cached = memoryCitationsByMessageObject.get(message);
	if (cached) {
		return cached;
	}
	const citations = extractMemoryCitations(message.parts);
	memoryCitationsByMessageObject.set(message, citations);
	return citations;
}

/** Read receipts, reactions, message actions and realtime room events. */
export function useChatRealtimeRoom({
	ghostChatActive,
	convId,
	contributedMessageActions,
	merged,
	messages,
	feedback,
	convIdRef,
	activeConversationId,
	setFeedback,
	chatTarget,
	contextHandoffsRef,
	setContextHandoffs,
	conversationModelChangesRef,
	setConversationModelChanges,
	setProviderModelSelection,
	setSelectedModel,
	setModelSelectionCleared,
	realtimeClientIdRef,
	setMessages,
}: UseChatRealtimeRoomInput) {
	// ── Multi-user collaboration (Phase 2): live chat fan-out + presence ────────
	// Join this conversation's realtime room (only once a real `convId` exists —
	// never the draft id) so another human's messages appear live and we can show
	// who is present/typing. Anonymous (no node JWT) still works: with no verified
	// author, nothing is attributed or live-inserted, leaving the single-user flow
	// untouched.
	//
	// The signed-in human supplies the display name used for presence.
	const oidcUser = useAppStore((s) => s.oidcUser);

	// This client's stable Core user id (the JWT subject Core stamps as a message's
	// `author_user_id`). Resolved once; lets us tell our own echoed message from
	// someone else's. Null when signed out (anonymous) — then own/other is
	// indistinguishable, but an anonymous author is null too, so nothing inserts.
	const myUserIdRef = useRef<string | null>(null);
	const [myUserId, setMyUserId] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		// `getRealtimeUserId` resolves to null on any failure (never rejects).
		getRealtimeUserId().then((id) => {
			if (!cancelled) {
				myUserIdRef.current = id;
				setMyUserId(id);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const {
		applyRealtimeFrame: applyReadReceiptFrame,
		byMessage: readReceiptsByMessage,
		markVisible: markReadMessageVisible,
		users: readReceiptUsers,
	} = useMessageReadReceipts(ghostChatActive ? null : convId, myUserId);

	// This connection's room member id (from the join ack), used to drop our own
	// presence echo so we never show ourselves as "typing".
	const myMemberIdRef = useRef<string | null>(null);

	const reactionsPluginEnabled = useMemo(
		() => contributedMessageActions.some(isMessageReactionAction),
		[contributedMessageActions]
	);

	// Emoji reactions for this conversation. A temporary chat is never persisted, so
	// there is nothing to react TO and no room to fan reactions out over — the
	// null conversation id disables the query the same way it skips presence.
	const {
		byMessage: reactionsByMessage,
		applyRealtimeFrame: applyReactionFrame,
		toggle: toggleReaction,
	} = useMessageReactions(
		ghostChatActive || !reactionsPluginEnabled ? null : convId
	);

	// Saved state of generative-UI widgets (checklists, forms, calculators), so
	// they reopen as the user left them. A temporary chat keeps state in memory.
	const agentUiStateHost = useAgentUiStateHost(ghostChatActive ? null : convId);

	const memoryCitationsByMessage = useMemo(() => {
		const citationsByMessage = new Map<
			string,
			ReturnType<typeof extractMemoryCitations>
		>();
		const transcriptMessages = [...merged.messages, ...messages];
		for (const message of transcriptMessages) {
			const citations = memoryCitationsOf(message);
			if (citations.length > 0) {
				citationsByMessage.set(message.id, citations);
			}
		}
		return citationsByMessage;
	}, [merged.messages, messages]);

	const committedActionStatesRef = useRef<
		ReadonlyMap<string, MessageActionRuntimeState>
	>(new Map());
	const messageActionStates = useMemo(() => {
		const states = new Map<string, MessageActionRuntimeState>();
		const messageIds = new Set([
			...reactionsByMessage.keys(),
			...Object.keys(feedback),
			...memoryCitationsByMessage.keys(),
		]);
		for (const messageId of messageIds) {
			const buckets = reactionsByMessage.get(messageId);
			const rating = feedback[messageId];
			const memoryCitations = memoryCitationsByMessage.get(messageId);
			states.set(messageId, {
				...(buckets ? { reactionBuckets: buckets } : undefined),
				...(memoryCitations ? { memoryCitations } : undefined),
				...(rating
					? { toggleValues: { "learning.feedback": rating } }
					: undefined),
			});
		}
		return reuseUnchangedActionStates(committedActionStatesRef.current, states);
	}, [feedback, memoryCitationsByMessage, reactionsByMessage]);
	useEffect(() => {
		committedActionStatesRef.current = messageActionStates;
	}, [messageActionStates]);

	const runContributedMessageAction = useCallback(
		(action: ContributedMessageAction, context: MessageActionContext) => {
			if (isMessageReactionAction(action)) {
				if (context.value) {
					toggleReaction(context.messageId, context.value);
				}
				return;
			}
			if (
				action.id === "learning.feedback" &&
				action.plugin === "@ryu/learning"
			) {
				if (isMergedHistoryId(context.messageId)) {
					return;
				}
				const conversationId = convIdRef.current ?? activeConversationId;
				if (!conversationId) {
					return;
				}
				if (!action.capability) {
					return;
				}
				const rating =
					context.value === "up"
						? "up"
						: context.value === "down"
							? "down"
							: null;
				let previous: "up" | "down" | undefined;
				setFeedback((current) => {
					previous = current[context.messageId];
					const next = { ...current };
					if (rating) {
						next[context.messageId] = rating;
					} else {
						delete next[context.messageId];
					}
					return next;
				});
				void pluginHostInvoke(chatTarget, action.plugin, action.capability, {
					...action.args,
					conversation_id: conversationId,
					message_id: context.messageId,
					rating,
				}).catch(() => {
					if ((convIdRef.current ?? activeConversationId) !== conversationId) {
						return;
					}
					setFeedback((current) => {
						const reverted = { ...current };
						if (previous) {
							reverted[context.messageId] = previous;
						} else {
							delete reverted[context.messageId];
						}
						return reverted;
					});
				});
				return;
			}
			if (!(action.plugin && action.capability)) {
				return;
			}
			const args = {
				...action.args,
				message_id: context.messageId,
				...(context.value === undefined ? undefined : { value: context.value }),
			};
			void pluginHostInvoke(chatTarget, action.plugin, action.capability, args);
		},
		[activeConversationId, chatTarget, toggleReaction]
	);
	// Handed to the transcript through a latest-value ref: the reaction toggle
	// above changes identity on every render, and a new handler would re-render
	// every settled transcript turn on every streamed chunk.
	const contributedMessageActionRef = useRef(runContributedMessageAction);
	contributedMessageActionRef.current = runContributedMessageAction;
	const handleContributedMessageAction = useCallback(
		(action: ContributedMessageAction, context: MessageActionContext) =>
			contributedMessageActionRef.current(action, context),
		[]
	);

	// Remote members' latest presence (name + typing), keyed by member id. Our own
	// member is excluded. Reset when the conversation changes.
	const [remotePresence, setRemotePresence] = useState<
		Record<string, { name?: string | null; typing?: boolean }>
	>({});
	// Presence belongs to the room we are leaving, so wipe it when convId changes.
	// convId is the reset trigger, not read in the body.
	useEffect(() => {
		setRemotePresence({});
		myMemberIdRef.current = null;
	}, [convId]);

	// Live-insert a message authored by ANOTHER human. Assistant turns (null
	// author) arrive through the local SSE stream, and our own message echoes back
	// under our user id (its optimistic copy is already shown under a different,
	// client-generated id) — both are skipped here. Dedupe by id guards against a
	// frame being delivered twice. Appended last = created_at order for live
	// arrival; the server timestamp is kept in metadata for later reconstruction.
	const handleRealtimeEvent = useCallback(
		(raw: Parameters<typeof realtimeEventInputSchema.safeParse>[0]) => {
			const parsed = realtimeEventInputSchema.safeParse(raw);
			if (!parsed.success) {
				return;
			}
			const data = parsed.data;
			const handoffFrame = parseConversationContextHandoffFrame(data);
			if (handoffFrame) {
				if (handoffFrame.conversationId === convIdRef.current) {
					const handoffs = mergeContextHandoffs(contextHandoffsRef.current, [
						handoffFrame.handoff,
					]);
					contextHandoffsRef.current = handoffs;
					setContextHandoffs(handoffs);
				}
				return;
			}
			const modelSelectionFrame = parseConversationModelSelectionFrame(data);
			if (modelSelectionFrame) {
				if (modelSelectionFrame.conversationId !== convIdRef.current) {
					return;
				}
				const { change } = modelSelectionFrame;
				const merged = mergeConversationModelChanges(
					conversationModelChangesRef.current,
					[change]
				);
				conversationModelChangesRef.current = merged;
				setConversationModelChanges(merged);
				setProviderModelSelection(
					change.providerId
						? {
								modelId: change.modelId,
								providerId: change.providerId,
								providerLabel: change.providerLabel,
							}
						: null
				);
				setSelectedModel(change.modelId);
				setModelSelectionCleared(change.modelId === null);
				return;
			}
			const frame = data;
			if (frame.type === "readReceipt" || frame.type === "read_receipt") {
				applyReadReceiptFrame(data);
				return;
			}
			// Reactions ride the same named-event channel as messages. Routed before
			// the message guard below, which would otherwise drop them on the floor.
			if (frame.type === "reaction") {
				applyReactionFrame(data, myUserIdRef.current);
				return;
			}
			if (frame.type !== "message") {
				return;
			}
			const observed = observeConversationMessageEvent(data);
			if (!observed) {
				return;
			}
			const msg = observed.event.message;
			const authorId = msg.author_user_id ?? null;
			// Suppress only the exact client that submitted the optimistic message.
			// Another tab or device owned by the same user must still receive it.
			const isOwnMessage = isRealtimeMessageEcho(
				msg.client_id,
				realtimeClientIdRef.current
			);
			if (!(msg.id && isNativeText(msg.content) && authorId) || isOwnMessage) {
				return;
			}
			const inserted = {
				id: msg.id,
				role: "user",
				parts: [{ type: "text", text: msg.content }],
				metadata: {
					author: { name: msg.author_name ?? undefined, id: authorId },
					createdAt: msg.created_at,
					ryuPersisted: true,
					origin_server: msg.origin_server ?? undefined,
					source: msg.source ?? undefined,
					widget_instance_id: msg.widget_instance_id ?? undefined,
				},
			} satisfies UIMessage;
			setMessages((prev) => {
				if (prev.some((m) => m.id === msg.id)) {
					return prev;
				}
				return [...prev, inserted];
			});
		},
		[
			applyReactionFrame,
			applyReadReceiptFrame,
			setConversationModelChanges,
			setMessages,
			setModelSelectionCleared,
			setProviderModelSelection,
			setSelectedModel,
		]
	);

	// Apply a presence delta from another member: upsert their name/typing, or
	// drop them on a `presence_leave`. Our own echo (same member id) is ignored.
	const handleRealtimePresence = useCallback(
		(data: Parameters<NonNullable<RealtimeHandlers["onPresence"]>>[0]) => {
			const frame = observeChatPresence(data, "delta");
			if (!frame) {
				return;
			}
			const memberId = frame.memberId;
			if (!memberId || memberId === myMemberIdRef.current) {
				return;
			}
			if (frame.kind === "leave") {
				setRemotePresence((prev) => {
					if (!(memberId in prev)) {
						return prev;
					}
					const next = { ...prev };
					delete next[memberId];
					return next;
				});
				return;
			}
			setRemotePresence((prev) => ({
				...prev,
				[memberId]: { name: frame.name, typing: Boolean(frame.typing) },
			}));
		},
		[]
	);
	return {
		oidcUser,
		myUserIdRef,
		myUserId,
		readReceiptsByMessage,
		markReadMessageVisible,
		readReceiptUsers,
		myMemberIdRef,
		agentUiStateHost,
		messageActionStates,
		handleContributedMessageAction,
		remotePresence,
		setRemotePresence,
		handleRealtimeEvent,
		handleRealtimePresence,
	} as const;
}
