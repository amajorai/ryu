import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentAvailability } from "../agent-availability.tsx";
import {
	appendDraftInsertion,
	mergeDraftSeedWithInsertions,
} from "./agent-chat-helpers.tsx";
import type { AgentChatBaseScope } from "./agent-chat-scope.ts";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { deriveContextUsage } from "./context-usage.tsx";
import { InputBar } from "./input-bar.tsx";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";

export type UseAgentChatDraftInput = AgentChatBaseScope;

/** Availability, the composer draft and its seeds, and which messages the transcript shows. */
export function useAgentChatDraft({
	draftControls,
	seedDraft,
	onSeedDraftConsumed,
	draftInsertion,
	onDraftInsertionConsumed,
	onDraftChange,
	slots,
	messages,
	contextSize,
	statsModelName,
	statsProviderHint,
	voiceMode,
	error,
	historyLoading,
	historyError,
	status,
	emptyStatePosition,
}: UseAgentChatDraftInput) {
	const rootRef = useRef<HTMLDivElement>(null);
	const { animationsEnabled } = useChatDisplayPrefs();
	const availability = useAgentAvailability();
	const promptsPaused = availability !== "online";
	const prefersReducedMotion = useMediaQuery(
		"(prefers-reduced-motion: reduce)"
	);
	const reduceMotion = !animationsEnabled || prefersReducedMotion;
	const [draft, setDraft] = useState("");
	const draftTouchedRef = useRef(false);
	const consumedDraftInsertionIdRef = useRef<number | null>(null);
	const pendingDraftInsertionsRef = useRef<string[]>([]);
	const setDraftFromUser = useCallback((nextDraft: string) => {
		draftTouchedRef.current = true;
		setDraft(nextDraft);
	}, []);
	const resolvedDraftControls = draftControls
		? { ...draftControls, onInsert: setDraftFromUser }
		: undefined;

	// Apply a composer seed (e.g. from a deep link) once per distinct value, so a
	// pre-filled prompt lands in the textarea without clobbering later edits.
	const seededValueRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (
			seedDraft &&
			seedDraft !== seededValueRef.current &&
			!draftTouchedRef.current &&
			(draft.length === 0 || pendingDraftInsertionsRef.current.length > 0)
		) {
			seededValueRef.current = seedDraft;
			setDraft(
				mergeDraftSeedWithInsertions(
					seedDraft,
					pendingDraftInsertionsRef.current
				)
			);
			pendingDraftInsertionsRef.current = [];
			onSeedDraftConsumed?.();
		}
	}, [draft, onSeedDraftConsumed, seedDraft]);

	useEffect(() => {
		if (
			!draftInsertion ||
			draftInsertion.id === consumedDraftInsertionIdRef.current
		) {
			return;
		}
		consumedDraftInsertionIdRef.current = draftInsertion.id;
		const text = draftInsertion.text.trim();
		if (text) {
			if (!seededValueRef.current) {
				pendingDraftInsertionsRef.current.push(text);
			}
			setDraft((current) => appendDraftInsertion(current, text));
		}
		onDraftInsertionConsumed?.(draftInsertion.id);
	}, [draftInsertion, onDraftInsertionConsumed]);

	// Observe the composer text for surfaces that persist it (the desktop keeps
	// unsent text as a draft). A ref for the callback so a consumer passing an
	// inline arrow does not re-fire this on every render — the DRAFT changing is
	// the event, not the identity of the listener.
	const draftListener = useRef(onDraftChange);
	draftListener.current = onDraftChange;
	useEffect(() => {
		draftListener.current?.(draft);
	}, [draft]);

	const ResolvedInputBar = slots?.InputBar ?? InputBar;

	// Context-window meter for the composer: the fullness of THIS conversation,
	// derived from the latest turn's usage stats. The denominator prefers an
	// ACP-reported window, else the model's `contextSize` (launch config /
	// models.dev). Null (no meter) until a turn reports usage — it is live-only.
	// The model/provider hints key the prompt-cache TTL when a part omits them.
	const contextMeter = useMemo(
		() =>
			deriveContextUsage(messages, contextSize, {
				model: statsModelName,
				provider: statsProviderHint,
			}) ?? undefined,
		[messages, contextSize, statsModelName, statsProviderHint]
	);

	// A failed request is shown as a synthetic trailing assistant message. Built
	// in a memo rather than inline in the JSX because a fresh array literal there
	// hands MessageList a new `messages` identity on EVERY render for as long as
	// an error is on screen — which invalidates normalizeMessages /
	// groupMessagesIntoTurns / the TOC continuously, and re-arms the pinned-message
	// measuring effect every pass (the escalation path to React error #185).
	const voiceMessages = voiceMode?.active ? voiceMode.messages : undefined;
	const errorMessage = error?.message;
	// What the transcript shows after the conversation's own messages: the live
	// call's turns, then the failed request. One function so the live transcript
	// view (`liveMessages`) extends its newer messages exactly the same way.
	const withTranscriptExtras = useCallback(
		(base: UIMessage[]): RenderedMessage[] => {
			const withVoice =
				voiceMessages && voiceMessages.length > 0
					? [...base, ...voiceMessages]
					: base;
			return errorMessage === undefined
				? withVoice
				: [
						...withVoice,
						{
							id: "agent-chat-error",
							role: "assistant",
							parts: [
								{
									type: "error",
									title: "Request failed",
									message: errorMessage,
								},
							],
						} satisfies RenderedMessage,
					];
		},
		[errorMessage, voiceMessages]
	);
	const transcriptMessages = useMemo(
		() =>
			voiceMessages && voiceMessages.length > 0
				? [...messages, ...voiceMessages]
				: messages,
		[messages, voiceMessages]
	);
	const listMessages = useMemo(
		() => withTranscriptExtras(messages),
		[messages, withTranscriptExtras]
	);

	// "Nothing in this thread" and "this thread has not arrived yet" are different
	// facts, and only the first one may show the new-chat greeting. A restored tab
	// paints before its history resolves, so deriving emptiness from the message
	// count ALONE is what made every reopened conversation look like a brand-new
	// chat at boot — the alarming "all my chats are gone" screen. `historyLoading`
	// and `historyError` are only ever set for a thread that HAS a conversation
	// id, so a real new chat still gets its greeting.
	const isPlaceholder = Boolean(historyLoading || historyError);
	const isStreaming = status === "streaming" || status === "submitted";
	// A submitted turn is already a real chat, even if the transport has not
	// appended the optimistic user message yet. Leaving the empty layout mounted
	// for that gap made the composer teleport only after the first stream frame.
	const isEmpty =
		!(error || isPlaceholder) &&
		transcriptMessages.length === 0 &&
		!isStreaming;
	const isCenteredEmptyState = isEmpty && emptyStatePosition === "center";
	// The placeholder replaces the transcript only while there is nothing to show;
	// a re-fetch over an already-rendered thread must not blank it.
	const showPlaceholder =
		isPlaceholder && !error && transcriptMessages.length === 0;
	return {
		rootRef,
		availability,
		promptsPaused,
		reduceMotion,
		draft,
		setDraftFromUser,
		resolvedDraftControls,
		ResolvedInputBar,
		contextMeter,
		listMessages,
		withTranscriptExtras,
		isStreaming,
		isEmpty,
		isCenteredEmptyState,
		showPlaceholder,
	} as const;
}
