// The terminal window/tab title Ryu sets while it runs (OpenTUI emits OSC 0,
// which sets the window title like OSC 2): "ryu: <label>"
// when idle and "<spinner> ryu: <label>" while the focused chat streams, so a
// background terminal tab or multiplexer pane shows that a turn is running.

import cliSpinners from "cli-spinners";
import { herdrText } from "./herdr.ts";

/** The same braille frames as the in-transcript spinner. */
export const TITLE_SPINNER_FRAMES: readonly string[] = cliSpinners.dots.frames;

/** Title spinner cadence. Every frame is a terminal write, so it advances far
 * slower than the in-app spinner (one frame per elapsed-time tick). */
export const TITLE_SPINNER_INTERVAL_MS = 1000;

const TITLE_LABEL_LIMIT = 60;

/**
 * The title for `label`. `frame` is the spinner frame while streaming, null when
 * idle. The label is reduced to one line without control characters, so a
 * conversation title can never smuggle an escape sequence into the terminal.
 */
export function terminalTitle(label: string, frame: number | null): string {
	const clean = herdrText(label, TITLE_LABEL_LIMIT);
	const base = clean ? `ryu: ${clean}` : "ryu";
	if (frame === null) {
		return base;
	}
	const glyph =
		TITLE_SPINNER_FRAMES[frame % TITLE_SPINNER_FRAMES.length] ?? "⠋";
	return `${glyph} ${base}`;
}
