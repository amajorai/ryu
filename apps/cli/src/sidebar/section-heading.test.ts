// Section headers render in capitals. The title is translated first, then
// capitalized, since "AGENTS" never matches the catalog's "Agents".
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

const german = createCliTranslator("de", {
	Account: "Konto",
	Agents: "Agenten",
	Projects: "Projekte",
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
const { projectsHeading, sectionHeading } = await import(
	"./section-heading.ts"
);
const { buildSidebarRows, resolveCollapsed } = await import("./rows.ts");
const { emptySidebarData } = await import("./data.ts");

describe("section headings under German", () => {
	test("translates, then capitalizes", () => {
		expect(sectionHeading("Agents")).toBe("AGENTEN");
		expect(sectionHeading("Account")).toBe("KONTO");
		expect(projectsHeading()).toBe("PROJEKTE");
	});

	test("an untranslated title is still capitalized", () => {
		expect(sectionHeading("Workflows")).toBe("WORKFLOWS");
	});

	test("the keyboard row list carries the translated header", () => {
		const noop = () => undefined;
		const rows = buildSidebarRows(
			emptySidebarData,
			resolveCollapsed(emptySidebarData, {}),
			"console",
			{
				openPalette: noop,
				openSettings: noop,
				openTab: noop,
				switchMode: noop,
				switchNode: noop,
				toggleSection: noop,
			}
		);
		const header = rows.find((row) => row.key === "section:agents");
		expect(header?.label).toBe("AGENTEN");
		const projects = rows.find((row) => row.key === "section:projects");
		expect(projects?.label).toBe("PROJEKTE");
	});
});
