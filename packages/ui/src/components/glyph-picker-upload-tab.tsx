"use client";

import { Slider } from "@ryu/ui/components/slider.tsx";
import { TabsContent } from "@ryu/ui/components/tabs.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ImagePlus } from "lucide-react";
import type { RefObject } from "react";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import styles from "./glyph-picker.module.css";
import {
	type GlyphPickerDrawingStyle,
	MAX_ZOOM,
} from "./glyph-picker-constants.ts";
import type { GlyphPickerState } from "./glyph-picker-state.ts";

export function GlyphPickerUploadTab({
	state,
	fileInputRef,
}: {
	state: GlyphPickerState;
	fileInputRef: RefObject<HTMLInputElement | null>;
}) {
	const { previewUrl, rendered, setRendered, zoom, setZoom } = state;
	const guideSide = rendered
		? Math.min(rendered.width, rendered.height) / zoom
		: 0;

	const guideSizeStyle: GlyphPickerDrawingStyle = {
		"--glyph-picker-square-size": `${guideSide}px`,
	};
	return (
		<TabsContent className="pt-3" value="avatar">
			{previewUrl ? (
				<div className="space-y-4">
					<div className="flex h-64 items-center justify-center overflow-hidden rounded-lg bg-muted/30">
						<div className="relative inline-flex">
							{}
							{}
							{}
							<img
								alt="Crop preview"
								className="block max-h-64 max-w-full object-contain"
								onLoad={(e) => {
									const img = e.currentTarget;
									setRendered({
										width: img.clientWidth,
										height: img.clientHeight,
									});
								}}
								src={safeMediaUrl(previewUrl) ?? undefined}
							/>
							{guideSide > 0 ? (
								<div
									className={cn(
										"pointer-events-none absolute rounded-full border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]",
										styles.cropGuidePosition,
										styles.square
									)}
									style={guideSizeStyle}
								/>
							) : null}
						</div>
					</div>
					<div className="flex items-center gap-4">
						<span className="text-muted-foreground text-xs">Zoom</span>
						<Slider
							aria-label="Zoom"
							max={MAX_ZOOM}
							min={1}
							onValueChange={(v) => {
								const next = Array.isArray(v) ? v[0] : v;
								if (isNativeNumber(next)) {
									setZoom(next);
								}
							}}
							step={0.1}
							value={[zoom]}
						/>
					</div>
				</div>
			) : (
				<button
					className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => fileInputRef.current?.click()}
					type="button"
				>
					<ImagePlus className="size-6" />
					<span>Choose an image to crop</span>
				</button>
			)}
		</TabsContent>
	);
}
