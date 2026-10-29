import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	pluginDocumentSchema,
	pluginRecord,
} from "../src/lib/api/plugin-wire-values.ts";
import { parseProofJson, parseProofJsonRecord } from "./fixture-json.ts";

import type { PromptStudioFixtureHooks } from "./prompt-studio-fixture-contract.ts";

declare global {
	interface Window {
		__promptStudioProof: PromptStudioFixtureHooks;
	}
}

const exportedPromptFixtureSchema = z.object({
	defaultTest: pluginDocumentSchema,
	evaluateOptions: pluginDocumentSchema,
	judge_model: z.string(),
	prompts: z.array(
		z.union([
			z.string(),
			z.object({ content: z.string(), id: z.string(), name: z.string() }),
		])
	),
	providers: z.array(z.string()),
	tests: z.array(
		z.object({
			assert: z.array(
				z.object({ type: z.string(), value: z.string(), weight: z.number() })
			),
			id: z.string(),
			prompt: z.string(),
			threshold: z.number(),
		})
	),
});

const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

async function readProof(page: import("@playwright/test").Page) {
	return await page.evaluate(() => window.__promptStudioProof.snapshot());
}

async function armFailure(
	page: import("@playwright/test").Page,
	operation: string
): Promise<void> {
	await page.evaluate(
		(name) => window.__promptStudioProof.armFailure(name),
		operation
	);
}

async function downloadedText(download: import("@playwright/test").Download) {
	const filePath = await download.path();
	expect(filePath).not.toBeNull();
	if (filePath === null) {
		throw new Error("Prompt Studio download path is missing.");
	}
	return await readFile(filePath, "utf8");
}

test("Prompt preview sends the rendered draft through Core and starts a fresh session when reopened", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	await expect(page.getByTestId("proof-status")).toHaveText(
		"Production UI mounted"
	);
	const editor = page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first();
	await expect(editor).toBeVisible();
	await expect(editor).toContainText("You are a concise assistant.");
	await expect(editor).toContainText("Use {{topic}}.");
	await editor.fill("You are a QA assistant. Use {{product}} carefully.");
	await expect(editor).toContainText("You are a QA assistant.");
	await expect
		.poll(async () => (await readProof(page)).draft)
		.toContain("{{product}}");
	await expect(page.getByText(/1 variable detected/u)).toBeVisible();
	await page.getByLabel("product", { exact: true }).fill("Ryu Desktop");
	await page.getByRole("button", { name: "Preview prompt" }).click();
	await expect(
		page.getByText("Preview response", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Preview fixture response.", { exact: true })
	).toBeVisible();
	let snapshot = await readProof(page);
	let chatRequest = snapshot.requests.find(
		(request) =>
			request.path === "/api/chat/stream" && request.method === "POST"
	);
	expect(chatRequest?.body).toMatchObject({
		agent_id: "prompt-studio-proof-agent",
		conversation_id: expect.any(String),
		enable_long_term: false,
		response_mode: "developer",
	});
	expect(JSON.stringify(chatRequest?.body)).toContain(
		"You are a QA assistant. Use Ryu Desktop carefully."
	);
	const firstConversationId = z
		.object({ conversation_id: z.string() })
		.parse(chatRequest?.body).conversation_id;
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-preview-response.png"),
	});
	await page.getByRole("button", { name: "Close preview" }).click();
	await expect(page.getByText("Preview response", { exact: true })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Preview prompt" }).click();
	await expect(
		page.getByText("Preview fixture response.", { exact: true })
	).toBeVisible();
	snapshot = await readProof(page);
	chatRequest = snapshot.requests.filter(
		(request) =>
			request.path === "/api/chat/stream" && request.method === "POST"
	)[1];
	expect(chatRequest?.body).toMatchObject({
		conversation_id: expect.any(String),
	});
	expect(
		z.object({ conversation_id: z.string() }).parse(chatRequest?.body)
			.conversation_id
	).not.toBe(firstConversationId);
	const secondConversationId = z
		.object({ conversation_id: z.string() })
		.parse(chatRequest?.body).conversation_id;
	await page.getByRole("button", { name: "Close preview" }).click();
	await armFailure(page, "preview-chat");
	await page.getByRole("button", { name: "Preview prompt" }).click();
	await expect(page.locator(".text-status-destructive").first()).toBeVisible();
	snapshot = await readProof(page);
	chatRequest = snapshot.requests.filter(
		(request) =>
			request.path === "/api/chat/stream" && request.method === "POST"
	)[2];
	expect(chatRequest?.body).toMatchObject({
		conversation_id: expect.any(String),
	});
	expect(
		z.object({ conversation_id: z.string() }).parse(chatRequest?.body)
			.conversation_id
	).not.toBe(secondConversationId);
	await page.getByRole("button", { name: "Close preview" }).click();
	await page.getByRole("button", { name: "Preview prompt" }).click();
	await expect(
		page.getByText("Preview fixture response.", { exact: true })
	).toBeVisible();
	snapshot = await readProof(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.path === "/api/chat/stream" && request.method === "POST"
		)
	).toHaveLength(4);
	await page.getByRole("button", { name: "Close preview" }).click();
	await page.evaluate(() => window.__promptStudioProof.holdNextPreviewChat());
	await page.getByRole("button", { name: "Preview prompt" }).click();
	await expect(
		page.getByRole("button", { name: "Stop preview response" })
	).toBeVisible();
	await page.getByRole("button", { name: "Stop preview response" }).click();
	await expect(
		page.getByRole("button", { name: "Stop preview response" })
	).toHaveCount(0);
	await expect
		.poll(async () => (await readProof(page)).abortedPreviewChats)
		.toBe(1);
	// Core keeps a saved preview turn running after its stream is aborted, so
	// Stop must also cancel that conversation's turn on Core.
	snapshot = await readProof(page);
	const heldConversationId = z
		.object({ conversation_id: z.string() })
		.parse(
			snapshot.requests
				.filter(
					(request) =>
						request.path === "/api/chat/stream" && request.method === "POST"
				)
				.at(-1)?.body
		).conversation_id;
	await expect
		.poll(async () =>
			(await readProof(page)).requests
				.filter(
					(request) =>
						request.path === "/api/chat/cancel" && request.method === "POST"
				)
				.map((request) => request.body)
		)
		.toEqual([{ conversation_id: heldConversationId }]);
});

test("Prompt Studio keeps the complete local prompt-testing workflow visible", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await page.goto("/prompt-studio-proof.html?reset=true", {
		waitUntil: "domcontentloaded",
	});
	await page.waitForLoadState("networkidle");
	await expect(page.getByTestId("proof-status")).toHaveText(
		"Production UI mounted"
	);
	await expect(page.getByText("Prompt Studio").first()).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-proof-initial.png"),
	});

	await page.getByLabel("Suite name").fill("Promptfoo regression suite");
	await page.getByLabel("Version label (optional)").fill("Baseline");
	await page.getByRole("button", { name: "Add variant" }).click();
	await page
		.getByPlaceholder(
			"A second system prompt variant. {{vars}} are rendered per case."
		)
		.fill("You are a precise assistant. Use {{topic}}.");
	await page.getByLabel("Prompt variant 1 name").fill("Precise");
	await page.getByLabel("Prompt variant 1 type").selectOption("chat");
	await page
		.getByPlaceholder('[{"role":"user","content":"Hello {{name}}"}]')
		.fill('[{"role":"user","content":"Describe {{topic}}"}]');
	await page.getByRole("button", { name: "Duplicate Precise" }).click();
	await expect(page.getByLabel("Prompt variant 2 name")).toHaveValue(
		"Precise copy"
	);
	await page.getByRole("button", { name: "Move Precise copy up" }).click();
	await expect(page.getByLabel("Prompt variant 1 name")).toHaveValue(
		"Precise copy"
	);
	await page.getByRole("button", { name: "Move Precise copy down" }).click();
	await expect(page.getByLabel("Prompt variant 1 name")).toHaveValue("Precise");
	await page.getByRole("button", { name: "Remove Precise copy" }).click();
	await expect(page.getByLabel("Prompt variant 2 name")).toHaveCount(0);
	await expect(page.getByLabel("Prompt variant 1 type")).toHaveValue("chat");
	await expect(
		page.getByPlaceholder('[{"role":"user","content":"Hello {{name}}"}]')
	).toHaveValue(
		'[\n  {\n    "role": "user",\n    "content": "Describe {{topic}}"\n  }\n]'
	);
	await page
		.getByLabel("Registry evaluators (optional, comma-separated)")
		.fill("assertions");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	let snapshot = await readProof(page);
	expect(snapshot.suite).toMatchObject({
		agent_id: "prompt-studio-proof-agent",
		name: "Promptfoo regression suite",
	});
	expect(snapshot.suiteVersions[0]).toMatchObject({ label: "Baseline" });
	const createSuiteRequest = snapshot.requests.find(
		(request) =>
			request.method === "POST" && request.path === "/api/prompt-suites"
	);
	expect(createSuiteRequest?.body).toMatchObject({
		agent_id: "prompt-studio-proof-agent",
		label: "Baseline",
		name: "Promptfoo regression suite",
		config: {
			prompts: expect.arrayContaining([
				expect.objectContaining({ id: "primary", type: "text" }),
				expect.objectContaining({
					messages: [{ content: "Describe {{topic}}", role: "user" }],
					name: "Precise",
					type: "chat",
				}),
			]),
			tests: expect.any(Array),
		},
	});

	await page.getByRole("button", { name: "Add test case" }).click();
	await page.getByLabel("User message").first().fill("Explain {{topic}}");
	await page.getByLabel("Case 1 id").fill("golden-case");
	await page
		.getByLabel("Expected (optional substring)")
		.first()
		.fill("concise");
	await page.getByLabel("Assertion threshold (optional)").first().fill("0.5");
	await page.getByRole("button", { name: "Add assertion" }).click();
	await page.getByLabel("Assertion type").first().selectOption("icontains_any");
	await page.getByLabel("Assertion value").first().fill("concise,brief");
	await page.getByLabel("Assertion weight").first().fill("2");
	await page.getByLabel("Assertion provider").first().fill("judge-fixture");
	await page.getByLabel("Assertion transform").first().fill("trim");
	await page.getByRole("switch", { name: "Negate assertion" }).first().click();
	await page
		.getByLabel("Reference/context (optional JSON)")
		.first()
		.fill('{"source":"proof"}');
	await page.getByLabel("Metadata JSON").first().fill('{"team":"qa"}');
	await page
		.getByLabel("Provider override (optional)")
		.first()
		.fill("openai:gpt-4o");
	await page
		.getByLabel("Provider output fixture (optional JSON)")
		.first()
		.fill('{"fixture":"exact"}');
	await page
		.getByLabel("Providers (optional, comma-separated)")
		.first()
		.fill("openai:gpt-4o, anthropic:claude-fixture");
	await page
		.getByText(
			"Promptfoo case options (prefix, suffix, transform, timeout, cache)"
		)
		.first()
		.click();
	await page
		.locator('textarea[placeholder*="prefix"]')
		.first()
		.fill(
			'{"cache":false,"prefix":"[case] ","timeout_ms":5000,"transform":"trim"}'
		);
	await page
		.getByText(
			"Promptfoo case options (prefix, suffix, transform, timeout, cache)"
		)
		.first()
		.click();
	await expect(
		page.locator('textarea[placeholder*="prefix"]').first()
	).toBeHidden();
	await page
		.getByText(
			"Promptfoo case options (prefix, suffix, transform, timeout, cache)"
		)
		.first()
		.click();
	await expect(
		page.locator('textarea[placeholder*="prefix"]').first()
	).toBeVisible();
	await page.getByRole("button", { name: "Add model" }).click();
	await page.getByLabel("Add model to compare").fill("gpt-4.1-mini");
	await page.getByRole("button", { name: "Add model" }).click();
	await page.getByRole("button", { name: "Remove model gpt-4.1-mini" }).click();
	await expect(
		page.getByRole("button", { name: "Remove model gpt-4.1-mini" })
	).toHaveCount(0);
	await page.getByLabel("Add model to compare").fill("gpt-4.1-mini");
	await page.getByLabel("Add model to compare").press("Enter");
	await page.getByLabel("Judge model (optional)").fill("gpt-4.1-mini");
	await page
		.getByLabel("Registry evaluators (optional, comma-separated)")
		.fill("assertions, pii_detector");
	await page.getByText("Run options and Promptfoo defaults").click();
	await expect(page.getByLabel("Concurrency")).toBeHidden();
	await page.getByText("Run options and Promptfoo defaults").click();
	await expect(page.getByLabel("Concurrency")).toBeVisible();
	await page.getByLabel("Concurrency").fill("3");
	await page.getByLabel("Timeout (ms)").fill("9000");
	await page.getByLabel("Repeat cases").fill("2");
	await page.getByRole("switch", { name: "Cache outputs" }).click();
	await page
		.getByLabel("Run tags (key=value, comma-separated)")
		.fill("branch=qa, owner=evals");
	await page.getByLabel("Prompt prefix").fill("[suite] ");
	await page.getByLabel("Prompt suffix").fill(" [review]");
	await page
		.getByLabel("Default test JSON (inherited by imported cases)")
		.fill('{"vars":{"locale":"en"}}');
	await page
		.getByLabel("Custom JS/Python evaluators (Core sandbox)")
		.fill(
			'[{"id":"safe_output","lang":"js","source":"return output.length > 0"}]'
		);
	await page.getByLabel("Version label (optional)").fill("Configured");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("2 versions")).toBeVisible();
	snapshot = await readProof(page);
	const updateSuiteRequest = snapshot.requests.find(
		(request) =>
			request.method === "PUT" &&
			request.path === "/api/prompt-suites/ps_prompt_studio_proof"
	);
	expect(updateSuiteRequest?.body).toMatchObject({
		label: "Configured",
		name: "Promptfoo regression suite",
		config: {
			code_evaluators: [
				{
					id: "safe_output",
					lang: "js",
					source: "return output.length > 0",
				},
			],
			defaultTest: { vars: { locale: "en" } },
			evaluators: ["assertions", "pii_detector"],
			prompts: expect.arrayContaining([
				expect.objectContaining({
					messages: [{ content: "Describe {{topic}}", role: "user" }],
					name: "Precise",
					type: "chat",
				}),
			]),
			tests: expect.arrayContaining([
				expect.objectContaining({
					id: "golden-case",
					prompt: "Explain {{topic}}",
				}),
			]),
			run_config: {
				cache: false,
				max_concurrency: 3,
				repeat: 2,
				tags: { branch: "qa", owner: "evals" },
				timeout_ms: 9000,
			},
		},
	});
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByText("Overall").first()).toBeVisible();
	await expect(
		page.getByText("A concise explanation of prompt engineering.").first()
	).toBeVisible();
	snapshot = await readProof(page);
	const evalRequests = snapshot.requests.filter(
		(request) =>
			request.method === "POST" && request.path === "/api/gateway/evals/run"
	);
	expect(evalRequests).toHaveLength(2);
	expect(evalRequests.map((request) => request.body)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				agent_id: "prompt-studio-proof-agent",
				model: "gpt-4o-mini",
				models: ["gpt-4o-mini", "gpt-4.1-mini"],
				judge_model: "gpt-4.1-mini",
				evaluators: ["assertions", "pii_detector"],
				code_evaluators: [
					{
						id: "safe_output",
						lang: "js",
						source: "return output.length > 0",
					},
				],
				max_concurrency: 3,
				timeout_ms: 9000,
				repeat: 2,
				cache: false,
				tags: { branch: "qa", owner: "evals" },
				prefix: "[suite] ",
				suffix: " [review]",
				prompt_id: "primary",
				dataset: expect.arrayContaining([
					expect.objectContaining({
						id: "golden-case",
						prompt: "Explain {{topic}}",
						context: { source: "proof" },
						metadata: { team: "qa" },
						provider: "openai:gpt-4o",
						providers: ["openai:gpt-4o", "anthropic:claude-fixture"],
						provider_output: { fixture: "exact" },
						options: expect.objectContaining({
							cache: false,
							prefix: "[case] ",
							timeout_ms: 5000,
							transform: "trim",
						}),
					}),
				]),
			}),
			expect.objectContaining({
				prompt_id: expect.not.stringMatching(/^primary$/u),
				system_messages: [{ content: "Describe {{topic}}", role: "user" }],
			}),
		])
	);
	await page.getByRole("button", { name: "Pass" }).first().click();
	await page.getByLabel("Human review score").first().fill("0.73");
	await page
		.getByLabel("Human review comment")
		.first()
		.fill("Keep this concise.");
	await page.getByRole("button", { name: "Save comment" }).first().click();
	await expect
		.poll(async () => Object.keys((await readProof(page)).reviews).length)
		.toBe(1);
	snapshot = await readProof(page);
	expect(Object.values(snapshot.reviews)[0]).toMatchObject({
		comment: "Keep this concise.",
		highlighted: false,
		pass: true,
		result_key: "primary:gpt-4o-mini:0",
		score: 0.73,
	});
	await page
		.getByRole("button", { name: /Promptfoo regression suite/ })
		.first()
		.click();

	await page.getByRole("button", { name: "Save version" }).click();
	await page.getByRole("button", { name: /History/ }).click();
	await expect(page.getByRole("button", { name: "Diff" })).toBeVisible();
	await page.getByRole("button", { name: "Diff" }).click();
	await expect(
		page.getByText(/You are a concise assistant/).first()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-proof-complete.png"),
	});
	await page.getByRole("button", { name: "Restore" }).click();
	snapshot = await readProof(page);
	expect(snapshot.promptVersions[0]?.prompt).toContain(
		"You are a concise assistant"
	);
	await page
		.getByLabel("Restore suite version")
		.selectOption({ label: "Baseline" });
	await expect(page.getByLabel("User message")).toHaveCount(0);
	await expect(page.getByLabel("Prompt variant 1 type")).toHaveValue("chat");
	snapshot = await readProof(page);
	expect(pluginRecord(snapshot.suite?.config)?.tests).toEqual([]);
	expect(
		snapshot.requests.some(
			(request) =>
				request.method === "POST" &&
				request.path ===
					"/api/prompt-suites/ps_prompt_studio_proof/versions/psv_prompt_studio_proof-1/restore"
		)
	).toBe(true);

	expect(browserErrors).toEqual([]);
});

test("Prompt Studio import preview can cancel or apply a real config and JSON export round-trips its data", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true&holdSuiteList=true");
	const editor = page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first();
	await expect(editor).toBeVisible();
	const importedConfig = {
		defaultTest: { vars: { locale: "en" } },
		judge_model: "gpt-4.1-mini",
		prompts: [
			"Imported role for {{product}}.",
			{
				id: "compact",
				name: "Compact",
				content: "Be brief about {{product}}.",
			},
		],
		providers: ["openai:gpt-4o"],
		run_config: {
			cache: false,
			max_concurrency: 2,
			repeat: 3,
			timeout_ms: 7000,
			tags: { branch: "imported" },
		},
		tests: [
			{
				assert: [{ type: "contains", value: "Ryu", weight: 2 }],
				description: "Imported support case",
				id: "imported-case",
				metadata: { team: "qa" },
				options: { prefix: "[case] ", transform: "trim" },
				prompt: "Explain {{product}}",
				provider: "openai:gpt-4o",
				threshold: 0.75,
				vars: { product: "Ryu" },
			},
		],
	};
	const fileInput = page.locator('input[type="file"]');
	await fileInput.setInputFiles({
		name: "support-suite.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(importedConfig)),
	});
	await expect(page.getByTestId("promptfoo-import-preview")).toContainText(
		"support-suite.json contains 2 prompts, 1 test, and 1 provider"
	);
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByTestId("promptfoo-import-preview")).toHaveCount(0);
	await expect(editor).toContainText("You are a concise assistant.");

	await fileInput.setInputFiles({
		name: "support-suite.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(importedConfig)),
	});
	await page.getByRole("button", { name: "Apply import" }).click();
	await expect
		.poll(async () => (await readProof(page)).draft)
		.toContain("Imported role for {{product}}");
	await expect(editor).toContainText("Imported role for {{product}}");
	await expect(page.getByText(/1 variable detected/u)).toBeVisible();
	await page.evaluate(() =>
		window.__promptStudioProof.releaseInitialSuiteList()
	);
	await expect(page.getByText("Loading durable suite…")).toHaveCount(0);
	await expect(page.getByLabel("Suite name")).toHaveValue("support-suite");
	await expect(page.getByLabel("Case 1 id")).toHaveValue("imported-case");
	await expect(page.getByLabel("Expected (optional substring)")).toHaveValue(
		""
	);
	await expect(page.getByLabel("Assertion value")).toHaveValue("Ryu");
	await expect(page.getByLabel("Assertion weight")).toHaveValue("2");
	await expect(page.getByLabel("Concurrency")).toHaveValue("2");
	await expect(page.getByLabel("Timeout (ms)")).toHaveValue("7000");
	await expect(page.getByLabel("Repeat cases")).toHaveValue("3");
	await expect(
		page.getByLabel("Run tags (key=value, comma-separated)")
	).toHaveValue("branch=imported");
	await page.getByLabel("Export format").selectOption("json");
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	const exported = exportedPromptFixtureSchema.parse(
		parseProofJson(await downloadedText(await downloadPromise))
	);
	expect(exported).toMatchObject({
		judge_model: "gpt-4.1-mini",
		providers: ["openai:gpt-4o"],
		evaluateOptions: {
			cache: false,
			maxConcurrency: 2,
			repeat: 3,
			timeoutMs: 7000,
			tags: { branch: "imported" },
		},
		tests: [
			expect.objectContaining({
				id: "imported-case",
				prompt: "Explain {{product}}",
				threshold: 0.75,
				assert: [
					expect.objectContaining({
						type: "contains",
						value: "Ryu",
						weight: 2,
					}),
				],
			}),
		],
	});
	expect(exported.prompts[0]).toBe("Imported role for {{product}}.");
	expect(exported.prompts[1]).toMatchObject({
		content: "Be brief about {{product}}.",
		id: "compact",
		name: "Compact",
	});
	await page.getByLabel("Export format").selectOption("yaml");
	const yamlDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	const yamlExport = exportedPromptFixtureSchema.parse(
		parseYaml(await downloadedText(await yamlDownload))
	);
	expect(yamlExport).toMatchObject({
		judge_model: "gpt-4.1-mini",
		providers: ["openai:gpt-4o"],
		tests: [expect.objectContaining({ id: "imported-case" })],
	});
	await page.getByLabel("Export format").selectOption("jsonl");
	const jsonlDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	const jsonlText = await downloadedText(await jsonlDownload);
	const jsonlCase = parseProofJsonRecord(jsonlText.trim());
	expect(jsonlCase).toMatchObject({
		id: "imported-case",
		prompt: "Explain {{product}}",
		vars: { locale: "en", product: "Ryu" },
	});
	await page.getByLabel("Export format").selectOption("csv");
	const csvDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	const csvText = await downloadedText(await csvDownload);
	expect(csvText).toContain("id,description,prompt");
	expect(csvText).toContain("imported-case");
	expect(csvText).toContain("Explain {{product}}");
	await page.getByLabel("Export format").selectOption("json");
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-import-export.png"),
	});
	await fileInput.setInputFiles({
		name: "malformed.json",
		mimeType: "application/json",
		buffer: Buffer.from("{ invalid json"),
	});
	await expect(page.getByText(/^Import failed:/u)).toBeVisible();
	await expect(page.getByTestId("promptfoo-import-preview")).toHaveCount(0);
	await expect(page.getByLabel("Suite name")).toHaveValue("support-suite");
	await expect(editor).toContainText("Imported role for {{product}}");
});

test("Prompt Studio suite-create errors remain visible and the same save can be retried", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	await page.getByLabel("Suite name").fill("Retryable prompt suite");
	await page.getByLabel("Version label (optional)").fill("First save");
	await armFailure(page, "suite-create");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("/api/prompt-suites failed: 503")).toBeVisible();
	let snapshot = await readProof(page);
	expect(snapshot.suite).toBeNull();
	expect(
		snapshot.requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/api/prompt-suites"
		)
	).toHaveLength(1);
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	snapshot = await readProof(page);
	expect(snapshot.suite).toMatchObject({ name: "Retryable prompt suite" });
	expect(snapshot.suiteVersions[0]).toMatchObject({ label: "First save" });
	expect(
		snapshot.requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/api/prompt-suites"
		)
	).toHaveLength(2);
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-suite-retry.png"),
	});
});

test("Prompt Studio test-case rows duplicate, reorder, remove, and save chat messages and variables", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	await page.getByRole("button", { name: "Add test case" }).click();
	await page.getByLabel("Case 1 id").fill("case-alpha");
	await page.getByPlaceholder("Name (optional)").first().fill("Case Alpha");
	await page.getByLabel("User message").first().fill("Hello {{name}}");
	await page.getByPlaceholder("Value for {{name}}").fill("Ada");
	await page
		.getByLabel("Chat messages (optional JSON)")
		.first()
		.fill(
			'[{"role":"system","content":"Use names carefully."},{"role":"user","content":"Hello {{name}}"}]'
		);
	await page
		.getByLabel("Expected (optional substring)")
		.first()
		.fill("Welcome Ada");
	await page
		.getByRole("switch", { name: /Inherit default test for case 1/ })
		.click();
	await page.getByRole("button", { name: "Add assertion" }).click();
	await page.getByLabel("Assertion value").fill("temporary assertion");
	await page.getByRole("button", { name: "Remove assertion" }).click();
	await expect(page.getByLabel("Assertion type")).toHaveCount(0);

	await page.getByRole("button", { name: "Add test case" }).click();
	await page.getByLabel("Case 2 id").fill("case-beta");
	await page.getByPlaceholder("Name (optional)").nth(1).fill("Case Beta");
	await page.getByLabel("User message").nth(1).fill("Say goodbye");
	await page.getByRole("button", { name: "Duplicate test case 1" }).click();
	await expect(page.getByPlaceholder("Name (optional)").nth(1)).toHaveValue(
		"Case Alpha copy"
	);
	await page.getByRole("button", { name: "Move case 2 down" }).click();
	await expect(page.getByPlaceholder("Name (optional)").nth(1)).toHaveValue(
		"Case Beta"
	);
	await page.getByRole("button", { name: "Move case 3 up" }).click();
	await expect(page.getByPlaceholder("Name (optional)").nth(1)).toHaveValue(
		"Case Alpha copy"
	);
	await page.getByRole("button", { name: "Remove test case 2" }).click();
	await expect(page.getByLabel("Case 2 id")).toHaveValue("case-beta");

	await page.getByLabel("Suite name").fill("Row editing proof");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	const snapshot = await readProof(page);
	const createRequest = snapshot.requests.find(
		(request) =>
			request.method === "POST" && request.path === "/api/prompt-suites"
	);
	expect(createRequest?.body).toMatchObject({
		config: {
			tests: expect.arrayContaining([
				expect.objectContaining({
					assertions: [],
					description: "Case Alpha",
					expected: "Welcome Ada",
					id: "case-alpha",
					inheritDefaultTest: false,
					messages: [
						{ content: "Use names carefully.", role: "system" },
						{ content: "Hello {{name}}", role: "user" },
					],
					prompt: "Hello {{name}}",
					vars: { name: "Ada" },
				}),
				expect.objectContaining({
					description: "Case Beta",
					id: "case-beta",
					prompt: "Say goodbye",
				}),
			]),
		},
	});
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-test-case-rows.png"),
	});
});

test("Prompt Studio gates editing and execution for locked, agentless, model-less, and ACP states", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true&locked=true");
	await expect(page.getByText("Locked — read only")).toBeVisible();
	await expect(
		page.locator("#prompt-studio-editor [contenteditable='true']")
	).toHaveCount(0);
	await expect(page.getByLabel("Suite name")).toBeDisabled();
	await expect(page.getByLabel("Version label (optional)")).toBeDisabled();
	await expect(page.getByRole("button", { name: "Save suite" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Save version" })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("button", { name: "Add variant" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add test case" })
	).toBeDisabled();
	await expect(
		page.getByLabel("Registry evaluators (optional, comma-separated)")
	).toBeDisabled();
	await expect(page.getByLabel("Concurrency")).toBeDisabled();
	await expect(page.getByLabel("Timeout (ms)")).toBeDisabled();
	await expect(page.getByLabel("Repeat cases")).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Cache outputs" })
	).toBeDisabled();
	await expect(
		page.getByLabel("Run tags (key=value, comma-separated)")
	).toBeDisabled();
	await expect(page.getByLabel("Prompt prefix")).toBeDisabled();
	await expect(page.getByLabel("Prompt suffix")).toBeDisabled();
	await expect(
		page.getByLabel("Default test JSON (inherited by imported cases)")
	).toBeDisabled();
	await expect(
		page.getByLabel("Custom JS/Python evaluators (Core sandbox)")
	).toBeDisabled();
	await expect(page.getByLabel("Add model to compare")).toBeDisabled();
	await expect(page.getByLabel("Judge model (optional)")).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Run test cases" })
	).toBeDisabled();
	await expect(page.locator('input[type="file"]')).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Preview prompt" })
	).toBeEnabled();

	await page.goto("/prompt-studio-proof.html?reset=true&agent=none");
	await expect(
		page.getByRole("button", { name: "Preview prompt" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Run test cases" })
	).toBeDisabled();
	await expect(page.getByRole("button", { name: "Save suite" })).toBeDisabled();

	await page.goto("/prompt-studio-proof.html?reset=true&model=");
	await expect(
		page.getByRole("button", { name: "Run test cases" })
	).toBeDisabled();
	await expect(
		page.getByText("No model bound — wire the agent's model to run evals.")
	).toBeVisible();

	await page.goto("/prompt-studio-proof.html?reset=true&engine=acp%3Afixture");
	await expect(
		page.getByRole("button", { name: "Run test cases" })
	).toBeDisabled();
	await expect(
		page.getByText(
			"ACP agents bypass the gateway, so gateway evals do not apply."
		)
	).toBeVisible();

	await page.goto("/prompt-studio-proof.html?reset=true");
	await page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first()
		.fill("");
	await expect
		.poll(async () =>
			(await readProof(page)).draft.replaceAll("\u200B", "").trim()
		)
		.toBe("");
	await expect(
		page.getByRole("button", { name: "Preview prompt" })
	).toBeDisabled();
});

test("Prompt Studio reports eval failures, retries with exact run options, saves durable results, and aborts on Stop", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	await page.getByLabel("Suite name").fill("Run proof suite");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	await page.getByRole("button", { name: "Add test case" }).click();
	await page.getByLabel("User message").first().fill("Explain {{topic}}");
	await page.getByLabel("Concurrency").fill("5");
	await page.getByLabel("Timeout (ms)").fill("8000");
	await page.getByLabel("Repeat cases").fill("4");
	await page.getByRole("switch", { name: "Cache outputs" }).click();
	await page
		.getByLabel("Run tags (key=value, comma-separated)")
		.fill("job=coverage");
	await page.getByLabel("Prompt prefix").fill("prefix:");
	await page.getByLabel("Prompt suffix").fill(":suffix");
	await armFailure(page, "eval-run");
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(
		page.getByText("/api/gateway/evals/run failed: 503")
	).toBeVisible();
	expect((await readProof(page)).runs).toHaveLength(0);
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Run proof suite ·/ }).first()
	).toBeVisible();
	let snapshot = await readProof(page);
	const evalRequest = snapshot.requests.find(
		(request) =>
			request.path === "/api/gateway/evals/run" && request.method === "POST"
	);
	expect(evalRequest?.body).toMatchObject({
		agent_id: "prompt-studio-proof-agent",
		model: "gpt-4o-mini",
		max_concurrency: 5,
		timeout_ms: 8000,
		repeat: 4,
		cache: false,
		tags: { job: "coverage" },
		prefix: "prefix:",
		suffix: ":suffix",
		prompt_id: "primary",
		dataset: [expect.objectContaining({ prompt: "Explain {{topic}}" })],
	});
	expect(snapshot.runs).toHaveLength(1);
	expect(snapshot.runs[0]).toMatchObject({
		request: {
			run_config: {
				cache: false,
				max_concurrency: 5,
				repeat: 4,
				tags: { job: "coverage" },
				timeout_ms: 8000,
			},
		},
		result: { variants: [expect.objectContaining({ promptId: "primary" })] },
	});
	await page.reload();
	await expect(page.getByLabel("Suite name")).toHaveValue("Run proof suite");
	await expect(page.getByText("1 versions")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Run proof suite ·/ }).first()
	).toBeVisible();
	await page
		.getByRole("button", { name: /Run proof suite ·/ })
		.first()
		.click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	snapshot = await readProof(page);
	const savedRunId = snapshot.runs[0]?.id;
	expect(savedRunId).toBe("pr_prompt_studio_proof-1");
	expect(snapshot.requests).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "/api/prompt-suites/ps_prompt_studio_proof/runs/pr_prompt_studio_proof-1",
				method: "GET",
			}),
			expect.objectContaining({
				path: "/api/prompt-suites/ps_prompt_studio_proof/runs/pr_prompt_studio_proof-1/reviews",
				method: "GET",
			}),
		])
	);
	await expect
		.poll(async () => page.evaluate(() => window.location.hash))
		.toContain(`run_id=${savedRunId}`);
	await page.reload();
	await expect(page.getByText("Results matrix")).toBeVisible();
	snapshot = await readProof(page);
	expect(snapshot.requests).toContainEqual({
		body: null,
		method: "GET",
		path: `/api/prompt-suites/ps_prompt_studio_proof/runs/${savedRunId}`,
	});
	expect(snapshot.requests).toContainEqual({
		body: null,
		method: "GET",
		path: `/api/prompt-suites/ps_prompt_studio_proof/runs/${savedRunId}/reviews`,
	});
	await page.evaluate(() => window.__promptStudioProof.holdNextEvalRun());
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
	await page.getByRole("button", { name: "Stop" }).click();
	await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
	await expect.poll(async () => (await readProof(page)).abortedRuns).toBe(1);
	await expect.poll(async () => (await readProof(page)).runs.length).toBe(1);
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-run-results.png"),
	});
});

test("Prompt Studio filters and exports result cells and maintains durable run history", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	const promptEditor = page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first();
	await expect(promptEditor).toContainText("Use {{topic}}.");
	await page.getByLabel("Suite name").fill("Matrix proof suite");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();
	await page.getByRole("button", { name: "Run test cases" }).click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	await expect(page.getByText("4 visible cells")).toBeVisible();
	const unavailableModelCard = page
		.getByText("gpt-4.1-mini", { exact: true })
		.first()
		.locator("..");
	await expect(unavailableModelCard).toContainText("Policy");
	await expect(unavailableModelCard).toContainText("N/A");

	const jsonOutputCell = page.locator("tbody tr").nth(1).locator("td").nth(1);
	await jsonOutputCell.getByText("Inspect full cell").click();
	await expect(jsonOutputCell).toContainText("Latency score: N/A");
	await jsonOutputCell
		.getByLabel("Cell output render mode")
		.selectOption("json");
	await expect(jsonOutputCell.locator("pre").nth(1)).toHaveText(
		'{\n  "answer": "Prompt engineering is writing instructions for a model."\n}'
	);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await jsonOutputCell.getByRole("button", { name: "Copy" }).nth(0).click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toContain("Give a brief answer about prompt engineering");
	await jsonOutputCell.getByRole("button", { name: "Copy" }).nth(1).click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(
			'{"answer":"Prompt engineering is writing instructions for a model."}'
		);
	await jsonOutputCell.getByText("Inspect full cell").click();
	const markdownOutputCell = page
		.locator("tbody tr")
		.nth(1)
		.locator("td")
		.nth(2);
	await markdownOutputCell.getByText("Inspect full cell").click();
	await markdownOutputCell
		.getByLabel("Cell output render mode")
		.selectOption("markdown");
	await expect(markdownOutputCell.locator("strong")).toHaveText("clear");
	await markdownOutputCell
		.getByLabel("Cell output render mode")
		.selectOption("text");
	await expect(markdownOutputCell.locator("strong")).toHaveCount(0);
	await expect(markdownOutputCell).toContainText("**clear**");
	await markdownOutputCell.getByText("Inspect full cell").click();

	await page.getByLabel("Search result matrix").fill("A concise explanation");
	await expect(page.getByText("1 visible cells")).toBeVisible();
	await page.getByLabel("Search result matrix").fill("");
	await page.getByLabel("Filter result metadata").fill("team=billing");
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Filter result metadata").fill("");
	await page.getByLabel("Search result matrix").fill("locale.{0,8}en");
	await page.getByRole("switch", { name: "Regex result search" }).click();
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Search result matrix").fill("");
	await page.getByRole("switch", { name: "Regex result search" }).click();
	const firstCell = page.locator("tbody tr").first().locator("td").nth(1);
	await firstCell.locator('[data-slot="tooltip-trigger"]').first().hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
		'found one of the values: "concise"'
	);
	await page.getByLabel("Result matrix filter").selectOption("pass");
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Result matrix filter").selectOption("error");
	await expect(page.getByText("0 visible cells")).toBeVisible();
	await page.getByLabel("Result matrix filter").selectOption("different");
	await expect(page.getByText("4 visible cells")).toBeVisible();
	await page.getByLabel("Result matrix filter").selectOption("fail");
	await expect(page.getByText("2 visible cells")).toBeVisible();
	await page.getByLabel("Results export format").selectOption("csv");
	const csvDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const csv = await downloadedText(await csvDownload);
	expect(csv).toContain("latency_available,policy_available");
	expect(csv.trim().split(/\r?\n/u)).toHaveLength(3);

	await page.getByLabel("Result matrix filter").selectOption("all");
	await firstCell.getByRole("button", { name: "Highlight" }).click();
	await expect
		.poll(async () => Object.keys((await readProof(page)).reviews).length)
		.toBe(1);
	const failReviewCell = page.locator("tbody tr").first().locator("td").nth(2);
	await failReviewCell.getByRole("button", { name: "Fail" }).click();
	await expect
		.poll(async () => Object.keys((await readProof(page)).reviews).length)
		.toBe(2);
	const review = Object.values((await readProof(page)).reviews)[0];
	expect(review).toMatchObject({ highlighted: true, pass: true });
	expect(
		Object.values((await readProof(page)).reviews).find(
			(saved) => saved.result_key === "primary:gpt-4.1-mini:0"
		)
	).toMatchObject({ pass: false });
	await page.getByLabel("Result matrix filter").selectOption("highlighted");
	await expect(page.getByText("1 visible cells")).toBeVisible();
	await page.getByLabel("Results export format").selectOption("human_yaml");
	const reviewDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const reviewYaml = await downloadedText(await reviewDownload);
	expect(reviewYaml).toContain("highlighted: true");
	expect(reviewYaml).toContain("pass: true");
	await page.getByLabel("Result matrix filter").selectOption("all");
	await page.getByLabel("Results export format").selectOption("json");
	const allJsonDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const allJson = z
		.array(pluginDocumentSchema)
		.parse(parseProofJson(await downloadedText(await allJsonDownload)));
	expect(allJson).toHaveLength(4);
	await page.getByLabel("Results export format").selectOption("yaml");
	const allYamlDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	expect(
		z
			.array(pluginDocumentSchema)
			.parse(parseYaml(await downloadedText(await allYamlDownload)))
	).toHaveLength(4);
	await page.getByLabel("Results export format").selectOption("failed_json");
	const failedJsonDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const failedRows = z
		.array(z.object({ score: z.object({ assertions_pass: z.boolean() }) }))
		.parse(parseProofJson(await downloadedText(await failedJsonDownload)));
	expect(failedRows).toHaveLength(2);
	expect(failedRows.every((row) => row.score.assertions_pass === false)).toBe(
		true
	);
	await page.getByLabel("Results export format").selectOption("dpo_jsonl");
	const dpoDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export selected" }).click();
	const dpoRows = (await downloadedText(await dpoDownload))
		.trim()
		.split(/\r?\n/u)
		.map((line) => parseProofJsonRecord(line));
	expect(dpoRows).toHaveLength(2);
	expect(dpoRows[0]).toMatchObject({
		chosen_model: expect.any(String),
		rejected_model: expect.any(String),
	});
	await page.getByLabel("Results export format").selectOption("human_yaml");
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-results-matrix.png"),
	});

	let snapshot = await readProof(page);
	expect(snapshot.runs).toHaveLength(1);
	const originalRun = snapshot.runs[0];
	expect(originalRun).toBeDefined();
	const originalName = originalRun?.name ?? "";
	await page.getByRole("button", { name: `Duplicate ${originalName}` }).click();
	await expect.poll(async () => (await readProof(page)).runs.length).toBe(2);
	snapshot = await readProof(page);
	const duplicateRun = snapshot.runs.find((run) => run.id !== originalRun?.id);
	expect(duplicateRun?.name).toBe(`${originalName} copy`);
	const duplicateName = duplicateRun?.name ?? "";
	await page.getByRole("button", { name: duplicateName, exact: true }).click();
	await expect(page.getByText("Results matrix")).toBeVisible();
	await page
		.getByRole("button", { name: `Compare ${originalName}`, exact: true })
		.click();
	await expect(page.getByText("Run comparison")).toBeVisible();
	await expect(page.getByText(`vs ${originalRun?.id}`)).toBeVisible();
	await page.getByRole("button", { name: `Rename ${duplicateName}` }).click();
	await page
		.getByLabel(`Rename ${duplicateName}`)
		.fill("Renamed comparison run");
	await page
		.getByRole("button", { name: `Save name for ${duplicateName}` })
		.click();
	await expect
		.poll(
			async () =>
				(await readProof(page)).runs.find((run) => run.id === duplicateRun?.id)
					?.name
		)
		.toBe("Renamed comparison run");
	snapshot = await readProof(page);
	expect(snapshot.requests).toContainEqual({
		body: { name: "Renamed comparison run" },
		method: "PUT",
		path: `/api/prompt-suites/ps_prompt_studio_proof/runs/${duplicateRun?.id}`,
	});
	await page
		.getByRole("button", { name: "Delete Renamed comparison run" })
		.click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		(await readProof(page)).requests.filter(
			(request) => request.method === "DELETE"
		)
	).toHaveLength(0);
	await page
		.getByRole("button", { name: "Delete Renamed comparison run" })
		.click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect.poll(async () => (await readProof(page)).runs.length).toBe(1);
	await expect(
		page.getByRole("button", { name: "Renamed comparison run", exact: true })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: evidence("prompt-studio-run-history.png"),
	});
});
