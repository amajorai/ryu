import type { ChatVoiceMode } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { useCallback, useRef } from "react";
import { useVoiceLiveCall } from "@/src/components/voice/VoiceCallComposer.tsx";
import { useSpeechPlayback } from "@/src/hooks/useSpeechPlayback.ts";
import { useVoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { generateImage } from "@/src/lib/api/images.ts";
import {
	getDesktopTtsEngineOptions,
	getDesktopTtsPrefs,
} from "@/src/lib/api/preferences.ts";
import { generateVideo } from "@/src/lib/api/video.ts";
import { speakText } from "@/src/lib/api/voice.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import { buildVersions } from "@/src/lib/chat-message-selectors.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatGoals } from "./ChatPage.goals.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatMediaAndVoiceInput = ReturnType<
	typeof useChatModelSelection
> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatGoals>;

/** Image and video generation, read-aloud, and voice mode. */
export function useChatMediaAndVoice({
	setMessages,
	chatTargetRef,
	chatTarget,
	convId,
	draftConvId,
	convIdRef,
	setActiveConversationId,
	refresh,
	loadMessagesPageResult,
	isTranscriptCurrent,
	olderMessagesCursorRef,
	setHasOlderMessages,
	messageSentAtRef,
	setVersions,
	voiceInputEngine,
}: UseChatMediaAndVoiceInput) {
	// Multimodal: generate an image from the composer text and surface it inline as
	// an assistant message. The result is client-only — Core's /api/images/generate
	// is one-shot and isn't written to the conversation store, so the image is not
	// re-hydrated on reload (loadMessages rebuilds history as text-only parts).
	// The generation itself, against an assistant message that ALREADY exists.
	// Split out from the handler below so a failed generation can be re-run in
	// place (see `handleRetryGeneration`) instead of echoing the prompt a second
	// time. Core has no progress events for this path, so the status goes straight
	// from `generating` to `complete`/`error` — no fabricated intermediate steps.
	const runImageGeneration = useCallback(
		async (assistantId: string, prompt: string) => {
			const settle = (parts: UIMessage["parts"]) => {
				setMessages((prev) =>
					prev.map((m) => (m.id === assistantId ? { ...m, parts } : m))
				);
			};
			// Back to the in-flight frame first: on a retry the message still holds
			// the failed part, and the frame must reserve its box again.
			settle([
				{
					type: "data-image-generation",
					data: { status: "generating", prompt },
				},
			]);
			try {
				const urls = await generateImage(chatTargetRef.current, prompt);
				const [first, ...rest] = urls;
				if (!first) {
					settle([
						{
							type: "data-image-generation",
							data: {
								status: "error",
								prompt,
								statusText: "The image engine returned no image.",
							},
						},
					]);
					return;
				}
				// The first image drives the generation surface; any extras (n > 1)
				// ride along as plain file parts, which render in the same frame.
				settle([
					{
						type: "data-image-generation",
						data: { status: "complete", prompt, url: first },
					},
					...rest.map<UIMessage["parts"][number]>((url) => ({
						type: "file",
						mediaType: "image/png",
						url,
					})),
				]);
			} catch (e) {
				settle([
					{
						type: "data-image-generation",
						data: {
							status: "error",
							prompt,
							statusText:
								e instanceof Error ? e.message : "Could not generate image.",
						},
					},
				]);
			}
		},
		[setMessages]
	);

	const handleGenerateImage = useCallback(
		async (prompt: string) => {
			const userId = `img-user-${Date.now()}`;
			const assistantId = `img-${Date.now()}`;
			// Echo the prompt as a user bubble, and reserve the image frame in the
			// same tick: MessageList renders a `data-image-generation` part through
			// the ImageGeneration surface, so the turn shows the generation running
			// and the finished image fades into an already-sized frame.
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} satisfies UIMessage,
				{
					id: assistantId,
					role: "assistant",
					parts: [
						{
							type: "data-image-generation",
							data: { status: "generating", prompt },
						},
					],
				} satisfies UIMessage,
			]);
			await runImageGeneration(assistantId, prompt);
		},
		[runImageGeneration, setMessages]
	);

	// The video twin of `runImageGeneration`, on the matching
	// `data-video-generation` part. The sdcpp vid_gen response shape is
	// best-effort (see lib/api/video.ts) — an empty result keeps the frame and
	// says which model to load, rather than dropping a bare error card.
	const runVideoGeneration = useCallback(
		async (assistantId: string, prompt: string) => {
			const settle = (parts: UIMessage["parts"]) => {
				setMessages((prev) =>
					prev.map((m) => (m.id === assistantId ? { ...m, parts } : m))
				);
			};
			settle([
				{
					type: "data-video-generation",
					data: { status: "generating", prompt },
				},
			]);
			try {
				const clips = await generateVideo(chatTargetRef.current, prompt);
				const [first, ...rest] = clips;
				if (!first) {
					settle([
						{
							type: "data-video-generation",
							data: {
								status: "error",
								prompt,
								statusText:
									"The engine returned no video. Load a video model (Wan/LTX) in the sdcpp engine and try again.",
							},
						},
					]);
					return;
				}
				// Same split as images: the first clip drives the generation surface,
				// extras ride along as file parts (which render in the same frame).
				settle([
					{
						type: "data-video-generation",
						data: { status: "complete", prompt, url: first.url },
					},
					...rest.map<UIMessage["parts"][number]>((clip) => ({
						type: "file",
						mediaType: clip.mediaType,
						url: clip.url,
					})),
				]);
			} catch (e) {
				settle([
					{
						type: "data-video-generation",
						data: {
							status: "error",
							prompt,
							statusText:
								e instanceof Error ? e.message : "Could not generate video.",
						},
					},
				]);
			}
		},
		[setMessages]
	);

	// Multimodal: generate a video from the composer text, surfaced inline exactly
	// like the image path. Client-only (not persisted).
	const handleGenerateVideo = useCallback(
		async (prompt: string) => {
			const userId = `vid-user-${Date.now()}`;
			const assistantId = `vid-${Date.now()}`;
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} satisfies UIMessage,
				{
					id: assistantId,
					role: "assistant",
					parts: [
						{
							type: "data-video-generation",
							data: { status: "generating", prompt },
						},
					],
				} satisfies UIMessage,
			]);
			await runVideoGeneration(assistantId, prompt);
		},
		[runVideoGeneration, setMessages]
	);

	// Retry a FAILED inline generation. Not `handleRegenerateMessage`: that one
	// branches a persisted turn server-side, and these parts are client-only (Core
	// never wrote them to the conversation store), so there is nothing to branch.
	// The narrowest correct call is re-running the same generator against the same
	// assistant message — no second user echo, no new bubble.
	const handleRetryGeneration = useCallback(
		(messageId: string, kind: "image" | "video", prompt: string) => {
			const run = kind === "video" ? runVideoGeneration : runImageGeneration;
			void run(messageId, prompt);
		},
		[runImageGeneration, runVideoGeneration]
	);

	// Speak an assistant reply via Core, honouring the Voice-tab Audio preference.
	// The shared owner keeps replacement/toggle/unmount cleanup identity-safe.
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
				return speakText(chatTargetRef.current, trimmed, {
					engine: prefs.engine,
					language: engineOptions.language,
					referenceAudio: engineOptions.referenceAudio,
					speed: engineOptions.speed,
					voice: engineOptions.voice || prefs.voice || undefined,
				});
			});
		},
		[playSpeech]
	);
	const handleSpeakRef = useRef(handleSpeak);
	handleSpeakRef.current = handleSpeak;
	const desktopTts = getDesktopTtsPrefs();
	// ChatGPT-style continuous voice mode (its own separate entry point — the
	// composer mic above stays as push-to-talk voice INPUT). All realtime logic
	// (VAD, endpointing, barge-in) lives in Core; this reflects it into the overlay.
	const voiceMode = useVoiceMode(chatTarget, {
		conversationId: convId ?? draftConvId.current,
		onCallEnded: (summary) => {
			if (
				(convIdRef.current ?? draftConvId.current) !== summary.conversationId
			) {
				return;
			}
			if (!convIdRef.current) {
				setActiveConversationId(summary.conversationId);
			}
			setMessages((current) =>
				current.some((message) => message.id === summary.messageId)
					? current
					: [
							...current,
							{
								id: summary.messageId,
								role: "user",
								parts: [{ type: "text", text: summary.content }],
							},
						]
			);
			refresh();
			// The call's turns render as synthetic `voice-call-*` messages only
			// while the call is live; Core persisted the real rows as it went.
			// Reload the newest page so the spoken exchange stays on screen (with
			// persisted ids) once the live turns unmount, instead of vanishing
			// until the next reload.
			void loadMessagesPageResult(summary.conversationId).then((page) => {
				if (
					page.status === "error" ||
					page.messages.length === 0 ||
					!isTranscriptCurrent() ||
					(convIdRef.current ?? draftConvId.current) !== summary.conversationId
				) {
					return;
				}
				const nextCursor = page.olderMessagesCursor ?? null;
				olderMessagesCursorRef.current = nextCursor;
				setHasOlderMessages(
					page.hasOlderMessages === true && nextCursor !== null
				);
				for (const persisted of page.messages) {
					if (isNativeNumber(persisted.timestamp)) {
						messageSentAtRef.current.set(persisted.id, persisted.timestamp);
					}
				}
				setVersions(buildVersions(page.messages));
				const now = Date.now();
				setMessages(page.messages.map((m) => hydrateHistoryMessage(m, now)));
			});
		},
		sttEngine: voiceInputEngine,
		ttsEngine: desktopTts.engine,
		ttsVoice: desktopTts.voice || undefined,
	});
	const voiceModeSlot: ChatVoiceMode = useVoiceLiveCall(voiceMode);
	return {
		handleGenerateImage,
		handleGenerateVideo,
		handleRetryGeneration,
		handleSpeak,
		handleSpeakRef,
		voiceMode,
		voiceModeSlot,
	} as const;
}
