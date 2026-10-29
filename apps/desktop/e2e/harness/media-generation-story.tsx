import type {
	ImageGenerationPartData,
	VideoGenerationPartData,
} from "@ryu/blocks/desktop/agent-elements/message-list.tsx";
// Standalone browser story for the INLINE MEDIA GENERATION surfaces in the real
// transcript — `data-image-generation` and `data-video-generation` parts, drawn
// by `AssistantGeneratedImage` / `AssistantGeneratedVideo` in
// `packages/blocks/src/desktop/agent-elements/message-list.tsx` on top of
// `@ryu/ui/components/motion/{image,video}-generation.tsx`.
//
// Why this exists: until now video had no generation component at all (it fell
// through to a "Download attachment (video/mp4)" anchor), and NEITHER media type
// had a retry — a failed generation was a dead end on screen. Both halves are
// only observable through the transcript, because the retry affordance is
// rendered by the component but WIRED by the surface: the part carries the
// prompt, MessageList turns it into a call, and the producer re-runs the
// generator against the same assistant message. A unit test of the component
// alone would pass with the prop never plumbed.
//
// The fixture mounts a transcript holding, in order:
//   • a FAILED video generation, carrying the engine's own error text;
//   • a FAILED image generation (the same wiring, other media type);
//   • a bare `file` part with `video/mp4`, which must land in the video frame
//     rather than the download-link fallback.
//
// The story stands in for Core: `onRetryGeneration` flips the named message to
// `generating`, then settles it `complete` a beat later — the exact shape
// ChatPage's `runVideoGeneration` / `runImageGeneration` produce. The settled
// clip URL is a stub: the harness ships no encoder, so nothing here decodes, and
// the spec asserts the state machine and the rendered element, never playback.

import type { UIMessage } from "ai";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

/** How long the stand-in engine "works" for before settling. */
const SETTLE_DELAY_MS = 40;

const VIDEO_MESSAGE_ID = "gen-video-failed";
const IMAGE_MESSAGE_ID = "gen-image-failed";

const VIDEO_PROMPT = "a paper plane crossing a lit server room";
const IMAGE_PROMPT = "a brass key on a slate desk";

/** The real diagnostic ChatPage surfaces when the engine returns nothing. */
const VIDEO_ERROR =
	"The engine returned no video. Load a video model (Wan/LTX) in the sdcpp engine and try again.";

/** Stand-in media. Neither decodes here; both prove the element was rendered. */
const STUB_VIDEO_URL = "data:video/mp4;base64,AAAAHGZ0eXBtcDQy";
const ARRIVED_VIDEO_URL = "data:video/mp4;base64,AAAAHGZ0eXBpc29t";

function generationMessage(
	id: string,
	type: "data-image-generation" | "data-video-generation",
	data: ImageGenerationPartData | VideoGenerationPartData
): UIMessage {
	return {
		id,
		role: "assistant",
		parts: [{ type, data }],
	};
}

function buildTranscript(): UIMessage[] {
	return [
		{
			id: "user-video",
			role: "user",
			parts: [{ type: "text", text: VIDEO_PROMPT }],
		},
		generationMessage(VIDEO_MESSAGE_ID, "data-video-generation", {
			status: "error",
			prompt: VIDEO_PROMPT,
			statusText: VIDEO_ERROR,
		}),
		{
			id: "user-image",
			role: "user",
			parts: [{ type: "text", text: IMAGE_PROMPT }],
		},
		generationMessage(IMAGE_MESSAGE_ID, "data-image-generation", {
			status: "error",
			prompt: IMAGE_PROMPT,
			statusText: "The image engine returned no image.",
		}),
		{
			id: "arrived-clip",
			role: "assistant",
			parts: [{ type: "file", mediaType: "video/mp4", url: ARRIVED_VIDEO_URL }],
		},
	];
}

function Story() {
	const [messages, setMessages] = useState<UIMessage[]>(buildTranscript);
	const [retries, setRetries] = useState(0);

	// The stand-in producer. Mirrors ChatPage: rewrite the SAME assistant message
	// in place — back to the in-flight frame first, then settled — with no second
	// user echo and no new bubble.
	const handleRetryGeneration = useCallback(
		(messageId: string, kind: "image" | "video", prompt: string) => {
			const type =
				kind === "video" ? "data-video-generation" : "data-image-generation";
			const rewrite = (
				data: ImageGenerationPartData | VideoGenerationPartData
			) => {
				setMessages((prev) =>
					prev.map((message) =>
						message.id === messageId
							? {
									...message,
									parts: [{ type, data }],
								}
							: message
					)
				);
			};
			setRetries((count) => count + 1);
			rewrite({ status: "generating", prompt });
			window.setTimeout(() => {
				rewrite({
					status: "complete",
					prompt,
					url: kind === "video" ? STUB_VIDEO_URL : ARRIVED_VIDEO_URL,
				});
			}, SETTLE_DELAY_MS);
		},
		[]
	);

	return (
		<div className="flex h-screen flex-col bg-background">
			<div
				data-retry-count={retries}
				data-testid="story-state"
				data-video-message-id={VIDEO_MESSAGE_ID}
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				<ChatDisplayPrefs>
					<AgentChat
						conversationKey="conv-media-generation"
						currentUser={{ id: "me", name: "You" }}
						messages={messages}
						onRetryGeneration={handleRetryGeneration}
						onSend={() => {
							// The story never sends; the composer is here because the real
							// surface always carries one.
						}}
						onStop={() => {
							// Required by AgentChatProps; nothing streams here.
						}}
						status="ready"
					/>
				</ChatDisplayPrefs>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Story />);
