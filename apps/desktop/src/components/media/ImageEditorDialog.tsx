"use client";

import "./ImageEditorDialog.css";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createBrowserLocalImageRuntime } from "@ryu/browser-local-ai";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { OverflowActions } from "@ryu/ui/components/overflow-actions.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { buildImageEditorActions } from "./ImageEditorDialog-actions.tsx";
import { messageForStatus } from "./ImageEditorDialog-canvas.ts";
import { useImageEditorInteractions } from "./ImageEditorDialog-interactions.ts";
import { useImageEditorOperations } from "./ImageEditorDialog-operations.ts";
import {
	ImageEditorCommentPanel,
	ImageEditorModelSettingsPanel,
	ImageEditorPaddingPanel,
	ImageEditorSubjectsPanel,
} from "./ImageEditorDialog-panels.tsx";
import { ImageEditorResizePanel } from "./ImageEditorDialog-resize-panel.tsx";
import { useImageEditorState } from "./ImageEditorDialog-state.ts";
import {
	IMAGE_EDITOR_OPERATION_LABELS,
	type ImageEditorDialogProps,
} from "./ImageEditorDialog-types.ts";

export type {
	ImageEditorAsset,
	ImageEditorDialogProps,
} from "./ImageEditorDialog-types.ts";

const localImageRuntime = createBrowserLocalImageRuntime();

export function ImageEditorDialog({
	image,
	onAiResize,
	onClose,
	onOpenDrawesome,
	onUseInChat,
	open,
	runtime = localImageRuntime,
}: ImageEditorDialogProps) {
	const state = useImageEditorState({ image, open, runtime });
	const operations = useImageEditorOperations(state, {
		onAiResize,
		onClose,
		runtime,
	});
	const interactions = useImageEditorInteractions(state, {
		closeEditor: operations.closeEditor,
		image,
		onUseInChat,
	});
	const editor = { ...state, ...operations, ...interactions };
	const {
		addEditedImageToChat,
		closeEditor,
		dimensions,
		downloadImage,
		editorNotice,
		editorReady,
		engineStatus,
		error,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		imageCanvasRef,
		imageLoading,
		isBusy,
		modelSettingsOpen,
		operation,
		paddingPanelOpen,
		pointerPointsRef,
		pointerToolRef,
		resizePanelOpen,
		segments,
		setPointerPreview,
		tool,
	} = editor;

	if (!image) {
		return null;
	}

	const statusMessage = messageForStatus(engineStatus);
	const busyLabel = operation
		? IMAGE_EDITOR_OPERATION_LABELS[operation.kind]
		: null;
	const { overflowActions, primaryActions } = buildImageEditorActions(editor, {
		image,
		onOpenDrawesome,
	});

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					closeEditor();
				}
			}}
			open={open}
		>
			<DialogContent
				appearance="image-editor"
				mobileFullPage
				showCloseButton={false}
			>
				<DialogHeader className="sr-only">
					<DialogTitle>Edit image</DialogTitle>
					<DialogDescription>
						Select a subject, edit the image, or use AI Resize to expand its
						canvas.
					</DialogDescription>
				</DialogHeader>
				<div className="relative flex h-full min-h-0 flex-col bg-background">
					<header className="z-30 flex h-12 shrink-0 items-center justify-between gap-4 border-b bg-background/90 px-4 backdrop-blur-xl sm:px-6">
						<div className="min-w-0">
							<h2
								className="truncate font-medium text-sm"
								title={image.filename}
							>
								{image.filename?.trim() || "Untitled image"}
							</h2>
						</div>
						<Button
							aria-label="Close image editor"
							onClick={closeEditor}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon icon={Cancel01Icon} size={16} />
						</Button>
					</header>

					{modelSettingsOpen && (
						<ImageEditorModelSettingsPanel editor={editor} />
					)}

					<main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background">
						<div
							className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center overflow-hidden p-2 sm:p-6"
							data-image-editor-grid=""
						>
							{imageLoading && (
								<div className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
									Loading image…
								</div>
							)}
							{dimensions && (
								<canvas
									aria-label="Image editor canvas"
									className={cn(
										"h-auto max-h-full w-full max-w-full touch-none rounded-md shadow-xl outline-none",
										tool === "select" && "cursor-crosshair",
										tool === "markup" && "cursor-crosshair",
										tool === "comment" && "cursor-copy",
										tool === "erase" && "cursor-cell"
									)}
									data-testid="image-editor-canvas"
									height={dimensions.height}
									onPointerCancel={() => {
										pointerToolRef.current = null;
										pointerPointsRef.current = [];
										setPointerPreview([]);
									}}
									onPointerDown={handlePointerDown}
									onPointerMove={handlePointerMove}
									onPointerUp={handlePointerUp}
									ref={imageCanvasRef}
									width={dimensions.width}
								/>
							)}
						</div>

						<nav
							aria-label="Image editing actions"
							className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-2"
						>
							<div className="pointer-events-auto max-w-full">
								<OverflowActions
									className="max-w-full"
									classNames={{
										label: "hidden sm:inline",
										track: "max-w-[calc(100vw-1rem)]",
									}}
									collapseOnAction
									overflowActions={overflowActions}
									primaryActions={primaryActions}
									size="sm"
								/>
							</div>
						</nav>

						{resizePanelOpen && (
							<ImageEditorResizePanel editor={editor} onAiResize={onAiResize} />
						)}

						{paddingPanelOpen && <ImageEditorPaddingPanel editor={editor} />}

						{segments.length > 0 &&
							tool === "select" &&
							!(resizePanelOpen || paddingPanelOpen || modelSettingsOpen) && (
								<ImageEditorSubjectsPanel editor={editor} />
							)}

						{tool === "comment" && <ImageEditorCommentPanel editor={editor} />}
					</main>

					<footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-6">
						<div className="min-w-0 text-xs">
							{imageLoading ? (
								<span role="status">Loading image…</span>
							) : dimensions ? (
								<span className="text-muted-foreground">
									{dimensions.width.toLocaleString()} ×{" "}
									{dimensions.height.toLocaleString()} px
								</span>
							) : (
								<span className="text-muted-foreground">Image unavailable</span>
							)}
							{busyLabel && (
								<span className="ml-3 text-muted-foreground" role="status">
									{busyLabel}
								</span>
							)}
							{editorNotice && !busyLabel && (
								<span className="ml-3 text-muted-foreground" role="status">
									{editorNotice}
								</span>
							)}
							{statusMessage && !busyLabel && !editorNotice && (
								<span className="ml-3 text-muted-foreground" role="status">
									{statusMessage}
								</span>
							)}
						</div>
						<div className="flex shrink-0 gap-2">
							{error && (
								<p
									className="max-w-sm self-center text-destructive text-xs"
									role="alert"
								>
									{error}
								</p>
							)}
							<Button
								aria-label="Download edited PNG"
								disabled={!editorReady || isBusy}
								onClick={() => void downloadImage()}
								size="sm"
								variant="outline"
							>
								Download PNG
							</Button>
							{onUseInChat && (
								<Button
									aria-label="Add edited image to chat"
									disabled={!editorReady || isBusy}
									onClick={() => void addEditedImageToChat()}
									size="sm"
								>
									Add to chat
								</Button>
							)}
						</div>
					</footer>
				</div>
			</DialogContent>
		</Dialog>
	);
}
