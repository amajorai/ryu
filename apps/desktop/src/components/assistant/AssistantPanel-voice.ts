import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { type RefObject, useCallback } from "react";
import { foldFinishedCall } from "@/src/components/voice/voice-call.ts";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpeechPlayback } from "@/src/hooks/useSpeechPlayback.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getDesktopTtsEngineOptions,
	getDesktopTtsPrefs,
} from "@/src/lib/api/preferences.ts";
import { speakText } from "@/src/lib/api/voice.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import type { AssistantBuilderSession } from "@/src/store/useAssistantStore.ts";

/** Speak-a-reply and voice-call history reconciliation for the panel. */
export function useAssistantVoice({
	builderRef,
	chatTarget,
	convIdRef,
	loadMessagesResult,
	setMessages,
	statusRef,
}: {
	builderRef: RefObject<AssistantBuilderSession | null>;
	chatTarget: ApiTarget;
	convIdRef: RefObject<string>;
	loadMessagesResult: ReturnType<
		typeof useChatHistoryContext
	>["loadMessagesResult"];
	setMessages: UseChatHelpers<UIMessage>["setMessages"];
	statusRef: RefObject<UseChatHelpers<UIMessage>["status"]>;
}) {
	// Multimodal (speak): synthesize an assistant reply via Core's `/api/voice/speak`
	// and play it, honouring the Voice-tab Audio engine/voice. A second click on the
	// same turn toggles playback off (`audio.play()` resolves at start, so the hover
	// button re-enables mid-playback). A missing TTS sidecar throws; the message
	// toolbar's speak button swallows it (silent no-op), so the surface degrades
	// gracefully — the same posture as STT, which has no capability probe to gate on.
	const { play: playSpeech } = useSpeechPlayback();
	const handleSpeak = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) {
				return;
			}
			await playSpeech(trimmed, () => {
				const prefs = getDesktopTtsPrefs();
				const engineOptions = getDesktopTtsEngineOptions(prefs.engine);
				return speakText(chatTarget, trimmed, {
					engine: prefs.engine,
					language: engineOptions.language,
					referenceAudio: engineOptions.referenceAudio,
					speed: engineOptions.speed,
					voice: engineOptions.voice || prefs.voice || undefined,
				});
			});
		},
		[chatTarget, playSpeech]
	);

	// A call's spoken turns render as ephemeral `voice-call-*` rows only while it
	// is live; Core persisted the real rows as it went. Once it ends, pull them
	// back (as ChatPage does) so the exchange stays on screen with persisted ids
	// instead of vanishing until the panel reopens. A generic thread is stored in
	// full, so its stored history replaces the transcript. A builder thread chats
	// with `persist: false`, so only this call's stored rows are folded in ahead
	// of its summary. Nothing is replaced while a new text turn is in flight.
	const reconcileCallHistory = useCallback(
		async (
			summary: { conversationId: string; messageId: string },
			builderThread: boolean
		) => {
			const result = await loadMessagesResult(summary.conversationId);
			const stillCurrent = builderThread
				? builderRef.current?.conversationId === summary.conversationId
				: !builderRef.current && convIdRef.current === summary.conversationId;
			const turnInFlight =
				statusRef.current === "streaming" || statusRef.current === "submitted";
			if (
				result.status === "error" ||
				result.messages.length === 0 ||
				!stillCurrent ||
				turnInFlight
			) {
				return;
			}
			const now = Date.now();
			if (builderThread) {
				setMessages((current) =>
					foldFinishedCall<UIMessage, (typeof result.messages)[number]>(
						current,
						result.messages,
						summary.messageId,
						(row) => hydrateHistoryMessage(row, now)
					)
				);
				return;
			}
			setMessages(
				result.messages.map((message) => hydrateHistoryMessage(message, now))
			);
		},
		[loadMessagesResult, setMessages]
	);
	return { handleSpeak, reconcileCallHistory };
}
