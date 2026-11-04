import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { rustModuleSource } from "../../../lib/api/rust-module-source.ts";
import {
	doctorSeverityLabel,
	gatewayDoctorFindingCopy,
	TRANSLATED_GATEWAY_DOCTOR_CHECK_IDS,
} from "./doctor-finding-copy.ts";

const repoFile = (path: string): string =>
	readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");
const marked: LiteralMessage = (source, values = {}) =>
	`«${formatMessage(source, values, "en")}»`;

/** `finding(` / `fixable_finding(` call sites: check id, summary, action. */
function gatewayFindingSites(): {
	action: string;
	checkId: string;
	summary: string;
}[] {
	const source = repoFile("apps/gateway/src/api/doctor.rs");
	const sites = [];
	const call =
		/(?:fixable_)?finding\(\s*"([a-z][a-z.-]+)",\s*"[a-z]+",\s*[^,]+,\s*"([^"]+)",[\s\S]*?Some\("([^"]+)"\),\s*\)\);/gu;
	for (const match of source.matchAll(call)) {
		const [, checkId = "", summary = "", action = ""] = match;
		sites.push({ action, checkId, summary });
	}
	return sites;
}

function driftCodes(): string[] {
	const source = repoFile("apps/gateway/src/policy/drift.rs");
	return [...source.matchAll(/DriftWarning::new\(\s*"([a-z_]+)"/gu)].map(
		(match) => match[1] ?? ""
	);
}

function coreAppendedCodes(): string[] {
	const source = rustModuleSource("apps/core/src/server");
	return [
		...source.matchAll(/add_finding\(\s*&mut findings,\s*"([a-z.-]+)"/gu),
	].map((match) => match[1] ?? "");
}

describe("Gateway doctor check-id coverage", () => {
	test("every check id the Gateway emits has a translated message", () => {
		const sites = gatewayFindingSites();
		// Guard the scraper itself: the doctor has well over a dozen checks.
		expect(sites.length).toBeGreaterThan(15);
		const emitted = [
			...sites.map((site) => site.checkId),
			...driftCodes(),
			...coreAppendedCodes(),
		];
		expect(driftCodes().length).toBeGreaterThanOrEqual(5);
		expect(coreAppendedCodes().length).toBeGreaterThanOrEqual(3);
		const missing = emitted.filter(
			(checkId) => !TRANSLATED_GATEWAY_DOCTOR_CHECK_IDS.includes(checkId)
		);
		expect(missing).toEqual([]);
	});

	test("the English messages match the Gateway's summary and action", () => {
		for (const site of gatewayFindingSites()) {
			const copy = gatewayDoctorFindingCopy(
				{
					checkId: site.checkId,
					detail: "",
					recommendedAction: site.action,
					severity: "warning",
					summary: "(server)",
				},
				english
			);
			expect({ checkId: site.checkId, summary: copy.summary }).toEqual({
				checkId: site.checkId,
				summary: site.summary,
			});
			expect(copy.action).toBe(site.action);
		}
	});
});

describe("drift and Core-appended sentences", () => {
	test("the English details match drift.rs and Core's appended findings", () => {
		const drift = repoFile("apps/gateway/src/policy/drift.rs");
		const driftSites = [
			...drift.matchAll(
				/DriftWarning::new\(\s*"([a-z_]+)",\s*"[a-z]+",\s*"([^"]+)",/gu
			),
		];
		expect(driftSites.length).toBeGreaterThanOrEqual(5);
		for (const [, checkId = "", detail = ""] of driftSites) {
			const copy = gatewayDoctorFindingCopy(
				{
					checkId,
					detail: "(server)",
					recommendedAction: "(server)",
					severity: "warning",
					summary: "(server)",
				},
				english
			);
			expect({ checkId, detail: copy.detail }).toEqual({ checkId, detail });
		}
		const core = rustModuleSource("apps/core/src/server");
		const coreSites = [
			...core.matchAll(
				/add_finding\(\s*&mut findings,\s*"([a-z.-]+)",\s*"[a-z]+",\s*"[a-z]+",\s*"([^"]+)",\s*"([^"]+)",\s*"[a-z-]+",\s*"([^"]+)",/gu
			),
		];
		expect(coreSites.length).toBeGreaterThanOrEqual(3);
		for (const [
			,
			checkId = "",
			summary = "",
			detail = "",
			action = "",
		] of coreSites) {
			const copy = gatewayDoctorFindingCopy(
				{
					checkId,
					detail: "(server)",
					recommendedAction: "(server)",
					severity: "warning",
					summary: "(server)",
				},
				english
			);
			expect({
				action: copy.action,
				checkId,
				detail: copy.detail,
				summary: copy.summary,
			}).toEqual({
				action,
				checkId,
				detail,
				summary,
			});
		}
	});
});

describe("gatewayDoctorFindingCopy", () => {
	test("reads the bind address into the translated detail", () => {
		const detail =
			"Gateway is bound to 0.0.0.0:7981 but auth is disabled. This would expose provider credentials and billable traffic to the network.";
		const finding = {
			checkId: "security.exposed-without-auth",
			detail,
			recommendedAction: "server action",
			severity: "error",
			summary: "server summary",
		};
		expect(gatewayDoctorFindingCopy(finding, english).detail).toBe(detail);
		expect(gatewayDoctorFindingCopy(finding, marked)).toEqual({
			action:
				"«Bind Gateway to loopback or enable authentication before exposing it.»",
			detail: `«${detail}»`,
			summary: "«Gateway is exposed without authentication»",
		});
	});

	test("turns the on/off words into select values", () => {
		const seen: unknown[] = [];
		const spy: LiteralMessage = (source, values = {}) => {
			seen.push(values);
			return formatMessage(source, values, "en");
		};
		const detail = "Inbound scanning is off; outbound scanning is on.";
		const copy = gatewayDoctorFindingCopy(
			{
				checkId: "security.partial-firewall-scan",
				detail,
				severity: "warning",
				summary: "",
			},
			spy
		);
		expect(copy.detail).toBe(detail);
		expect(copy.action).toBeUndefined();
		expect(seen).toContainEqual({ inbound: "off", outbound: "on" });
		const redaction = gatewayDoctorFindingCopy(
			{
				checkId: "security.redaction-disabled",
				detail: "Secret redaction is on; PII redaction is off.",
				severity: "warning",
				summary: "",
			},
			english
		);
		expect(redaction.detail).toBe(
			"Secret redaction is on; PII redaction is off."
		);
	});

	test("reads the path and mode, and the provider id", () => {
		const permissions =
			"/home/a/.ryu/gateway.toml has mode 644; provider and auth metadata should normally be readable only by the Gateway account.";
		expect(
			gatewayDoctorFindingCopy(
				{
					checkId: "security.config-permissions",
					detail: permissions,
					severity: "warning",
					summary: "",
				},
				english
			).detail
		).toBe(permissions);
		const provider =
			"Routing selects provider `openai`, but that provider is not configured on this Gateway.";
		expect(
			gatewayDoctorFindingCopy(
				{
					checkId: "connectivity.default-provider-missing",
					detail: provider,
					severity: "warning",
					summary: "",
				},
				marked
			).detail
		).toBe(`«${provider}»`);
	});

	test("keeps the Gateway's English when the detail no longer parses", () => {
		const copy = gatewayDoctorFindingCopy(
			{
				checkId: "security.exposed-without-auth",
				detail: "A reworded sentence.",
				severity: "error",
				summary: "",
			},
			marked
		);
		expect(copy.detail).toBe("A reworded sentence.");
		expect(copy.summary).toBe("«Gateway is exposed without authentication»");
	});

	test("keeps every field of an unknown check id", () => {
		const finding = {
			checkId: "future.check",
			detail: "New detail.",
			recommendedAction: "New action.",
			severity: "info",
			summary: "New summary",
		};
		expect(gatewayDoctorFindingCopy(finding, marked)).toEqual({
			action: "New action.",
			detail: "New detail.",
			summary: "New summary",
		});
	});

	test("drift codes share one summary and action", () => {
		const copy = gatewayDoctorFindingCopy(
			{
				checkId: "exec_without_firewall",
				detail: "server detail",
				recommendedAction: "server action",
				severity: "error",
				summary: "server summary",
			},
			english
		);
		expect(copy.summary).toBe("Policy settings contradict each other");
		expect(copy.detail).toBe(
			"Tool execution is enabled but the DLP firewall is disabled: tool inputs and outputs flow with no inspection."
		);
	});

	test("labels the severity words", () => {
		expect(doctorSeverityLabel("error", marked)).toBe("«Error»");
		expect(doctorSeverityLabel("warning", marked)).toBe("«Warning»");
		expect(doctorSeverityLabel("info", marked)).toBe("«Info»");
		expect(doctorSeverityLabel("other", marked)).toBe("other");
	});
});
