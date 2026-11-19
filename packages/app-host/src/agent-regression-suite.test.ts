import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
// The provider registers its runtime here; the test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../i18n/src/active-locale.ts";
import { agentRegressionSuiteNames } from "./agent-regression-suite.ts";

const DE: Record<string, string> = {
	"Agent regression suite": "Agent-Regressionssuite",
	"Trace baseline": "Trace-Ausgangswert",
};

const runtime = {
	direction: "ltr" as const,
	locale: "de",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		const english = fallback ?? source;
		return formatMessage(DE[english] ?? english, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(runtime);
});

test("a trace import's new suite is named in the creator's language", () => {
	const tl: LiteralMessage = (source) => `[${source}]`;
	expect(agentRegressionSuiteNames(tl)).toEqual({
		label: "[Trace baseline]",
		name: "[Agent regression suite]",
	});
});

test("without a translator the names follow the active locale", () => {
	registerActiveI18nRuntime(runtime);
	expect(agentRegressionSuiteNames()).toEqual({
		label: "Trace-Ausgangswert",
		name: "Agent-Regressionssuite",
	});
});
