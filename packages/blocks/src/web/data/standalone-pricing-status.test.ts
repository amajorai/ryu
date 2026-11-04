import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	STANDALONE_PRODUCT_PRICING,
	standaloneStatusLabel,
} from "./standalone-pricing.ts";

test("every published status has an English label equal to its id", () => {
	for (const entry of STANDALONE_PRODUCT_PRICING) {
		expect(standaloneStatusLabel(entry.status)).toBe(entry.status);
	}
	expect(STANDALONE_PRODUCT_PRICING.map((entry) => entry.status)).toContain(
		"Metered"
	);
});

test("a status label goes through the given translator", () => {
	const german: LiteralMessage = (source, values) =>
		formatMessage(source === "Metered" ? "Nach Verbrauch" : source, values);
	expect(standaloneStatusLabel("Metered", german)).toBe("Nach Verbrauch");
});
