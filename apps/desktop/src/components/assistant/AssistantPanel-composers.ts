import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { type RefObject, useCallback, useRef } from "react";
import type { useBuilderRuntime } from "@/src/hooks/useBuilderRuntime.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	AssistantBuilderSession,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";
import { BUILDER_PLACEHOLDER } from "./AssistantPanel-request.ts";
import type { useAssistantVoice } from "./AssistantPanel-voice.ts";
import { type ComposerSendFile, useComposerSlot } from "./useComposerSlot.tsx";

type BuilderRuntime = ReturnType<typeof useBuilderRuntime>;

/** The generic + builder composers and the live refs the send path drains. */
export function useAssistantComposers({
	activeConvId,
	bare,
	builderRef,
	builderRuntime,
	chatTarget,
	convId,
	convIdRef,
	genericRuntime,
	handleGenerateImage,
	isAppSurface,
	isBuilder,
	reconcileCallHistory,
	refresh,
	setConversationId,
	setMessages,
	status,
}: {
	activeConvId: string;
	bare: boolean;
	builderRef: RefObject<AssistantBuilderSession | null>;
	builderRuntime: BuilderRuntime;
	chatTarget: ApiTarget;
	convId: string;
	convIdRef: RefObject<string>;
	genericRuntime: BuilderRuntime;
	handleGenerateImage: (prompt: string) => Promise<void>;
	isAppSurface: boolean;
	isBuilder: boolean;
	reconcileCallHistory: ReturnType<
		typeof useAssistantVoice
	>["reconcileCallHistory"];
	refresh: () => void;
	setConversationId: ReturnType<
		typeof useAssistantStore.getState
	>["setConversationId"];
	setMessages: UseChatHelpers<UIMessage>["setMessages"];
	status: UseChatHelpers<UIMessage>["status"];
}) {
	// The full chat composer — the SAME one the main chat page renders (Agent ·
	// Model · Thinking menu + STT voice + voice mode + image attachments) — built
	// once by the shared `useComposerSlot`. Both runtimes get a composer (no
	// conditional hooks); the active one is picked. The builder pane relabels its
	// placeholder. The narrow floating/docked panel keeps the roomy stacked
	// textarea and only compactifies the agent-picker trigger.
	const genericComposer = useComposerSlot(genericRuntime, {
		target: chatTarget,
		surface: "ask-ryu",
		compact: bare && !isBuilder,
		compactTrigger: true,
		conversationId: convId,
		onCallEnded: (summary) => {
			if (convIdRef.current && convIdRef.current !== summary.conversationId) {
				return;
			}
			setConversationId(summary.conversationId);
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
			reconcileCallHistory(summary, false).catch(() => {
				// The summary is already on screen; the turns return on the next reload.
			});
		},
		isWorking: status === "streaming" || status === "submitted",
		minimal: bare && !isBuilder,
		// Image-gen only on the chat composer — the builder pane describes what to
		// build, where a free-form "generate image" prompt has no place.
		onGenerateImage: handleGenerateImage,
	});
	const builderComposer = useComposerSlot(builderRuntime, {
		target: chatTarget,
		surface: "dashboard",
		compactTrigger: true,
		placeholder: BUILDER_PLACEHOLDER,
		conversationId: activeConvId,
		// Voice mode talks to Core directly under the conversation id, without
		// the app's preamble, page context, or `persist: false`; an app surface's
		// turns must go through its own send path instead.
		voiceMode: !isAppSurface,
		onCallEnded: (summary) => {
			if (builderRef.current?.conversationId !== summary.conversationId) {
				return;
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
			reconcileCallHistory(summary, true).catch(() => {
				// The summary is already on screen; the turns are simply not folded in.
			});
		},
		isWorking: status === "streaming" || status === "submitted",
	});
	const activeComposer = isBuilder ? builderComposer : genericComposer;
	const composerSlot = activeComposer.inputBar;
	// Live ref so `handleSend` can fold staged images into the outgoing message
	// without depending on the composer identity (which flips builder↔generic).
	const takeImagesRef = useRef(activeComposer.takeImages);
	takeImagesRef.current = activeComposer.takeImages;
	// Live ref for the queued Ryu Clip context text, folded into the outgoing text
	// at send time (frames ride the image path via `takeImages`). Same live-ref
	// indirection as images so the send handler never depends on the composer
	// identity (which flips builder<->generic).
	const takeClipTextRef = useRef(activeComposer.takeClipText);
	takeClipTextRef.current = activeComposer.takeClipText;
	// Stable attach fn for the clip composer controls, reading the live composer.
	const attachClipRef = useRef(activeComposer.attachClip);
	attachClipRef.current = activeComposer.attachClip;
	const attachClip = useCallback(
		(text: string, frames: ComposerSendFile[]) =>
			attachClipRef.current(text, frames),
		[]
	);
	return {
		activeComposer,
		attachClip,
		composerSlot,
		genericComposer,
		takeClipTextRef,
		takeImagesRef,
	};
}
