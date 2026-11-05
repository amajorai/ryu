import { afterEach, describe, expect, test } from "bun:test";
import {
	formatMessage,
	type LiteralMessage,
	type MessageValuesInput,
} from "@ryu/i18n";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import {
	installerErrorText,
	installerProgressText,
} from "./installer-error-text.ts";

// A stand-in translator that marks every sentence it was asked for, so the
// assertions prove each message went through `tl()` as one whole sentence.
const tl: LiteralMessage = (source, values) =>
	`[${formatMessage(source, values ?? {}, "en")}]`;

describe("installerErrorText", () => {
	test("maps the installer exit code to a whole translated sentence", () => {
		expect(
			installerErrorText(
				{ code: "installer_exit", detail: "exit status: 1" },
				tl
			)
		).toBe("[Ryu setup didn't finish. Try again.]");
	});

	test("an unknown code falls back to the generic sentence", () => {
		expect(
			installerErrorText({ code: "something_newer", detail: "boom" }, tl)
		).toBe("[Ryu setup failed]");
	});

	test("never shows a raw error sentence from an older native build", () => {
		const text = installerErrorText(
			{ error: "canonical installer exited with exit status: 1" },
			tl
		);
		expect(text).toBe("[Ryu setup failed]");
		expect(text).not.toContain("canonical installer");
	});

	test("an empty payload uses the generic sentence", () => {
		expect(installerErrorText({}, tl)).toBe("[Ryu setup failed]");
	});
});

describe("installerProgressText", () => {
	test("formats the percent through the translated template", () => {
		expect(installerProgressText(42, tl)).toMatch(/^\[42\s?% of setup\]$/u);
	});

	test("returns nothing when no percent is reported", () => {
		expect(installerProgressText(undefined, tl)).toBeUndefined();
		expect(installerProgressText(Number.NaN, tl)).toBeUndefined();
	});
});

// A runtime for `locale` whose `tl` answers from a tiny pack, the way the
// mounted provider does, so the percent is formatted by the active locale.
function localeRuntime(
	locale: string,
	pack: Record<string, string>
): ActiveI18nRuntime & { tl: LiteralMessage } {
	return {
		direction: locale === "ar" ? "rtl" : "ltr",
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			return formatMessage(
				pack[fallback ?? id] ?? fallback ?? id,
				values,
				locale
			);
		},
		tl: (source, values) =>
			formatMessage(pack[source] ?? source, values ?? {}, locale),
	};
}

describe("installer toasts in other locales", () => {
	let active: ActiveI18nRuntime | null = null;
	afterEach(() => {
		if (active) {
			unregisterActiveI18nRuntime(active);
			active = null;
		}
	});

	const cases = [
		{
			locale: "de",
			pack: {
				"{percent} of setup": "{percent} der Einrichtung",
				"Ryu setup didn't finish. Try again.":
					"Die Einrichtung von Ryu wurde nicht abgeschlossen. Versuche es erneut.",
			},
			percent: "42\u00a0% der Einrichtung",
		},
		{
			locale: "ja",
			pack: {
				"{percent} of setup": "セットアップ {percent}",
				"Ryu setup didn't finish. Try again.":
					"Ryu のセットアップが完了しませんでした。もう一度お試しください。",
			},
			percent: "セットアップ 42%",
		},
		{
			locale: "ar",
			pack: {
				"{percent} of setup": "{percent} من الإعداد",
				"Ryu setup didn't finish. Try again.":
					"لم يكتمل إعداد Ryu. حاول مرة أخرى.",
			},
			percent: `${new Intl.NumberFormat("ar", { style: "percent" }).format(0.42)} من الإعداد`,
		},
	];

	for (const { locale, pack, percent } of cases) {
		test(`${locale}: percent and failure use the locale, never the raw cause`, () => {
			const runtime = localeRuntime(locale, pack);
			active = runtime;
			registerActiveI18nRuntime(runtime);
			expect(installerProgressText(42, runtime.tl)).toBe(percent);
			const failure = installerErrorText(
				{ code: "installer_exit", detail: "exit status: 1" },
				runtime.tl
			);
			expect(failure).toBe(pack["Ryu setup didn't finish. Try again."]);
			expect(failure).not.toContain("exit status");
		});
	}
});
