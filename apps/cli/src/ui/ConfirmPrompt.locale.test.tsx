/* @jsxImportSource @opentui/react */
// The button labels sit inside "[ … ]" template text, which the JSX runtime
// never translates; each label is translated before the brackets are added.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	Cancel: "Abbrechen",
	Uninstall: "Deinstallieren",
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
const { ThemeProvider } = await import("@/components/ui/theme-provider.tsx");
const { testRender } = await import("../__tests__/cli-test-render.ts");
const { ryuTheme } = await import("./theme.ts");
const { ConfirmPrompt } = await import("./ConfirmPrompt.tsx");

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

describe("confirm prompt under German", () => {
	test("both button labels are translated inside their brackets", async () => {
		setup = await testRender(
			<ThemeProvider reducedMotion theme={ryuTheme}>
				<ConfirmPrompt
					active={false}
					confirmLabel="Uninstall"
					consequence="It stops."
					onCancel={() => undefined}
					onConfirm={() => undefined}
					title="Uninstall Browser?"
				/>
			</ThemeProvider>,
			{ height: 10, width: 100 }
		);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("[ Abbrechen ]");
		expect(frame).toContain("[ Deinstallieren ]");
	});
});
