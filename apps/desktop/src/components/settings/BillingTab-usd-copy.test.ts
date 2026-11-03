import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	balanceThresholdError,
	rechargeRangeError,
	sandboxBudgetCaption,
} from "./BillingTab-usd-copy.ts";

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");
const raw: LiteralMessage = (source) => source;

/** Intl separates digit groups and the sign with (narrow) no-break spaces. */
const plainSpaces = (text: string): string => text.replaceAll(/[  ]/gu, " ");

describe("sandboxBudgetCaption", () => {
	test("keeps the published English sentence", () => {
		expect(sandboxBudgetCaption(english, "en")).toBe(
			"The most one sandboxed run on this node may cost before Ryu stops it. $0 means no limit."
		);
	});

	test("formats the zero amount for German", () => {
		const caption = plainSpaces(sandboxBudgetCaption(english, "de"));
		expect(caption).toContain("0 $ means no limit.");
		expect(caption).not.toContain("$0");
	});

	test("hands translators one sentence with a placeholder", () => {
		expect(sandboxBudgetCaption(raw, "en")).toContain(
			"{zeroAmount} means no limit."
		);
	});
});

describe("billing amount errors", () => {
	test("keep the published English sentences", () => {
		expect(balanceThresholdError(english, "en")).toBe(
			"Set a balance threshold above $0."
		);
		expect(rechargeRangeError(english, 5, 1000, "en")).toBe(
			"Recharge amount must be between $5 and $1,000."
		);
	});

	test("format the amounts for German", () => {
		expect(plainSpaces(balanceThresholdError(english, "de"))).toBe(
			"Set a balance threshold above 0 $."
		);
		expect(plainSpaces(rechargeRangeError(english, 5, 1000, "de"))).toBe(
			"Recharge amount must be between 5 $ and 1.000 $."
		);
	});

	test("hand translators placeholders, not amounts", () => {
		expect(balanceThresholdError(raw)).not.toMatch(/\$/u);
		expect(rechargeRangeError(raw, 5, 1000)).not.toMatch(/\$/u);
	});
});
