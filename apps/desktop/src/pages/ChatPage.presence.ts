import type { JoinAck } from "@ryuhq/core-client/realtime.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	invalidateGitStatus,
	invalidateWorktreeDiff,
	invalidateWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import {
	fetchComposerPrediction,
	fetchNextPromptSuggestions,
} from "@/src/lib/api/chat.ts";
import { getVoiceModeReadbackPrefs } from "@/src/lib/api/preferences.ts";
import { extractAssistantText } from "@/src/lib/chat-message-selectors.ts";
import { getChatTabBusySpeed } from "@/src/lib/chat-tab-busy-speed.ts";
import { observeChatPresence } from "@/src/lib/realtime/chat-presence-observation.ts";
import { useRealtimeRoom } from "@/src/lib/realtime/use-realtime-room.ts";
import { useMeetingRecordingStore } from "@/src/store/useMeetingRecordingStore.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import { TYPING_IDLE_MS } from "./ChatPage.helpers.ts";
import type { useChatMediaAndVoice } from "./ChatPage.media-voice.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatRealtimeRoom } from "./ChatPage.realtime-room.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatPresenceInput = ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatMediaAndVoice> &
	ReturnType<typeof useChatRealtimeRoom>;

/** Room presence, typing, and follow-up suggestions. */
export function useChatPresence({
	myMemberIdRef,
	setRemotePresence,
	ghostChatActive,
	convId,
	handleRealtimeEvent,
	handleRealtimePresence,
	setHistoryReloadKey,
	realtimeClientIdRef,
	oidcUser,
	remotePresence,
	status,
	currentTabId,
	updateTabBusy,
	acp,
	refresh,
	chatTargetRef,
	messages,
	handleSpeakRef,
	draftConvId,
	scrollToMessageId,
	clearScrollToMessage,
}: UseChatPresenceInput) {
	const handleRealtimeJoinAck = useCallback((ack: JoinAck) => {
		myMemberIdRef.current = ack.memberId;
		setRemotePresence((prev) => {
			const next = { ...prev };
			for (const entry of ack.presence) {
				const frame = observeChatPresence(entry, "roster");
				if (frame?.kind !== "upsert") {
					continue;
				}
				if (frame.memberId && frame.memberId !== ack.memberId) {
					next[frame.memberId] = {
						name: frame.name,
						typing: Boolean(frame.typing),
					};
				}
			}
			return next;
		});
		// Publish an initial payload so both the roster snapshot and future
		// presence deltas carry a human-readable identity before typing starts.
		publishRoomPresenceRef.current({
			name: myPresenceNameRef.current,
			typing: false,
		});
	}, []);

	// A temporary chat never opens a realtime room: its turns are never
	// persisted (so Core fans out nothing), and we also skip presence so a
	// temporary thread stays fully private. `null` room id = no join.
	const { publishPresence: publishRoomPresence } = useRealtimeRoom(
		ghostChatActive ? null : convId,
		"conversation",
		{
			onEvent: handleRealtimeEvent,
			onJoinAck: handleRealtimeJoinAck,
			onPresence: handleRealtimePresence,
			onResyncRequired: () => setHistoryReloadKey((value) => value + 1),
		},
		realtimeClientIdRef.current
	);

	// Our presence display name (control-plane profile), read into a ref so the
	// stable typing publisher always sends the current value.
	const myPresenceNameRef = useRef("Someone");
	myPresenceNameRef.current = oidcUser?.name ?? oidcUser?.email ?? "Someone";
	const publishRoomPresenceRef = useRef<typeof publishRoomPresence>(() => {});
	publishRoomPresenceRef.current = publishRoomPresence;

	// Debounced typing presence: publish `typing:true` on activity, then
	// `typing:false` once the user pauses (or on send). No-op until the room is
	// open (publishPresence swallows pre-open calls).
	const typingTimerRef = useRef<number | null>(null);
	const stopTyping = useCallback(() => {
		if (typingTimerRef.current !== null) {
			window.clearTimeout(typingTimerRef.current);
			typingTimerRef.current = null;
		}
		publishRoomPresenceRef.current({
			typing: false,
			name: myPresenceNameRef.current,
		});
	}, []);
	const handleTypingActivity = useCallback(() => {
		publishRoomPresenceRef.current({
			typing: true,
			name: myPresenceNameRef.current,
		});
		if (typingTimerRef.current !== null) {
			window.clearTimeout(typingTimerRef.current);
		}
		typingTimerRef.current = window.setTimeout(() => {
			typingTimerRef.current = null;
			publishRoomPresenceRef.current({
				typing: false,
				name: myPresenceNameRef.current,
			});
		}, TYPING_IDLE_MS);
	}, []);

	// A short human-readable presence line: who is typing wins; otherwise who is
	// here. Empty when alone, so nothing renders in the common single-user case.
	const presenceLabel = useMemo(() => {
		const members = Object.values(remotePresence);
		const typingNames = members
			.filter((m) => m.typing)
			.map((m) => m.name?.trim() || "Someone");
		if (typingNames.length > 0) {
			const verb = typingNames.length === 1 ? "is" : "are";
			return `${typingNames.join(", ")} ${verb} typing…`;
		}
		const presentNames = members.map((m) => m.name?.trim() || "Someone");
		if (presentNames.length > 0) {
			return presentNames.length === 1
				? `${presentNames[0]} is here`
				: `${presentNames.length} others here`;
		}
		return null;
	}, [remotePresence]);

	// The conversation id of the most recently completed run. Used to query the
	// worktree diff after stream completion. Reset when a new conversation starts.
	const [diffConvId, setDiffConvId] = useState<string | null>(null);

	// ChatGPT-style next-prompt suggestions: fetched from Core once a turn
	// settles, cleared the moment the next turn starts (or the thread switches).
	const [followUps, setFollowUps] = useState<string[]>([]);
	// Composer prediction (Composer Predictions plugin): the user's likely next
	// message, shown as Tab-to-accept ghost text. Shares the chips' lifecycle.
	const [composerPrediction, setComposerPrediction] = useState<string | null>(
		null
	);
	const followUpAbort = useRef<AbortController | null>(null);

	// After a streamed reply completes, re-sync the sidebar list from Core and
	// record the conversation id so DiffReviewPane can fetch the run's diff.
	const prevStatus = useRef(status);
	useEffect(() => {
		// Keep the tab chip in sync with the live stream so the spinner/shimmer
		// appear as soon as the user sends — before Core's run_status catches up.
		if (currentTabId) {
			const busy = status === "streaming" || status === "submitted";
			updateTabBusy(
				currentTabId,
				busy,
				getChatTabBusySpeed(status, acp.acpMode, acp.acpOptionValues)
			);
		}
		// A new turn is in flight — drop stale chips and cancel any pending fetch.
		// This runs on every message update of the turn, so keep the empty list
		// as it is: a fresh `[]` re-rendered the whole page once more per update.
		if (status === "streaming" || status === "submitted") {
			setFollowUps((current) => (current.length === 0 ? current : []));
			setComposerPrediction(null);
			followUpAbort.current?.abort();
			followUpAbort.current = null;
		}
		// Any transition INTO "ready", not only from "streaming": a turn that is
		// answered without ever emitting a stream chunk goes submitted → ready, and
		// gating on "streaming" meant such a turn never re-synced the sidebar — its
		// row kept the draft's title and stayed in the loose Chats bucket for the
		// rest of the session, even though Core had already stamped the folder.
		if (prevStatus.current !== "ready" && status === "ready") {
			refresh();
			// The run has finished writing files, so this is the moment the working
			// tree changed — re-read git now rather than waiting for the safety-net
			// poll. Cheap: once per turn, not once per chunk.
			invalidateGitStatus();
			// The run belongs to THIS TAB's conversation. Never the shared
			// focused-tab `activeConversationId`: a run that finishes while another
			// tab is focused would read that tab's diff and follow-ups.
			if (convId) {
				invalidateWorktreeStatus(convId);
				invalidateWorktreeDiff(convId);
				setDiffConvId(convId);
			}
			// Auto read-back when enabled (Voice settings), unless a meeting is recording.
			getVoiceModeReadbackPrefs(chatTargetRef.current).then((prefs) => {
				if (!prefs.enabled) {
					return;
				}
				if (useMeetingRecordingStore.getState().active) {
					return;
				}
				const lastAssistant = messages
					.filter((m) => m.role === "assistant")
					.at(-1);
				if (!lastAssistant) {
					return;
				}
				const text = extractAssistantText(lastAssistant);
				if (text) {
					handleSpeakRef.current(text)?.catch(() => undefined);
				}
			});
			// The chat-title plugin may re-title after a completed turn. Refresh
			// once more so the sidebar picks up the new title without a reload.
			const t = setTimeout(refresh, 2500);
			prevStatus.current = status;
			// Ask Core for follow-up prompts for the turn that just finished.
			// Best-effort: an empty list simply shows no chips.
			const followUpConversationId = convId ?? draftConvId.current;
			if (followUpConversationId) {
				const controller = new AbortController();
				followUpAbort.current = controller;
				fetchNextPromptSuggestions(
					chatTargetRef.current,
					followUpConversationId,
					controller.signal
				).then((items) => {
					if (!controller.signal.aborted) {
						setFollowUps(items);
					}
				});
				fetchComposerPrediction(
					chatTargetRef.current,
					followUpConversationId,
					controller.signal
				).then((prediction) => {
					if (!controller.signal.aborted) {
						setComposerPrediction(prediction);
					}
				});
			}
			return () => clearTimeout(t);
		}
		prevStatus.current = status;
	}, [
		status,
		refresh,
		convId,
		messages,
		currentTabId,
		acp.acpMode,
		acp.acpOptionValues,
		updateTabBusy,
	]);

	// Clear busy on unmount so a closed streaming tab doesn't leave a stale spinner.
	useEffect(() => {
		return () => {
			if (currentTabId) {
				updateTabBusy(currentTabId, false);
			}
		};
	}, [currentTabId, updateTabBusy]);

	// Sidebar / TOC jump: once messages are hydrated, ask the message list to
	// scroll to the pending anchor and clear the one-shot tab flag.
	useEffect(() => {
		if (!(scrollToMessageId && currentTabId && messages.length > 0)) {
			return;
		}
		const timer = window.setTimeout(() => {
			window.dispatchEvent(
				new CustomEvent("ryu:scroll-to-message", {
					detail: { messageId: scrollToMessageId },
				})
			);
			clearScrollToMessage(currentTabId);
		}, 80);
		return () => window.clearTimeout(timer);
	}, [scrollToMessageId, currentTabId, messages.length, clearScrollToMessage]);

	// Switching THIS TAB's thread must not carry chips across conversations.
	// The tab-local `convId` is load-bearing: it changes on every in-tab thread
	// switch, so without it this never runs again after mount and the chips leak
	// into the next conversation. Never key this on the shared focused-tab
	// `activeConversationId`: every chat tab stays mounted, so focusing another
	// tab would clear this background tab's chips and abort its in-flight
	// suggestions request.
	useEffect(() => {
		setFollowUps([]);
		setComposerPrediction(null);
		followUpAbort.current?.abort();
		followUpAbort.current = null;
	}, [convId]);
	return {
		stopTyping,
		handleTypingActivity,
		presenceLabel,
		diffConvId,
		setDiffConvId,
		followUps,
		setFollowUps,
		composerPrediction,
	} as const;
}
