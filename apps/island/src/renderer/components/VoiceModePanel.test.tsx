import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceMode } from "../hooks/use-voice-mode.ts";
import { VoiceModePanel } from "./VoiceModePanel.tsx";

const VOICE: VoiceMode = {
	active: true,
	caption: "",
	error: null,
	interrupt: () => undefined,
	levels: [0.12, 0.82],
	phase: "thinking",
	start: () => undefined,
	stop: () => undefined,
	transcript: "",
};

test("wraps Island voice mode in the libraries.dev voice glow while thinking", () => {
	const markup = renderToStaticMarkup(
		<VoiceModePanel onClose={() => undefined} voice={VOICE} />
	);

	expect(markup).toContain("data-voice-beam=");
	expect(markup).toContain('data-processing="true"');
	expect(markup).toContain("Thinking…");
});
