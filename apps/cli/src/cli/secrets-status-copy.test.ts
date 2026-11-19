// Vault change-request and broker-proposal states print as whole sentences, so
// a German reader never sees a raw `applied` or `expired` inside German text.
// The stub catalog stands in for the German pack.
import { describe, expect, mock, test } from "bun:test";
import type { VaultChangeStatus } from "@ryuhq/core-client/vault";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"No applied change requests.": "Keine angewendeten Änderungsanfragen.",
	"No pending change requests.": "Keine offenen Änderungsanfragen.",
	"Change request {id} is now applied.":
		"Änderungsanfrage {id} ist jetzt angewendet.",
	"Change request {id} is still pending.":
		"Änderungsanfrage {id} ist noch offen.",
	"Proposal {id} has expired (environment {environment}).":
		"Vorschlag {id} ist abgelaufen (Umgebung {environment}).",
	"Proposal {id} was approved (environment {environment}).":
		"Vorschlag {id} wurde genehmigt (Umgebung {environment}).",
	"No expired proposals.": "Keine abgelaufenen Vorschläge.",
	"No pending proposals.": "Keine offenen Vorschläge.",
	"Shared values: control plane": "Gemeinsame Werte: Steuerungsebene",
	"Shared values: local": "Gemeinsame Werte: lokal",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const {
	changeRequestNowText,
	noChangeRequestsText,
	noProposalsText,
	proposalStatusText,
	sharedValuesSourceText,
} = await import("./secrets-status-copy.ts");

describe("Vault status sentences under German", () => {
	test("an empty change-request list names its status in German", () => {
		expect(noChangeRequestsText("applied")).toBe(
			"Keine angewendeten Änderungsanfragen."
		);
		expect(noChangeRequestsText("pending")).toBe(
			"Keine offenen Änderungsanfragen."
		);
	});

	test("a decided change request reads as one German sentence", () => {
		expect(changeRequestNowText("cr_1", "applied")).toBe(
			"Änderungsanfrage cr_1 ist jetzt angewendet."
		);
		expect(changeRequestNowText("cr_1", "pending")).toBe(
			"Änderungsanfrage cr_1 ist noch offen."
		);
	});

	test("a proposal's state reads as one German sentence", () => {
		expect(
			proposalStatusText({ environment: "prod", id: "bp_1", status: "expired" })
		).toBe("Vorschlag bp_1 ist abgelaufen (Umgebung prod).");
		expect(
			proposalStatusText({
				environment: "prod",
				id: "bp_1",
				status: "approved",
			})
		).toBe("Vorschlag bp_1 wurde genehmigt (Umgebung prod).");
	});

	test("an empty proposal list names its status in German", () => {
		expect(noProposalsText("expired")).toBe("Keine abgelaufenen Vorschläge.");
		expect(noProposalsText("pending")).toBe("Keine offenen Vorschläge.");
	});

	test("the shared-values source is one German line, not an English word", () => {
		expect(sharedValuesSourceText(true)).toBe(
			"Gemeinsame Werte: Steuerungsebene"
		);
		expect(sharedValuesSourceText(false)).toBe("Gemeinsame Werte: lokal");
	});

	test("a status Core adds later still prints, through the generic template", () => {
		const future = "archived" as VaultChangeStatus;
		expect(noChangeRequestsText(future)).toBe("No archived change requests.");
		expect(changeRequestNowText("cr_2", future)).toBe(
			"Change request cr_2 is now archived."
		);
		expect(noProposalsText("withdrawn" as "pending")).toBe(
			"No withdrawn proposals."
		);
	});
});
