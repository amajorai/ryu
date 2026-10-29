// One desktop-owned audio controller for plugin-contributed ambient sound.
// The controller is deliberately independent of React so multiple consumers
// can converge on one HTMLAudioElement instead of creating one per agent run.

export interface AmbientAudioSyncOptions {
	/** Whether the source should loop while playback is active. */
	loop?: boolean;
	/** Whether the aggregate agent state currently wants playback. */
	playing: boolean;
	/** Source URL from the plugin's declarative live-activity contribution. */
	source?: string;
	/** Normalized volume in the inclusive 0..1 range. */
	volume: number;
}

export type AmbientAudioFactory = (source: string) => HTMLAudioElement | null;

export function clampAmbientVolume(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

function resolveSource(source: string): string {
	if (!globalThis.document) {
		return source;
	}
	try {
		return new URL(source, document.baseURI).href;
	} catch {
		return source;
	}
}

function browserAudioFactory(source: string): HTMLAudioElement | null {
	if (!globalThis.Audio) {
		return null;
	}
	return new Audio(source);
}

/** A singleton-friendly, conflict-safe audio player. */
export class AmbientAudioController {
	private audio: HTMLAudioElement | null = null;
	private source: string | null = null;

	constructor(
		private readonly createAudio: AmbientAudioFactory = browserAudioFactory
	) {}

	sync(options: AmbientAudioSyncOptions): void {
		const source = options.source?.trim();
		if (!(options.playing && source)) {
			this.stop();
			return;
		}

		const resolvedSource = resolveSource(source);
		if (!this.audio) {
			this.audio = this.createAudio(resolvedSource);
			if (!this.audio) {
				return;
			}
			this.audio.preload = "auto";
			this.source = resolvedSource;
		} else if (this.source !== resolvedSource) {
			this.audio.pause();
			this.audio.currentTime = 0;
			this.audio.src = resolvedSource;
			this.audio.load();
			this.source = resolvedSource;
		}

		this.audio.loop = options.loop ?? true;
		this.audio.volume = clampAmbientVolume(options.volume);
		if (this.audio.paused) {
			void this.audio.play().catch(() => {
				// Autoplay can be refused by a browser. Tauri permits this path,
				// and a later sync retries without surfacing a noisy toast.
			});
		}
	}

	stop(): void {
		if (!this.audio) {
			return;
		}
		this.audio.pause();
		this.audio.currentTime = 0;
	}

	dispose(): void {
		this.stop();
		this.audio = null;
		this.source = null;
	}
}

/** The only ambient player the desktop creates. */
export const ambientAudioController = new AmbientAudioController();
