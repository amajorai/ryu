import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import { parseProofJson, parseProofJsonRecord } from "./fixture-json.ts";
import {
	armFailure,
	downloadedText,
	evidence,
	exportedPromptFixtureSchema,
	readProof,
} from "./prompt-studio-proof-helpers.ts";

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
	// The Markdown editor applies its deserialized initial value after it is
	// interactive (already so at 07d403e33, before Ryu Quiet), and that can land
	// after an early clear. Clear until the cleared draft sticks.
	const editor = page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first();
	await expect(editor).toContainText("You are a concise assistant.");
	await expect(async () => {
		await editor.fill("");
		await expect
			.poll(
				async () =>
					(await readProof(page)).draft.replaceAll("\u200B", "").trim(),
				{ timeout: 1000 }
			)
			.toBe("");
	}).toPass();
	await expect(
		page.getByRole("button", { name: "Preview prompt" })
	).toBeDisabled();
});

test("a prompt edit made before the durable suite loads is kept", async ({
	page,
}) => {
	await page.goto("/prompt-studio-proof.html?reset=true");
	await page.getByLabel("Suite name").fill("Late load proof");
	await page.getByRole("button", { name: "Save suite" }).click();
	await expect(page.getByText("1 versions")).toBeVisible();

	// Reopen with the suite list held: the editor is live before the durable
	// suite (carrying its own copy of the prompt) arrives.
	await page.goto("/prompt-studio-proof.html?holdSuiteList=true");
	await expect(page.getByText("Loading durable suite…")).toBeVisible();
	const editor = page
		.locator("#prompt-studio-editor [contenteditable='true']")
		.first();
	await editor.getByText("Use {{topic}}.").click();
	await page.keyboard.press("End");
	await page.keyboard.type(" Draft edit.");
	await expect
		.poll(async () => (await readProof(page)).draft)
		.toContain("Use {{topic}}. Draft edit.");

	await page.evaluate(() =>
		window.__promptStudioProof.releaseInitialSuiteList()
	);
	await expect(page.getByText("Loading durable suite…")).toHaveCount(0);
	await expect(page.getByLabel("Suite name")).toHaveValue("Late load proof");
	await expect(editor).toContainText("Use {{topic}}. Draft edit.");
	expect((await readProof(page)).draft).toContain("Use {{topic}}. Draft edit.");
});
