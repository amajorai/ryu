import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	exporterFieldLabel,
	exporterFieldPlaceholder,
} from "./PrivacySettings-options.ts";

const GERMAN: Record<string, string> = {
	"{label}: {example}": "{label}: {example}",
	"Region or site": "Region oder Site",
	"us, eu, or us5": "us, eu oder us5",
	"API key reference": "API-Schlüssel-Referenz",
};

const german: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values, "de");

describe("exporter field copy", () => {
	test("placeholder translates the label and a prose example", () => {
		expect(exporterFieldPlaceholder("region", german)).toBe(
			"Region oder Site: us, eu oder us5"
		);
	});

	test("reference examples stay literal while the label translates", () => {
		expect(exporterFieldPlaceholder("apiKeyRef", german)).toBe(
			"API-Schlüssel-Referenz: env:LANGSMITH_API_KEY"
		);
		expect(exporterFieldLabel("apiKeyRef", german)).toBe(
			"API-Schlüssel-Referenz"
		);
	});
});
