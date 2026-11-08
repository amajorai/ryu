import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCliTranslator } from "../i18n/translate.ts";
import { busyActivityLabel } from "../surfaces/chat/statusBar.tsx";
import { busyElapsedLabel } from "./StatusBar-elapsed.ts";

function cliCatalog(locale: string): Record<string, string> {
	return JSON.parse(
		readFileSync(
			new URL(
				`../../../../packages/i18n/locales/cli/${locale}.json`,
				import.meta.url
			),
			"utf8"
		)
	);
}

const german = createCliTranslator("de", cliCatalog("de"));
const japanese = createCliTranslator("ja", cliCatalog("ja"));
const english = createCliTranslator(null, null);

describe("busyElapsedLabel", () => {
	test("English keeps seconds, then rolls over into minutes", () => {
		expect(busyElapsedLabel(12, "en")).toBe("12s");
		expect(busyElapsedLabel(60, "en")).toBe("1m");
		expect(busyElapsedLabel(125, "en")).toBe("2m 5s");
	});

	test("German uses its own narrow units", () => {
		expect(busyElapsedLabel(12, "de")).toBe("12 Sek.");
		expect(busyElapsedLabel(125, "de")).toBe("2 Min., 5 Sek.");
	});

	test("Japanese never shows a raw seconds count past a minute", () => {
		const label = busyElapsedLabel(125, "ja");
		expect(label).not.toBe("125s");
		expect(label).toMatch(/^2.*5/u);
	});
});

describe("busyActivityLabel", () => {
	test("German and Japanese translate what the turn is doing", () => {
		expect(busyActivityLabel("none", null, german.tr)).toBe("Denkt nach…");
		expect(busyActivityLabel("permission", null, japanese.tr)).toBe(
			"許可を待っています…"
		);
		expect(busyActivityLabel("none", "Read", german.tr)).toBe(
			"Dateien werden gelesen…"
		);
		expect(busyActivityLabel("none", "Read", japanese.tr)).toBe(
			"ファイルを読み取り中…"
		);
	});

	test("English stays as authored", () => {
		expect(busyActivityLabel("question", null, english.tr)).toBe(
			"Waiting for your answer…"
		);
		expect(busyActivityLabel("none", "Bash", english.tr)).toBe(
			"Running command…"
		);
	});
});
