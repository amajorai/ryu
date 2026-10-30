import {
	ImageGeneration,
	type ImageGenerationStatus,
} from "@ryu/ui/components/motion/image-generation.tsx";
import {
	VideoGeneration,
	type VideoGenerationStatus,
} from "@ryu/ui/components/motion/video-generation.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type React from "react";
import { useCallback, useState } from "react";
import { InlineImagePreview } from "./image-preview.tsx";
import type { MessageListProps } from "./message-list-types.ts";

/** Longest edge, in px, a generated image occupies in the transcript. */
const MAX_IMAGE_EDGE = 360;

export interface ImageGenerationPartData {
	/** The prompt that produced it, shown under the frame. */
	prompt?: string;
	/** Where the generation is: `generating` while Core is working, then
	 *  `complete` (with `url`) or `error` (with `statusText` = the reason). */
	status: ImageGenerationStatus;
	/** Overrides the component's stock status line — used to surface the engine's
	 *  own error text instead of a generic "Generation failed". */
	statusText?: string;
	/** The finished image, once there is one. */
	url?: string;
}

/**
 * The one inline surface for a generated image, in both its pending and its
 * finished state. The frame is square until the image reports its own
 * dimensions, then takes the real aspect ratio — with `object-contain` so a
 * non-square generation (`size: "512x768"`) is never cropped.
 *
 * `showStatus` is off for images that merely *arrive* as `file` parts (pasted,
 * or streamed by Core): those get the same frame, without a status line
 * describing work that never happened here.
 */
export function AssistantGeneratedImage({
	filename,
	onAnnotateImage,
	onRetry,
	prompt,
	showStatus,
	status,
	statusText,
	url,
}: ImageGenerationPartData & {
	filename?: string;
	onAnnotateImage?: MessageListProps["onAnnotateImage"];
	onRetry?: () => void;
	showStatus: boolean;
}) {
	const [size, setSize] = useState<{ height: number; width: number } | null>(
		null
	);

	const handleLoad = useCallback(
		(event: React.SyntheticEvent<HTMLImageElement>) => {
			const { naturalHeight, naturalWidth } = event.currentTarget;
			if (naturalWidth > 0 && naturalHeight > 0) {
				setSize({ height: naturalHeight, width: naturalWidth });
			}
		},
		[]
	);

	// The frame is square until the image reports its own dimensions. A portrait
	// generation then narrows rather than growing tall, so BOTH edges stay within
	// the transcript's 360px budget (the old render capped height the same way).
	const maxWidth =
		size && size.height > size.width
			? Math.round(MAX_IMAGE_EDGE * (size.width / size.height))
			: MAX_IMAGE_EDGE;

	const frameStyle: NativeMessageMediaFrameStyle = {
		"--message-media-max-width": `${maxWidth}px`,
	};

	return (
		<div
			className="w-full max-w-(--message-media-max-width)"
			style={frameStyle}
		>
			<ImageGeneration
				aspectRatio={size ? `${size.width} / ${size.height}` : "1 / 1"}
				mediaClassName="[&>*]:object-contain [&_img]:object-contain"
				onRetry={onRetry}
				prompt={prompt}
				// Only ever the image's real dimensions — nothing is claimed before
				// the engine has actually produced something.
				resolution={size ? `${size.width} × ${size.height}` : undefined}
				showStatus={showStatus}
				size="fluid"
				status={status}
				statusText={statusText}
			>
				{url ? (
					<InlineImagePreview
						alt={prompt ?? "Generated image"}
						filename={filename ?? prompt ?? "Generated image"}
						imageClassName="size-full object-contain"
						onAnnotate={onAnnotateImage}
						onLoad={handleLoad}
						src={url}
					/>
				) : null}
			</ImageGeneration>
		</div>
	);
}

export interface VideoGenerationPartData {
	/** A still to hold the frame while the clip buffers, when the engine gave one. */
	poster?: string;
	/** The prompt that produced it, shown under the frame. */
	prompt?: string;
	/** Where the generation is: `generating` while Core is working, then
	 *  `complete` (with `url`) or `error` (with `statusText` = the reason). */
	status: VideoGenerationStatus;
	/** Overrides the component's stock status line — used to surface the engine's
	 *  own error text instead of a generic "Generation failed". */
	statusText?: string;
	/** The finished clip, once there is one. */
	url?: string;
}

const SECONDS_PER_MINUTE = 60;

/** `4.2` → `"0:04"`. Only ever called with a duration the element reported. */
function formatClipDuration(seconds: number): string {
	const whole = Math.round(seconds);
	const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
	const rest = whole % SECONDS_PER_MINUTE;
	return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * The one inline surface for a generated video, in both its pending and its
 * finished state — the twin of {@link AssistantGeneratedImage}. The frame is
 * 16/9 until the clip reports its own dimensions on `loadedmetadata`, which is
 * also where the duration badge comes from; nothing is claimed before the
 * element has actually measured the media.
 *
 * `showStatus` is off for clips that merely *arrive* as `file` parts, exactly as
 * for images: same frame, no status line describing work that never happened.
 */
export function AssistantGeneratedVideo({
	onRetry,
	poster,
	prompt,
	showStatus,
	status,
	statusText,
	url,
}: VideoGenerationPartData & {
	onRetry?: () => void;
	showStatus: boolean;
}) {
	const safeUrl = safeMediaUrl(url);
	const safePoster = safeMediaUrl(poster);
	const [meta, setMeta] = useState<{
		duration: number;
		height: number;
		width: number;
	} | null>(null);

	const handleLoadedMetadata = useCallback(
		(event: React.SyntheticEvent<HTMLVideoElement>) => {
			const { duration, videoHeight, videoWidth } = event.currentTarget;
			if (videoWidth > 0 && videoHeight > 0) {
				setMeta({
					duration: Number.isFinite(duration) ? duration : 0,
					height: videoHeight,
					width: videoWidth,
				});
			}
		},
		[]
	);

	// Same budget as the image frame: a portrait clip narrows rather than growing
	// tall, so BOTH edges stay within the transcript's 360px allowance.
	const maxWidth =
		meta && meta.height > meta.width
			? Math.round(MAX_IMAGE_EDGE * (meta.width / meta.height))
			: MAX_IMAGE_EDGE;

	const frameStyle: NativeMessageMediaFrameStyle = {
		"--message-media-max-width": `${maxWidth}px`,
	};

	return (
		<div
			className="w-full max-w-(--message-media-max-width)"
			style={frameStyle}
		>
			<VideoGeneration
				aspectRatio={meta ? `${meta.width} / ${meta.height}` : "16 / 9"}
				duration={
					meta && meta.duration > 0
						? formatClipDuration(meta.duration)
						: undefined
				}
				mediaClassName="[&>*]:object-contain [&_video]:object-contain"
				onRetry={onRetry}
				poster={safePoster ?? undefined}
				prompt={prompt}
				showStatus={showStatus}
				size="fluid"
				status={status}
				statusText={statusText}
			>
				{safeUrl ? (
					<video
						aria-label={prompt ?? "Generated video"}
						controls
						onLoadedMetadata={handleLoadedMetadata}
						playsInline
						poster={safePoster ?? undefined}
						preload="metadata"
						src={safeUrl}
					>
						<a href={safeUrl}>Download video</a>
					</video>
				) : null}
			</VideoGeneration>
		</div>
	);
}

/** Measured native image/video geometry supplies only the CSS custom property;
 * the frame class owns max-width. Keep the original rounded pixel calculation. */
interface NativeMessageMediaFrameStyle extends React.CSSProperties {
	"--message-media-max-width": string;
}
