/* @jsxImportSource @opentui/react */
// The queue bar and overlay join hint parts with " · ". Each part is a whole
// catalogued phrase translated before the join; the joined line never matches.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"c clear": "c leeren",
	"Enter inspect": "Enter prüfen",
	"Esc cancel": "Esc abbrechen",
	Queue: "Warteschlange",
	"x remove": "x entfernen",
	"{label} · {count} queued": "{label} · {count} in der Warteschlange",
	"↑↓ move": "↑↓ bewegen",
	"⇧↑↓ reorder": "⇧↑↓ umsortieren",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { queueActionHints } = await import("./chat-queue-hints.ts");
const { ChatQueueBar } = await import("./ChatQueueBar.tsx");
const { ThemeProvider } = await import("@/components/ui/theme-provider.tsx");
const { testRender } = await import("../__tests__/cli-test-render.ts");
const { ryuTheme } = await import("../ui/theme.ts");

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	const current = setup;
	setup = null;
	if (current) {
		await act(async () => {
			current.renderer.destroy();
		});
	}
});

const noop = () => undefined;

describe("queue hints under German", () => {
	test("every action part is translated before the join", () => {
		expect(
			queueActionHints({
				cancelHint: "Esc cancel",
				clearHint: "c clear",
				onClear: noop,
				onMove: noop,
				onRemove: noop,
			})
		).toBe(
			"↑↓ bewegen · ⇧↑↓ umsortieren · x entfernen · c leeren · Esc abbrechen"
		);
	});

	test("the unfocused bar names its label and hints in German", async () => {
		setup = await testRender(
			<ThemeProvider reducedMotion theme={ryuTheme}>
				<ChatQueueBar
					items={["first", "second"]}
					onClear={noop}
					onFocus={noop}
				/>
			</ThemeProvider>,
			{ width: 80, height: 8 }
		);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Warteschlange · 2 in der Warteschlange");
		expect(frame).toContain("Enter prüfen · c leeren");
	});
});
