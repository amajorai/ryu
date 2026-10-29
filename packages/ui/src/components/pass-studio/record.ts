/**
 * Export one complete drawing cycle. Timestamped WebCodecs frames preserve the
 * intended media duration even when rendering or encoding is slower than real
 * time. Browsers without a supported frame encoder retain canvas MediaRecorder.
 */

/**
 * The codec ladder, best first.
 *
 * MP4/H.264 first because it is the only container X, LinkedIn and Instagram
 * all ingest without re-encoding. Chrome has recorded it since 126 and Safari
 * has for longer; Firefox has neither, and falls through to WebM — which is why
 * the produced type is REPORTED back to the caller rather than assumed. A file
 * named `.mp4` that is really VP9 in a WebM container fails at the upload, long
 * after the user has left the page that made it.
 */
const CODEC_LADDER = [
	{ extension: "mp4", mimeType: "video/mp4;codecs=avc1.42E01E" },
	{ extension: "mp4", mimeType: "video/mp4" },
	{ extension: "webm", mimeType: "video/webm;codecs=vp9" },
	{ extension: "webm", mimeType: "video/webm" },
] as const;

/**
 * ~20 Mbit at 1080p60. The default the recorder picks is tuned for camera video
 * and bands badly across a shader gradient, which is most of this frame — and a
 * gradient is exactly what banding shows up on. Raised with the frame rate:
 * holding 12 Mbit while doubling to 60fps would have halved the budget per
 * frame and traded the judder for mush.
 */
const VIDEO_BITS_PER_SECOND = 20_000_000;

/** Headroom for the encoder to take the final frame before the recorder stops. */
const FINAL_FRAME_GRACE_MS = 40;

export interface PassRecording {
	blob: Blob;
	extension: "mp4" | "webm";
	mimeType: string;
}

/** What this browser can actually produce, or null if it cannot record at all. */
export function supportedRecordingFormat():
	| (typeof CODEC_LADDER)[number]
	| null {
	if (globalThis.MediaRecorder === undefined) {
		return null;
	}
	return (
		CODEC_LADDER.find((candidate) =>
			MediaRecorder.isTypeSupported(candidate.mimeType)
		) ?? null
	);
}

/**
 * Record `canvas` for `seconds`, driving it with `onFrame` on every animation
 * frame. `onFrame` receives the time in seconds since the recording started,
 * wrapped into the loop — so the caller draws a cycle and this closes it.
 */
function recordCanvasLoopRealtime({
	canvas,
	fps,
	onFrame,
	onProgress,
	seconds,
	signal,
}: {
	canvas: HTMLCanvasElement;
	fps: number;
	onFrame: (time: number) => void;
	onProgress?: (fraction: number) => void;
	seconds: number;
	signal?: AbortSignal;
}): Promise<PassRecording> {
	const format = supportedRecordingFormat();
	if (!format) {
		return Promise.reject(
			new Error("This browser cannot record video from a canvas")
		);
	}

	return new Promise<PassRecording>((resolve, reject) => {
		// The stream self-samples at `fps` AND is nudged on every frame we draw.
		//
		// Belt and braces, because each mechanism alone has a failure mode that has
		// already bitten:
		//
		// - Self-sampling alone takes whatever happens to be on the canvas when the
		//   browser looks. Combined with an early stop it lost the tail of the
		//   cycle; a measured export finished 24 degrees short of a full turn.
		// - A manual `captureStream(0)` track alone is exact, but depends on
		//   `requestFrame`, which is not universal — Safari has shipped
		//   `captureStream` without it. Where it is missing the track emits only the
		//   frame present when recording began and the export is a ten-second STILL.
		//   That is the worst failure available here and it must not be reachable.
		//
		// Asking a self-sampling track for extra frames is harmless (at worst a
		// duplicate, which the encoder collapses), so the reliable mechanism carries
		// the recording and the precise one sharpens it.
		const stream = canvas.captureStream(fps);
		// SAFETY: canvas.captureStream creates a canvas-capture video track. The
		// native requestFrame method is optional here because older Safari capture
		// streams omit it; retain the existing self-sampling fallback unchanged.
		const frameTrack = stream.getVideoTracks()[0] as
			| (Omit<CanvasCaptureMediaStreamTrack, "requestFrame"> &
					Partial<Pick<CanvasCaptureMediaStreamTrack, "requestFrame">>)
			| undefined;
		const publish = () => frameTrack?.requestFrame?.();
		const recorder = new MediaRecorder(stream, {
			mimeType: format.mimeType,
			videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
		});
		const chunks: Blob[] = [];
		let raf = 0;
		let start = 0;
		/** Set when the run is abandoned rather than completed — see `onHidden`. */
		let failed = false;

		const stopTracks = () => {
			for (const track of stream.getTracks()) {
				track.stop();
			}
		};

		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) {
				chunks.push(event.data);
			}
		};
		recorder.onerror = () => {
			cancelAnimationFrame(raf);
			stopTracks();
			document.removeEventListener("visibilitychange", onHidden);
			reject(new Error("Recording failed"));
		};
		recorder.onstop = () => {
			cancelAnimationFrame(raf);
			stopTracks();
			document.removeEventListener("visibilitychange", onHidden);
			if (failed) {
				reject(
					new Error("Recording stopped because the tab went to the background")
				);
				return;
			}
			resolve({
				blob: new Blob(chunks, { type: format.mimeType }),
				extension: format.extension,
				mimeType: format.mimeType,
			});
		};

		signal?.addEventListener("abort", () => {
			if (recorder.state !== "inactive") {
				recorder.stop();
			}
		});

		// Backgrounding the tab produces the same symptom as a broken recorder, and
		// it must not be mistaken for one. `requestAnimationFrame` stops in a hidden
		// tab while the capture stream keeps sampling, so the canvas freezes on
		// whatever frame it reached and the export is a still — silently, with no
		// error anywhere. Failing loudly means the caller can say what went wrong
		// and the member can try again, rather than posting a frozen card.
		const onHidden = () => {
			if (document.hidden && recorder.state !== "inactive") {
				failed = true;
				cancelAnimationFrame(raf);
				recorder.stop();
			}
		};
		document.addEventListener("visibilitychange", onHidden);

		// The cycle is cut into a FIXED number of frames and the recording is not
		// finished until the last of them has been drawn.
		//
		// Driving content straight off the wall clock and stopping once ten seconds
		// had passed looked equivalent and was not: whichever frame happened to be
		// on screen when the clock ran out became the final frame, and the encoder's
		// own flush lost a further stretch on top. A measured export came out 9.11s
		// long, so the card had turned 328 degrees instead of 360 and the wrap was a
		// visible jump — the loop was closed in the preview, which runs a true
		// cycle, and open in the file, which is the only one anybody sees.
		//
		// Indexing by frame fixes the endpoint: frame N-1 is the frame immediately
		// before the wrap, by construction, however many frames were dropped on the
		// way there. The index is still PACED by the clock, so the clip runs at real
		// speed rather than as fast as the machine can draw.
		const totalFrames = Math.max(1, Math.round(seconds * fps));
		let lastDrawn = -1;

		const tick = (now: number) => {
			if (start === 0) {
				start = now;
			}
			const elapsed = (now - start) / 1000;
			const target = Math.min(totalFrames - 1, Math.floor(elapsed * fps));
			if (target > lastDrawn) {
				lastDrawn = target;
				// Frame i sits at i/fps into the cycle. Frame 0 is drawn once, at the
				// start, and never repeated at the end — the player's own wrap is what
				// returns to it, and re-emitting it would show frame 0 twice in a row.
				onFrame(target / fps);
				publish();
				onProgress?.((target + 1) / totalFrames);
			}
			if (lastDrawn >= totalFrames - 1) {
				// One frame interval of grace before stopping: `captureStream` samples
				// the canvas asynchronously, and stopping in the same task drops the
				// frame just drawn — which is the one that has to be there.
				setTimeout(
					() => {
						if (recorder.state !== "inactive") {
							recorder.stop();
						}
					},
					FINAL_FRAME_GRACE_MS + 1000 / fps
				);
				return;
			}
			raf = requestAnimationFrame(tick);
		};

		// Draw before starting so the canvas is never blank, then publish the
		// opening frame explicitly — with a manual track nothing is captured until
		// it is asked for.
		onFrame(0);
		lastDrawn = 0;
		recorder.start();
		publish();
		raf = requestAnimationFrame(tick);
	});
}

function nextRecordingFrame(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let raf = 0;
		const cleanup = () => {
			cancelAnimationFrame(raf);
			signal?.removeEventListener("abort", interrupted);
			document.removeEventListener("visibilitychange", interrupted);
		};
		const interrupted = () => {
			if (!(signal?.aborted || document.hidden)) {
				return;
			}
			cleanup();
			reject(
				signal?.aborted
					? new DOMException("Recording aborted", "AbortError")
					: new Error(
							"Recording stopped because the tab went to the background"
						)
			);
		};
		signal?.addEventListener("abort", interrupted);
		document.addEventListener("visibilitychange", interrupted);
		raf = requestAnimationFrame(() => {
			cleanup();
			resolve();
		});
		interrupted();
	});
}

/** Encode every frame on its intended media timeline, independently of capture latency. */
export async function recordCanvasLoop(options: {
	canvas: HTMLCanvasElement;
	fps: number;
	onFrame: (time: number) => void;
	onProgress?: (fraction: number) => void;
	seconds: number;
	signal?: AbortSignal;
}): Promise<PassRecording> {
	if (globalThis.VideoEncoder === undefined) {
		return recordCanvasLoopRealtime(options);
	}
	const {
		BufferTarget,
		CanvasSource,
		Mp4OutputFormat,
		Output,
		Quality,
		WebMOutputFormat,
		canEncodeVideo,
	} = await import("mediabunny");
	const quality = new Quality({ bitrate: VIDEO_BITS_PER_SECOND });
	const dimensions = {
		width: options.canvas.width,
		height: options.canvas.height,
		quality,
	};
	const codec = (await canEncodeVideo("avc", dimensions))
		? "avc"
		: (await canEncodeVideo("vp9", dimensions))
			? "vp9"
			: null;
	if (!codec) {
		return recordCanvasLoopRealtime(options);
	}
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: codec === "avc" ? new Mp4OutputFormat() : new WebMOutputFormat(),
	});
	const source = new CanvasSource(options.canvas, { codec, quality });
	output.addVideoTrack(source, { frameRate: options.fps });
	const checkActive = () => {
		if (options.signal?.aborted) {
			throw new DOMException("Recording aborted", "AbortError");
		}
		if (document.hidden) {
			throw new Error(
				"Recording stopped because the tab went to the background"
			);
		}
	};
	try {
		checkActive();
		await output.start();
		const frames = Math.max(1, Math.round(options.seconds * options.fps));
		const duration = options.seconds / frames;
		for (let frame = 0; frame < frames; frame++) {
			checkActive();
			options.onFrame(frame * duration);
			// add captures this canvas now and awaits encoder backpressure. A slow
			// device takes longer to export; it cannot silently drop media time.
			await source.add(frame * duration, duration);
			options.onProgress?.((frame + 1) / frames);
			await nextRecordingFrame(options.signal);
		}
		checkActive();
		await output.finalize();
		checkActive();
		if (!target.buffer) {
			throw new Error("Could not encode the pass video");
		}
		return {
			blob: new Blob([target.buffer], {
				type: codec === "avc" ? "video/mp4" : "video/webm",
			}),
			extension: codec === "avc" ? "mp4" : "webm",
			mimeType: codec === "avc" ? "video/mp4" : "video/webm",
		};
	} catch (error) {
		await output.cancel();
		throw error;
	}
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Revoked on the next task, not immediately: Safari has not started reading
	// the object URL by the time `click()` returns.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
