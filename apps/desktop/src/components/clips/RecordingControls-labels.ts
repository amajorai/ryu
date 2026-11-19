import {
	BrowserIcon,
	ComputerIcon,
	Mic01Icon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	ClipCaptureSources,
	ClipSources,
	ClipTarget,
} from "@/src/lib/api/clips.ts";

// The record bar's source names: the OS names a display or window, and every
// generic name is translated before it goes into an aria-label sentence.

/** One glyph for each audio input toggle, in display order. */
export const AUDIO_META: {
	icon: IconSvgElement;
	key: keyof ClipCaptureSources;
}[] = [
	{ key: "mic", icon: Mic01Icon },
	{ key: "systemAudio", icon: VolumeHighIcon },
];

/** An audio input toggle's name, translated before it goes into a sentence. */
export function audioSourceLabel(
	key: keyof ClipCaptureSources,
	tl: LiteralMessage
): string {
	return key === "mic" ? tl("Microphone") : tl("System audio");
}

/**
 * Resolve the label + glyph for the currently-selected video surface. The OS
 * names a display or window; the generic fallbacks are translated.
 */
export function describeTarget(
	target: ClipTarget,
	sources: ClipSources | null,
	tl: LiteralMessage
) {
	if (target.kind === "display") {
		const display = sources?.displays.find((d) => d.id === target.displayId);
		return { label: display?.label ?? tl("Display"), Icon: ComputerIcon };
	}
	if (target.kind === "window") {
		const win = sources?.windows.find((w) => w.id === target.windowId);
		return { label: win?.title ?? tl("Window"), Icon: BrowserIcon };
	}
	return { label: tl("Screen"), Icon: ComputerIcon };
}
