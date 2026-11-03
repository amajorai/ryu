import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import { formatRoutingSignal } from "../lib/api/routing.ts";
import {
	formatPercent as formatAuditPercent,
	formatScore,
} from "./agents/AgentObservabilityView-audit.ts";
import { pct } from "./PromptStudio-format.ts";
import { usageCaption } from "./shell/NodeSelector-service-row.tsx";

// Visible percentages format through formatPercent, so German readers see
// "42 %" like the rest of the app instead of a hand-built "42%".
const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "de");
	},
};
const DE = "42 %";

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("desktop percent labels", () => {
	test("keep the English form in English", () => {
		expect(pct(0.42)).toBe("42%");
		expect(formatScore(0.42)).toBe("42%");
		expect(formatAuditPercent(null)).toBe("—");
		expect(
			formatRoutingSignal({
				label: "Error rate",
				threshold: 50,
				unit: "percent",
				value: 42,
			})
		).toBe("42%");
	});

	test("use the German percent format under de", () => {
		registerActiveI18nRuntime(german);
		expect(pct(0.42)).toBe(DE);
		expect(formatScore(0.42)).toBe(DE);
		expect(formatAuditPercent(0.42)).toBe(DE);
		expect(
			formatRoutingSignal({
				label: "Error rate",
				threshold: 50,
				unit: "percent",
				value: 42,
			})
		).toBe(DE);
		expect(
			usageCaption({
				cpuPercent: 42,
				memoryBytes: 0,
				pid: 1,
				running: true,
				sandbox: null,
			})
		).toContain(DE);
	});
});
