"use client";

import { useCallback } from "react";
import type { InputBarProps } from "./input-bar-types.ts";
import { useVoiceRecorder } from "./useVoiceRecorder.ts";

/** Stable fallback so the voice hook can be called unconditionally. */
const noopTranscribe = async (): Promise<string> => "";

/**
 * Voice input: record from the default mic, show a live waveform, and append
 * the transcript to the composer. The hook is always called (Rules of Hooks);
 * its UI only renders when a `voice` prop is supplied.
 */
export function useComposerVoiceInput({
	focusComposer,
	input,
	setInput,
	voice,
}: {
	focusComposer: () => void;
	input: string;
	setInput: (v: string) => void;
	voice: InputBarProps["voice"];
}) {
	const appendTranscript = useCallback(
		(text: string) => {
			const base = input.trim();
			setInput(base ? `${base} ${text}` : text);
			requestAnimationFrame(focusComposer);
		},
		[focusComposer, input, setInput]
	);
	return useVoiceRecorder({
		transcribe: voice?.transcribe ?? noopTranscribe,
		onTranscript: appendTranscript,
	});
}
