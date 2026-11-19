import { translate } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";

/** A media call whose non-JSON failure falls back to its HTTP status. */
export type MediaCall =
	| "audio-poll"
	| "speak"
	| "speech-install"
	| "speech-process"
	| "transcribe"
	| "tts-install"
	| "tts-model-install"
	| "video";

/**
 * The status-only failure sentence for one media call, shown when Core's error
 * body carries no reason of its own. Each call has its own whole sentence so
 * the catalog translates it.
 */
export function mediaStatusFailure(
	call: MediaCall,
	status: number,
	tl: LiteralMessage = translate
): string {
	const values = { status: String(status) };
	switch (call) {
		case "audio-poll":
			return tl("Checking the audio job failed: {status}", values);
		case "speak":
			return tl("Speech synthesis failed: {status}", values);
		case "speech-install":
			return tl("Speech Processing install failed: {status}", values);
		case "speech-process":
			return tl("Speech Processing failed: {status}", values);
		case "transcribe":
			return tl("Transcription failed: {status}", values);
		case "tts-install":
			return tl("TTS engine install failed: {status}", values);
		case "tts-model-install":
			return tl("TTS model install failed: {status}", values);
		default:
			return tl("Video generation failed: {status}", values);
	}
}
