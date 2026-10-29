import { describe, expect, test } from "bun:test";
import { defaultRetryPolicy, formatRoutingSignal } from "./routing.ts";

describe("formatRoutingSignal", () => {
	test("usd readings always show two decimals", () => {
		const reading = { label: "Ryu credits", threshold: 5 };
		expect(formatRoutingSignal({ ...reading, unit: "usd", value: 3 })).toBe(
			"$3.00"
		);
		expect(formatRoutingSignal({ ...reading, unit: "usd", value: 1.5 })).toBe(
			"$1.50"
		);
		expect(formatRoutingSignal({ ...reading, unit: "usd", value: 0.456 })).toBe(
			"$0.46"
		);
	});

	test("percent readings are rounded to whole percent", () => {
		const reading = { label: "Claude weekly", threshold: 50 };
		expect(
			formatRoutingSignal({ ...reading, unit: "percent", value: 42.6 })
		).toBe("43%");
		expect(
			formatRoutingSignal({ ...reading, unit: "percent", value: 7.4 })
		).toBe("7%");
		expect(formatRoutingSignal({ ...reading, unit: "percent", value: 0 })).toBe(
			"0%"
		);
	});
});

describe("defaultRetryPolicy", () => {
	test("is off, rerouting, unrestricted, with a 2% spent threshold", () => {
		expect(defaultRetryPolicy()).toEqual({
			enabled: false,
			notify_only: false,
			candidates: [],
			spent_below_percent: 2,
		});
	});

	test("returns a fresh object so an edited draft cannot leak into the default", () => {
		const draft = defaultRetryPolicy();
		draft.enabled = true;
		draft.candidates.push("acp:codex");
		expect(defaultRetryPolicy().enabled).toBe(false);
		expect(defaultRetryPolicy().candidates).toEqual([]);
	});
});
