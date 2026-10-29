"use client";

// beui.dev/components/agents/image-generation
//
// A stable generated-image surface: the frame is reserved up front, so a turn
// moves from "generating" through to a finished image without any layout shift.
// While work is in flight a dithered dot field fills the frame; when the media
// lands it fades in over the field and the field unmounts.
//
// Vendored (not installed) so the imports point at this repo's own motion
// primitives, exactly like its neighbours in this directory. The surface body
// it shares with `./video-generation.tsx` lives in `./generation-surface.tsx`;
// this file keeps the image-specific parts: its status names and copy, the
// resolution badge, and the reserved aspect ratio.

import css from "./image-generation.module.css";

interface Inline1Style extends CSSProperties {
	"--image-generation-1-aspect-ratio"?: CSSProperties["aspectRatio"];
}

import type { CSSProperties, ReactNode } from "react";
import {
	type GenerationMediaProps,
	GenerationSurface,
} from "./generation-surface.tsx";

export type ImageGenerationStatus =
	| "queued"
	| "generating"
	| "refining"
	| "complete"
	| "error";

export interface ImageGenerationProps extends GenerationMediaProps {
	/** The completed media. Pass an img, canvas, video, or custom preview. */
	children?: ReactNode;
	resolution?: string;
	status?: ImageGenerationStatus;
}

const STATUS_TEXT = {
	queued: "Waiting to generate",
	generating: "Generating image",
	refining: "Refining details",
	complete: "Image ready",
	error: "Generation failed",
} satisfies Record<ImageGenerationStatus, string>;

export function ImageGeneration({
	status = "generating",
	// Upstream defaults this to the string "1024 × 1024". Dropped: a destructuring
	// default fires on an explicit `undefined`, so a caller that doesn't KNOW the
	// output size cannot opt out of the badge — it would stamp fabricated
	// dimensions on the image. No value ⇒ no badge (the surface's guard).
	resolution,
	aspectRatio = "1 / 1",
	statusText,
	...props
}: ImageGenerationProps) {
	const inline1Style: Inline1Style = {
		"--image-generation-1-aspect-ratio": aspectRatio,
	};
	return (
		<GenerationSurface
			{...props}
			badge={resolution}
			frameClassName={css.inline1}
			kind="image"
			phase={status === "refining" ? "detailing" : status}
			state={status}
			statusText={statusText ?? STATUS_TEXT[status]}
			style={inline1Style}
		/>
	);
}
