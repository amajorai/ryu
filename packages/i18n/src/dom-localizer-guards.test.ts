import { afterEach, describe, expect, test } from "bun:test";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { observeDomLocalization } = await import("./dom-localizer.ts");
const { clearLocalizedOutputs, hasNonLatinLetters, isLocalizedOutput } =
	await import("./dom-localizer-outputs.ts");
const { messageIdForLiteral, registerLiteralCatalogLoader } = await import(
	"./literal-catalog.ts"
);
const { LiteralTemplateIndex } = await import("./literal-templates.ts");
const { I18nRuntime } = await import("./core.ts");

type Runtime = InstanceType<typeof I18nRuntime>;
type Locale = "ar" | "de" | "ja";

// The official catalog entries behind the r25 probe's rewrites of user text.
const CATALOGS: Record<Locale, Record<string, string>> = {
	ar: {
		"Release {latestRelease}": "الإصدار {latestRelease}",
		"Open {name}": "فتح {name}",
		"Deleted {name}": "تم حذف {name}",
	},
	de: {
		"{title} is ready.": "{title} ist bereit.",
		"Release {latestRelease}": "Version {latestRelease}",
		"Open {name}": "{name} öffnen",
		"Needs {engine}": "Benötigt {engine}",
		"Waiting on {name}": "Warten auf {name}",
		"{count} notes": "{count} Notizen",
		Agents: "Agenten",
		"Deleted {name}": "{name} gelöscht",
	},
	ja: {
		"{title} is ready.": "{title}の準備ができました。",
		"Release {latestRelease}": "リリース {latestRelease}",
		"Open {name}": "{name} を開く",
		"Needs {engine}": "{engine}が必要",
		"Waiting on {name}": "{name}を待っています",
		"{count} notes": "メモ {count} 件",
		Agents: "エージェント",
		"Deleted {name}": "{name}を削除しました",
	},
};

const LOCALES = ["de", "ja"] as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const disposers: (() => void)[] = [];

function runtimeFor(locale: Locale): Runtime {
	registerLiteralCatalogLoader((requested) =>
		Object.hasOwn(CATALOGS, requested.slice(0, 2))
			? CATALOGS[requested.slice(0, 2) as Locale]
			: null
	);
	return new I18nRuntime([], { initialLocale: locale, initialPackId: null });
}

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

/** What `tl(source, values)` renders through `runtime`. */
function tl(
	runtime: Runtime,
	source: string,
	values: Record<string, string>
): string {
	return runtime.translate(messageIdForLiteral(source), values, source);
}

const text = (id: string) => document.getElementById(id)?.textContent;
const label = (id: string) =>
	document.getElementById(id)?.getAttribute("aria-label");

afterEach(() => {
	for (const dispose of disposers.splice(0)) {
		dispose();
	}
	registerLiteralCatalogLoader(null);
	clearLocalizedOutputs();
	document.body.innerHTML = "";
});

describe("user text and translated output stay as written", () => {
	test.each(LOCALES)("a message preview span (%s)", async (locale) => {
		const runtime = runtimeFor(locale);
		document.body.innerHTML =
			'<p><span id=title data-ryu-i18n="off">Release notes</span><span id=preview data-ryu-i18n="off">Draft is ready.</span></p>';
		localize(runtime);
		await settle();
		expect(text("title")).toBe("Release notes");
		expect(text("preview")).toBe("Draft is ready.");
	});

	test.each(LOCALES)("text already in Japanese (%s)", async (locale) => {
		const runtime = runtimeFor(locale);
		document.body.innerHTML =
			'<button id=open aria-label="Release notes を開く">Release notes を開く</button>';
		localize(runtime);
		await settle();
		expect(text("open")).toBe("Release notes を開く");
		expect(label("open")).toBe("Release notes を開く");
	});

	test.each(
		LOCALES
	)("a list label that only starts like a template (%s)", async (locale) => {
		const runtime = runtimeFor(locale);
		document.body.innerHTML = [
			'<a id=needs aria-label="Needs you, 2 conversations">Needs you, 2 conversations</a>',
			"<p id=waiting>Waiting on you</p>",
			"<p id=lone>Needs you</p>",
		].join("");
		localize(runtime);
		await settle();
		expect(text("needs")).toBe("Needs you, 2 conversations");
		expect(label("needs")).toBe("Needs you, 2 conversations");
		expect(text("waiting")).toBe("Waiting on you");
		expect(text("lone")).toBe("Needs you");
	});

	test("a half-translated label around an English status word (de)", async () => {
		const runtime = runtimeFor("de");
		document.body.innerHTML =
			'<a id=rail aria-label="Needs you, 2 Unterhaltungen">x</a>';
		localize(runtime);
		await settle();
		expect(label("rail")).toBe("Needs you, 2 Unterhaltungen");
	});

	test("tl() output in a Latin-script locale is not translated again (de)", async () => {
		const runtime = runtimeFor("de");
		const opened = tl(runtime, "Open {name}", { name: "Release notes" });
		expect(opened).toBe("Release notes öffnen");
		expect(isLocalizedOutput(opened)).toBe(true);
		document.body.innerHTML = `<button id=open aria-label="${opened}">${opened}</button>`;
		localize(runtime);
		await settle();
		expect(text("open")).toBe("Release notes öffnen");
		expect(label("open")).toBe("Release notes öffnen");
	});

	test("localized-text lookups do not template-match localized text", () => {
		const runtime = runtimeFor("ja");
		const lookup = (value: string) =>
			runtime.translate(messageIdForLiteral(value), {}, value);
		expect(lookup("Release notesを選択")).toBe("Release notesを選択");
		expect(runtime.templateMessage("Release notes を開く")).toBeUndefined();
		expect(lookup("Release v2.4")).toBe("リリース v2.4");
	});

	test("an untranslated English fallback stays open to the localizer (de)", () => {
		const runtime = runtimeFor("de");
		expect(tl(runtime, "Not in the catalog {name}", { name: "x" })).toBe(
			"Not in the catalog x"
		);
		expect(isLocalizedOutput("Not in the catalog x")).toBe(false);
	});
});

describe("exact literals and templates still translate", () => {
	test.each([
		[
			"de",
			"Agenten",
			"Version v2.4",
			"Benötigt Docker",
			"Warten auf Ada",
			"1,234 Notizen",
		],
		[
			"ja",
			"エージェント",
			"リリース v2.4",
			"Dockerが必要",
			"Adaを待っています",
			"メモ 1,234 件",
		],
	] as const)("%s", async (locale, agents, release, needs, waiting, notes) => {
		const runtime = runtimeFor(locale);
		document.body.innerHTML = [
			"<p id=agents>Agents</p>",
			"<p id=release>Release v2.4</p>",
			"<p id=needs>Needs Docker</p>",
			"<p id=waiting>Waiting on Ada</p>",
			"<p id=notes>1,234 notes</p>",
		].join("");
		localize(runtime);
		await settle();
		expect(text("agents")).toBe(agents);
		expect(text("release")).toBe(release);
		expect(text("needs")).toBe(needs);
		expect(text("waiting")).toBe(waiting);
		expect(text("notes")).toBe(notes);
	});
});

describe("capture guards", () => {
	const index = () => new LiteralTemplateIndex(CATALOGS.de);

	test.each([
		"Needs you, 2 conversations",
		"Needs you",
		"Waiting on you",
		"Waiting on them",
		"Needs Docker, and then retry",
		"Ada: Release notes",
		"Release notes · 0:03",
	])("refuses %p", (value) => {
		expect(index().match(value, "de")).toBeUndefined();
	});

	test("keeps digit-grouping commas and lists of values", () => {
		expect(index().match("1,234 notes", "de")).toBe("1,234 Notizen");
		expect(index().match("Waiting on Ada, Ben", "de")).toBe(
			"Warten auf Ada, Ben"
		);
	});
});

describe("values in the reader's own script", () => {
	test.each([
		["ja", "Deleted 田中のメモ", "田中のメモを削除しました"],
		["ar", "Deleted ملف المشروع", "تم حذف ملف المشروع"],
		["de", "Deleted Привет", "Привет gelöscht"],
	] as const)("%s translates a template around them", async (locale, source, expected) => {
		const runtime = runtimeFor(locale);
		document.body.innerHTML = `<p id=deleted>${source}</p>`;
		localize(runtime);
		await settle();
		expect(text("deleted")).toBe(expected);
	});

	test.each([
		["ja", "Release notes を開く"],
		["ar", "Release notes افتح"],
	] as const)("%s refuses a capture that mixes scripts", async (locale, source) => {
		const runtime = runtimeFor(locale);
		expect(runtime.templateMessage(source)).toBeUndefined();
		document.body.innerHTML = `<p id=mixed>${source}</p><p id=native>فتح الملف</p>`;
		localize(runtime);
		await settle();
		expect(text("mixed")).toBe(source);
		expect(text("native")).toBe("فتح الملف");
	});

	test("ar tl() output is not translated again", async () => {
		const runtime = runtimeFor("ar");
		const opened = tl(runtime, "Open {name}", { name: "Release v2.4" });
		// The Latin value is bidi-isolated (FSI ... PDI) inside the RTL sentence.
		expect(opened).toBe("فتح \u2068Release v2.4\u2069");
		document.body.innerHTML = `<p id=open>${opened}</p>`;
		localize(runtime);
		await settle();
		expect(text("open")).toBe(opened);
	});
});

test("non-Latin letters are detected in any script", () => {
	for (const value of ["を開く", "Открыть", "فتح", "열기", "पढ़ें"]) {
		expect(hasNonLatinLetters(value)).toBe(true);
	}
	for (const value of ["Release notes", "Öffnen", "Ça va", "→ 1,234 …"]) {
		expect(hasNonLatinLetters(value)).toBe(false);
	}
});
