import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { glanceTileLabel } from "./glance-tile-label.ts";

/** A German catalog that knows the words the label is built from. */
const DE: Record<string, string> = {
	"{name}, {state}": "{name}, {state}",
	"Needs attention": "Braucht Aufmerksamkeit",
	Working: "Arbeitet",
};

const de = (source: string, values?: MessageValuesInput) =>
	formatMessage(DE[source] ?? source, values ?? {}, "de");
const en = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values ?? {}, "en");

describe("glanceTileLabel", () => {
	test("reads as before in English", () => {
		expect(glanceTileLabel(en, "Ada", "working")).toBe("Ada, Working");
		expect(glanceTileLabel(en, "Ada", "your-turn")).toBe("Ada, Your turn");
	});

	test("translates the state word", () => {
		expect(glanceTileLabel(de, "Ada", "working")).toBe("Ada, Arbeitet");
		expect(glanceTileLabel(de, "Ada", "attention")).toBe(
			"Ada, Braucht Aufmerksamkeit"
		);
	});
});
