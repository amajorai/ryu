import { expect, test } from "bun:test";
import { effortLevelLabel } from "./effort-level-label.ts";

const JA: Record<string, string> = {
	Off: "オフ",
	Minimal: "最小",
	Low: "低",
	Medium: "中",
	High: "高",
	"Extra high": "超高",
	Max: "最大",
};
const DE: Record<string, string> = {
	Off: "Aus",
	Minimal: "Minimal",
	Low: "Niedrig",
	Medium: "Mittel",
	High: "Hoch",
	"Extra high": "Sehr hoch",
	Max: "Max.",
};
const IDS: [string, string][] = [
	["off", "Off"],
	["minimal", "Minimal"],
	["low", "Low"],
	["medium", "Medium"],
	["high", "High"],
	["xhigh", "Extra high"],
	["max", "Max"],
];

const catalogTranslator =
	(catalog: Record<string, string>) =>
	(source: string): string =>
		catalog[source] ?? source;

test("every known level id reads in Japanese and German", () => {
	for (const [id, english] of IDS) {
		expect(effortLevelLabel(id, catalogTranslator(JA))).toBe(JA[english]);
		expect(effortLevelLabel(id, catalogTranslator(DE))).toBe(DE[english]);
	}
});

test("English names the levels without inventing Xhigh", () => {
	const identity = (source: string) => source;
	expect(IDS.map(([id]) => effortLevelLabel(id, identity))).toEqual(
		IDS.map(([, english]) => english)
	);
	expect(effortLevelLabel("XHigh", identity)).toBe("Extra high");
	expect(effortLevelLabel(" High ", identity)).toBe("High");
});

test("a provider's own level name passes through untranslated", () => {
	expect(effortLevelLabel("turbo", catalogTranslator(JA))).toBe("turbo");
	expect(effortLevelLabel("", catalogTranslator(JA))).toBe("");
});

test("without a translator it formats the English source", () => {
	expect(effortLevelLabel("xhigh")).toBe("Extra high");
});
