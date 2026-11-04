import { describe, expect, it } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import { isolateBidi, providerArrow, versionArrow } from "./version-arrow.ts";

const FSI = "\u2068";
const PDI = "\u2069";

const AR: Record<string, string> = {
	"{from} → {to}": "{from} ← {to}",
	"{toolkit} → {provider}": "{toolkit} ← {provider}",
};

const englishTl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});
const arabicTl: LiteralMessage = (source, values) =>
	formatMessage(AR[source] ?? source, values ?? {}, "ar");

describe("isolateBidi", () => {
	it("wraps text in a first-strong isolate", () => {
		expect(isolateBidi("1.2.0")).toBe(`${FSI}1.2.0${PDI}`);
	});
});

describe("versionArrow", () => {
	it("keeps from before to with each version isolated", () => {
		expect(versionArrow("1.2.0", "1.3.0", englishTl)).toBe(
			`${FSI}1.2.0${PDI} → ${FSI}1.3.0${PDI}`
		);
	});

	it("takes the arrow from the catalog in Arabic", () => {
		expect(versionArrow("1.2.0", "1.3.0", arabicTl)).toBe(
			`${FSI}1.2.0${PDI} ← ${FSI}1.3.0${PDI}`
		);
	});
});

describe("providerArrow", () => {
	it("names the toolkit and then its new provider", () => {
		expect(providerArrow("Web search", "Brave", englishTl)).toBe(
			`${FSI}Web search${PDI} → ${FSI}Brave${PDI}`
		);
		expect(providerArrow("بحث الويب", "Brave", arabicTl)).toBe(
			`${FSI}بحث الويب${PDI} ← ${FSI}Brave${PDI}`
		);
	});
});
