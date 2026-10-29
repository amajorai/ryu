import { expect, test } from "bun:test";
import { samplingConfigSchema } from "./inference.ts";

test("sampling transport retains raw provider extras and future JSON generation fields", () => {
	const input = {
		temperature: 0.7,
		stop: ["end", "done"],
		extra: { provider_hint: { priority: 2 }, flags: [true, null] },
		logit_bias: { "42": -50 },
		future_sampler: { mode: "adaptive" },
	};
	expect(samplingConfigSchema.parse(input)).toEqual(input);
	expect(samplingConfigSchema.parse({})).toEqual({});
});

test("sampling transport rejects invalid known fields and values JSON cannot carry", () => {
	for (const input of [
		{ temperature: "0.7" },
		{ stop: ["valid", 42] },
		{ temperature: Number.NaN },
		{ extra: { unsupported: 1n } },
	]) {
		expect(samplingConfigSchema.safeParse(input).success).toBe(false);
	}
});
