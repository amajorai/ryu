import { describe, expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	companionDocumentLocale,
	companionHtmlLocaleAttributes,
	companionLocaleScript,
} from "./companion-locale.ts";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";

const APP_HTML =
	'<!doctype html><html lang="en"><head><title>App</title></head><body></body></html>';

/** Run the locale bootstrap against a stub `<html>` and a stub `i18n.subscribe`
 *  stream, returning the attributes it left on the root element. */
function runLocaleScript(
	initial: Parameters<typeof companionLocaleScript>[0],
	emitted: string[]
): { attributes: Record<string, string>; streamed: string[] } {
	const attributes: Record<string, string> = {};
	const streamed: string[] = [];
	const context = {
		callStream: (
			method: string,
			_args: unknown[],
			onChunk: (data: string) => void
		) => {
			streamed.push(method);
			for (const chunk of emitted) {
				onChunk(chunk);
			}
			return { promise: Promise.resolve(), cancel: () => undefined };
		},
		document: {
			documentElement: {
				setAttribute: (name: string, value: string) => {
					attributes[name] = value;
				},
			},
		},
	};
	runInNewContext(
		`${companionLocaleScript(initial)}\nfollowHostLocale();`,
		context
	);
	return { attributes, streamed };
}

describe("companionDocumentLocale", () => {
	it("derives rtl for Arabic and keeps an explicit direction", () => {
		expect(companionDocumentLocale({ locale: "ar" })).toEqual({
			dir: "rtl",
			lang: "ar",
		});
		expect(companionDocumentLocale({ locale: "pt-br" })).toEqual({
			dir: "ltr",
			lang: "pt-BR",
		});
		expect(companionDocumentLocale({ locale: "en", direction: "rtl" })).toEqual(
			{ dir: "rtl", lang: "en" }
		);
	});

	it("falls back to English for missing or malformed tags", () => {
		expect(companionDocumentLocale(undefined)).toEqual({
			dir: "ltr",
			lang: "en",
		});
		expect(
			companionHtmlLocaleAttributes({ locale: '"><script>x</script>' })
		).toBe('lang="en" dir="ltr"');
	});
});

describe("Path A srcdoc locale", () => {
	it("starts an Arabic companion with lang=ar dir=rtl", () => {
		const out = thirdPartyPluginSrcdoc(
			"n",
			"",
			"@acme/x",
			undefined,
			{},
			true,
			{
				locale: { locale: "ar" },
			}
		);
		expect(out).toContain('<html lang="ar" dir="rtl">');
		expect(out).toContain('callStream("i18n.subscribe"');
	});

	it("starts Japanese and German companions left-to-right in their language", () => {
		for (const locale of ["ja", "de"]) {
			const out = thirdPartyPluginSrcdoc(
				"n",
				"",
				"@acme/x",
				undefined,
				{},
				true,
				{
					locale: { locale },
				}
			);
			expect(out).toContain(`<html lang="${locale}" dir="ltr">`);
		}
	});

	it("keeps lang=en dir=ltr when the host passes no locale", () => {
		const out = thirdPartyPluginSrcdoc("n", "", "@acme/x");
		expect(out).toContain('<html lang="en" dir="ltr">');
	});
});

describe("Path B srcdoc locale", () => {
	it("seeds the host locale before the app's own <html> tag", () => {
		const out = htmlCompanionSrcdoc(
			"n",
			APP_HTML,
			"@acme/x",
			undefined,
			undefined,
			undefined,
			false,
			{ locale: { locale: "ar" } }
		);
		const seedAt = out.indexOf('applyHostLocale({"dir":"rtl","lang":"ar"})');
		expect(seedAt).toBeGreaterThan(0);
		expect(seedAt).toBeLessThan(out.indexOf('<html lang="en">'));
	});

	it("seeds Japanese ltr ahead of the app's own <html> tag", () => {
		const out = htmlCompanionSrcdoc(
			"n",
			APP_HTML,
			"@acme/x",
			undefined,
			undefined,
			undefined,
			false,
			{ locale: { locale: "ja" } }
		);
		const seedAt = out.indexOf('applyHostLocale({"dir":"ltr","lang":"ja"})');
		expect(seedAt).toBeGreaterThan(0);
		expect(seedAt).toBeLessThan(out.indexOf('<html lang="en">'));
	});

	it("skips the seed without a locale but still follows the host language", () => {
		const out = htmlCompanionSrcdoc("n", APP_HTML, "@acme/x");
		expect(out).not.toContain("applyHostLocale({");
		expect(out).toContain("followHostLocale();");
	});
});

describe("companionLocaleScript", () => {
	it("applies the seed, then follows a language change", () => {
		const { attributes, streamed } = runLocaleScript({ locale: "ar" }, [
			JSON.stringify({ locale: "de", direction: "ltr" }),
		]);
		expect(streamed).toEqual(["i18n.subscribe"]);
		expect(attributes).toEqual({ dir: "ltr", lang: "de" });
	});

	it("ignores malformed snapshots", () => {
		const { attributes } = runLocaleScript({ locale: "fa" }, [
			"not json",
			JSON.stringify({ locale: "<x>", direction: "sideways" }),
		]);
		expect(attributes).toEqual({ dir: "rtl", lang: "fa" });
	});
});
