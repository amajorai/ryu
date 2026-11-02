import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { formatCost } from "../agents/AgentObservabilityView-audit.ts";
import { formatCountdown } from "./UsageCostSection-format.ts";

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("usage countdowns and costs", () => {
	test("keep the compact English readouts", () => {
		expect(formatCountdown(125)).toBe("2m 5s");
		expect(formatCountdown(42)).toBe("42s");
		expect(formatCountdown(null)).toBe("—");
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(3400)).toBe("$0.0034");
	});

	test("use German units and a decimal comma under de", () => {
		registerActiveI18nRuntime(german);
		const countdown = formatCountdown(125);
		expect(countdown).not.toContain("2m");
		expect(countdown).toMatch(/^2\s?Min\. 5\s?Sek\.$/u);
		expect(formatCost(3400)).toMatch(/^0,0034\s\$$/u);
		expect(formatCost(0)).toMatch(/^0,00\s\$$/u);
	});
});
