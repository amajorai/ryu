import { describe, expect, test } from "bun:test";

import type { LiteralMessage } from "@ryu/i18n/react";

import { fmtBytes, usageText } from "./NodeSelector-usage-format.ts";

// Intl puts a no-break space between a German number and its unit.
const NBSP = String.fromCodePoint(0xa0);
const GIB = 1024 ** 3;
const USED_RAM = Math.round(41.3 * GIB);
const TOTAL_RAM = Math.round(63.7 * GIB);

const PLACEHOLDER = /\{(\w+)\}/gu;

function placeholderValue(values: unknown, key: string): string {
	return typeof values === "object" && values !== null
		? String(Reflect.get(values, key) ?? "")
		: "";
}

const englishTl: LiteralMessage = (source, values) =>
	source.replace(PLACEHOLDER, (_, key: string) =>
		placeholderValue(values, key)
	);

describe("fmtBytes", () => {
	test("keeps Core's English rounding", () => {
		expect(fmtBytes(USED_RAM, "", "en")).toBe("41.3 GB");
		expect(fmtBytes(512 * GIB, "", "en")).toBe("512 GB");
		expect(fmtBytes(484 * 1024 ** 2, "", "en")).toBe("484 MB");
		expect(fmtBytes(900, "", "en")).toBe("900 B");
	});

	test("uses the locale's decimal separator", () => {
		expect(fmtBytes(USED_RAM, "41.3 GB", "de")).toBe(`41,3${NBSP}GB`);
	});

	test("uses the locale's digits and unit name", () => {
		expect(fmtBytes(USED_RAM, "41.3 GB", "ar")).toBe(
			new Intl.NumberFormat("ar", {
				maximumFractionDigits: 1,
				minimumFractionDigits: 1,
				style: "unit",
				unit: "gigabyte",
				unitDisplay: "short",
			}).format(41.3)
		);
	});

	test("falls back to Core's string when the count is missing", () => {
		expect(fmtBytes(null, "41.3 GB", "de")).toBe("41.3 GB");
		expect(fmtBytes(undefined, "", "de")).toBe("");
	});
});

describe("usageText", () => {
	test("joins used and total through the translator", () => {
		const german: LiteralMessage = (source, values) =>
			englishTl(
				source === "{used} / {total}" ? "{used} von {total}" : source,
				values
			);
		expect(
			usageText(
				{
					totalBytes: TOTAL_RAM,
					totalHuman: "63.7 GB",
					usedBytes: USED_RAM,
					usedHuman: "41.3 GB",
				},
				german,
				"de"
			)
		).toBe(`41,3${NBSP}GB von 63,7${NBSP}GB`);
	});

	test("shows the known side alone, or nothing", () => {
		expect(
			usageText(
				{
					totalBytes: TOTAL_RAM,
					totalHuman: "",
					usedBytes: null,
					usedHuman: "",
				},
				englishTl,
				"en"
			)
		).toBe("63.7 GB");
		expect(
			usageText(
				{ totalBytes: null, totalHuman: "", usedBytes: null, usedHuman: "" },
				englishTl,
				"en"
			)
		).toBe("");
	});
});
