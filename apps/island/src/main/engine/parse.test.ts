import { describe, expect, it } from "bun:test";
import { extractJsonObject, parseModelSuggestion } from "./parse.ts";

describe("extractJsonObject", () => {
	it("returns the object from clean JSON", () => {
		expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
	});

	it("strips leading prose and trailing commentary", () => {
		const raw = 'Sure! Here you go:\n{"relevant":true}\nHope that helps.';
		expect(extractJsonObject(raw)).toBe('{"relevant":true}');
	});

	it("unwraps a ```json fenced block", () => {
		const raw = '```json\n{"x": {"y": 2}}\n```';
		expect(extractJsonObject(raw)).toBe('{"x": {"y": 2}}');
	});

	it("ignores braces inside strings", () => {
		const raw = '{"body":"use { and } carefully"}';
		expect(extractJsonObject(raw)).toBe(raw);
	});

	it("returns null when there is no object", () => {
		expect(extractJsonObject("no json here")).toBeNull();
	});

	it("returns null for an unbalanced object", () => {
		expect(extractJsonObject('{"a":1')).toBeNull();
	});
});

describe("parseModelSuggestion", () => {
	const valid =
		'{"relevant":true,"title":"Summarize","body":"This page is long.","action":"chat","confidence":0.8}';

	it("parses a valid suggestion", () => {
		const parsed = parseModelSuggestion(valid);
		expect(parsed).toEqual({
			relevant: true,
			title: "Summarize",
			body: "This page is long.",
			action: "chat",
			confidence: 0.8,
		});
	});

	it("parses through surrounding prose", () => {
		const parsed = parseModelSuggestion(`Here:\n${valid}\nDone.`);
		expect(parsed?.title).toBe("Summarize");
	});

	it("drops relevant:false", () => {
		expect(
			parseModelSuggestion('{"relevant":false,"title":"x","confidence":0.9}')
		).toBeNull();
	});

	it("drops low-confidence suggestions", () => {
		expect(
			parseModelSuggestion(
				'{"relevant":true,"title":"x","body":"y","confidence":0.3}'
			)
		).toBeNull();
	});

	it("drops suggestions with an empty title", () => {
		expect(
			parseModelSuggestion(
				'{"relevant":true,"title":"  ","body":"y","confidence":0.9}'
			)
		).toBeNull();
	});

	it("never throws on malformed input", () => {
		expect(parseModelSuggestion("totally not json")).toBeNull();
		expect(parseModelSuggestion("{broken")).toBeNull();
		expect(parseModelSuggestion("")).toBeNull();
	});

	it("defaults action to chat and clamps confidence", () => {
		const parsed = parseModelSuggestion(
			'{"relevant":true,"title":"t","body":"b","confidence":5}'
		);
		expect(parsed?.action).toBe("chat");
		expect(parsed?.confidence).toBe(1);
	});
});
