import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import { formatWholeUsd, memberSeatCountLabel } from "./billing-amounts.ts";

const SEATS = "{count, plural, one {# member seat} other {# member seats}}";

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

describe("billing amounts follow the UI language", () => {
	test("English keeps whole-dollar prices and grouped top-up bounds", () => {
		expect(formatWholeUsd(5)).toBe("$5");
		expect(formatWholeUsd(1000)).toBe("$1,000");
		expect(formatWholeUsd(4.5)).toBe("$4.50");
		expect(memberSeatCountLabel(1)).toBe("1 member seat");
		expect(memberSeatCountLabel(12)).toBe("12 member seats");
	});

	test("German groups the top-up maximum and puts the symbol last", () => {
		mount(
			runtimeFor("de", {
				[SEATS]:
					"{count, plural, one {# Mitgliedsplatz} other {# Mitgliedsplätze}}",
			})
		);
		expect(formatWholeUsd(1000)).toBe("1.000 $");
		expect(memberSeatCountLabel(1)).toBe("1 Mitgliedsplatz");
		expect(memberSeatCountLabel(1200)).toBe("1.200 Mitgliedsplätze");
	});

	test("Arabic formats the seat count and amount with Arabic rules", () => {
		mount(runtimeFor("ar"));
		const expected = new Intl.NumberFormat("ar", {
			currency: "USD",
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
			style: "currency",
			trailingZeroDisplay: "stripIfInteger",
		}).format(1000);
		expect(formatWholeUsd(1000)).toBe(expected);
		expect(memberSeatCountLabel(3)).toBe(
			`${new Intl.NumberFormat("ar").format(3)} member seats`
		);
	});
});
