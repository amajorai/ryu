import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const timestamps: { timestamp: number; duration: number }[] = [];
let canceled = 0;
let finalized = 0;
class Target {
	buffer: ArrayBuffer | null = null;
}
class Source {
	async add(timestamp: number, duration: number) {
		timestamps.push({ timestamp, duration });
		await Promise.resolve();
	}
}
class Output {
	target: Target;
	constructor({ target }: { target: Target }) {
		this.target = target;
	}
	addVideoTrack() {}
	async start() {}
	async finalize() {
		finalized++;
		this.target.buffer = new ArrayBuffer(8);
	}
	async cancel() {
		canceled++;
	}
}
mock.module("mediabunny", () => ({
	BufferTarget: Target,
	CanvasSource: Source,
	Output,
	Quality: class {},
	Mp4OutputFormat: class {},
	WebMOutputFormat: class {},
	canEncodeVideo: async () => true,
}));
const { recordCanvasLoop } = await import("./record.ts");
const original = {
	document: globalThis.document,
	encoder: globalThis.VideoEncoder,
	raf: globalThis.requestAnimationFrame,
	cancel: globalThis.cancelAnimationFrame,
	recorder: globalThis.MediaRecorder,
};
const documentFixture = Object.assign(new EventTarget(), { hidden: false });
let clock = 0;
beforeEach(() => {
	timestamps.length = 0;
	canceled = 0;
	finalized = 0;
	clock = 0;
	documentFixture.hidden = false;
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: documentFixture,
	});
	Object.defineProperty(globalThis, "VideoEncoder", {
		configurable: true,
		value: class {},
	});
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		value: (callback: FrameRequestCallback) => {
			clock += 137;
			queueMicrotask(() => callback(clock));
			return clock;
		},
	});
	Object.defineProperty(globalThis, "cancelAnimationFrame", {
		configurable: true,
		value: () => {},
	});
});
afterEach(() => {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: original.document,
	});
	Object.defineProperty(globalThis, "VideoEncoder", {
		configurable: true,
		value: original.encoder,
	});
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		value: original.raf,
	});
	Object.defineProperty(globalThis, "cancelAnimationFrame", {
		configurable: true,
		value: original.cancel,
	});
	Object.defineProperty(globalThis, "MediaRecorder", {
		configurable: true,
		value: original.recorder,
	});
});
// SAFETY: This suite installs a VideoEncoder and mediabunny fixtures that
// accept the canvas without DOM calls. The real encoder branch reads only its
// width/height before passing it to the installed Source test double.
const canvas = { width: 1920, height: 1080 } as HTMLCanvasElement;
test("slow frame scheduling still encodes all600 actual frames on an exact ten-second timeline", async () => {
	const drawn: number[] = [];
	const result = await recordCanvasLoop({
		canvas,
		fps: 60,
		seconds: 10,
		onFrame: (time) => drawn.push(time),
	});
	expect(clock).toBeGreaterThan(80_000);
	expect(drawn).toHaveLength(600);
	expect(timestamps).toHaveLength(600);
	for (let frame = 0; frame < 600; frame++) {
		expect(drawn[frame]).toBeCloseTo(frame / 60, 10);
		expect(timestamps[frame]!.timestamp).toBeCloseTo(frame / 60, 10);
		expect(timestamps[frame]!.duration).toBeCloseTo(1 / 60, 10);
	}
	expect(
		timestamps.at(-1)!.timestamp + timestamps.at(-1)!.duration
	).toBeCloseTo(10, 10);
	expect(finalized).toBe(1);
	expect(canceled).toBe(0);
	expect(result.extension).toBe("mp4");
});
test("aborting an active export cancels the encoder instead of finalizing a file", async () => {
	const controller = new AbortController();
	await expect(
		recordCanvasLoop({
			canvas,
			fps: 60,
			seconds: 10,
			signal: controller.signal,
			onFrame: () => {},
			onProgress: () => controller.abort(),
		})
	).rejects.toMatchObject({ name: "AbortError" });
	expect(timestamps).toHaveLength(1);
	expect(finalized).toBe(0);
	expect(canceled).toBe(1);
});
test("backgrounding an active export cancels rather than saving a frozen frame", async () => {
	await expect(
		recordCanvasLoop({
			canvas,
			fps: 60,
			seconds: 10,
			onFrame: () => {},
			onProgress: () => {
				documentFixture.hidden = true;
				documentFixture.dispatchEvent(new Event("visibilitychange"));
			},
		})
	).rejects.toThrow("background");
	expect(finalized).toBe(0);
	expect(canceled).toBe(1);
});

test("browsers without VideoEncoder retain the existing MediaRecorder export path", async () => {
	Object.defineProperty(globalThis, "VideoEncoder", {
		configurable: true,
		value: undefined,
	});
	let tracksStopped = 0;
	let capturedFps = 0;
	class Recorder {
		static isTypeSupported() {
			return true;
		}
		state = "inactive";
		ondataavailable: ((event: { data: Blob }) => void) | null = null;
		onstop: (() => void) | null = null;
		start() {
			this.state = "recording";
		}
		stop() {
			this.state = "inactive";
			this.ondataavailable?.({ data: new Blob(["encoded fixture"]) });
			this.onstop?.();
		}
	}
	Object.defineProperty(globalThis, "MediaRecorder", {
		configurable: true,
		value: Recorder,
	});
	// SAFETY: This controlled Recorder test uses only canvas frame size and
	// the captureStream adapter below, not the remaining browser canvas API.
	const realtimeCanvas = { width: 1920, height: 1080 } as HTMLCanvasElement;
	Object.defineProperty(realtimeCanvas, "captureStream", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: (fps: number) => {
			capturedFps = fps;
			const track = {
				requestFrame: () => {},
				stop: () => {
					tracksStopped++;
				},
			};
			return { getVideoTracks: () => [track], getTracks: () => [track] };
		},
	});
	const recording = await recordCanvasLoop({
		canvas: realtimeCanvas,
		fps: 60,
		seconds: 10,
		onFrame: () => {},
	});
	expect(capturedFps).toBe(60);
	expect(tracksStopped).toBe(1);
	expect(recording.extension).toBe("mp4");
	expect(finalized).toBe(0);
	expect(timestamps).toHaveLength(0);
});
