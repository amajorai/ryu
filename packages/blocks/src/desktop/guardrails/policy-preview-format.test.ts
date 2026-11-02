import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { formatPreviewValue } from "./policy-preview-format.ts";

const GERMAN: Record<string, string> = {
	"{amount} per day": "{amount} pro Tag",
	"{amount} per month": "{amount} pro Monat",
	"{id} (off)": "{id} (aus)",
	"{id}: {action}": "{id}: {action}",
	Block: "Blockieren",
	"No restriction": "Keine Einschränkung",
	"Nothing allowed": "Nichts erlaubt",
};

const germanTl = (source: string, values?: MessageValuesInput) =>
	formatMessage(GERMAN[source] ?? source, values, "de");

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(_id: string, values?: MessageValuesInput, fallback?: string) {
		return germanTl(fallback ?? _id, values);
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("policy preview values", () => {
	test("read in English without a provider", () => {
		expect(formatPreviewValue({ usdMicro: 30_000_000, window: "weekly" })).toBe(
			"$30 per week"
		);
		expect(formatPreviewValue([])).toBe("No restriction");
	});

	test("use the German currency format and messages under de", () => {
		registerActiveI18nRuntime(german);
		expect(
			formatPreviewValue({ usdMicro: 30_000_000, window: "daily" })
		).toMatch(/^30\s\$ pro Tag$/u);
		expect(
			formatPreviewValue({ usdMicro: 12_500_000, window: "monthly" })
		).toMatch(/^12,50\s\$ pro Monat$/u);
		expect(formatPreviewValue([])).toBe("Keine Einschränkung");
		expect(formatPreviewValue(["<deny-all>"])).toBe("Nichts erlaubt");
		expect(
			formatPreviewValue({ enabled: false, id: "pii", inlineAction: "block" })
		).toBe("pii: Blockieren (aus)");
	});

	test("format amounts and numbers in the ja and ar locales", () => {
		for (const [locale, amount, count] of [
			["ja", "$12.50", "1,234.5"],
			["ar", "12.50 US$", "1,234.5"],
		] as const) {
			const runtime = { ...german, locale };
			registerActiveI18nRuntime(runtime);
			try {
				// Arabic adds a right-to-left mark and a no-break space; normalize them.
				expect(
					formatPreviewValue({ usdMicro: 12_500_000 })
						.replace(/\u200f/gu, "")
						.replace(/\s/gu, " ")
				).toBe(amount);
				expect(formatPreviewValue(1234.5)).toBe(count);
			} finally {
				unregisterActiveI18nRuntime(runtime);
			}
		}
	});

	test("use a component's own translator when one is passed", () => {
		expect(formatPreviewValue({ enabled: false, id: "pii" }, germanTl)).toBe(
			"pii (aus)"
		);
	});
});
