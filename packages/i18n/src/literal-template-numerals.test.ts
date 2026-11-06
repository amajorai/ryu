import { describe, expect, test } from "bun:test";

import {
	formatCapturedNumeral,
	isIdentifierArgument,
} from "./literal-template-numerals.ts";
import { LiteralTemplateIndex } from "./literal-templates.ts";

const RENDER_REVIEW = "Expected {expected} seconds; received {actual} seconds.";
const GERMAN = {
	[RENDER_REVIEW]: "{expected} Sekunden erwartet; {actual} Sekunden erhalten.",
	"Released in {year}": "Veröffentlicht {year}",
	"Opened issue {id} with {size} bytes": "Issue {id} mit {size} Bytes geöffnet",
	"Imports would exceed {limit} bytes":
		"Importe würden {limit} Bytes überschreiten",
	"Using port {port} for {count} clips": "Port {port} für {count} Clips",
	"More about {titleLabel}": "Mehr über {titleLabel}",
	"Clip failed: {error}": "Clip fehlgeschlagen: {error}",
	"The clips overlap for {overlap} s.":
		"Die Clips überlappen sich {overlap} s.",
};
const ARABIC = {
	[RENDER_REVIEW]: "المتوقع {expected} ثانية؛ المستلم {actual} ثانية.",
};
const ENGLISH = { [RENDER_REVIEW]: RENDER_REVIEW };
const JAPANESE = {
	[RENDER_REVIEW]: "{expected} 秒を想定しましたが、{actual} 秒でした。",
	"Imports would exceed {limit} bytes": "インポートが {limit} バイトを超えます",
};
const TYPED_GERMAN = {
	"Synced {count} files to the archive":
		"{count, plural, one {# Datei} other {# Dateien}} ins Archiv synchronisiert",
	"Uploaded {size} bytes to the server":
		"{size, number} Bytes auf den Server hochgeladen",
	"Waited {seconds} seconds for the server":
		"{seconds, plural, one {# Sekunde} other {# Sekunden}} auf den Server gewartet",
	"Retried {attempts} times in {seconds} seconds":
		"{attempts, select, 0 {Kein Versuch} other {{attempts} Versuche}} in {seconds} Sekunden",
};
/** A translation that inserts every argument as plain text. */
const TEXT = "{value}";

const expectedIn = (locale: string, value: number, digits: number) =>
	new Intl.NumberFormat(locale, {
		maximumFractionDigits: digits,
		minimumFractionDigits: digits,
	}).format(value);

describe("numbers captured by literal templates", () => {
	test("German decimals use a decimal comma", () => {
		const index = new LiteralTemplateIndex(GERMAN);
		expect(
			index.match("Expected 12.50 seconds; received 3.00 seconds.", "de")
		).toBe("12,50 Sekunden erwartet; 3,00 Sekunden erhalten.");
		expect(index.match("The clips overlap for 1.5 s.", "de")).toBe(
			"Die Clips überlappen sich 1,5 s."
		);
	});

	test("Arabic digits follow the locale's numbering system", () => {
		const index = new LiteralTemplateIndex(ARABIC);
		for (const locale of ["ar", "ar-EG"]) {
			expect(
				index.match("Expected 12.50 seconds; received 3.00 seconds.", locale)
			).toBe(
				`المتوقع ${expectedIn(locale, 12.5, 2)} ثانية؛ المستلم ${expectedIn(locale, 3, 2)} ثانية.`
			);
		}
		expect(formatCapturedNumeral("expected", "12.50", "ar-EG", TEXT)).toBe(
			"١٢٫٥٠"
		);
	});

	test("Japanese keeps ASCII digits and groups thousands", () => {
		const index = new LiteralTemplateIndex(JAPANESE);
		expect(
			index.match("Expected 12.50 seconds; received 3.00 seconds.", "ja")
		).toBe("12.50 秒を想定しましたが、3.00 秒でした。");
		expect(index.match("Imports would exceed 52428800 bytes", "ja")).toBe(
			"インポートが 52,428,800 バイトを超えます"
		);
	});

	test("arguments the translation formats itself keep their raw value", () => {
		const index = new LiteralTemplateIndex(TYPED_GERMAN);
		expect(index.match("Synced 12345 files to the archive", "de")).toBe(
			"12.345 Dateien ins Archiv synchronisiert"
		);
		expect(index.match("Waited 1.5 seconds for the server", "de")).toBe(
			"1,5 Sekunden auf den Server gewartet"
		);
		expect(index.match("Waited 1.0 seconds for the server", "de")).toBe(
			"1 Sekunde auf den Server gewartet"
		);
		// A select arm reuses the value as text: the select key stays raw.
		expect(index.match("Retried 20000 times in 2.5 seconds", "de")).toBe(
			"20000 Versuche in 2,5 Sekunden"
		);
	});

	test("large integers are grouped, small ones stay as written", () => {
		const index = new LiteralTemplateIndex(GERMAN);
		expect(index.match("Imports would exceed 52428800 bytes", "de")).toBe(
			"Importe würden 52.428.800 Bytes überschreiten"
		);
		expect(index.match("Using port 8080 for 12 clips", "de")).toBe(
			"Port 8080 für 12 Clips"
		);
	});

	test("identifier-like arguments keep their digits", () => {
		const index = new LiteralTemplateIndex(GERMAN);
		expect(index.match("Released in 2026", "de")).toBe("Veröffentlicht 2026");
		expect(index.match("Opened issue 123456 with 20480 bytes", "de")).toBe(
			"Issue 123456 mit 20.480 Bytes geöffnet"
		);
		for (const name of [
			"id",
			"year",
			"port",
			"status",
			"code",
			"index",
			"version",
			"revision",
			"revisionNumber",
			"issueId",
			"exitCode",
			"titleLabel",
		]) {
			expect(isIdentifierArgument(name)).toBe(true);
			expect(formatCapturedNumeral(name, "123456.5", "de", TEXT)).toBe(
				"123456.5"
			);
		}
		expect(isIdentifierArgument("seconds")).toBe(false);
	});

	test("values that only look numeric stay verbatim", () => {
		for (const value of [
			"007",
			"1e5",
			"1,5",
			"12.",
			".5",
			"+3.5",
			"1.2.3",
			"12345678901234567890",
			"1.1234567",
			"v2.4",
		]) {
			expect(formatCapturedNumeral("amount", value, "de", TEXT)).toBe(value);
		}
		expect(formatCapturedNumeral("amount", "-0.25", "de", TEXT)).toBe("-0,25");
	});

	test("label, relay and exact entries are unaffected", () => {
		const index = new LiteralTemplateIndex(GERMAN);
		expect(index.match("More about 12.5", "de")).toBe("Mehr über 12.5");
		expect(index.match("Clip failed: 12.5", "de")).toBe(
			"Clip fehlgeschlagen: 12.5"
		);
	});

	test("English output is unchanged", () => {
		const index = new LiteralTemplateIndex(ENGLISH);
		expect(
			index.match("Expected 12.50 seconds; received 3.00 seconds.", "en")
		).toBe("Expected 12.50 seconds; received 3.00 seconds.");
		expect(formatCapturedNumeral("bytes", "52428800", "en", TEXT)).toBe(
			"52,428,800"
		);
		expect(formatCapturedNumeral("seconds", "0.50", "en", TEXT)).toBe("0.50");
	});
});
