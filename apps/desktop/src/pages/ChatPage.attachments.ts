import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef } from "react";
import type { DrawesomeSketchAttachment } from "@/src/components/chat/DrawesomeSketchDialog.tsx";
import { CHAT_REFERENCE_DRAG_MIME } from "@/src/components/layout/tabDnd.tsx";
import type { ImageEditorAsset } from "@/src/components/media/ImageEditorDialog.tsx";
import { fetchEditableImage } from "@/src/components/media/image-editor-utils.ts";
import {
	generateImageResize,
	type ImageResizeRequest,
} from "@/src/lib/api/images.ts";
import { fileToDataUrl } from "@/src/lib/api/uploads.ts";
import { readDraggedChatReference } from "@/src/lib/chat-reference-drag.ts";
import {
	IMAGE_AND_TEXT_ACCEPT,
	stageImageAndTextFiles,
	textToDataUrl,
} from "@/src/lib/composer/attachments.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPresence } from "./ChatPage.presence.ts";

export type UseChatAttachmentsInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPresence>;

/** Image attachments, paste, and drag and drop. */
export function useChatAttachments({
	chatTarget,
	setAttachedImages,
	setImageEditorAsset,
	chatTargetRef,
	drawesomeCompanion,
	setDrawesomeSourceImage,
	setDrawesomeDialogOpen,
	setIsDragOver,
	isActiveTabRef,
	setConvId,
	setActiveConversationId,
	setDiffConvId,
}: UseChatAttachmentsInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	/** Keep very large pastes out of the prompt body and make them inspectable files. */
	const LONG_PASTE_THRESHOLD = 10_000;

	const addImages = useCallback(
		(files: File[]) => {
			const unsupported = stageImageAndTextFiles(
				chatTarget,
				files,
				(item) => setAttachedImages((prev) => [...prev, item]),
				(message) =>
					toast.error("Could not attach file", { description: message })
			);
			if (unsupported.length > 0) {
				toast.error("Can't attach these files yet", {
					description: tlRef.current(
						"{files} — images and text files are supported.",
						{ files: unsupported.join(", ") }
					),
				});
			}
		},
		[chatTarget]
	);

	const handleAttach = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = IMAGE_AND_TEXT_ACCEPT;
		input.multiple = true;
		input.onchange = () => {
			if (input.files) {
				addImages(Array.from(input.files));
			}
		};
		input.click();
	}, [addImages]);

	const handleRemoveImage = useCallback((id: string) => {
		setAttachedImages((prev) => prev.filter((img) => img.id !== id));
	}, []);

	const handleOpenImageEditor = useCallback((image: ImageEditorAsset) => {
		setImageEditorAsset(image);
	}, []);

	const handleAiResize = useCallback(async (request: ImageResizeRequest) => {
		const resultUrl = await generateImageResize(chatTargetRef.current, request);
		return fetchEditableImage(resultUrl, request.signal);
	}, []);

	const handleOpenDrawesome = useCallback(() => {
		if (drawesomeCompanion) {
			setDrawesomeSourceImage(null);
			setDrawesomeDialogOpen(true);
		}
	}, [drawesomeCompanion]);

	const handleAnnotateImage = useCallback(
		async (image: { filename?: string; id: string; url: string }) => {
			if (!drawesomeCompanion) {
				return;
			}
			const filename = image.filename?.trim() || "image.png";
			try {
				let dataUrl = image.url;
				if (!dataUrl.startsWith("data:")) {
					const response = await fetch(dataUrl, {
						credentials: "same-origin",
					});
					if (!response.ok) {
						throw new Error(`Image request failed (${response.status})`);
					}
					const blob = await response.blob();
					dataUrl = await fileToDataUrl(
						new File([blob], filename, {
							type: blob.type || "image/png",
						})
					);
				}
				setDrawesomeSourceImage({ filename, url: dataUrl });
				setDrawesomeDialogOpen(true);
			} catch {
				toast.error("Could not open this image for annotation", {
					description: "The image could not be read by Drawesome.",
				});
			}
		},
		[drawesomeCompanion]
	);

	const handleDrawesomeDialogOpenChange = useCallback((open: boolean) => {
		setDrawesomeDialogOpen(open);
		if (!open) {
			setDrawesomeSourceImage(null);
		}
	}, []);

	const handleAttachSketch = useCallback(
		(attachment: DrawesomeSketchAttachment) => {
			setAttachedImages((previous) => [
				...previous,
				{
					id: `sketch-${Date.now()}`,
					filename: attachment.filename,
					url: attachment.dataUrl,
					mimeType: attachment.mimeType,
					size: attachment.size,
				},
			]);
			toast.success("Sketch attached", {
				description: "It will be included with your next message in this chat.",
			});
		},
		[]
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const pastedText = e.clipboardData.getData("text/plain");
			if (pastedText.length >= LONG_PASTE_THRESHOLD) {
				e.preventDefault();
				setAttachedImages((prev) => [
					...prev,
					{
						id: `paste-${Date.now()}-${prev.length}`,
						filename: "pasted-text.txt",
						url: textToDataUrl(pastedText),
						mimeType: "text/plain",
						size: new TextEncoder().encode(pastedText).byteLength,
					},
				]);
				return;
			}
			const files = Array.from(e.clipboardData.files);
			addImages(files);
		},
		[addImages]
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer.types.includes(CHAT_REFERENCE_DRAG_MIME)) {
			e.dataTransfer.dropEffect = "copy";
			return;
		}
		setIsDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		if (
			!e.currentTarget.contains(
				/* SAFETY: React dispatches the native DOM dragleave event here; its relatedTarget is the previous DOM node or null, which contains accepts. */ e.relatedTarget as Node
			)
		) {
			setIsDragOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			const chat = readDraggedChatReference(e.dataTransfer);
			if (chat) {
				window.dispatchEvent(
					new CustomEvent("ryu:chat-reference-drop", { detail: chat })
				);
				return;
			}
			const files = Array.from(e.dataTransfer.files);
			addImages(files);
		},
		[addImages]
	);

	// When the user clicks a run-completion OS notification, navigate to that
	// run's review pane. The event is dispatched by useRuns in the hook after
	// the Notification's onclick fires (see useRuns.ts).
	useEffect(() => {
		const handler = (e: Event) => {
			// Only the focused tab navigates, so one notification click doesn't
			// hijack every mounted chat tab.
			if (!isActiveTabRef.current) {
				return;
			}
			const { runId } =
				/* SAFETY: run-store.ts notification onclick dispatches this exact native CustomEvent with detail { runId: run.id }; the run owner supplies its complete string id. */ (
					e as CustomEvent<{ runId: string }>
				).detail;
			if (runId) {
				setConvId(runId);
				setActiveConversationId(runId);
				setDiffConvId(runId);
			}
		};
		window.addEventListener("ryu:run-notification-click", handler);
		return () =>
			window.removeEventListener("ryu:run-notification-click", handler);
	}, [setActiveConversationId]);
	return {
		addImages,
		handleAttach,
		handleRemoveImage,
		handleOpenImageEditor,
		handleAiResize,
		handleOpenDrawesome,
		handleAnnotateImage,
		handleDrawesomeDialogOpenChange,
		handleAttachSketch,
		handlePaste,
		handleDragOver,
		handleDragLeave,
		handleDrop,
	} as const;
}
