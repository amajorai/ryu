// A Services action's toast is one whole sentence per action and outcome, not
// "{label} failed {name}" ("Restarted failed ryu-core").
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Couldn't restart {name}": "{name} konnte nicht neu gestartet werden",
	"Started all services": "Alle Dienste gestartet",
	"Started {name}": "{name} gestartet",
	downloading: "wird heruntergeladen",
	"install failed": "Installation fehlgeschlagen",
	stopped: "angehalten",
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
const { serviceActionNotice } = await import("./services-notices.ts");
const { rowStatus } = await import("./services-rows.tsx");

const THEME = {
	colors: {
		error: "red",
		mutedForeground: "gray",
		primary: "blue",
		success: "green",
		warning: "yellow",
	},
};

describe("Services notices", () => {
	test("each action and outcome is one translated sentence", () => {
		expect(serviceActionNotice("start", true, "ollama")).toBe(
			"ollama gestartet"
		);
		expect(serviceActionNotice("restart", false, "ollama")).toBe(
			"ollama konnte nicht neu gestartet werden"
		);
		expect(serviceActionNotice("startAll", true, "ollama")).toBe(
			"Alle Dienste gestartet"
		);
	});

	test("English failures read as sentences", () => {
		expect(serviceActionNotice("stop", false, "qmd")).toBe("Couldn't stop qmd");
		expect(serviceActionNotice("stopAll", false, "qmd")).toBe(
			"Couldn't stop all services"
		);
		expect(serviceActionNotice("uninstall", true, "qmd")).toBe(
			"Uninstalled qmd"
		);
	});

	test("row statuses are translated", () => {
		const flags = {
			downloading: false,
			installed: true,
			installFailed: false,
			running: false,
		};
		expect(rowStatus(THEME, flags).text).toBe("angehalten");
		expect(rowStatus(THEME, { ...flags, downloading: true }).text).toBe(
			"wird heruntergeladen"
		);
		expect(rowStatus(THEME, { ...flags, installFailed: true }).text).toBe(
			"Installation fehlgeschlagen"
		);
	});
});
