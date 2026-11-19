/* @jsxImportSource @opentui/react */
// A settings notice is coloured by its kind, never by reading its text: under
// German a failure reads "Konnte nicht…", and it must still be red.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { act, type ReactNode } from "react";
import { createCliTranslator } from "../../i18n/translate.ts";
import type { PanelNotice } from "./panel-notice.tsx";

const german = createCliTranslator("de", {
	"Could not complete action: {error}":
		"Aktion konnte nicht abgeschlossen werden: {error}",
	"Security update confirmed.": "Sicherheitsänderung bestätigt.",
});
mock.module("../../i18n/translate.ts", () => ({
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
const { testRender } = await import("../../__tests__/cli-test-render.ts");
const { ryuTheme } = await import("../../ui/theme.ts");
const { AccountSecurityView } = await import("./account-security-view.tsx");
const { PanelNoticeText } = await import("./panel-notice.tsx");

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

/** The foreground colour of the rendered span holding `needle`. */
async function colourOf(node: ReactNode, needle: string): Promise<string> {
	setup = await testRender(
		<ThemeProvider reducedMotion theme={ryuTheme}>
			{node}
		</ThemeProvider>,
		{ width: 100, height: 20 }
	);
	await setup.renderOnce();
	const span = setup
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((candidate) => candidate.text.includes(needle));
	return span ? rgbToHex(span.fg).toLowerCase() : "no span";
}

const failure: PanelNotice = {
	kind: "error",
	text: german.tf("Could not complete action: {error}", {
		error: "Zeitüberschreitung",
	}),
};
const success: PanelNotice = {
	kind: "ok",
	text: "Security update confirmed.",
};

function securityView(message: PanelNotice) {
	return (
		<AccountSecurityView
			busy={false}
			codes={[]}
			emailChange={{}}
			message={message}
			methodIndex={0}
			methods={[]}
			operation="password"
			session={{}}
			stage="idle"
			uri=""
			value=""
		/>
	);
}

describe("settings notices under German", () => {
	test("a translated account-security failure is coloured as an error", async () => {
		expect(await colourOf(securityView(failure), "konnte nicht")).toBe(
			ryuTheme.colors.error.toLowerCase()
		);
	});

	test("a translated account-security result is coloured as a success", async () => {
		expect(
			await colourOf(securityView(success), "Sicherheitsänderung bestätigt.")
		).toBe(ryuTheme.colors.success.toLowerCase());
	});

	test("a failed panel load forces the error colour", async () => {
		expect(
			await colourOf(<PanelNoticeText error notice={success} />, "bestätigt")
		).toBe(ryuTheme.colors.error.toLowerCase());
	});
});
