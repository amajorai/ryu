"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { DEFAULT_IMAGE_EDITOR_MODELS } from "@/src/lib/image-editor-models.ts";
import type { ImageEditorController } from "./ImageEditorDialog-interactions.ts";

export function ImageEditorModelSettingsPanel({
	editor,
}: {
	editor: ImageEditorController;
}) {
	const { models, saveModelInput, saveModels, updateModels } = editor;
	return (
		<section
			aria-label="Local image model settings"
			className="absolute top-14 right-3 z-30 grid w-[min(35rem,calc(100vw-1.5rem))] gap-3 rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-xl backdrop-blur-xl sm:right-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
		>
			<label className="grid gap-1.5 text-xs">
				<span>Segmentation engine</span>
				<Input
					aria-label="Segmentation model id"
					autoCapitalize="off"
					autoComplete="off"
					onChange={(event) =>
						saveModelInput("segmentationModelId", event.currentTarget.value)
					}
					spellCheck={false}
					value={models.segmentationModelId}
				/>
			</label>
			<label className="grid gap-1.5 text-xs">
				<span>Background removal engine</span>
				<Input
					aria-label="Background removal model id"
					autoCapitalize="off"
					autoComplete="off"
					onChange={(event) =>
						saveModelInput(
							"backgroundRemovalModelId",
							event.currentTarget.value
						)
					}
					spellCheck={false}
					value={models.backgroundRemovalModelId}
				/>
			</label>
			<div className="flex gap-2">
				<Button
					onClick={() => updateModels(DEFAULT_IMAGE_EDITOR_MODELS)}
					size="sm"
					variant="ghost"
				>
					Defaults
				</Button>
				<Button onClick={saveModels} size="sm" variant="secondary">
					Save models
				</Button>
			</div>
			<p className="text-muted-foreground text-xs sm:col-span-3">
				Models download once and are cached in this browser. Image pixels stay
				local during segmentation and background removal. AI Resize uses the
				image provider configured in Gateway.
			</p>
		</section>
	);
}

export function ImageEditorPaddingPanel({
	editor,
}: {
	editor: ImageEditorController;
}) {
	const { editorReady, expandCanvas, isBusy, paddingInput, setPaddingInput } =
		editor;
	return (
		<section
			aria-label="Transparent padding options"
			className="absolute top-14 left-1/2 z-30 grid w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2 gap-3 rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-xl"
		>
			<h3 className="font-medium text-sm">Add blank padding</h3>
			<label className="grid gap-1 text-xs">
				<span>Transparent padding per side</span>
				<Input
					aria-label="Transparent padding per side"
					disabled={!editorReady || isBusy}
					inputMode="numeric"
					onChange={(event) => setPaddingInput(event.currentTarget.value)}
					type="number"
					value={paddingInput}
				/>
			</label>
			<Button
				aria-label="Apply transparent padding"
				disabled={!editorReady || isBusy}
				onClick={expandCanvas}
				size="sm"
			>
				Add padding
			</Button>
		</section>
	);
}

export function ImageEditorSubjectsPanel({
	editor,
}: {
	editor: ImageEditorController;
}) {
	const tl = useLiteralMessages();
	const {
		eraseSelectedSegment,
		isBusy,
		segments,
		selectedSegment,
		selectedSegmentId,
		setSelectedSegmentId,
	} = editor;
	return (
		<section
			aria-label="Detected subjects"
			className="absolute top-14 left-3 z-20 grid max-h-[min(55dvh,28rem)] w-56 gap-2 overflow-y-auto rounded-xl border bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur-xl sm:left-6"
			role="group"
		>
			<h3 className="font-medium text-xs">Detected subjects</h3>
			{segments.slice(0, 12).map((segment, index) => (
				<Button
					aria-label={tl("Select {subject}", {
						subject:
							segment.label || tl("Subject {number}", { number: index + 1 }),
					})}
					aria-pressed={segment.id === selectedSegmentId}
					className="min-w-0 justify-start"
					key={segment.id}
					onClick={() => setSelectedSegmentId(segment.id)}
					size="sm"
					variant={segment.id === selectedSegmentId ? "secondary" : "ghost"}
				>
					{segment.label || tl("Subject {number}", { number: index + 1 })}
				</Button>
			))}
			<Button
				aria-label="Erase selected subject"
				disabled={!selectedSegment || isBusy}
				onClick={eraseSelectedSegment}
				size="sm"
				variant="outline"
			>
				Erase subject
			</Button>
		</section>
	);
}

export function ImageEditorCommentPanel({
	editor,
}: {
	editor: ImageEditorController;
}) {
	const { commentInput, setCommentInput } = editor;
	return (
		<div className="absolute bottom-3 left-1/2 z-20 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur-xl">
			<label className="grid gap-1.5 text-xs">
				<span>Comment text</span>
				<Textarea
					aria-label="Comment text"
					maxLength={240}
					onChange={(event) => setCommentInput(event.currentTarget.value)}
					placeholder="Write a note, then click the image"
					rows={2}
					value={commentInput}
				/>
			</label>
		</div>
	);
}
