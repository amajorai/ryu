import { describe, expect, test } from "bun:test";
import { trialBillingSentence } from "./BillingTab-plan-copy.ts";

const tl = (source: string) => `[${source}]`;

describe("trialBillingSentence", () => {
	test("each interval translates as one whole sentence", () => {
		expect(trialBillingSentence("month", tl)).toBe(
			"[Billed monthly after trial ends.]"
		);
		expect(trialBillingSentence("year", tl)).toBe(
			"[Billed annually after trial ends.]"
		);
	});

	test("no interval, or an unknown one, adds no sentence", () => {
		expect(trialBillingSentence(null, tl)).toBe("");
		expect(trialBillingSentence("week", tl)).toBe("");
	});
});
