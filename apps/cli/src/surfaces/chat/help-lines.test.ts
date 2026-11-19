// The /help overlay translates each command description before it is placed
// after the usage, so a German reader sees German descriptions.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"ask a side question": "eine Nebenfrage stellen",
	"choose an agent": "einen Agenten wählen",
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
const { helpOverlayLines } = await import("./help-lines.ts");

describe("/help overlay lines under German", () => {
	test("descriptions are translated and usages stay verbatim", () => {
		expect(
			helpOverlayLines([
				{ description: "choose an agent", usage: "/agent" },
				{ description: "ask a side question", usage: "/btw <question>" },
			])
		).toEqual([
			"/agent           einen Agenten wählen",
			"/btw <question>  eine Nebenfrage stellen",
		]);
	});

	test("a description without a catalog entry stays English", () => {
		expect(
			helpOverlayLines([
				{ description: "toggle double-check", usage: "/check" },
			])
		).toEqual(["/check  toggle double-check"]);
	});
});
