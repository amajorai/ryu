import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useCallback } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { generateImage } from "@/src/lib/api/images.ts";

/** Inline image generation (and in-place retry) for the panel's chat. */
export function useAssistantImageGeneration(
	chatTarget: ApiTarget,
	setMessages: UseChatHelpers<UIMessage>["setMessages"]
) {
	// Multimodal (image): generate from the composer text and surface the result
	// inline, mirroring ChatPage's handler exactly so the Ask Ryu dock reads the
	// same. Client-only — `/api/images/generate` is one-shot and not written to the
	// conversation store, so it isn't re-hydrated on reload. A backing engine that
	// isn't available surfaces as an inline error on the same surface (graceful
	// degradation).
	//
	// The generation itself runs against an assistant message that ALREADY
	// exists, so a failed one can be re-run in place (see `handleRetryGeneration`)
	// rather than echoing the prompt a second time — same split as ChatPage.
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
				const urls = await generateImage(chatTarget, prompt);
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
				settle([
					{
						type: "data-image-generation",
						data: { status: "complete", prompt, url: first },
					},
					...rest.map((url): UIMessage["parts"][number] => ({
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
		[chatTarget, setMessages]
	);

	const handleGenerateImage = useCallback(
		async (prompt: string) => {
			const userId = `img-user-${Date.now()}`;
			const assistantId = `img-${Date.now()}`;
			// Echo the prompt as a user bubble, and reserve the image frame in the
			// same tick — the `data-image-generation` part MessageList renders through
			// the ImageGeneration surface. Status goes straight from `generating` to
			// `complete`/`error`: this path has no progress events to report.
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} satisfies (typeof prev)[number],
				{
					id: assistantId,
					role: "assistant",
					parts: [
						{
							type: "data-image-generation",
							data: { status: "generating", prompt },
						},
					],
				} satisfies (typeof prev)[number],
			]);
			await runImageGeneration(assistantId, prompt);
		},
		[runImageGeneration, setMessages]
	);

	// Retry a failed inline generation, in place on the same assistant message.
	// This dock has no video composer action (`onGenerateVideo` is never passed),
	// so only the image kind can reach here; a video part would have to come from
	// somewhere that cannot produce one.
	const handleRetryGeneration = useCallback(
		(messageId: string, kind: "image" | "video", prompt: string) => {
			if (kind !== "image") {
				return;
			}
			void runImageGeneration(messageId, prompt);
		},
		[runImageGeneration]
	);
	return { handleGenerateImage, handleRetryGeneration };
}
