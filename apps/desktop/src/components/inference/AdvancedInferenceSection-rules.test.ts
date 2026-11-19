import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	jsonObjectSchema,
	logitBiasSchema,
	samplingNumberError,
} from "./AdvancedInferenceSection-rules.ts";

function firstMessage(result: { error?: { issues: { message: string }[] } }) {
	return result.error?.issues[0]?.message;
}

describe("advanced inference JSON schemas", () => {
	test("non-object JSON reports the field's own copy", () => {
		expect(firstMessage(jsonObjectSchema.safeParse([]))).toBe(
			"Must be a JSON object"
		);
		expect(firstMessage(jsonObjectSchema.safeParse(null))).toBe(
			"Must be a JSON object"
		);
		expect(jsonObjectSchema.safeParse({ type: "json_object" }).success).toBe(
			true
		);
	});

	test("logit bias validates token ids and bias range", () => {
		expect(firstMessage(logitBiasSchema.safeParse({ "42": "2" }))).toBe(
			"Bias values must be numbers from -100 to 100."
		);
		expect(firstMessage(logitBiasSchema.safeParse({ "42": 101 }))).toBe(
			"Bias values must be numbers from -100 to 100."
		);
		expect(firstMessage(logitBiasSchema.safeParse({ token: 2 }))).toBe(
			"Token IDs must be non-negative integers."
		);
		expect(firstMessage(logitBiasSchema.safeParse([]))).toBe(
			"Must be a JSON object"
		);
		expect(logitBiasSchema.safeParse({ "42": -100, "17": 100 }).data).toEqual({
			"42": -100,
			"17": 100,
		});
	});
});

describe("samplingNumberError", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;

	test("the field label is translated before it fills the sentence", () => {
		expect(
			samplingNumberError("frequency_penalty", 3, "model", undefined, tl)
		).toBe(
			'[{label} must be no greater than {max}.]{"label":"[Frequency penalty]","max":"2"}'
		);
		expect(samplingNumberError("seed", 1.5, "model", undefined, tl)).toBe(
			'[{label} must be a whole number.]{"label":"[Seed]"}'
		);
	});
});
