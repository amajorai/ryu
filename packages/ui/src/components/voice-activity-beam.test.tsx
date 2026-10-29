import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceActivityBeam } from "./voice-activity-beam.tsx";

test("renders the voice glow and sweeps while processing", () => {
	const markup = renderToStaticMarkup(
		<VoiceActivityBeam
			className="h-8 w-40"
			levels={[0.18, 0.9, Number.NaN]}
			processing
		>
			<span>Listening</span>
		</VoiceActivityBeam>
	);

	expect(markup).toContain('data-voice-activity-beam="glow"');
	expect(markup).toContain('data-voice-level="0.90"');
	expect(markup).toContain('data-processing="true"');
	expect(markup).toContain("data-voice-processing-sweep");
	expect(markup).toContain("Listening");
	expect(markup).toContain('aria-hidden="true"');
});

test("keeps the glow quiet when inactive and does not render a processing sweep", () => {
	const markup = renderToStaticMarkup(
		<VoiceActivityBeam active={false} levels={[0.8, 1]} />
	);

	expect(markup).toContain('data-active="false"');
	expect(markup).toContain('data-voice-level="0.00"');
	expect(markup).not.toContain("data-voice-processing-sweep");
});
