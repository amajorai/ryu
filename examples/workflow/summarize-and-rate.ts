#!/usr/bin/env bun

/**
 * A Ryu workflow (Runnable, kind: "workflow") that composes other Runnables.
 *
 * A workflow orchestrates steps — here it calls a tool (deterministic) and a
 * model (via the gateway) in sequence. Any Runnable can be a step; agents,
 * tools, and workflows are peers under one `run(input, ctx)` contract.
 *
 * Run:  bun run examples/workflow/summarize-and-rate.ts
 */

import { defineTool, defineWorkflow } from "@ryuhq/sdk";
import { defineModel } from "@ryuhq/sdk/model";

const model = defineModel(process.env.RYU_MODEL ?? "gpt-4o-mini");

// A deterministic step: word count.
const wordCount = defineTool<{ text: string }, number>({
	id: "tool-word-count",
	name: "Word Count",
	schema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	run(input) {
		return Promise.resolve(
			input.text.trim().split(/\s+/).filter(Boolean).length
		);
	},
});

export const summarizeAndRate = defineWorkflow<
	{ text: string },
	{ words: number; summary: string }
>({
	id: "workflow-summarize-and-rate",
	name: "Summarize & Count",
	async run(input, ctx) {
		const words = await wordCount.run({ text: input.text }, ctx);
		const reply = await model.chat([
			{ role: "system", content: "Summarize the user's text in one sentence." },
			{ role: "user", content: input.text },
		]);
		return { words, summary: reply.content };
	},
});

if (import.meta.main) {
	const text =
		"Ryu wraps any agent engine behind one control layer that governs every model call.";
	const out = await summarizeAndRate.run(
		{ text },
		{ gateway: undefined as never }
	);
	process.stdout.write(`${out.words} words — ${out.summary}\n`);
}
