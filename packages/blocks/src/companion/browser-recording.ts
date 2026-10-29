import type {
	MediaRecordingInput,
	MediaRecordingResult,
} from "@ryu/app-host/media-recording";
import { downsample, encodeWav } from "./audio-pcm.ts";

/** How long a stopped microphone stays open for its owner's next clip. Apps
 *  that follow speech in back-to-back clips (stop, read, discard, start) reuse
 *  the open device instead of reopening it every cycle, which would drop the
 *  audio spoken while the device restarts, flicker the OS microphone
 *  indicator, and switch Bluetooth headset profiles. Samples are never kept
 *  while no clip is recording. */
const WARM_MS = 1500;

/** One microphone owner per trusted host document. Each app retains its own pending clip. */
export class BrowserRecordingHost {
	private owner: string | null = null;
	private stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private processor: ScriptProcessorNode | null = null;
	private samples: Float32Array[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Owner whose stopped device is still open for a quick restart. */
	private warmOwner: string | null = null;
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly clips = new Map<
		string,
		{ id: string; startedAt: string; durationMs: number; blob?: Blob }
	>();
	private starting = false;
	private startingOwner: string | null = null;

	private status(owner: string): MediaRecordingResult {
		const clip = this.clips.get(owner);
		return {
			available: !!globalThis.navigator?.mediaDevices?.getUserMedia,
			background: false,
			state: this.owner === owner ? "recording" : clip ? "pending" : "idle",
			...(clip
				? {
						id: clip.id,
						startedAt: clip.startedAt,
						durationMs:
							this.owner === owner
								? Date.now() - Date.parse(clip.startedAt)
								: clip.durationMs,
					}
				: undefined),
		};
	}
	/** Close the device. Fields are cleared before awaiting, so a start that
	 *  runs meanwhile cannot have its new device torn down by this close. */
	private async closeDevice() {
		clearTimeout(this.warmTimer);
		this.warmOwner = null;
		const { stream, context, processor } = this;
		this.stream = null;
		this.context = null;
		this.processor = null;
		this.samples = [];
		processor?.disconnect();
		for (const track of stream?.getTracks() ?? []) {
			track.stop();
		}
		await context?.close().catch(() => undefined);
	}
	/** End the owner's clip. With `keepWarm`, the device stays open briefly for
	 *  the same owner's next start; otherwise it is closed now. */
	private async stop(keepWarm = false) {
		const owner = this.owner;
		const context = this.context;
		if (!(owner && context)) {
			return;
		}
		this.owner = null;
		clearTimeout(this.timer);
		const rate = context.sampleRate;
		const frames = this.samples;
		this.samples = [];
		const merged = new Float32Array(
			frames.reduce((total, frame) => total + frame.length, 0)
		);
		let offset = 0;
		for (const frame of frames) {
			merged.set(frame, offset);
			offset += frame.length;
		}
		const clip = this.clips.get(owner);
		if (clip) {
			clip.durationMs = Math.round((merged.length * 1000) / rate);
			clip.blob = encodeWav(downsample(merged, rate, 16_000), 16_000);
		}
		if (keepWarm) {
			this.warmOwner = owner;
			clearTimeout(this.warmTimer);
			this.warmTimer = setTimeout(() => {
				this.closeDevice().catch(() => undefined);
			}, WARM_MS);
			return;
		}
		await this.closeDevice();
	}
	private begin(owner: string) {
		clearTimeout(this.warmTimer);
		this.warmOwner = null;
		this.samples = [];
		this.owner = owner;
		this.clips.set(owner, {
			id: crypto.randomUUID(),
			startedAt: new Date().toISOString(),
			durationMs: 0,
		});
		this.timer = setTimeout(
			() => {
				this.stop().catch(() => undefined);
			},
			5 * 60 * 1000
		);
	}
	private async open(owner: string): Promise<boolean> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1 },
		});
		this.stream = stream;
		if (this.startingOwner !== owner) {
			await this.closeDevice();
			return false;
		}
		const context = new AudioContext();
		this.context = context;
		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(4096, 1, 1);
		this.processor = processor;
		this.samples = [];
		processor.onaudioprocess = (event) => {
			// Only a recording clip keeps audio; a warm device discards it.
			if (this.owner && this.processor === processor) {
				this.samples.push(
					new Float32Array(event.inputBuffer.getChannelData(0))
				);
			}
		};
		source.connect(processor);
		processor.connect(context.destination);
		await context.resume();
		// The app may have been unmounted while the device was resuming.
		if (this.startingOwner !== owner) {
			await this.closeDevice();
			return false;
		}
		for (const track of stream.getAudioTracks()) {
			track.onended = () => {
				if (this.stream !== stream) {
					return;
				}
				if (this.owner) {
					this.stop().catch(() => undefined);
				} else {
					this.closeDevice().catch(() => undefined);
				}
			};
		}
		return true;
	}
	async call(
		owner: string,
		input: MediaRecordingInput
	): Promise<MediaRecordingResult> {
		if (input.action === "status") {
			return this.status(owner);
		}
		if (input.action === "rewind" || input.action === "ack") {
			throw new Error(
				"This host returns whole recordings. Use Shadow for rewind, and discard only after the transcript is saved."
			);
		}
		if (input.action === "start") {
			if (this.clips.has(owner)) {
				return this.status(owner);
			}
			if (this.owner || this.starting) {
				throw new Error(
					"Another app is using the microphone. Stop its recording first."
				);
			}
			if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
				return this.status(owner);
			}
			const warm =
				this.warmOwner === owner &&
				this.stream?.getAudioTracks().some((t) => t.readyState === "live");
			if (warm) {
				this.begin(owner);
				return this.status(owner);
			}
			this.starting = true;
			this.startingOwner = owner;
			try {
				// Another app's warm device is closed before this app opens its own.
				if (this.warmOwner) {
					await this.closeDevice();
				}
				if (await this.open(owner)) {
					this.begin(owner);
				}
			} catch (error) {
				await this.closeDevice();
				throw error;
			} finally {
				this.starting = false;
				this.startingOwner = null;
			}
			return this.status(owner);
		}
		const clip = this.clips.get(owner);
		if (!clip || clip.id !== input.id) {
			throw new Error("This recording is no longer available to this app.");
		}
		if (input.action === "stop") {
			if (this.owner === owner) {
				await this.stop(true);
			}
			return this.status(owner);
		}
		if (input.action === "discard") {
			if (this.owner === owner) {
				await this.stop();
			}
			this.clips.delete(owner);
			return this.status(owner);
		}
		if (!clip.blob || this.owner === owner) {
			throw new Error("Stop recording before transcribing it.");
		}
		const bytes = new Uint8Array(await clip.blob.arrayBuffer());
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 8192) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
		}
		return {
			...this.status(owner),
			audio: `data:audio/wav;base64,${btoa(binary)}`,
			filename: "recording.wav",
		};
	}
	/** Stop capture when an app's host is unmounted; keep its clip for retry. */
	release(owner: string) {
		if (this.startingOwner === owner) {
			this.startingOwner = null;
		}
		if (this.owner === owner) {
			this.stop().catch(() => undefined);
		} else if (this.warmOwner === owner) {
			this.closeDevice().catch(() => undefined);
		}
	}
}

export const browserRecordingHost = new BrowserRecordingHost();
