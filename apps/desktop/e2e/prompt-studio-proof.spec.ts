import { expect, test } from "@playwright/test";
import { z } from "zod";
import { pluginRecord } from "../src/lib/api/plugin-wire-values.ts";
import {
	armFailure,
	evidence,
	readProof,
} from "./prompt-studio-proof-helpers.ts";

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
