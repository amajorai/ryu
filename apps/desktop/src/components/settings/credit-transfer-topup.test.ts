import { describe, expect, test } from "bun:test";
import {
	formatMoneyPlaceholder,
	readTopupInput,
} from "./credit-transfer-topup.ts";

describe("readTopupInput", () => {
	test("reads a German decimal comma as cents, not a truncated dollar", () => {
		expect(readTopupInput("7,5", "de")).toEqual({
			invalid: false,
			microUsd: 7_500_000,
		});
	});

	test("reads English amounts and empty input", () => {
		expect(readTopupInput("1,000.25", "en").microUsd).toBe(1_000_250_000);
		expect(readTopupInput("", "en")).toEqual({ invalid: false, microUsd: 0 });
	});

	test("flags unreadable or negative text instead of truncating it", () => {
		expect(readTopupInput("7,5", "en")).toEqual({ invalid: true, microUsd: 0 });
		expect(readTopupInput("abc", "de").invalid).toBe(true);
		expect(readTopupInput("-3", "en").invalid).toBe(true);
	});
});

describe("formatMoneyPlaceholder", () => {
	test("writes the placeholder with the locale's decimal separator", () => {
		expect(formatMoneyPlaceholder("en")).toBe("0.00");
		expect(formatMoneyPlaceholder("de")).toBe("0,00");
	});
});
