import { describe, expect, it } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import { importRowsLabel } from "./import-rows-label.ts";

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {}, "en");

// A stand-in Arabic catalog entry: the ICU message lets a translation give
// every Arabic plural form, which a flat "Import {rowCount} rows" never could.
const ARABIC: Record<string, string> = {
	"{rowCount, plural, one {Import # row} other {Import # rows}}":
		"{rowCount, plural, zero {لا صفوف للاستيراد} one {استيراد صف واحد} two {استيراد صفين} few {استيراد # صفوف} many {استيراد # صفًا} other {استيراد # صف}}",
};
const arabic: LiteralMessage = (source, values) =>
	formatMessage(ARABIC[source] ?? source, values ?? {}, "ar");

describe("importRowsLabel", () => {
	it("agrees with the count in English", () => {
		expect(importRowsLabel(english, 1)).toBe("Import 1 row");
		expect(importRowsLabel(english, 3)).toBe("Import 3 rows");
	});

	it("lets Arabic pick the few form for 3 and the dual for 2", () => {
		expect(importRowsLabel(arabic, 3)).toBe("استيراد 3 صفوف");
		expect(importRowsLabel(arabic, 2)).toBe("استيراد صفين");
		expect(importRowsLabel(arabic, 1)).toBe("استيراد صف واحد");
	});
});
