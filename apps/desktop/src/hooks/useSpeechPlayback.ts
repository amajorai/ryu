import { useCallback, useEffect, useRef } from "react";

export type SpeechPlaybackResult = "playing" | "stopped" | "superseded";

export interface SpeechPlaybackOptions {
	/** Prepare the element (for example, select an output device) before play. */
	prepareAudio?: (
		audio: HTMLAudioElement
	) => Promise<boolean> | Promise<void> | void;
	/** A repeated key stops the current/pending clip. Disable for preview buttons. */
	toggle?: boolean;
}

interface OwnedPlayback {
	audio: HTMLAudioElement;
	disposed: boolean;
	key: string;
	onEnded: () => void;
	onError: () => void;
	url: string;
}

export interface SpeechPlaybackControls {
	play: (
		key: string,
		createBlob: () => Promise<Blob>,
		options?: SpeechPlaybackOptions
	) => Promise<SpeechPlaybackResult>;
	stop: () => void;
}

/**
 * Own one blob-backed audio element for a surface.
 *
 * Replacement, toggle-off, media completion/error, play/prepare rejection, and
 * unmount all converge on the same idempotent disposer. Generation ids also make
 * a late synthesis result harmless after a newer request or unmount.
 */
export function useSpeechPlayback(): SpeechPlaybackControls {
	const currentRef = useRef<OwnedPlayback | null>(null);
	const generationRef = useRef(0);
	const pendingKeyRef = useRef<string | null>(null);

	const dispose = useCallback((playback: OwnedPlayback) => {
		if (playback.disposed) {
			return;
		}
		playback.disposed = true;
		playback.audio.removeEventListener("ended", playback.onEnded);
		playback.audio.removeEventListener("error", playback.onError);
		try {
			playback.audio.pause();
		} catch {
			// Revoking the owned blob URL is still required if a browser shim throws.
		}
		URL.revokeObjectURL(playback.url);
		if (currentRef.current === playback) {
			currentRef.current = null;
		}
	}, []);

	const stop = useCallback(() => {
		generationRef.current += 1;
		pendingKeyRef.current = null;
		const current = currentRef.current;
		if (current) {
			dispose(current);
		}
	}, [dispose]);

	const play = useCallback(
		async (
			key: string,
			createBlob: () => Promise<Blob>,
			options: SpeechPlaybackOptions = {}
		): Promise<SpeechPlaybackResult> => {
			const toggle = options.toggle ?? true;
			if (
				toggle &&
				(currentRef.current?.key === key || pendingKeyRef.current === key)
			) {
				stop();
				return "stopped";
			}

			const generation = generationRef.current + 1;
			generationRef.current = generation;
			pendingKeyRef.current = key;
			const previous = currentRef.current;
			if (previous) {
				dispose(previous);
			}

			let blob: Blob;
			try {
				blob = await createBlob();
			} catch (error) {
				if (generationRef.current === generation) {
					pendingKeyRef.current = null;
				}
				throw error;
			}
			if (generationRef.current !== generation) {
				return "superseded";
			}
			pendingKeyRef.current = null;

			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			let playback: OwnedPlayback;
			const onEnded = () => dispose(playback);
			const onError = () => dispose(playback);
			playback = {
				audio,
				disposed: false,
				key,
				onEnded,
				onError,
				url,
			};
			audio.addEventListener("ended", onEnded, { once: true });
			audio.addEventListener("error", onError, { once: true });
			currentRef.current = playback;

			try {
				await options.prepareAudio?.(audio);
				if (
					generationRef.current !== generation ||
					currentRef.current !== playback
				) {
					dispose(playback);
					return "superseded";
				}
				await audio.play();
				return currentRef.current === playback && !playback.disposed
					? "playing"
					: "superseded";
			} catch (error) {
				dispose(playback);
				throw error;
			}
		},
		[dispose, stop]
	);

	useEffect(() => stop, [stop]);

	return { play, stop };
}
