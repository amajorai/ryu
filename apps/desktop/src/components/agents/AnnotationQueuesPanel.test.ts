// apps/desktop/src/components/agents/AnnotationQueuesPanel.test.ts
//
// The review form's input parsing: label lists become the closed label set
// Core validates submissions against, and a score field must distinguish
// "no score" (omitted) from "not a number" (rejected before submit).

import { describe, expect, it } from "bun:test";
import { parseLabelList, parseScore } from "./AnnotationQueuesPanel.tsx";

describe("annotation review input parsing", () => {
	it("splits, trims and de-duplicates labels", () => {
		expect(parseLabelList(" correct, rude ,, correct,off-topic ")).toEqual([
			"correct",
			"rude",
			"off-topic",
		]);
		expect(parseLabelList("")).toEqual([]);
	});

	it("treats a blank score as omitted and garbage as invalid", () => {
		expect(parseScore("")).toBeUndefined();
		expect(parseScore("  ")).toBeUndefined();
		expect(parseScore("4.5")).toBe(4.5);
		expect(parseScore("four")).toBeNull();
	});
});
