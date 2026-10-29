import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	diffLines,
	diffPromptVersions,
	isAssignablePromptLabel,
	isPromptName,
	promptCreateInputSchema,
	promptVersionInputSchema,
	promptVersionVariables,
	templateSyntaxError,
	templateVariables,
} from "./prompt-hub.ts";

const fixtureSchema = z.object({
	cases: z.array(
		z.object({
			name: z.string(),
			template: z.string(),
			variables: z.array(z.string()).optional(),
			error: z.boolean().optional(),
		})
	),
});

const fixture = fixtureSchema.parse(
	JSON.parse(
		readFileSync(
			join(import.meta.dir, "fixtures/prompt-templates.json"),
			"utf8"
		)
	)
);

describe("golden prompt templates", () => {
	for (const golden of fixture.cases) {
		test(golden.name, () => {
			if (golden.error) {
				expect(templateSyntaxError(golden.template)).not.toBeNull();
				expect(() => templateVariables(golden.template)).toThrow();
				return;
			}
			expect(templateSyntaxError(golden.template)).toBeNull();
			expect(templateVariables(golden.template)).toEqual(
				golden.variables ?? []
			);
		});
	}
});

describe("names and labels", () => {
	test("prompt names are URL-safe and bounded", () => {
		expect(isPromptName("support.triage-v2")).toBe(true);
		expect(isPromptName("a/b")).toBe(false);
		expect(isPromptName("-leading")).toBe(false);
		expect(isPromptName("x".repeat(129))).toBe(false);
	});

	test("latest is reserved and labels are lowercase", () => {
		expect(isAssignablePromptLabel("production")).toBe(true);
		expect(isAssignablePromptLabel("canary-eu")).toBe(true);
		expect(isAssignablePromptLabel("latest")).toBe(false);
		expect(isAssignablePromptLabel("Prod")).toBe(false);
	});
});

describe("version input", () => {
	test("text prompts need a template and refuse messages", () => {
		expect(promptVersionInputSchema.safeParse({ type: "text" }).success).toBe(
			false
		);
		expect(
			promptVersionInputSchema.safeParse({
				type: "text",
				template: "hi",
				messages: [{ role: "user", content: "x" }],
			}).success
		).toBe(false);
	});

	test("chat prompts accept messages and placeholders", () => {
		const parsed = promptVersionInputSchema.parse({
			type: "chat",
			messages: [
				{ role: "system", content: "You help {{team}}." },
				{ type: "placeholder", name: "history" },
				{ role: "user", content: "{{question}}" },
			],
			labels: ["staging", "staging"],
		});
		expect(parsed.labels).toEqual(["staging"]);
		expect(promptVersionVariables(parsed)).toEqual({
			placeholders: ["history"],
			variables: ["team", "question"],
		});
	});

	test("template syntax errors carry the failing path", () => {
		const result = promptVersionInputSchema.safeParse({
			type: "chat",
			messages: [
				{ role: "system", content: "ok" },
				{ role: "user", content: "{{#open}}" },
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["messages", 1, "content"]);
	});

	test("the latest label cannot be assigned", () => {
		expect(
			promptVersionInputSchema.safeParse({
				type: "text",
				template: "x",
				labels: ["latest"],
			}).success
		).toBe(false);
	});

	test("create input dedupes tags", () => {
		const parsed = promptCreateInputSchema.parse({
			name: "triage",
			tags: ["support", "support"],
			version: { type: "text", template: "x" },
		});
		expect(parsed.tags).toEqual(["support"]);
	});
});

describe("diff", () => {
	test("line diff keeps common lines and orders removals first", () => {
		expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
			{ op: "equal", text: "a" },
			{ op: "remove", text: "b" },
			{ op: "add", text: "x" },
			{ op: "equal", text: "c" },
		]);
	});

	test("line diff of large rewrites stays bounded and complete", () => {
		const before = Array.from({ length: 40_000 }, (_, i) => `a${i}`);
		const after = Array.from({ length: 40_000 }, (_, i) => `b${i}`);
		const lines = diffLines(
			["head", ...before, "tail"].join("\n"),
			["head", ...after, "tail"].join("\n")
		);
		expect(lines).toHaveLength(80_002);
		expect(lines[0]).toEqual({ op: "equal", text: "head" });
		expect(lines[1]).toEqual({ op: "remove", text: "a0" });
		expect(lines[40_001]).toEqual({ op: "add", text: "b0" });
		expect(lines.at(-1)).toEqual({ op: "equal", text: "tail" });
	});

	test("line diff matches the LCS inside the changed middle", () => {
		expect(diffLines("p\na\nb\nc\ns", "p\nb\nc\nd\ns")).toEqual([
			{ op: "equal", text: "p" },
			{ op: "remove", text: "a" },
			{ op: "equal", text: "b" },
			{ op: "equal", text: "c" },
			{ op: "add", text: "d" },
			{ op: "equal", text: "s" },
		]);
		expect(diffLines("same", "same")).toEqual([{ op: "equal", text: "same" }]);
	});

	test("version diff reports variables and model config changes", () => {
		const diff = diffPromptVersions(
			{
				version: 1,
				type: "text",
				template: "Hi {{name}}",
				messages: null,
				variables: ["name"],
				modelConfig: { model: "gpt-x", temperature: 0.2 },
			},
			{
				version: 2,
				type: "chat",
				template: null,
				messages: [{ role: "system", content: "Hi {{user}}" }],
				variables: ["user"],
				modelConfig: { model: "gpt-x", maxTokens: 100 },
			}
		);
		expect(diff.typeChanged).toBe(true);
		expect(diff.variables).toEqual({ added: ["user"], removed: ["name"] });
		expect(diff.modelConfig).toEqual({
			maxTokens: { from: null, to: 100 },
			temperature: { from: 0.2, to: null },
		});
		expect(diff.lines).toEqual([
			{ op: "remove", text: "Hi {{name}}" },
			{ op: "add", text: "[system]" },
			{ op: "add", text: "Hi {{user}}" },
		]);
	});
});
