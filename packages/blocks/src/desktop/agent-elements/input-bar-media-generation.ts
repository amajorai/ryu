"use client";

import { useCallback, useState } from "react";
import type { InputBarProps } from "./input-bar-types.ts";

/** Image / video generation from the composer text, with in-flight flags. */
export function useComposerMediaGeneration({
	input,
	onGenerateImage,
	onGenerateVideo,
	setInput,
}: {
	input: string;
	onGenerateImage: InputBarProps["onGenerateImage"];
	onGenerateVideo: InputBarProps["onGenerateVideo"];
	setInput: (v: string) => void;
}) {
	// Image generation: take the composer text as the prompt, hand it to the host
	// (which calls Core's /api/images/generate and surfaces the result), then clear
	// the composer. An in-flight flag disables the button while the engine works —
	// sd-server runs on CPU and can be slow, so the control must not look dead.
	const [isGenerating, setIsGenerating] = useState(false);
	const handleGenerateImage = useCallback(() => {
		const prompt = input.trim();
		if (!(prompt && onGenerateImage) || isGenerating) {
			return;
		}
		setIsGenerating(true);
		setInput("");
		Promise.resolve(onGenerateImage(prompt)).finally(() => {
			setIsGenerating(false);
		});
	}, [input, onGenerateImage, isGenerating, setInput]);

	// Video generation mirrors image generation. Separate in-flight flag so the
	// two buttons disable independently.
	const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
	const handleGenerateVideo = useCallback(() => {
		const prompt = input.trim();
		if (!(prompt && onGenerateVideo) || isGeneratingVideo) {
			return;
		}
		setIsGeneratingVideo(true);
		setInput("");
		Promise.resolve(onGenerateVideo(prompt)).finally(() => {
			setIsGeneratingVideo(false);
		});
	}, [input, onGenerateVideo, isGeneratingVideo, setInput]);

	return {
		handleGenerateImage,
		handleGenerateVideo,
		isGenerating,
		isGeneratingVideo,
	};
}
