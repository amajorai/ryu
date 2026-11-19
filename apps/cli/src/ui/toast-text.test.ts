// A repeated toast folds into "message ×N". The JSX runtime only translates a
// child that is exactly a catalogued string, so the count must be appended
// after the message is translated. The stub catalog stands in for German.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Copied to clipboard": "In die Zwischenablage kopiert",
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
const { toastText } = await import("./toast.tsx");

describe("toast line under German", () => {
	test("a repeated toast keeps its German message and appends the count", () => {
		expect(toastText("Copied to clipboard", 3)).toBe(
			"In die Zwischenablage kopiert ×3"
		);
	});

	test("a single toast is just the German message", () => {
		expect(toastText("Copied to clipboard", 1)).toBe(
			"In die Zwischenablage kopiert"
		);
	});

	test("a message the catalog does not hold passes through", () => {
		expect(toastText("node-7 offline", 2)).toBe("node-7 offline ×2");
	});
});
