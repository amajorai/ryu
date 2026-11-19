// The plugin row's state column: the chip is translated before it is padded,
// and padded by terminal cells so a wide script keeps the version column put.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const japanese = createCliTranslator("ja", {
	available: "利用可能",
	enabled: "有効",
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
const { chipFor, STATE_WIDTH, stateColumn } = await import(
	"./plugins-lifecycle.ts"
);

const app = (installed: boolean, enabled: boolean) =>
	({ enabled, id: "@ryu/x", installed, name: "X" }) as Parameters<
		typeof chipFor
	>[0];

describe("plugin state column under Japanese", () => {
	test("the chip label is translated", () => {
		expect(chipFor(app(false, false)).label).toBe("利用可能");
		expect(chipFor(app(true, true)).label).toBe("有効");
	});

	test("padding counts terminal cells, not code units", () => {
		const column = stateColumn(chipFor(app(false, false)), false);
		expect(column.startsWith("利用可能")).toBe(true);
		expect(Bun.stringWidth(column)).toBe(STATE_WIDTH);
	});

	test("an uncatalogued busy label still fills the column", () => {
		const column = stateColumn(chipFor(app(true, true)), true);
		expect(column).toBe("working".padEnd(STATE_WIDTH));
	});
});
