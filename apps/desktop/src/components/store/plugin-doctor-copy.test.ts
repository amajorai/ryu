import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { rustModuleSource } from "../../lib/api/rust-module-source.ts";
import {
	pluginDoctorFindingCopy,
	pluginDoctorSeverityLabel,
	TRANSLATED_PLUGIN_DOCTOR_CHECK_IDS,
} from "./plugin-doctor-copy.ts";

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");
const marked: LiteralMessage = (source, values = {}) =>
	`«${formatMessage(source, values, "en")}»`;

/** `plugin_doctor_finding(` call sites with literal check ids and sentences. */
function coreFindingSites(): {
	action: string;
	checkId: string;
	detail: string;
	summary: string;
}[] {
	const source = rustModuleSource("apps/core/src/server");
	const sites = [];
	const call =
		/plugin_doctor_finding\(\s*[a-z_]+,\s*"([a-z.-]+)",\s*"[a-z]+",\s*"[a-z]+",\s*"([^"]+)",\s*(?:"([^"]+)"|&format!)[\s\S]*?"([^"]+)",\s*json!/gu;
	for (const match of source.matchAll(call)) {
		const [, checkId = "", summary = "", detail = "", action = ""] = match;
		sites.push({ action, checkId, detail, summary });
	}
	return sites;
}

describe("plugin doctor check-id coverage", () => {
	test("every literal check id Core emits has a translated message", () => {
		const sites = coreFindingSites();
		expect(sites.length).toBeGreaterThan(14);
		const missing = sites
			.map((site) => site.checkId)
			.filter(
				(checkId) => !TRANSLATED_PLUGIN_DOCTOR_CHECK_IDS.includes(checkId)
			);
		expect(missing).toEqual([]);
	});

	test("the English messages match Core's sentences", () => {
		for (const site of coreFindingSites()) {
			const copy = pluginDoctorFindingCopy(
				{
					checkId: site.checkId,
					detail: "(server)",
					severity: "error",
					summary: "(server)",
				},
				english
			);
			expect({ checkId: site.checkId, summary: copy.summary }).toEqual({
				checkId: site.checkId,
				summary: site.summary,
			});
			expect(copy.action).toBe(site.action);
			if (site.detail) {
				expect(copy.detail).toBe(site.detail);
			}
		}
	});
});

describe("pluginDoctorFindingCopy", () => {
	test("translates summary, detail, action and severity separately", () => {
		expect(
			pluginDoctorFindingCopy(
				{
					checkId: "manifest.version",
					detail: "server detail",
					severity: "error",
					summary: "server summary",
				},
				marked
			)
		).toEqual({
			action: "«Publish a semver version in the manifest.»",
			detail:
				"«Core cannot compare upgrades or record a reproducible installed artifact without a version.»",
			severity: "«Error»",
			summary: "«Manifest version is missing»",
		});
	});

	test("reads the eval counts from the evidence", () => {
		const finding = {
			checkId: "evals.suite-ready",
			detail:
				"3 case(s) and 1 grader(s) are available; the read-only doctor did not execute them.",
			evidence: { caseCount: 3, graderCount: 1 },
			severity: "info",
			summary: "",
		};
		expect(pluginDoctorFindingCopy(finding, english).detail).toBe(
			"3 cases and 1 grader are available; the read-only doctor did not execute them."
		);
		expect(
			pluginDoctorFindingCopy({ ...finding, evidence: {} }, english).detail
		).toBe(finding.detail);
	});

	test("an eval-file issue keeps the parser's English detail", () => {
		const copy = pluginDoctorFindingCopy(
			{
				checkId: "evals.invalid-case",
				detail: "case.yaml is not valid YAML",
				severity: "warning",
				summary: "Package eval suite needs attention",
			},
			marked
		);
		expect(copy.summary).toBe("«Package eval suite needs attention»");
		expect(copy.detail).toBe("case.yaml is not valid YAML");
		expect(copy.action).toBe(
			"«Fix the reported eval file and run the plugin doctor again.»"
		);
	});

	test("an unknown check id keeps Core's English", () => {
		expect(
			pluginDoctorFindingCopy(
				{
					checkId: "future.check",
					detail: "New detail.",
					recommendedAction: "New action.",
					severity: "critical",
					summary: "New summary",
				},
				marked
			)
		).toEqual({
			action: "New action.",
			detail: "New detail.",
			severity: "critical",
			summary: "New summary",
		});
	});

	test("labels the severity words", () => {
		expect(pluginDoctorSeverityLabel("warning", marked)).toBe("«Warning»");
		expect(pluginDoctorSeverityLabel("info", marked)).toBe("«Info»");
	});
});

describe("pluginDoctorFindingCopy in German and Arabic", () => {
	const catalogTl =
		(locale: string, catalog: Record<string, string>): LiteralMessage =>
		(source, values = {}) =>
			formatMessage(catalog[source] ?? source, values, locale);
	const casesSource =
		"{cases, plural, one {{casesText} case} other {{casesText} cases}} and {graders, plural, one {{gradersText} grader} other {{gradersText} graders}} are available; the read-only doctor did not execute them.";

	test("German pluralises the eval counts from the evidence", () => {
		const de = catalogTl("de", {
			[casesSource]:
				"{cases, plural, one {{casesText} Fall} other {{casesText} Fälle}} und {graders, plural, one {{gradersText} Bewerter} other {{gradersText} Bewerter}} sind verfügbar; der schreibgeschützte Doctor hat sie nicht ausgeführt.",
			"Behavioral eval suite discovered": "Verhaltens-Eval-Suite gefunden",
			Info: "Info",
		});
		const copy = pluginDoctorFindingCopy(
			{
				checkId: "evals.suite-ready",
				detail: "3 case(s) and 1 grader(s) are available.",
				evidence: { caseCount: 3, graderCount: 1 },
				severity: "info",
				summary: "Behavioral eval suite discovered",
			},
			de
		);
		expect(copy.summary).toBe("Verhaltens-Eval-Suite gefunden");
		expect(copy.detail).toBe(
			"3 Fälle und 1 Bewerter sind verfügbar; der schreibgeschützte Doctor hat sie nicht ausgeführt."
		);
	});

	test("Arabic replaces the severity, summary and detail", () => {
		const ar = catalogTl("ar", {
			Error: "خطأ",
			"Manifest version is missing": "إصدار البيان مفقود",
			"Core cannot compare upgrades or record a reproducible installed artifact without a version.":
				"لا يمكن للنواة مقارنة الترقيات بدون إصدار.",
		});
		const copy = pluginDoctorFindingCopy(
			{
				checkId: "manifest.version",
				detail: "server detail",
				severity: "error",
				summary: "Manifest version is missing",
			},
			ar
		);
		expect(copy.severity).toBe("خطأ");
		expect(copy.summary).toBe("إصدار البيان مفقود");
		expect(copy.detail).toBe("لا يمكن للنواة مقارنة الترقيات بدون إصدار.");
	});
});
