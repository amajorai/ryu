// Keeps the agent-editor search index honest.
//
// The index stores labels VERBATIM because the DOM anchor is an exact text
// match — a renamed row does not degrade the search, it silently breaks it. So
// this re-reads the editor source and fails on any indexed label that no longer
// appears there, which is the only thing a unit test can check without a DOM.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_SETTINGS_ENTRIES,
	AGENT_TAB_LABELS,
	searchAgentSettings,
} from "./agent-settings-search.ts";

const SOURCE = readFileSync(join(import.meta.dir, "agent-edit.tsx"), "utf8");

describe("agent settings index", () => {
	test("every indexed label still exists in the editor", () => {
		const missing = AGENT_SETTINGS_ENTRIES.filter(
			(entry) => !SOURCE.includes(entry.label)
		).map((entry) => `${entry.id} → "${entry.label}"`);
		expect(missing).toEqual([]);
	});

	test("every indexed group still exists in the editor", () => {
		const missing = AGENT_SETTINGS_ENTRIES.filter(
			(entry) => entry.group && !SOURCE.includes(entry.group)
		).map((entry) => `${entry.id} → "${entry.group}"`);
		expect(missing).toEqual([]);
	});

	test("ids are unique", () => {
		const ids = AGENT_SETTINGS_ENTRIES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every entry files under a known tab", () => {
		for (const entry of AGENT_SETTINGS_ENTRIES) {
			expect(AGENT_TAB_LABELS[entry.tab]).toBeTruthy();
		}
	});
});

describe("searchAgentSettings", () => {
	test("an empty query matches nothing", () => {
		expect(searchAgentSettings("")).toEqual([]);
		expect(searchAgentSettings("   ")).toEqual([]);
	});

	test("finds a row by a word that is not in its label", () => {
		const hits = searchAgentSettings("cron");
		expect(hits.map((h) => h.id)).toContain("agent.cron");
		// The keyword path, not the label path: nothing is called "crontab".
		expect(searchAgentSettings("crontab").map((h) => h.id)).toContain(
			"agent.cron"
		);
	});

	test("extra terms narrow rather than widen", () => {
		const broad = searchAgentSettings("memory");
		const narrow = searchAgentSettings("memory write");
		expect(narrow.length).toBeLessThan(broad.length);
		expect(narrow.map((h) => h.id)).toContain("agent.memory-write");
	});

	test("a label prefix outranks a mid-string match", () => {
		const hits = searchAgentSettings("to");
		expect(hits[0]?.label).toBe("Tone");
	});

	test("ranks a label match above a keyword-only match", () => {
		const hits = searchAgentSettings("skills");
		expect(hits[0]?.id).toBe("agent.skills");
	});

	test("finds the identity and account access sections by plain words", () => {
		expect(searchAgentSettings("on my behalf")[0]?.id).toBe(
			"agent.identity-mode"
		);
		expect(searchAgentSettings("treg").map((h) => h.id)).toContain(
			"agent.account-access"
		);
		expect(searchAgentSettings("which accounts")[0]?.id).toBe(
			"agent.account-access"
		);
	});

	test("respects the limit", () => {
		expect(searchAgentSettings("a", 3).length).toBeLessThanOrEqual(3);
	});
});
