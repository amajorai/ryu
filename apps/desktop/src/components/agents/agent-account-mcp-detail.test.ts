import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { mcpConnectionDetail } from "./agent-account-mcp-detail.ts";

const german: Record<string, string> = JSON.parse(
	readFileSync(
		new URL("../../../../../packages/i18n/locales/de.json", import.meta.url),
		"utf8"
	)
);

const englishTl = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");
const germanTl = (source: string, values?: MessageValuesInput) =>
	formatMessage(german[source] ?? source, values, "de");

describe("mcpConnectionDetail", () => {
	test("German renders the profile as one translated message", () => {
		expect(mcpConnectionDetail("alice@example.com", "work", germanTl)).toBe(
			"alice@example.com · Profil work"
		);
	});

	test("English keeps the account and profile", () => {
		expect(mcpConnectionDetail("alice@example.com", "work", englishTl)).toBe(
			"alice@example.com · Profile work"
		);
	});

	test("a connection without an account label shows only the profile", () => {
		expect(mcpConnectionDetail(null, "prof_1", germanTl)).toBe("Profil prof_1");
		expect(mcpConnectionDetail("", "prof_1", englishTl)).toBe("Profile prof_1");
	});
});
