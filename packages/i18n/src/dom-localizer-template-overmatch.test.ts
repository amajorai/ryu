import { afterEach, describe, expect, test } from "bun:test";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { observeDomLocalization } = await import("./dom-localizer.ts");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");
const { LiteralTemplateIndex } = await import("./literal-templates.ts");
const { I18nRuntime } = await import("./core.ts");

type Runtime = InstanceType<typeof I18nRuntime>;

// Untranslated English data (role names, page titles, FAQ questions) used
// to start like a short catalog template and come out half-translated:
// `Editing and Proofreading` read `and Proofreading wird bearbeitet`.
const GERMAN: Record<string, string> = {
	"Editing {title}": "{title} wird bearbeitet",
	"Ryu for {role}": "Ryu für {role}",
	"{first} and {second}": "{first} und {second}",
	"Review {item}": "{item} prüfen",
	"Can I {action}": "Darf ich {action}",
	"Couldn't load {name}": "{name} konnte nicht geladen werden",
	"Open {name}": "{name} öffnen",
	"Back to {page}": "Zurück zu {page}",
	"{count} seconds": "{count} Sekunden",
	"Search {source}…": "{source} durchsuchen…",
	"{name} device code": "{name}-Gerätecode",
	"Sign in to {action}": "Bei {action} anmelden",
	"No {items} yet": "Noch keine {items}",
	"Renamed {name} to {name}": "Nicht umbenannt: {name}",
};

// The real ja/ar catalog entries behind the same overmatch.
const JAPANESE: Record<string, string> = {
	"Editing {title}": "{title} を編集中",
	"Can I {action}?": "{action}してもよいですか？",
};
const ARABIC: Record<string, string> = {
	"Editing {title}": "تعديل {title}",
	"Can I {action}?": "هل يمكنني {action}؟",
};

const index = () => new LiteralTemplateIndex(GERMAN);

describe("template overmatch on untranslated English", () => {
	test.each([
		"Editing and Proofreading",
		"QA and Testing",
		"Proposal and SOW drafting",
		"Ryu for Sales",
		"Ryu for data science",
		"Ryu for editing and proofreading",
		"Review a pull request",
		"Can I keep using Claude Code or Codex?",
		"Can I keep each client's data separated?",
		"Couldn't load the overview",
		"Couldn't copy the device code",
		"Sign in to write the first review.",
		"No one lives here yet",
	])("leaves %p as written", (text) => {
		expect(index().match(text, "de")).toBeUndefined();
	});

	test.each([
		["Editing Roadmap", "Roadmap wird bearbeitet"],
		["Editing Q3 roadmap", "Q3 roadmap wird bearbeitet"],
		["Open Settings", "Settings öffnen"],
		["Back to Marketplace", "Zurück zu Marketplace"],
		["15 seconds", "15 Sekunden"],
		["Search Hugging Face…", "Hugging Face durchsuchen…"],
		["Couldn't load Q3 plan", "Q3 plan konnte nicht geladen werden"],
		["Q3 and Q4", "Q3 und Q4"],
		["Renamed a to a", "Nicht umbenannt: a"],
		["No agents yet", "Noch keine agents"],
	])("still translates %p", (text, expected) => {
		expect(index().match(text, "de")).toBe(expected);
	});

	test.each([
		["ja", JAPANESE, "Q3 roadmap を編集中"],
		["ar", ARABIC, "تعديل Q3 roadmap"],
	] as const)("%s leaves prose alone and keeps values", (locale, catalog, title) => {
		const localeIndex = new LiteralTemplateIndex(catalog);
		expect(
			localeIndex.match("Editing and Proofreading", locale)
		).toBeUndefined();
		expect(
			localeIndex.match("Can I build my own app?", locale)
		).toBeUndefined();
		expect(localeIndex.match("Editing Q3 roadmap", locale)).toBe(title);
	});
});

const disposers: (() => void)[] = [];

function localize(runtime: Runtime): void {
	disposers.push(
		observeDomLocalization({
			root: document.body,
			state: () => ({
				availablePacks: runtime.availablePacks,
				hasOverlayMessage: (id: string) =>
					runtime.overlayMessage(id) !== undefined,
				t: (id: string, values?: Record<string, string>, fallback?: string) =>
					runtime.translate(id, values, fallback),
				templateMessage: (text: string) => runtime.templateMessage(text),
			}),
			translationKey: () => String(runtime.getVersion()),
		})
	);
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) {
		dispose();
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("the DOM localizer keeps untranslated role names intact (de)", async () => {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("de") ? GERMAN : null
	);
	const runtime = new I18nRuntime([], {
		initialLocale: "de",
		initialPackId: null,
	});
	document.body.innerHTML = [
		"<h2 id=role>Editing and Proofreading</h2>",
		"<h1 id=hero>Ryu for Sales</h1>",
		"<p id=title>Editing Roadmap</p>",
	].join("");
	localize(runtime);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const text = (id: string) => document.getElementById(id)?.textContent;
	expect(text("role")).toBe("Editing and Proofreading");
	expect(text("hero")).toBe("Ryu for Sales");
	expect(text("title")).toBe("Roadmap wird bearbeitet");
});
