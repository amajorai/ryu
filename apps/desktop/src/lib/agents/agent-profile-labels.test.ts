import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	AgentLifecycleStatus,
	AgentSafetyProfile,
} from "@/src/lib/api/agents.ts";
import {
	AGENT_LIFECYCLE_LABELS,
	AGENT_SAFETY_PROFILE_LABELS,
	agentLifecycleLabel,
	agentSafetyProfileLabel,
} from "./agent-profile-labels.ts";

function loadCatalog(locale: string): Record<string, string> {
	return JSON.parse(
		readFileSync(
			new URL(
				`../../../../../packages/i18n/locales/${locale}.json`,
				import.meta.url
			),
			"utf8"
		)
	) as Record<string, string>;
}

// The real ICU formatter over a shipped locale catalog.
function catalogMessages(locale: string): LiteralMessage {
	const catalog = loadCatalog(locale);
	return (source: string, values?: MessageValuesInput) =>
		formatMessage(catalog[source] ?? source, values ?? {}, locale);
}

const identity: LiteralMessage = (
	source: string,
	values?: MessageValuesInput
) => formatMessage(source, values ?? {}, "en");

const japanese = catalogMessages("ja");

const SAFETY_PROFILES = Object.keys(
	AGENT_SAFETY_PROFILE_LABELS
) as AgentSafetyProfile[];
const LIFECYCLE_STATUSES = Object.keys(
	AGENT_LIFECYCLE_LABELS
) as AgentLifecycleStatus[];

const LATIN_WORD = /[A-Za-z]{2,}/;

describe("agent profile labels", () => {
	test("covers every safety profile and lifecycle status", () => {
		expect(SAFETY_PROFILES.sort()).toEqual([
			"approval_required",
			"autonomous",
			"read_only",
			"verified_plan_only",
		]);
		expect(LIFECYCLE_STATUSES.sort()).toEqual(["active", "draft", "trial"]);
	});

	test("renders sentence-case English, never the raw enum value", () => {
		expect(agentSafetyProfileLabel("verified_plan_only", identity)).toBe(
			"Verified plans only"
		);
		expect(agentSafetyProfileLabel("read_only", identity)).toBe("Read-only");
		expect(agentLifecycleLabel("trial", identity)).toBe("Trial");
		expect(agentLifecycleLabel("draft", identity)).toBe("Draft");
	});

	test("every label is translated under the Japanese catalog", () => {
		for (const profile of SAFETY_PROFILES) {
			const label = agentSafetyProfileLabel(profile, japanese);
			expect(label).not.toMatch(LATIN_WORD);
			expect(label).not.toBe(AGENT_SAFETY_PROFILE_LABELS[profile]);
		}
		for (const status of LIFECYCLE_STATUSES) {
			const label = agentLifecycleLabel(status, japanese);
			expect(label).not.toMatch(LATIN_WORD);
			expect(label).not.toBe(AGENT_LIFECYCLE_LABELS[status]);
		}
	});

	test("Arabic and German render their catalog translations", () => {
		const arabic = catalogMessages("ar");
		const german = catalogMessages("de");
		const arabicCatalog = loadCatalog("ar");
		const germanCatalog = loadCatalog("de");
		for (const profile of SAFETY_PROFILES) {
			const source = AGENT_SAFETY_PROFILE_LABELS[profile];
			const arabicLabel = agentSafetyProfileLabel(profile, arabic);
			expect(arabicLabel).not.toMatch(LATIN_WORD);
			expect(arabicLabel).toBe(arabicCatalog[source] ?? "");
			const germanLabel = agentSafetyProfileLabel(profile, german);
			expect(germanLabel).toBe(germanCatalog[source] ?? "");
			expect(germanLabel).not.toBe(source);
		}
		for (const status of LIFECYCLE_STATUSES) {
			const source = AGENT_LIFECYCLE_LABELS[status];
			const arabicLabel = agentLifecycleLabel(status, arabic);
			expect(arabicLabel).not.toMatch(LATIN_WORD);
			expect(arabicLabel).toBe(arabicCatalog[source] ?? "");
			const germanLabel = agentLifecycleLabel(status, german);
			expect(germanLabel).toBe(germanCatalog[source] ?? "");
			expect(germanLabel).not.toBe(source);
		}
	});
});
