/* @jsxImportSource @opentui/react */
// The connection card's status line ("checking…", "retrying in 3s…") was a
// literal assigned to a variable or built in a template, which the JSX runtime
// never translates. Pin the CLI to a German stub catalog before the card loads.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"checking…": "wird geprüft…",
	"retrying in {seconds}s…": "neuer Versuch in {seconds} s…",
	"retrying…": "neuer Versuch…",
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
const { ConnectionCard, retryCountdown } = await import("./ConnectionCard.tsx");

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

describe("connection card status under German", () => {
	test("the retry countdown is one German phrase", () => {
		expect(retryCountdown(3000, 0)).toBe("neuer Versuch in 3 s…");
		expect(retryCountdown(0, 10)).toBe("neuer Versuch…");
	});

	test("the first check reads in German", async () => {
		setup = await testRender(
			<ThemeProvider reducedMotion theme={ryuTheme}>
				<ConnectionCard
					keysActive={false}
					nextRetryAt={null}
					progress={null}
					showStart={false}
					showSwitchNode={false}
					starting={false}
					url="http://127.0.0.1:8980"
				/>
			</ThemeProvider>,
			{ width: 80, height: 10 }
		);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("wird geprüft…");
		expect(frame).not.toContain("checking…");
	});
});
