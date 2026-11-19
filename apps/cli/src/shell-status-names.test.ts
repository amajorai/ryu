// The status bar's mode and region names are passed through props the JSX
// runtime does not translate, so they are translated as whole words here. The
// stub catalog stands in for the German pack.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "./i18n/translate.ts";

const german = createCliTranslator("de", {
	Agent: "Agent",
	Bot: "Bot",
	Bottom: "Unten",
	Left: "Links",
	Right: "Rechts",
});
const japanese = createCliTranslator("ja", {
	Agent: "エージェント",
	Bottom: "下",
});
let active = german;
mock.module("./i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: (...args: Parameters<typeof german.tf>) => active.tf(...args),
	tr: (value: string) => active.tr(value),
	trMessage: (value: string) => active.trMessage(value),
	translateProps: german.translateProps,
}));
const { focusedRegionName, productModeName, shellStatusLeft } = await import(
	"./shell-status-names.ts"
);

describe("shell status names", () => {
	test("the focused side region is named in the reader's language", () => {
		active = german;
		expect(focusedRegionName("bottom")).toBe("Unten");
		expect(focusedRegionName("left")).toBe("Links");
		expect(focusedRegionName("right")).toBe("Rechts");
		expect(focusedRegionName("center")).toBeUndefined();
	});

	test("the mode name is translated before it is capitalised", () => {
		active = japanese;
		expect(productModeName("console")).toBe("エージェント");
		expect(shellStatusLeft("console", "http://127.0.0.1:8980")).toBe(
			"エージェント · http://127.0.0.1:8980"
		);
		expect(focusedRegionName("bottom")).toBe("下");
	});

	test("English keeps the stored modes' display names", () => {
		active = createCliTranslator(null, null);
		expect(shellStatusLeft("console", "u")).toBe("AGENT · u");
		expect(shellStatusLeft("bot", "u")).toBe("BOT · u");
		expect(shellStatusLeft("os", "u")).toBe("OS · u");
	});
});
