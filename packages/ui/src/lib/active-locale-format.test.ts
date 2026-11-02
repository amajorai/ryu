import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { compileFormula } from "./data-grid-formula.ts";
import { formatCount, formatCurrency } from "./number-format.ts";
import { formatDate, getDisplayLocale } from "./timezone.ts";

const UNKNOWN_FUNCTION = "Unknown function {name}";

function runtimeFor(locale: string, messages: Record<string, string> = {}) {
	return {
		direction: locale === "ar" ? ("rtl" as const) : ("ltr" as const),
		locale,
		translate(source: string, values?: MessageValuesInput, fallback?: string) {
			const message = (fallback && messages[fallback]) ?? fallback ?? source;
			return formatMessage(message, values, locale);
		},
	};
}

let mounted: ReturnType<typeof runtimeFor> | null = null;

function mount(runtime: ReturnType<typeof runtimeFor>): void {
	mounted = runtime;
	registerActiveI18nRuntime(runtime);
}

afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(mounted);
		mounted = null;
	}
});

describe("shared formatters follow the UI locale, not the OS", () => {
	test("English output is unchanged without a provider", () => {
		expect(getDisplayLocale()).toBe("en");
		expect(formatCount(1234)).toBe("1,234");
		expect(formatCurrency(1_234_567)).toBe("$1.2m");
		expect(formatDate("2026-10-30", { dateStyle: "medium" })).toBe(
			"Oct 30, 2026"
		);
	});

	test("de groups numbers and writes dates the German way", () => {
		mount(runtimeFor("de"));
		expect(getDisplayLocale()).toBe("de");
		expect(formatCount(1234)).toBe("1.234");
		expect(formatDate("2026-10-30", { dateStyle: "medium" })).toBe(
			"30.10.2026"
		);
	});

	test("ja writes month names in Japanese", () => {
		mount(runtimeFor("ja"));
		expect(formatDate("2026-10-30", { dateStyle: "long" })).toBe(
			"2026年10月30日"
		);
		expect(formatCount(1_234_567)).toBe(
			new Intl.NumberFormat("ja", {
				compactDisplay: "short",
				maximumFractionDigits: 1,
				notation: "compact",
			}).format(1_234_567)
		);
	});

	test("ar formats with the Arabic locale", () => {
		mount(runtimeFor("ar"));
		expect(formatCount(1234)).toBe(new Intl.NumberFormat("ar").format(1234));
	});

	test("formula errors reach the user in the UI language", () => {
		expect(compileFormula("=NOPE(1)")).toMatchObject({
			message: "Unknown function NOPE",
		});
		mount(
			runtimeFor("de", { [UNKNOWN_FUNCTION]: "Unbekannte Funktion {name}" })
		);
		expect(compileFormula("=NOPE(1)")).toMatchObject({
			message: "Unbekannte Funktion NOPE",
		});
	});
});
