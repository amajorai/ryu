"use client";

// The video sibling of `./image-generation.tsx`.
//
// A stable generated-video surface: the frame is reserved up front, so a turn
// moves from "generating" through to a playable clip without any layout shift.
// While work is in flight a dithered dot field fills the frame; when the media
// lands it fades in over the field and the field unmounts.
//
// The surface body it shares with the image surface lives in
// `./generation-surface.tsx`. Only the video-specific parts live here — its
// status names and copy, a poster frame, a duration badge, and the 16:9 default —
// and the shared body swaps the `<img>` fit for a playable element and leaves
// naming the media to that element.

import css from "./video-generation.module.css";

interface Inline1Style extends CSSProperties {
	"--video-generation-1-aspect-ratio"?: CSSProperties["aspectRatio"];
	"--video-generation-1-background-image"?: CSSProperties["backgroundImage"];
	"--video-generation-1-background-position"?: CSSProperties["backgroundPosition"];
	"--video-generation-1-background-size"?: CSSProperties["backgroundSize"];
}

import type { CSSProperties, ReactNode } from "react";
import {
	type GenerationMediaProps,
	GenerationSurface,
} from "./generation-surface.tsx";

export type VideoGenerationStatus =
	| "queued"
	| "generating"
	| "rendering"
	| "complete"
	| "error";

export interface VideoGenerationProps extends GenerationMediaProps {
	/** The completed media. Pass a video, canvas, or custom preview. */
	children?: ReactNode;
	/** Clip length badge, e.g. `"0:04"`. Omitted ⇒ no badge (see below). */
	duration?: string;
	/** A still shown behind the clip while it buffers, if the engine gave one. */
	poster?: string;
	status?: VideoGenerationStatus;
}

const STATUS_TEXT = {
	queued: "Waiting to generate",
	generating: "Generating video",
	rendering: "Rendering frames",
	complete: "Video ready",
	error: "Generation failed",
} satisfies Record<VideoGenerationStatus, string>;

export function VideoGeneration({
	status = "generating",
	// Same rule as the image surface's `resolution`: a destructuring default
	// fires on an explicit `undefined`, so a caller that doesn't KNOW the clip
	// length could not opt out of the badge — it would stamp a fabricated
	// duration on the video. No value ⇒ no badge (the surface's guard).
	duration,
	poster,
	aspectRatio = "16 / 9",
	statusText,
	...props
}: VideoGenerationProps) {
	const inline1Style: Inline1Style = {
		"--video-generation-1-aspect-ratio": aspectRatio,
		"--video-generation-1-background-image": poster
			? `url("${poster}")`
			: undefined,
		"--video-generation-1-background-position": "center",
		"--video-generation-1-background-size": "cover",
	};
	return (
		<GenerationSurface
			{...props}
			badge={duration}
			frameClassName={css.inline1}
			kind="video"
			phase={status === "rendering" ? "detailing" : status}
			state={status}
			statusText={statusText ?? STATUS_TEXT[status]}
			style={inline1Style}
		/>
	);
}
