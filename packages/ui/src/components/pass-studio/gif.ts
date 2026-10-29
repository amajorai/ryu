/// <reference path="../../types/gifenc.d.ts" />
/**
 * Export one loop as an animated GIF.
 *
 * The MP4 is the file X and Instagram want; the GIF is the one that goes
 * everywhere else — Slack, Discord, GitHub READMEs, iMessage, email — and
 * autoplays in all of them without a click. So it trades fidelity for reach:
 * smaller frame, fewer frames, 256 colours.
 *
 * One palette for the whole loop, not one per frame. A per-frame palette is
 * sharper on any single frame, but the shader gradient behind the card drifts
 * every frame, so per-frame quantisation re-bands it every frame too and the
 * field visibly shimmers. Sampling a handful of frames across the cycle and
 * building one palette from all of them keeps the bands still.
 *
 * Frames are timestamp-driven like the video path, so a slow device takes longer
 * to export but never produces a faster or shorter loop.
 */

/** Short edge of the GIF. 480 keeps a 10-second story loop around 10 MB. */
export const GIF_SHORT_EDGE = 480;
/** GIF frame delays are in centiseconds, so 20fps (5cs) is an exact rate; 24 is not. */
export const GIF_FPS = 20;
/** Frames sampled across the cycle to build the shared palette. */
const PALETTE_SAMPLES = 8;

export interface GifRecording {
	blob: Blob;
	extension: "gif";
	mimeType: "image/gif";
}

/** The GIF's pixel size for a source frame: short edge pinned, ratio kept. */
export function gifSize(
	width: number,
	height: number,
	shortEdge = GIF_SHORT_EDGE
): { height: number; width: number } {
	const scale = Math.min(1, shortEdge / Math.min(width, height));
	return {
		height: Math.max(1, Math.round(height * scale)),
		width: Math.max(1, Math.round(width * scale)),
	};
}

function nextFrame(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Recording aborted", "AbortError"));
			return;
		}
		// A macrotask, not rAF: rAF stalls in a background tab, and encoding a
		// frame is CPU work that should not wait for the next paint anyway.
		setTimeout(resolve, 0);
	});
}

/**
 * Record `canvas` for `seconds` as a looping GIF, driving it with `onFrame`.
 * `onFrame` draws the full-size frame; this downsamples it.
 */
export async function recordCanvasGif(options: {
	canvas: HTMLCanvasElement;
	fps?: number;
	onFrame: (time: number) => void;
	onProgress?: (fraction: number) => void;
	seconds: number;
	shortEdge?: number;
	signal?: AbortSignal;
}): Promise<GifRecording> {
	const { GIFEncoder, applyPalette, quantize } = await import("gifenc");
	const fps = options.fps ?? GIF_FPS;
	const { width, height } = gifSize(
		options.canvas.width,
		options.canvas.height,
		options.shortEdge
	);
	const small = document.createElement("canvas");
	small.width = width;
	small.height = height;
	const context = small.getContext("2d", { willReadFrequently: true });
	if (!context) {
		throw new Error("This browser cannot draw the GIF frames");
	}
	context.imageSmoothingQuality = "high";
	const frameAt = (time: number): Uint8ClampedArray => {
		options.onFrame(time);
		context.clearRect(0, 0, width, height);
		context.drawImage(options.canvas, 0, 0, width, height);
		return context.getImageData(0, 0, width, height).data;
	};

	const frames = Math.max(1, Math.round(options.seconds * fps));
	const step = options.seconds / frames;

	// Palette pass: a strip of evenly spaced frames, quantised together.
	const sample = new Uint8ClampedArray(width * height * 4 * PALETTE_SAMPLES);
	for (let index = 0; index < PALETTE_SAMPLES; index++) {
		await nextFrame(options.signal);
		sample.set(
			frameAt((index / PALETTE_SAMPLES) * options.seconds),
			index * width * height * 4
		);
	}
	const palette = quantize(sample, 256);

	const encoder = GIFEncoder();
	const delay = Math.round(1000 / fps);
	for (let frame = 0; frame < frames; frame++) {
		await nextFrame(options.signal);
		const index = applyPalette(frameAt(frame * step), palette);
		encoder.writeFrame(index, width, height, {
			delay,
			// Palette once, on the first frame; `repeat: 0` loops forever.
			...(frame === 0 ? { palette, repeat: 0 } : {}),
		});
		options.onProgress?.((frame + 1) / frames);
	}
	encoder.finish();
	return {
		blob: new Blob([encoder.bytes()], { type: "image/gif" }),
		extension: "gif",
		mimeType: "image/gif",
	};
}
