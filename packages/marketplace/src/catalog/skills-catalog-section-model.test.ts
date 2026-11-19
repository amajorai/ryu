// The skill stat strip under German, Japanese and Arabic UIs: source-reported
// counts use the reader's number format, dates the reader's calendar wording, and
// the Audits caption is one catalog sentence instead of a spliced English string.

import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import {
	formatSkillCount,
	skillInstallsValue,
	skillStatItems,
} from "./skills-catalog-section-model.ts";
import type { SkillDetail } from "./types.ts";

const AUDITS_SUB = "{passed}/{total} pass";

const CATALOGS: Record<string, Record<string, string>> = {
	ar: { [AUDITS_SUB]: "نجح {passed} من {total}" },
	de: { [AUDITS_SUB]: "{passed}/{total} bestanden" },
	ja: { [AUDITS_SUB]: "{total} 件中 {passed} 件合格" },
};

function standIn(locale: string) {
	const catalog = CATALOGS[locale] ?? {};
	return {
		direction: locale === "ar" ? ("rtl" as const) : ("ltr" as const),
		locale,
		translate(source: string, values?: MessageValuesInput, fallback?: string) {
			const english = fallback ?? source;
			return formatMessage(catalog[english] ?? english, values, locale);
		},
	};
}

let active: ReturnType<typeof standIn> | null = null;

function useLocale(locale: string) {
	active = standIn(locale);
	registerActiveI18nRuntime(active);
}

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

function metadata(
	over: Partial<SkillDetail["metadata"]> = {}
): SkillDetail["metadata"] {
	return {
		firstSeen: "2025-03-14T00:00:00Z",
		githubPushedAt: null,
		githubStars: "1500",
		installs: null,
		securityAudits: [
			{ status: "pass" },
			{ status: "Pass" },
			{ status: "fail" },
		],
		...over,
	} as SkillDetail["metadata"];
}

function cell(label: string, meta = metadata()) {
	return skillStatItems({
		downloads: null,
		installs: null,
		metadata: meta,
	}).find((item) => item.label === label);
}

describe("skillStatItems under a non-English UI", () => {
	test("German: stars use the German group separator", () => {
		useLocale("de");
		expect(cell("Stars")?.value).toBe("1.500");
	});

	test("German: the Audits caption comes from the catalog", () => {
		useLocale("de");
		const audits = cell("Audits");
		expect(audits?.sub).toBe("2/3 bestanden");
		expect(audits?.value).toBe("3");
	});

	test("Japanese: first seen is a Japanese date, not the raw timestamp", () => {
		useLocale("ja");
		const firstSeen = cell("First seen")?.value;
		expect(firstSeen).toBe("2025年3月14日");
		expect(cell("Audits")?.sub).toBe("3 件中 2 件合格");
	});

	test("Arabic: the Audits caption is a whole Arabic sentence", () => {
		useLocale("ar");
		expect(cell("Audits")?.sub).toBe(
			formatMessage("نجح {passed} من {total}", { passed: 2, total: 3 }, "ar")
		);
	});

	test("English keeps the source wording", () => {
		useLocale("en");
		expect(cell("Stars")?.value).toBe("1,500");
		expect(cell("Audits")?.sub).toBe("2/3 pass");
	});

	test("an unreported first-seen date drops the cell", () => {
		useLocale("en");
		expect(cell("First seen", metadata({ firstSeen: null }))).toBeUndefined();
	});
});

describe("formatSkillCount", () => {
	test("reads compact source counts and reformats them for the reader", () => {
		useLocale("de");
		expect(formatSkillCount("1.2k")).toBe("1.200");
		expect(formatSkillCount("2,500")).toBe("2.500");
	});

	test("keeps a non-count value as reported and drops an empty one", () => {
		useLocale("en");
		expect(formatSkillCount("lots")).toBe("lots");
		expect(formatSkillCount("  ")).toBeNull();
		expect(formatSkillCount(null)).toBeNull();
	});
});

describe("skillInstallsValue", () => {
	test("the card's count wins and uses the reader's number format", () => {
		useLocale("de");
		expect(skillInstallsValue(2500, "9,999")).toBe("2.500");
	});

	test("falls back to the reported string, reformatted for the reader", () => {
		useLocale("de");
		expect(skillInstallsValue(0, "1.2k")).toBe("1.200");
		expect(skillInstallsValue(0, null)).toBeNull();
	});
});
