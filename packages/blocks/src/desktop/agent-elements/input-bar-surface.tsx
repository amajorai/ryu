"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion, type Transition } from "motion/react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { FileAttachment } from "./input/file-attachment.tsx";
import styles from "./input-bar.module.css";
import type { InputBarProps } from "./input-bar-types.ts";

export interface ComposerSurfaceProps {
	activeComposerPrompt?: { content: ReactNode; id: string };
	attachedFiles: NonNullable<InputBarProps["attachedFiles"]>;
	attachedImages: NonNullable<InputBarProps["attachedImages"]>;
	composerEditor: ReactNode;
	composerHeader?: ReactNode;
	composerToolbar: ReactNode;
	composerTransition: Transition;
	draftSaveError: string | null;
	enableImagePreview: boolean;
	expanded: boolean;
	ghost?: boolean;
	handleContainerClick: (e: React.MouseEvent) => void;
	imageDisplayMode: "image-only" | "chip";
	isDragOver?: boolean;
	isTyping: boolean;
	liveCall: InputBarProps["liveCall"];
	onAnnotateImage: InputBarProps["onAnnotateImage"];
	onRemoveFile: InputBarProps["onRemoveFile"];
	onRemoveImage: InputBarProps["onRemoveImage"];
	reduceMotion: boolean;
	safeTypingAnimationImage: string | null;
	seamless?: boolean;
	setIsExpanded: Dispatch<SetStateAction<boolean>>;
	shouldRenderToolbar: boolean;
	showContextItems: boolean;
	showImage: boolean;
}

/** The composer card: prompt or input branch, attachments, and toolbar. */
export function ComposerSurface({
	activeComposerPrompt,
	attachedFiles,
	attachedImages,
	composerEditor,
	composerHeader,
	composerToolbar,
	composerTransition,
	draftSaveError,
	enableImagePreview,
	expanded,
	ghost,
	handleContainerClick,
	imageDisplayMode,
	isDragOver,
	isTyping,
	liveCall,
	onAnnotateImage,
	onRemoveFile,
	onRemoveImage,
	reduceMotion,
	safeTypingAnimationImage,
	seamless,
	setIsExpanded,
	shouldRenderToolbar,
	showContextItems,
	showImage,
}: ComposerSurfaceProps) {
	// A composer prompt (pending question, permission request) takes the input
	// branch's place, and with it the toolbar that carries the call controls. The
	// call must stay endable while the prompt is answerable, so the prompt branch
	// keeps a compact call row (status, errors, Mute/Interrupt/End) under it.
	const liveCallPromptRow =
		liveCall && activeComposerPrompt ? (
			<div
				className="flex min-w-0 items-center gap-2 px-2 pt-1.5 pb-2"
				data-slot="composer-live-call-row"
			>
				<div
					className="flex min-h-10 min-w-0 flex-1 items-center"
					data-slot="composer-live-call"
				>
					{liveCall.content}
				</div>
				<div
					className="flex shrink-0 items-center gap-1"
					data-slot="composer-live-call-actions"
				>
					{liveCall.actions}
				</div>
			</div>
		) : null;

	return (
		<motion.div
			className={cn(
				styles.composer,
				seamless
					? "bg-transparent"
					: "rounded-4xl border border-border bg-background shadow-xs dark:bg-card",
				expanded && !seamless && "rounded-2xl",
				isDragOver && "ring-2 ring-primary ring-inset",
				ghost && "bg-muted dark:bg-muted"
			)}
			initial={false}
			layout={!reduceMotion}
			onClick={handleContainerClick}
			transition={composerTransition}
		>
			{expanded && (
				<Button
					aria-label="Collapse composer"
					className="absolute top-2 right-2 z-10"
					onClick={(event) => {
						event.stopPropagation();
						setIsExpanded(false);
					}}
					size="icon-sm"
					title="Collapse composer"
					type="button"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
				</Button>
			)}
			<AnimatePresence initial={false} mode="wait">
				{activeComposerPrompt ? (
					<motion.div
						animate={{ opacity: 1, scale: 1, y: 0 }}
						className="w-full"
						exit={{ opacity: 0, scale: 0.985, y: -6 }}
						initial={reduceMotion ? false : { opacity: 0, scale: 0.985, y: 8 }}
						key={`composer-prompt-${activeComposerPrompt.id}`}
						transition={{ duration: reduceMotion ? 0 : 0.2 }}
					>
						{activeComposerPrompt.content}
						{liveCallPromptRow}
					</motion.div>
				) : (
					<motion.div
						animate={{ opacity: 1, scale: 1, y: 0 }}
						className="w-full"
						exit={{ opacity: 0, scale: 0.985, y: 6 }}
						initial={reduceMotion ? false : { opacity: 0, scale: 0.985, y: -8 }}
						key="composer-input"
						layout={!reduceMotion}
						transition={{ duration: reduceMotion ? 0 : 0.2 }}
					>
						{/* Composer header (e.g. pending quote preview), above the chips. */}
						{composerHeader}
						{liveCall?.header}
						{/* Context items (attached images/files) */}
						<div
							className={cn(
								styles.attachments,
								showContextItems && styles.attachmentsOpen
							)}
						>
							<div className="overflow-hidden">
								{showContextItems && (
									<div
										className="flex flex-wrap items-center gap-2 px-2 pt-2"
										data-slot="composer-attachments"
									>
										{attachedImages.map((img) => (
											<FileAttachment
												display={imageDisplayMode}
												enableImagePreview={enableImagePreview}
												filename={img.filename}
												id={img.id}
												isImage
												key={img.id}
												onAnnotate={onAnnotateImage}
												onRemove={
													onRemoveImage
														? () => onRemoveImage(img.id)
														: undefined
												}
												size={img.size}
												url={img.url}
											/>
										))}
										{attachedFiles.map((file) => (
											<FileAttachment
												filename={file.filename}
												id={file.id}
												key={file.id}
												onRemove={
													onRemoveFile ? () => onRemoveFile(file.id) : undefined
												}
												size={file.size}
											/>
										))}
									</div>
								)}
							</div>
						</div>

						{/* Typing animation image */}
						{isTyping && safeTypingAnimationImage && showImage && (
							<div className="flex flex-wrap gap-2 px-3 pt-3">
								<div className="relative size-16 shrink-0 overflow-hidden rounded-lg">
									{}
									<img
										alt=""
										className="h-full w-full object-cover"
										src={safeTypingAnimationImage}
									/>
								</div>
							</div>
						)}

						{shouldRenderToolbar ? composerToolbar : composerEditor}
						{draftSaveError && (
							<p
								className="px-3 pb-2 text-detail text-status-destructive"
								role="alert"
							>
								{draftSaveError}
							</p>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
