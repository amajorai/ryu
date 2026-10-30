import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordingPill } from "./recording-pill.tsx";

test("shows push-to-talk as a static dot and a quiet level meter, no glow", () => {
	const markup = renderToStaticMarkup(
		<RecordingPill agentName="Ryu Assistant" canCycle levels={[0.1, 0.7]} />
	);

	expect(markup).not.toContain("data-voice-beam=");
	expect(markup).not.toContain("animate-pulse");
	expect(markup).toContain("rounded-full bg-destructive");
	expect(markup).toContain("Ryu Assistant");
	expect(markup).toContain("⇥");
});

test("keeps the microphone failure readable without rendering a listening glow", () => {
	const markup = renderToStaticMarkup(
		<RecordingPill error="Couldn't access the microphone." levels={[0.8]} />
	);

	expect(markup).toContain("Couldn&#x27;t access the microphone.");
	expect(markup).not.toContain("data-voice-beam=");
});
