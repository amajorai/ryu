import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

/** A complete DOM audio element with deterministic playback for controller tests. */
export function createControlledAmbientAudio(
	source: string,
	currentTime = 0,
	playFailure?: Error
) {
	const audio = Object.assign(document.createElement("audio"), {
		currentTime,
		loadCount: 0,
		loop: false,
		pauseCount: 0,
		playCount: 0,
		playFailure,
		playbackPaused: true,
		preload: "",
		src: source,
		volume: 0,
		load() {
			this.loadCount += 1;
		},
		pause() {
			this.pauseCount += 1;
			this.playbackPaused = true;
		},
		async play() {
			this.playCount += 1;
			if (this.playFailure) {
				throw this.playFailure;
			}
			this.playbackPaused = false;
		},
	});
	Object.defineProperty(audio, "paused", {
		configurable: true,
		get: () => audio.playbackPaused,
	});
	return audio;
}
