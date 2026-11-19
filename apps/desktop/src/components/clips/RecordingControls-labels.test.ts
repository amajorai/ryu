import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ClipSources } from "@/src/lib/api/clips.ts";
import {
	audioSourceLabel,
	describeTarget,
} from "./RecordingControls-labels.ts";

const tl: LiteralMessage = (source) => `[${source}]`;

describe("record bar source names", () => {
	test("the generic capture targets are translated", () => {
		expect(describeTarget({ kind: "screen" }, null, tl).label).toBe("[Screen]");
		expect(
			describeTarget({ displayId: 7, kind: "display" }, null, tl).label
		).toBe("[Display]");
		expect(
			describeTarget({ kind: "window", windowId: 3 }, null, tl).label
		).toBe("[Window]");
	});

	test("an OS window title is shown as written", () => {
		const sources = {
			displays: [],
			windows: [{ id: 3, title: "Notes" }],
		} as unknown as ClipSources;
		expect(
			describeTarget({ kind: "window", windowId: 3 }, sources, tl).label
		).toBe("Notes");
	});

	test("audio toggles are named before they enter a sentence", () => {
		expect(audioSourceLabel("mic", tl)).toBe("[Microphone]");
		expect(audioSourceLabel("systemAudio", tl)).toBe("[System audio]");
	});
});
