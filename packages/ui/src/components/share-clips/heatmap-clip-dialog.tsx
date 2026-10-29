"use client";

import { Download04Icon, Gif01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "../button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../dialog.tsx";
import {
	PASS_FORMATS,
	type PassFormat,
	type PassFormatId,
	passFormat,
} from "../pass-studio/formats.ts";
import { recordCanvasGif } from "../pass-studio/gif.ts";
import { downloadBlob, recordCanvasLoop } from "../pass-studio/record.ts";
import { toast } from "../sileo.tsx";
import {
	buildHeatmapCells,
	drawHeatmapFrame,
	HEATMAP_CLIP_FPS,
	HEATMAP_CLIP_HOLD_TIME,
	HEATMAP_CLIP_PALETTES,
	HEATMAP_CLIP_SECONDS,
	type HeatmapClipData,
} from "./heatmap-clip.ts";

// Preview-then-download for the contributions-heatmap clip. The abort and
// progress handling is the pass share dialog's
// (`@ryu/blocks/web/pass-share-dialog.tsx`): closing the dialog aborts an
// in-flight export so it never drops a file after the member walked away.
//
// One canvas, at the export's full size, is both the preview and the encoder's
// source, so the file is the frame that was previewed.

const PERCENT = 100;
/** The ratios this scene is laid out for: a feed square, a story, a wide post. */
const CLIP_FORMAT_IDS: readonly PassFormatId[] = [
	"square",
	"portrait",
	"landscape",
];
const CLIP_FORMATS: readonly PassFormat[] = PASS_FORMATS.filter((format) =>
	CLIP_FORMAT_IDS.includes(format.id)
);
const DEFAULT_CLIP_FORMAT_ID: PassFormatId = "square";

type ExportKind = "gif" | "video";

export interface HeatmapClipDialogProps {
	data: HeatmapClipData;
	/** `ryu-activity` → `ryu-activity-1x1.mp4`. */
	filenameStem?: string;
	/** Dark or light scene. Defaults to dark, which reads best in a feed. */
	isDark?: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Where a finished file goes. Defaults to an anchor download, the save path
	 * the web app and the desktop webview already use for exports.
	 */
	onSaveFile?: (blob: Blob, filename: string) => void | Promise<void>;
	open: boolean;
}

function readFontFamily(element: HTMLElement): string {
	return getComputedStyle(element).fontFamily || "system-ui, sans-serif";
}

export function HeatmapClipDialog({
	data,
	filenameStem = "ryu-activity",
	isDark = true,
	onOpenChange,
	onSaveFile = downloadBlob,
	open,
}: HeatmapClipDialogProps) {
	const tl = useLiteralMessages();
	const reduceMotion = Boolean(useReducedMotion());
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const [formatId, setFormatId] = useState<PassFormatId>(
		DEFAULT_CLIP_FORMAT_ID
	);
	const [busy, setBusy] = useState<ExportKind | null>(null);
	const [progress, setProgress] = useState(0);
	const recordingRef = useRef<AbortController | null>(null);
	// The data is read through a ref so a parent re-render (a fresh object with
	// the same numbers) does not restart the preview loop from frame 0.
	const dataRef = useRef(data);
	dataRef.current = data;

	const format = passFormat(formatId);
	const palette = isDark
		? HEATMAP_CLIP_PALETTES.dark
		: HEATMAP_CLIP_PALETTES.light;

	const drawAt = (target: HTMLCanvasElement, time: number) => {
		const context = target.getContext("2d");
		if (!context) {
			return;
		}
		const current = dataRef.current;
		drawHeatmapFrame(
			context,
			current,
			time,
			{ height: target.height, width: target.width },
			palette,
			{
				cells: buildHeatmapCells(current.days, current.endDay),
				fontFamily: readFontFamily(target),
			}
		);
	};

	// Live preview: loop the scene while the dialog is open and idle. Reduced
	// motion holds the finished frame instead; the exported file still animates.
	useEffect(() => {
		if (!(open && canvas) || busy) {
			return;
		}
		if (reduceMotion) {
			drawAt(canvas, HEATMAP_CLIP_HOLD_TIME);
			return;
		}
		let raf = 0;
		let start = 0;
		const tick = (now: number) => {
			if (start === 0) {
				start = now;
			}
			drawAt(canvas, ((now - start) / 1000) % HEATMAP_CLIP_SECONDS);
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [open, canvas, busy, reduceMotion, format.width, format.height, isDark]);

	const filename = (extension: string) =>
		`${filenameStem}-${format.ratio.replace(":", "x")}.${extension}`;

	const exportClip = async (kind: ExportKind) => {
		if (!canvas) {
			return;
		}
		setBusy(kind);
		setProgress(0);
		const controller = new AbortController();
		recordingRef.current = controller;
		const onProgress = (fraction: number) => {
			if (!controller.signal.aborted) {
				setProgress(fraction);
			}
		};
		const options = {
			canvas,
			onFrame: (time: number) => drawAt(canvas, time),
			onProgress,
			seconds: HEATMAP_CLIP_SECONDS,
			signal: controller.signal,
		};
		try {
			const recording =
				kind === "gif"
					? await recordCanvasGif(options)
					: await recordCanvasLoop({ ...options, fps: HEATMAP_CLIP_FPS });
			if (controller.signal.aborted) {
				return;
			}
			await onSaveFile(recording.blob, filename(recording.extension));
			if (recording.extension === "webm") {
				toast.info("Saved as WebM", {
					description:
						"This browser can't record MP4, so the video was saved as WebM. Some networks only accept MP4.",
				});
			}
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			const backgrounded = String(error).includes("background");
			toast.error(
				backgrounded
					? "Recording stopped — the window went to the background"
					: kind === "gif"
						? "Couldn't make the GIF"
						: "Couldn't record the video",
				{
					description:
						"Keep this window in the foreground until the file is ready.",
				}
			);
		} finally {
			if (recordingRef.current === controller) {
				recordingRef.current = null;
				setBusy(null);
				setProgress(0);
			}
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (!next) {
			recordingRef.current?.abort();
			recordingRef.current = null;
			setBusy(null);
			setProgress(0);
			setFormatId(DEFAULT_CLIP_FORMAT_ID);
		}
		onOpenChange(next);
	};

	const label = (kind: ExportKind, idle: string) =>
		busy === kind ? `Exporting ${Math.round(progress * PERCENT)}%` : idle;

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Share your activity</DialogTitle>
					<DialogDescription>
						Your last 12 months of daily usage filling in day by day, as a
						looping video or GIF.
					</DialogDescription>
				</DialogHeader>

				<fieldset className="flex flex-wrap justify-center gap-1.5">
					<legend className="sr-only">Format</legend>
					{CLIP_FORMATS.map((option) => (
						<button
							aria-pressed={option.id === formatId}
							className={cn(
								"rounded-full border px-3 py-1 font-medium text-xs transition-colors",
								option.id === formatId
									? "border-transparent bg-foreground text-background"
									: "border-border text-muted-foreground hover:text-foreground"
							)}
							disabled={busy !== null}
							key={option.id}
							onClick={() => setFormatId(option.id)}
							title={option.label}
							type="button"
						>
							{option.ratio}
						</button>
					))}
				</fieldset>

				<div className="flex justify-center">
					<canvas
						aria-label="Preview of your activity clip"
						className="h-auto max-h-[50vh] w-auto max-w-full rounded-lg border border-border"
						height={format.height}
						key={format.id}
						ref={setCanvas}
						role="img"
						width={format.width}
					/>
				</div>
				<p className="text-center text-muted-foreground text-xs">
					{tl(
						"{ratio} · {label} · an {seconds}-second loop, recorded here. Keep this window in the foreground while it renders.",
						{
							label: format.label,
							ratio: format.ratio,
							seconds: String(HEATMAP_CLIP_SECONDS),
						}
					)}
				</p>

				<DialogFooter>
					<Button
						className="w-full sm:w-auto"
						disabled={busy !== null || !canvas}
						onClick={() => exportClip("gif")}
						size="lg"
						type="button"
						variant="secondary"
					>
						<HugeiconsIcon icon={Gif01Icon} size={18} />
						{label("gif", "Download GIF")}
					</Button>
					<Button
						className="w-full sm:w-auto"
						disabled={busy !== null || !canvas}
						onClick={() => exportClip("video")}
						size="lg"
						type="button"
					>
						<HugeiconsIcon icon={Download04Icon} size={18} />
						{label("video", "Download video")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
