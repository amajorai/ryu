import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { adminHelpEntries } from "./secrets-help-admin.ts";
import { renderHelpEntries } from "./secrets-help-format.ts";

describe("secrets admin help", () => {
	test("headings and descriptions translate; broker usages stay verbatim", () => {
		const german = createCliTranslator("de", {
			"Credential broker:": "Credential-Broker:",
			"Print the broker CA certificate (PEM)":
				"Das CA-Zertifikat des Brokers ausgeben (PEM)",
		});
		const text = renderHelpEntries(adminHelpEntries(german)).join("\n");
		expect(text).toContain("Credential-Broker:");
		expect(text).toMatch(
			/ {2}broker ca +Das CA-Zertifikat des Brokers ausgeben \(PEM\)/u
		);
		expect(text).toContain("  quota list | quota delete NAME");
	});
});
