import { afterEach, describe, expect, it } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../../packages/i18n/src/active-locale.ts";
import { formatAxisTick } from "./ChartWidget.tsx";

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? source, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("dashboard chart Y-axis ticks", () => {
	it("group digits in English", () => {
		expect(formatAxisTick(1234)).toBe("1,234");
	});

	it("follow the UI language", () => {
		registerActiveI18nRuntime(german);
		expect(formatAxisTick(1234)).toBe("1.234");
		expect(formatAxisTick(0.5)).toBe("0,5");
	});

	it("keep a non-numeric tick as written", () => {
		expect(formatAxisTick("n/a")).toBe("n/a");
	});
});
