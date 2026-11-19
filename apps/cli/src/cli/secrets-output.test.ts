// The export warning for missing Team and Organization values is one whole
// sentence per case, so a language pack translates it around the error code
// and the refusal hint instead of leaving a hand-built English line.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const UNREACHABLE =
	"Warning: Team and Organization values are missing because the control plane couldn't be reached ({sharedError}). Only your own and this node's values were used.";
const REFUSED =
	"Warning: Team and Organization values are missing because the control plane refused this request ({code}). Only your own and this node's values were used.";
const REFUSED_WITH_HINT =
	"Warning: Team and Organization values are missing because the control plane refused this request ({code}). {hint} Only your own and this node's values were used.";
const IP_HINT =
	"This node's organization doesn't allow requests from this node's network address. Ask an organization admin.";

// Pin the CLI to a German stub catalog before the module under test loads,
// the way LANG=de_DE.UTF-8 does at startup; the shipped catalog has no
// entries for these sentences yet.
const german = createCliTranslator("de", {
	[UNREACHABLE]:
		"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene nicht erreichbar war ({sharedError}). Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.",
	[REFUSED]:
		"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene diese Anfrage abgelehnt hat ({code}). Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.",
	[REFUSED_WITH_HINT]:
		"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene diese Anfrage abgelehnt hat ({code}). {hint} Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.",
	[IP_HINT]:
		"Die Organisation dieses Knotens lässt keine Anfragen von seiner Netzwerkadresse zu. Wende dich an eine Organisationsadministration.",
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
const { sharedValuesMissingWarning } = await import("./secrets-output.ts");
const { accessRefusalHint } = await import("../core/native-errors.ts");

describe("sharedValuesMissingWarning under a German translator", () => {
	test("names the outage inside the translated sentence", () => {
		expect(
			sharedValuesMissingWarning(
				"vault_shared_unreachable: the control plane answered 503"
			)
		).toBe(
			"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene nicht erreichbar war (vault_shared_unreachable: the control plane answered 503). Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.\n"
		);
	});

	test("translates the refusal hint inside the refusal sentence", () => {
		// The fixture hint must be the one the CLI ships for this code.
		expect(accessRefusalHint({ code: "org_ip_not_allowed" })?.hint).toBe(
			IP_HINT
		);
		expect(
			sharedValuesMissingWarning("vault_shared_refused: org_ip_not_allowed")
		).toBe(
			"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene diese Anfrage abgelehnt hat (org_ip_not_allowed). Die Organisation dieses Knotens lässt keine Anfragen von seiner Netzwerkadresse zu. Wende dich an eine Organisationsadministration. Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.\n"
		);
	});

	test("drops the hint slot when the refusal code has no hint", () => {
		const warning = sharedValuesMissingWarning(
			"vault_shared_refused: some_new_code"
		);
		expect(warning).toBe(
			"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene diese Anfrage abgelehnt hat (some_new_code). Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.\n"
		);
	});
});
