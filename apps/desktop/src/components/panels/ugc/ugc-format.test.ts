import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { formatPayoutRule } from "./ugc-format.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("formatPayoutRule", () => {
	test("a CPM rule is one message with the amount as a value", () => {
		expect(formatPayoutRule({ type: "cpm", cpm_cents: 250 }, tl)).toMatch(
			/^\[\{amount\} per 1,000 views\]\{"amount":".*2\.50"\}$/u
		);
	});

	test("a flat rule is one message with the amount as a value", () => {
		expect(formatPayoutRule({ type: "flat", flat_cents: 1200 }, tl)).toMatch(
			/^\[\{amount\} per approved post\]\{"amount":".*12\.00"\}$/u
		);
	});

	test("a missing rule says so in a translated message", () => {
		expect(formatPayoutRule(undefined, tl)).toBe("[No payout rule]");
	});
});
