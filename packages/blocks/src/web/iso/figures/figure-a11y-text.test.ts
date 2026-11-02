import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	ALONGSIDE,
	ENGINE_COUNT,
	spokenOf as engineSpokenOf,
	previewSpokenOf,
	restingSpoken,
} from "./core-engines/model.ts";
import {
	describePipeline,
	spokenOf as pipelineSpokenOf,
} from "./gateway-pipeline/model.ts";
import { describePassport, passportLabel } from "./passport-cabinet/model.ts";
import { describeSandbox } from "./sandbox-glovebox/model.ts";
import {
	describeWorkflowRun,
	NODE_COUNT,
	nodeAt,
} from "./workflow-run/model.ts";
import { type NodeStatus, statusLabel } from "./workflow-run/sim.ts";

/*
 * Every word a figure gives assistive tech must go through `tl`, as a whole sentence,
 * so a German or Japanese reader never hears an English fragment spliced into it.
 * The marker translator wraps each message it is handed in ⟦…⟧ and fills its
 * placeholders; any English that reaches the output without passing through `tl`
 * shows up outside a pair of brackets.
 */
const marked: LiteralMessage = (source, values = {}) => {
	const filled = source.replace(/\{(\w+)\}/gu, (_, name: string) =>
		String((values as Record<string, unknown>)[name] ?? `{${name}}`)
	);
	return `⟦${filled}⟧`;
};

/** The text left after removing every bracketed message, which must be empty. */
function untranslated(text: string): string {
	let rest = text;
	let previous = "";
	while (rest !== previous) {
		previous = rest;
		rest = rest.replace(/⟦[^⟦⟧]*⟧/gu, "");
	}
	return rest;
}

describe("figure accessibility text", () => {
	test("workflow run description and every node sentence go through tl", () => {
		expect(untranslated(describeWorkflowRun(marked))).toBe("");
		for (let node = 0; node < NODE_COUNT; node += 1) {
			expect(untranslated(nodeAt(node).name(marked))).toBe("");
			const does = nodeAt(node).does(marked);
			expect(does.length).toBeGreaterThan(2);
			expect(untranslated(does)).toBe("");
		}
		const statuses: NodeStatus[] = [
			"skipped",
			"completed",
			"awaiting-input",
			"running",
			"pending",
		];
		for (const status of statuses) {
			expect(untranslated(statusLabel(status, marked))).toBe("");
		}
	});

	test("core engine value text is whole translated sentences", () => {
		expect(untranslated(restingSpoken(marked))).toBe("");
		for (let engine = 0; engine < ENGINE_COUNT; engine += 1) {
			expect(untranslated(engineSpokenOf(engine, "loaded", 0, marked))).toBe(
				""
			);
			expect(untranslated(previewSpokenOf(engine, marked))).toBe("");
		}
		expect(untranslated(engineSpokenOf(null, "loaded", 0, marked))).toBe("");
		expect(untranslated(engineSpokenOf(0, "loading", 1, marked))).toBe("");
		expect(untranslated(engineSpokenOf(0, "unloading", 1, marked))).toBe("");
		for (const slot of ALONGSIDE) {
			expect(untranslated(slot.spoken(marked))).toBe("");
		}
	});

	test("passport description and label go through tl with localized numbers", () => {
		expect(untranslated(describePassport(marked, "en"))).toBe("");
		expect(untranslated(passportLabel(marked))).toBe("");
		expect(describePassport(marked, "de")).toContain("512 KiB");
	});

	test("the reference figures keep following the same pattern", () => {
		expect(untranslated(describePipeline(marked))).toBe("");
		expect(untranslated(pipelineSpokenOf(0, marked, "en"))).toBe("");
		expect(untranslated(describeSandbox(marked, "en"))).toBe("");
	});
});
