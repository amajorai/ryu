import { afterEach, describe, expect, test } from "bun:test";

import {
	activeLocale,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "./active-locale.ts";
import { I18nRuntime } from "./core.ts";

// A regional tag adopts the pack of its language for messages but keeps its
// own conventions for dates and numbers (the CLI's format/messages split).

const SAMPLE = 1234.5;
const DAY = Date.UTC(2026, 9, 31, 12);
const SHORT_DATE: Intl.DateTimeFormatOptions = {
	dateStyle: "short",
	timeZone: "UTC",
};

function detected(locale: string): I18nRuntime {
	return new I18nRuntime([], { initialLocale: [locale], initialPackId: null });
}

function intlNumber(locale: string): string {
	return new Intl.NumberFormat(locale).format(SAMPLE);
}

function intlDate(locale: string): string {
	return new Intl.DateTimeFormat(locale, SHORT_DATE).format(DAY);
}

let registered: I18nRuntime | null = null;

afterEach(() => {
	if (registered) {
		unregisterActiveI18nRuntime(registered);
		registered = null;
	}
});

describe("regional formatting locale", () => {
	for (const [regional, packLocale] of [
		["pt-PT", "pt-BR"],
		["es-MX", "es"],
		["fr-CA", "fr"],
		["de-CH", "de"],
	] as const) {
		test(`${regional} formats its own way while reading the ${packLocale} pack`, () => {
			const runtime = detected(regional);
			expect(runtime.locale).toBe(packLocale);
			expect(runtime.selectedPack?.locale).toBe(packLocale);
			expect(runtime.formatLocale).toBe(regional);
			expect(runtime.formatNumber(SAMPLE)).toBe(intlNumber(regional));
			expect(runtime.formatDate(DAY, SHORT_DATE)).toBe(intlDate(regional));
			// The snapshot plugins read keeps naming the pack's locale.
			expect(runtime.getSnapshot().locale).toBe(packLocale);
		});
	}

	test("the four regions really differ from their packs", () => {
		expect(intlNumber("es-MX")).not.toBe(intlNumber("es"));
		expect(intlNumber("de-CH")).not.toBe(intlNumber("de"));
		expect(intlDate("fr-CA")).not.toBe(intlDate("fr"));
		expect(intlDate("pt-PT")).not.toBe(intlDate("pt-BR"));
	});

	test("an exact pack match and zh-TW keep their previous behavior", () => {
		const brazil = detected("pt-BR");
		expect(brazil.formatLocale).toBe("pt-BR");
		const before = detected("zh-TW");
		expect(before.formatLocale).toBe(before.locale);
	});

	test("an explicit pack choice formats in the pack's locale", () => {
		const runtime = detected("es-MX");
		const pack = runtime.selectedPackId;
		runtime.selectPack(pack);
		expect(runtime.formatLocale).toBe("es");
	});

	test("setLocale keeps the regional tag it was given", () => {
		const runtime = new I18nRuntime([], { initialPackId: null });
		runtime.setLocale("de-CH");
		expect(runtime.locale).toBe("de");
		expect(runtime.formatLocale).toBe("de-CH");
	});

	test("a system change within one language publishes the new region", () => {
		const runtime = detected("fr-CA");
		let calls = 0;
		runtime.subscribe(() => {
			calls += 1;
		});
		runtime.applySystemLocales(["fr-CH"]);
		expect(calls).toBe(1);
		expect(runtime.formatLocale).toBe("fr-CH");
	});

	test("activeLocale() answers the formatting locale", () => {
		const runtime = detected("es-MX");
		registered = runtime;
		registerActiveI18nRuntime(runtime);
		expect(activeLocale()).toBe("es-MX");
	});
});
