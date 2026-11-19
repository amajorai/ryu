// The Plugins tab's toasts and cascade prompt are whole sentences per action,
// so no English verb id ("disable", "install") lands inside translated text.
// The stub catalog stands in for the Japanese pack.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const japanese = createCliTranslator("ja", {
	"Disabled {name}": "{name} を無効にしました",
	"Updated {name}": "{name} を更新しました",
	"Install failed: {error}": "インストールに失敗しました: {error}",
	"{message} (Press C to uninstall its dependents too.)":
		"{message}（C キーで依存項目もアンインストールします。）",
	"Disable {name} and its dependents?":
		"{name} とその依存項目を無効にしますか？",
	"Uninstall all": "すべてアンインストール",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "ja",
	CLI_LOCALE: "ja",
	CLI_TRANSLATOR: japanese,
	createCliTranslator,
	tf: japanese.tf,
	tr: japanese.tr,
	trMessage: japanese.trMessage,
	translateProps: japanese.translateProps,
}));
const {
	cascadeConfirmLabel,
	cascadeOfferText,
	cascadeTitleText,
	lifecycleDoneText,
	lifecycleFailedText,
} = await import("./plugins-lifecycle-copy.ts");

describe("plugin lifecycle copy under Japanese", () => {
	test("each action's toast is its own Japanese sentence", () => {
		expect(lifecycleDoneText("disable", "Notes")).toBe(
			"Notes を無効にしました"
		);
		expect(lifecycleDoneText("update", "Notes")).toBe("Notes を更新しました");
		expect(lifecycleFailedText("install", "network down")).toBe(
			"インストールに失敗しました: network down"
		);
	});

	test("the cascade offer, title and button carry no English verb", () => {
		const offer = cascadeOfferText("uninstall", "Blocked.");
		expect(offer).toBe(
			"Blocked.（C キーで依存項目もアンインストールします。）"
		);
		expect(cascadeTitleText("disable", "Notes")).toBe(
			"Notes とその依存項目を無効にしますか？"
		);
		expect(cascadeConfirmLabel("uninstall")).toBe("すべてアンインストール");
		for (const text of [offer, cascadeTitleText("disable", "Notes")]) {
			expect(text).not.toMatch(/disable|uninstall/iu);
		}
	});

	test("an uncatalogued action still reads as an English sentence", () => {
		expect(lifecycleDoneText("enable", "Notes")).toBe("Enabled Notes");
		expect(lifecycleFailedText("uninstall", "busy")).toBe(
			"Uninstall failed: busy"
		);
	});
});
