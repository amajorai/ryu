import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { servicesSummaryLine } from "./NodeSelector-services-summary.ts";

const STOPPED =
	"{count, plural, one {{services} stopped} other {{services} stopped}}";

// A stand-in `tl` over a small catalog, filled the way the runtime fills it.
function translator(locale: string, catalog: Record<string, string>) {
	return ((source: string, values?: MessageValuesInput) =>
		formatMessage(catalog[source] ?? source, values, locale)) as LiteralMessage;
}

describe("services summary line", () => {
	test("English names the stopped services in a list", () => {
		const tl = translator("en", {});
		expect(servicesSummaryLine(tl, false, ["Core", "Network"])).toBe(
			"Core and Network stopped"
		);
		expect(servicesSummaryLine(tl, false, [])).toBe("All running");
		expect(servicesSummaryLine(tl, true, ["Core"])).toBe("Checking…");
	});

	test("Japanese translates the sentence and the Network name", () => {
		const tl = translator("ja", {
			Network: "ネットワーク",
			[STOPPED]: "{services} が停止しています",
		});
		const line = servicesSummaryLine(tl, false, ["Gateway", "Network"]);
		expect(line).toContain("ネットワーク");
		expect(line).toContain("が停止しています");
		expect(line).not.toContain("stopped");
	});
});
