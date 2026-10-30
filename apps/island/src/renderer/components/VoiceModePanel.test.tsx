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

test("voice mode keeps one monochrome orb and no edge glow", () => {
	const markup = renderToStaticMarkup(
		<VoiceModePanel onClose={() => undefined} voice={VOICE} />
	);

	expect(markup).not.toContain("data-voice-beam=");
	expect(markup).toContain("rounded-full bg-foreground");
	expect(markup).toContain('aria-live="polite"');
	expect(markup).toContain("Thinking…");
	expect(markup).toContain("Interrupt");
});

test("a voice error reads as one sentence with Retry and Copy details", () => {
	const markup = renderToStaticMarkup(
		<VoiceModePanel
			onClose={() => undefined}
			voice={{ ...VOICE, error: "ws closed: 1006 upstream_unavailable" }}
		/>
	);

	expect(markup).toContain("Voice mode stopped.");
	expect(markup).toContain("Retry");
	expect(markup).toContain("Copy details");
	// The raw failure is only in the Copy details tooltip, not printed.
	expect(markup.split("ws closed: 1006").length - 1).toBe(1);
});
