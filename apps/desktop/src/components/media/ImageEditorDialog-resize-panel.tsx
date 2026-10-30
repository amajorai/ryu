"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { IMAGE_RESIZE_PRESETS } from "@/src/lib/api/image-resize.ts";
import type { ImageResizeRequest } from "@/src/lib/api/images.ts";
import type { ImageEditorController } from "./ImageEditorDialog-interactions.ts";
import { IMAGE_RESIZE_PRESET_ICONS } from "./ImageEditorDialog-types.ts";

export function ImageEditorResizePanel({
	editor,
	onAiResize,
}: {
	editor: ImageEditorController;
	onAiResize?: (request: ImageResizeRequest) => Promise<Blob>;
}) {
	const tl = useLiteralMessages();
	const {
		editorReady,
		isBusy,
		resizeAspect,
		resizeEngine,
		resizeInstructions,
		resizePresetOptions,
		runAiResize,
		setResizeAspect,
		setResizeEngine,
		setResizeInstructions,
	} = editor;
	return (
		<section
			aria-label="AI resize options"
			className="absolute top-14 left-1/2 z-30 grid w-[min(30rem,calc(100vw-1.5rem))] -translate-x-1/2 gap-3 rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-xl"
		>
			<div>
				<h3 className="font-medium text-sm">Resize with AI</h3>
				<p className="mt-1 text-muted-foreground text-xs">
					Choose a new frame. AI fills the added space without stretching the
					image.
				</p>
			</div>
			<div
				aria-label="Image resize engine"
				className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
				role="group"
			>
				<Button
					aria-pressed={resizeEngine === "local"}
					className="justify-center"
					onClick={() => setResizeEngine("local")}
					size="sm"
					variant={resizeEngine === "local" ? "outline" : "ghost"}
				>
					On this device
				</Button>
				<Button
					aria-pressed={resizeEngine === "gateway"}
					className="justify-center"
					onClick={() => setResizeEngine("gateway")}
					size="sm"
					variant={resizeEngine === "gateway" ? "outline" : "ghost"}
				>
					Gateway model
				</Button>
			</div>
			<ToggleGroup
				aria-label="Target aspect ratio and output size"
				className="grid w-full grid-cols-3"
				onValueChange={(values) => {
					const selectedPreset = IMAGE_RESIZE_PRESETS.find(
						(preset) => preset.id === values[0]
					);
					if (selectedPreset) {
						setResizeAspect(selectedPreset.id);
					}
				}}
				spacing={1.5}
				value={[resizeAspect]}
				variant="outline"
			>
				{resizePresetOptions.map(
					({ aspectLabel, dimensions: target, preset }) => (
						<ToggleGroupItem
							aria-label={tl(
								"Resize to {label}, {aspectLabel}, {width} by {height} pixels",
								{
									aspectLabel,
									height: String(target.height),
									label: preset.label,
									width: String(target.width),
								}
							)}
							density="resize-preset"
							key={preset.id}
							size="sm"
							value={preset.id}
						>
							<HugeiconsIcon
								aria-hidden="true"
								icon={IMAGE_RESIZE_PRESET_ICONS[preset.id]}
								size={16}
							/>
							<span className="font-medium text-xs leading-4">
								{preset.label}
							</span>
							<span className="type-compact text-muted-foreground tabular-nums leading-3">
								{aspectLabel} · {target.width.toLocaleString()} ×{" "}
								{target.height.toLocaleString()} px
							</span>
						</ToggleGroupItem>
					)
				)}
			</ToggleGroup>
			<label className="grid gap-1.5 text-xs">
				<span>Optional guidance</span>
				<Textarea
					aria-label="AI resize guidance"
					maxLength={280}
					onChange={(event) => setResizeInstructions(event.currentTarget.value)}
					placeholder="Continue the sky, keep the subject centered…"
					rows={2}
					value={resizeInstructions}
				/>
			</label>
			<p className="text-muted-foreground text-xs">
				{resizeEngine === "local"
					? "Uses your current local diffusion model; switch models in Store → Models. Your image stays on this device."
					: "Sends this image to the image model configured in Gateway; provider data policies and charges apply."}
			</p>
			<Button
				aria-label="Generate AI resize"
				disabled={!editorReady || isBusy || !onAiResize}
				onClick={() => void runAiResize()}
				size="sm"
			>
				AI Resize
			</Button>
		</section>
	);
}
