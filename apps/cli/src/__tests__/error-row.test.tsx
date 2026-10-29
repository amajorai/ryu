/* @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { TranscriptParts } from "../components/TranscriptParts.tsx";
import type { ChatPart } from "../core/chatTranscript.ts";
import { ryuLightTheme } from "../ui/theme.ts";
import { testRender } from "./cli-test-render.ts";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(async () => {
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

const failed: ChatPart[] = [
	{ type: "error", message: "HTTP 503 · upstream overloaded" },
];

async function renderError(recoveryHint: boolean, noUnicode = false) {
	setup = await testRender(
		<ThemeProvider noUnicode={noUnicode} reducedMotion theme={ryuLightTheme}>
			<TranscriptParts parts={failed} recoveryHint={recoveryHint} />
		</ThemeProvider>,
		{ width: 80, height: 6 }
	);
	await setup.renderOnce();
	return setup;
}

test("the latest failed turn shows a themed error row with the resend hint", async () => {
	const rendered = await renderError(true);
	const frame = rendered.captureCharFrame();
	expect(frame).toContain("Error: HTTP 503 · upstream overloaded");
	expect(frame).toContain("↑ edit & resend · /model switch");
	const errorLine = rendered
		.captureSpans()
		.lines.find((line) =>
			line.spans.some((span) => span.text.includes("Error: HTTP 503"))
		);
	const errorSpan = errorLine?.spans.find((span) =>
		span.text.includes("Error:")
	);
	expect(errorSpan?.fg).toEqual(RGBA.fromHex(ryuLightTheme.colors.error));
});

test("older failed turns drop the hint, and ASCII terminals get no arrows", async () => {
	const older = await renderError(false);
	const olderFrame = older.captureCharFrame();
	expect(olderFrame).toContain("Error: HTTP 503");
	expect(olderFrame).not.toContain("edit & resend");
	await act(async () => {
		older.renderer.destroy();
		await Promise.resolve();
	});

	const ascii = await renderError(true, true);
	const asciiFrame = ascii.captureCharFrame();
	expect(asciiFrame).toContain("up edit & resend - /model switch");
	expect(asciiFrame).not.toContain("↑");
});
