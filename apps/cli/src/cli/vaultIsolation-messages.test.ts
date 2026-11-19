import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";
import {
	isolationError,
	isolationText,
	reasonOf,
} from "./vaultIsolation-messages.ts";

const german = createCliTranslator("de", {
	"--mount {raw}: {reason}": "--mount {raw}: {reason}",
	"refusing to mount the host root filesystem.":
		"Das Stammdateisystem des Hosts wird nicht eingebunden.",
	"ryu: running {command} in an isolated container ({network}); network access only through the credential broker.":
		"ryu: {command} läuft in einem isolierten Container ({network}); Netzwerkzugriff nur über den Credential-Broker.",
});

describe("isolation messages", () => {
	test("a refusal keeps English and renders a nested reason in the locale", () => {
		const reason = reasonOf(isolationError(isolationText.hostRoot()));
		const error = isolationError(isolationText.mountRefused("/:/x", reason));
		expect(error.message).toBe(
			"--mount /:/x: refusing to mount the host root filesystem."
		);
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, german.tf)).toBe(
			"--mount /:/x: Das Stammdateisystem des Hosts wird nicht eingebunden."
		);
	});

	test("status lines render in the locale; plain errors pass through", () => {
		expect(
			renderLocalized(isolationText.running("bash", "ryu-vault-1"), german.tf)
		).toBe(
			"ryu: bash läuft in einem isolierten Container (ryu-vault-1); Netzwerkzugriff nur über den Credential-Broker."
		);
		expect(reasonOf(new Error("EACCES"))).toBe("EACCES");
		expect(reasonOf("x")).toBe("x");
	});
});
