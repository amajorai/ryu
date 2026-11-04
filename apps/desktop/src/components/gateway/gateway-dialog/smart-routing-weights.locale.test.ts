import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../../packages/i18n/src/active-locale.ts";
import type { SmartRoutingConfig } from "../../../lib/api/gateway.ts";
import { buildSmartRoutingConfig as buildAgentOverride } from "../../agents/AgentSmartRouteOverride-load.ts";
import type { RuleRow } from "./classify-tier.tsx";
import {
	buildSmartRoutingConfig,
	smartRoutingRulesError,
} from "./smart-routing-save.ts";

// Weighted-random targets are typed in the UI locale, so a German "0,5" is a
// half weight in both the Gateway card and the per-agent override.
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

const draft = {
	classifier_model: "",
	router_type: "random",
} as unknown as SmartRoutingConfig;

function rows(...weights: string[]): RuleRow[] {
	return weights.map((weight, index) => ({
		description: "",
		id: `r${index}`,
		model: `model-${index}`,
		weight,
	}));
}

describe("smart-routing weights in German", () => {
	test("the Gateway card accepts and saves comma decimals", () => {
		registerActiveI18nRuntime(german);
		const rules = rows("0,5", "1,25");
		expect(smartRoutingRulesError(rules, "random")).toBeNull();
		const saved = buildSmartRoutingConfig({
			draft,
			fresh: undefined,
			poolModels: "",
			poolProviders: "",
			routerType: "random",
			rules,
		});
		expect(saved.rules?.map((rule) => rule.weight)).toEqual([0.5, 1.25]);
	});

	test("the per-agent override keeps comma decimals and defaults a blank", () => {
		registerActiveI18nRuntime(german);
		const saved = buildAgentOverride(draft, rows("0,5", ""));
		expect(saved.rules?.map((rule) => rule.weight)).toEqual([0.5, 1]);
	});

	test("unreadable weights are still refused", () => {
		registerActiveI18nRuntime(german);
		expect(smartRoutingRulesError(rows("abc", "1"), "random")).not.toBeNull();
	});
});
