import { describe, expect, test } from "bun:test";
import type { PromptSummary, PromptVersion } from "./api/prompts.ts";
import {
	assignableLabel,
	editorCommitDraft,
	filterPrompts,
	instructionsFromVersion,
	isEditablePrompt,
	labelEntries,
	versionBody,
	versionDiffRows,
} from "./prompt-library.ts";

function summary(overrides: Partial<PromptSummary>): PromptSummary {
	return {
		name: "triage",
		description: null,
		tags: [],
		type: "text",
		latestVersion: 1,
		labels: {},
		source: "local",
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function version(overrides: Partial<PromptVersion>): PromptVersion {
	return {
		name: "triage",
		version: 1,
		type: "text",
		template: "Hi {{name}}",
		messages: null,
		variables: ["name"],
		placeholders: [],
		modelConfig: {},
		commitMessage: null,
		createdAt: "",
		createdBy: null,
		labels: [],
		...overrides,
	};
}

describe("prompt library helpers", () => {
	test("filters by name, description, tag and label", () => {
		const prompts = [
			summary({ name: "triage", tags: ["support"] }),
			summary({ name: "summarize", description: "Docs digest" }),
			summary({ name: "router", labels: { canary: 2 } }),
		];
		expect(filterPrompts(prompts, "SUPPORT").map((p) => p.name)).toEqual([
			"triage",
		]);
		expect(filterPrompts(prompts, "digest").map((p) => p.name)).toEqual([
			"summarize",
		]);
		expect(filterPrompts(prompts, "canary").map((p) => p.name)).toEqual([
			"router",
		]);
		expect(filterPrompts(prompts, " ")).toHaveLength(3);
	});

	test("orders production first", () => {
		expect(
			labelEntries({ labels: { staging: 2, canary: 3, production: 1 } })
		).toEqual([
			{ label: "production", version: 1 },
			{ label: "canary", version: 3 },
			{ label: "staging", version: 2 },
		]);
	});

	test("instructions keep the raw template or the system messages", () => {
		expect(instructionsFromVersion(version({}))).toBe("Hi {{name}}");
		const chat = version({
			type: "chat",
			template: null,
			messages: [
				{ role: "system", content: "Be brief." },
				{ type: "placeholder", name: "history" },
				{ role: "user", content: "{{q}}" },
				{ role: "developer", content: "Cite sources." },
			],
		});
		expect(instructionsFromVersion(chat)).toBe("Be brief.\n\nCite sources.");
		expect(versionBody(chat)).toContain("[placeholder: history]");
	});

	test("diff rows carry ids and readable model config changes", () => {
		const diff = versionDiffRows(
			version({ modelConfig: { temperature: 0.2 } }),
			version({
				version: 2,
				template: "Hello {{user}}",
				variables: ["user"],
				modelConfig: { temperature: 0.7 },
			})
		);
		expect(diff.rows).toEqual([
			{ id: "0", op: "remove", text: "Hi {{name}}" },
			{ id: "1", op: "add", text: "Hello {{user}}" },
		]);
		expect(diff.variables).toEqual({ added: ["user"], removed: ["name"] });
		expect(diff.modelConfig).toEqual(["temperature: 0.2 → 0.7"]);
	});

	test("labels are normalized and latest is refused", () => {
		expect(assignableLabel(" Staging ")).toBe("staging");
		expect(assignableLabel("latest")).toBeNull();
		expect(assignableLabel("bad label")).toBeNull();
	});

	test("organization mirrors are read-only", () => {
		expect(isEditablePrompt({ source: "cloud" })).toBe(false);
		expect(isEditablePrompt({ source: "local" })).toBe(true);
	});
});

describe("editorCommitDraft", () => {
	test("a text prompt commits the editor text as its template", () => {
		expect(
			editorCommitDraft(version({ version: 3, template: "old" }), "new")
		).toEqual({
			type: "text",
			template: "new",
			modelConfig: {},
			expectedLatestVersion: 3,
		});
	});

	test("an editor commit keeps the latest version's model settings", () => {
		const modelConfig = { model: "claude-x", temperature: 0.2 };
		expect(
			editorCommitDraft(version({ modelConfig, template: "old" }), "new")
				.modelConfig
		).toEqual(modelConfig);
		expect(
			editorCommitDraft(
				version({
					modelConfig,
					type: "chat",
					template: null,
					messages: [{ role: "user", content: "{{ticket}}" }],
				}),
				"persona"
			).modelConfig
		).toEqual(modelConfig);
	});

	test("a chat prompt keeps its messages and replaces the instructions", () => {
		const latest = version({
			version: 2,
			type: "chat",
			template: null,
			messages: [
				{ role: "user", content: "Context {{x}}" },
				{ role: "system", content: "old persona" },
				{ role: "developer", content: "old rules" },
				{ type: "placeholder", name: "history" },
				{ role: "user", content: "{{ticket}}" },
			],
		});
		expect(editorCommitDraft(latest, "new persona")).toEqual({
			type: "chat",
			messages: [
				{ role: "user", content: "Context {{x}}" },
				{ role: "system", content: "new persona" },
				{ type: "placeholder", name: "history" },
				{ role: "user", content: "{{ticket}}" },
			],
			modelConfig: {},
			expectedLatestVersion: 2,
		});
	});

	test("a chat prompt without instructions gets a leading system message", () => {
		const latest = version({
			type: "chat",
			template: null,
			messages: [{ role: "user", content: "{{ticket}}" }],
		});
		expect(editorCommitDraft(latest, "persona").messages).toEqual([
			{ role: "system", content: "persona" },
			{ role: "user", content: "{{ticket}}" },
		]);
	});
});
