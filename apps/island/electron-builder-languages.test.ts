// The Island setup wizard and uninstaller pick their language from the Windows
// display language, out of `nsis.installerLanguages`. electron-builder's
// default list has no Hindi, so these tests pin that the configured list covers
// every official Ryu locale, keeps the default list (no regression for other
// Windows languages), and resolves through electron-builder's own NSIS
// language code to an LCID and an MUI language name.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { OFFICIAL_CATALOG_LOCALES } from "@ryu/i18n/catalog-locale";

interface NsisLangs {
	bundledLanguages: string[];
	langIdToName: Record<string, string>;
	lcid: Record<string, number>;
}

interface NsisLangModule {
	createAddLangsMacro: (
		generator: { macro: (name: string, lines: string[]) => void },
		configurator: { langs: string[] }
	) => void;
	LangConfigurator: new (options: {
		installerLanguages?: string[] | null;
	}) => { isMultiLang: boolean; langs: string[] };
}

// app-builder-lib is electron-builder's dependency, not Island's, so resolve
// it from electron-builder to test against the version the build really uses.
const requireFromBuilder = createRequire(
	createRequire(import.meta.url).resolve("electron-builder")
);
const langs = requireFromBuilder(
	"app-builder-lib/out/util/langs.js"
) as NsisLangs;
const nsisLang = requireFromBuilder(
	"app-builder-lib/out/targets/nsis/nsisLang.js"
) as NsisLangModule;

const windowsToolsets = requireFromBuilder(
	"app-builder-lib/out/toolsets/windows.js"
) as { nsisChecksums: Record<string, unknown> };

interface BuilderConfig {
	nsis?: { installerLanguages?: unknown };
	toolsets?: { nsis?: unknown };
}

function builderConfig(): BuilderConfig {
	const yaml = readFileSync(
		join(import.meta.dir, "electron-builder.yml"),
		"utf8"
	);
	return Bun.YAML.parse(yaml) as BuilderConfig;
}

function configuredNsisToolset(): unknown {
	return builderConfig().toolsets?.nsis;
}

function configuredInstallerLanguages(): string[] {
	const list = builderConfig().nsis?.installerLanguages;
	if (!(Array.isArray(list) && list.every((it) => typeof it === "string"))) {
		throw new Error("nsis.installerLanguages must be a list of strings");
	}
	return list;
}

/** Whether an electron-builder `ll_RR` entry serves a BCP 47 Ryu locale. */
function entryServesLocale(entry: string, locale: string): boolean {
	const [language, region] = locale.split("-");
	const [entryLanguage, entryRegion] = entry.split("_");
	if (entryLanguage !== language) {
		return false;
	}
	return region === undefined || entryRegion === region;
}

function muiLanguageLines(installerLanguages: string[]): string[] {
	const configurator = new nsisLang.LangConfigurator({ installerLanguages });
	const lines: string[] = [];
	nsisLang.createAddLangsMacro(
		{ macro: (_name, macroLines) => lines.push(...macroLines) },
		configurator
	);
	return lines;
}

describe("Island NSIS installer languages", () => {
	const installerLanguages = configuredInstallerLanguages();

	test("covers every official Ryu locale and English", () => {
		expect(installerLanguages).toContain("en_US");
		const uncovered = OFFICIAL_CATALOG_LOCALES.filter(
			(locale) =>
				!installerLanguages.some((entry) => entryServesLocale(entry, locale))
		);
		expect(uncovered).toEqual([]);
	});

	test("keeps every language electron-builder offers by default", () => {
		const dropped = langs.bundledLanguages.filter(
			(lang) => !installerLanguages.includes(lang)
		);
		expect(dropped).toEqual([]);
	});

	test("uses language_REGION entries that each have a Windows LCID", () => {
		const configurator = new nsisLang.LangConfigurator({
			installerLanguages,
		});
		expect(configurator.isMultiLang).toBe(true);
		expect(configurator.langs).toEqual(installerLanguages);
		const withoutLcid = configurator.langs.filter(
			(lang) => typeof langs.lcid[lang] !== "number"
		);
		expect(withoutLcid).toEqual([]);
		expect(new Set(installerLanguages).size).toBe(installerLanguages.length);
	});

	test("adds the Hindi MUI language to the installer script", () => {
		const lines = muiLanguageLines(installerLanguages);
		expect(lines).toContain('!insertmacro MUI_LANGUAGE "Hindi"');
		expect(lines).toContain('!insertmacro MUI_LANGUAGE "English"');
		expect(lines).toHaveLength(installerLanguages.length);
	});

	test("builds Hindi with an NSIS toolset whose Hindi language file parses", () => {
		// The legacy toolset ("0.0.0", NSIS 3.0.4.1) ships a Hindi.nsh with an
		// unterminated string on the multi-user install-mode page, so makensis
		// fails on any assisted installer that lists hi_IN. Keep hi_IN only with
		// a toolset from electron-builder's own NSIS 3.12+ bundles.
		expect(installerLanguages).toContain("hi_IN");
		const toolset = configuredNsisToolset();
		expect(toolset).not.toBe("0.0.0");
		expect(Object.keys(windowsToolsets.nsisChecksums)).toContain(toolset);
	});

	test("a bare `hi` entry would not resolve to the Hindi LCID", () => {
		const configurator = new nsisLang.LangConfigurator({
			installerLanguages: ["hi"],
		});
		expect(configurator.langs).toEqual(["hi_HI"]);
		expect(langs.lcid.hi_HI).toBeUndefined();
		expect(langs.lcid.hi_IN).toBe(1081);
	});
});
