import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { type MediaCall, mediaStatusFailure } from "./media-status-failure.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

test("each media call's status fallback is one catalogued sentence", () => {
	const expected: Record<MediaCall, string> = {
		"audio-poll": "Checking the audio job failed: {status}",
		speak: "Speech synthesis failed: {status}",
		"speech-install": "Speech Processing install failed: {status}",
		"speech-process": "Speech Processing failed: {status}",
		transcribe: "Transcription failed: {status}",
		"tts-install": "TTS engine install failed: {status}",
		"tts-model-install": "TTS model install failed: {status}",
		video: "Video generation failed: {status}",
	};
	for (const [call, source] of Object.entries(expected)) {
		expect(mediaStatusFailure(call as MediaCall, 503, tl)).toBe(
			`[${source}]{"status":"503"}`
		);
	}
});

test("without a translator the English sentence carries the status", () => {
	expect(mediaStatusFailure("transcribe", 500)).toBe(
		"Transcription failed: 500"
	);
});
