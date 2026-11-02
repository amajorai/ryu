// Continues model-launch-config-settings-proof.spec.ts (split under the file token limit); helpers live in model-launch-config-settings-proof.helpers.ts.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	clipboardText,
	engineSaveButton,
	evidenceDir,
	openSection,
	openSettings,
	proofSnapshot,
	selectProfile,
} from "./model-launch-config-settings-proof.helpers.ts";

test.describe.configure({ timeout: 60_000 });

test("SGLang speculative controls validate and persist the exact engine defaults", async ({
	page,
}) => {
	await openSettings(page);
	await selectProfile(page, "engine:sglang");
	await openSection(page);

	const draftMax = page.getByLabel("Draft max", { exact: true });
	await expect(draftMax).toHaveValue("5");
	await expect(page.getByLabel("Draft model")).toHaveValue(
		"/models/sglang-draft"
	);
	await expect(page.getByLabel("Mem fraction static")).toHaveValue("0.75");
	await expect(page.getByLabel("Tensor parallel")).toHaveValue("2");
	await expect(page.getByLabel("Maximum running requests")).toHaveValue("12");

	await draftMax.fill("2.5");
	await expect(page.getByRole("alert")).toHaveText(
		"Draft max must be a whole number."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await draftMax.fill("5");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByLabel("Maximum running requests").fill("0");
	await expect(page.getByRole("alert")).toHaveText(
		"Maximum running requests must be at least 1."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await page.getByLabel("Maximum running requests").fill("12");
	await page.getByLabel("Draft model").fill("/models/sglang-draft-v2");
	await draftMax.fill("7");
	await page.getByLabel("Mem fraction static").fill("0.85");
	await page.getByLabel("Tensor parallel").fill("4");
	await page.getByLabel("Maximum running requests").fill("18");
	await page.getByLabel("Speculative algorithm").fill("eagle");

	await engineSaveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const expectedConfig = {
		draft_max: 7,
		draft_model: "/models/sglang-draft-v2",
		max_running_requests: 18,
		mem_fraction_static: 0.85,
		speculative_algorithm: "eagle",
		tensor_parallel: 4,
	};
	const savedPreferences = (await proofSnapshot(page)).preferences;
	expect(
		JSON.parse(savedPreferences["model.launch.engine.sglang"] ?? "{}")
	).toEqual(expectedConfig);
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-model-launch-sglang-speculative.png"),
	});

	await page.reload();
	await selectProfile(page, "engine:sglang");
	await openSection(page);
	await expect(page.getByLabel("Draft max", { exact: true })).toHaveValue("7");
	await expect(page.getByLabel("Draft model")).toHaveValue(
		"/models/sglang-draft-v2"
	);
	await expect(page.getByLabel("Maximum running requests")).toHaveValue("18");
});

test("vLLM draft controls and speculative JSON validate, save, and reload", async ({
	page,
}) => {
	await openSettings(page);
	await selectProfile(page, "engine:vllm");
	await openSection(page);

	const draftTokens = page.getByLabel("Draft tokens", { exact: true });
	const maxSequences = page.getByLabel("Maximum sequences", { exact: true });
	const gpuMemoryUtilization = page.getByLabel("GPU memory utilization", {
		exact: true,
	});
	const speculativeConfig = page.getByLabel("Speculative config (JSON)");
	await expect(page.getByLabel("Draft model")).toHaveValue(
		"/models/vllm-draft"
	);
	await expect(draftTokens).toHaveValue("4");
	await expect(maxSequences).toHaveValue("8");
	await expect(gpuMemoryUtilization).toHaveValue("0.75");
	await expect(speculativeConfig).toHaveValue(
		'{\n  "method": "ngram",\n  "num_speculative_tokens": 4\n}'
	);

	await draftTokens.fill("0");
	await expect(page.getByRole("alert")).toHaveText(
		"Draft tokens must be at least 1."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await draftTokens.fill("4");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await maxSequences.fill("0");
	await expect(page.getByRole("alert")).toHaveText(
		"Maximum sequences must be at least 1."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await maxSequences.fill("8");
	await gpuMemoryUtilization.fill("1.1");
	await expect(page.getByRole("alert")).toHaveText(
		"GPU memory utilization must be no greater than 1."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await gpuMemoryUtilization.fill("0.9");

	await speculativeConfig.fill('{"num_speculative_tokens":');
	await expect(page.getByRole("alert")).toHaveText("Invalid JSON.");
	await expect(speculativeConfig).toHaveAttribute("aria-invalid", "true");
	await expect(engineSaveButton(page)).toBeDisabled();
	await speculativeConfig.fill("[]");
	await expect(page.getByRole("alert")).toHaveText(
		"Speculative config must be a JSON object."
	);
	await expect(engineSaveButton(page)).toBeDisabled();

	const nextConfig = {
		method: "ngram",
		num_speculative_tokens: 6,
		custom: { allow: true },
	};
	await page.getByLabel("Draft model").fill("/models/vllm-draft-v2");
	await draftTokens.fill("6");
	await maxSequences.fill("12");
	await speculativeConfig.fill(JSON.stringify(nextConfig, null, 2));
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(engineSaveButton(page)).toBeEnabled();

	await engineSaveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const expectedConfig = {
		draft_max: 6,
		draft_model: "/models/vllm-draft-v2",
		gpu_memory_utilization: 0.9,
		max_num_seqs: 12,
		speculative_config: nextConfig,
		tensor_parallel: 2,
	};
	const savedPreferences = (await proofSnapshot(page)).preferences;
	expect(
		JSON.parse(savedPreferences["model.launch.engine.vllm"] ?? "{}")
	).toEqual(expectedConfig);
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			evidenceDir,
			"desktop-model-launch-vllm-speculative-config.png"
		),
	});

	await page.reload();
	await selectProfile(page, "engine:vllm");
	await openSection(page);
	await expect(page.getByLabel("Draft model")).toHaveValue(
		"/models/vllm-draft-v2"
	);
	await expect(draftTokens).toHaveValue("6");
	await expect(maxSequences).toHaveValue("12");
	await expect(speculativeConfig).toHaveValue(
		JSON.stringify(nextConfig, null, 2)
	);
});

test("Ollama Modelfile preview tracks saved runtime and sampling fields and copies", async ({
	page,
}) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await openSettings(page);
	await selectProfile(page, "engine:ollama");
	await openSection(page);

	const modelfile = page.getByLabel("Generated Ollama Modelfile");
	await expect(modelfile).toBeVisible();
	await expect(modelfile).toHaveAttribute("readonly", "");
	await expect(modelfile).toHaveValue(
		[
			"FROM <model-id>",
			"PARAMETER num_ctx 4096",
			"PARAMETER num_gpu 4",
			"PARAMETER num_batch 512",
			"PARAMETER num_thread 12",
			"PARAMETER top_k 40",
			"PARAMETER min_p 0.1",
			"PARAMETER repeat_penalty 1.15",
			"PARAMETER mirostat 2",
		].join("\n")
	);

	await page.getByLabel("Context size").fill("8192");
	await page.getByLabel("GPU layers").fill("12");
	await page.getByLabel("Batch size", { exact: true }).fill("1024");
	await page.getByLabel("Threads").fill("16");
	await page.getByRole("switch", { name: "Lock in RAM" }).click();
	await page.getByRole("switch", { name: "No mmap" }).click();
	await expect(modelfile).toHaveValue(
		[
			"FROM <model-id>",
			"PARAMETER num_ctx 8192",
			"PARAMETER num_gpu 12",
			"PARAMETER num_batch 1024",
			"PARAMETER num_thread 16",
			"PARAMETER use_mlock true",
			"PARAMETER use_mmap false",
			"PARAMETER top_k 40",
			"PARAMETER min_p 0.1",
			"PARAMETER repeat_penalty 1.15",
			"PARAMETER mirostat 2",
		].join("\n")
	);

	await engineSaveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Copy Modelfile profile" }).click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await expect
		.poll(() => clipboardText(page))
		.toBe(await modelfile.inputValue());
	const savedPreferences = (await proofSnapshot(page)).preferences;
	expect(
		JSON.parse(savedPreferences["model.launch.engine.ollama"] ?? "{}")
	).toEqual({
		batch_size: 1024,
		ctx_size: 8192,
		gpu_layers: 12,
		mlock: true,
		no_mmap: true,
		threads: 16,
	});
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			evidenceDir,
			"desktop-model-launch-ollama-modelfile-copy.png"
		),
	});

	await page.reload();
	await selectProfile(page, "engine:ollama");
	await openSection(page);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await expect(page.getByLabel("GPU layers")).toHaveValue("12");
	await expect(modelfile).toHaveValue(await clipboardText(page));
});

test("manual runtime args save and copy in command order", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await openSettings(page);
	await selectProfile(page, "engine:lemonade");
	await openSection(page);
	await expect(
		page.getByText("Runtime launch profile", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			"This is a saved copy only. Paste the arguments into the external runtime; Ryu cannot apply them to that process."
		)
	).toBeVisible();

	const args = page.getByLabel("Runtime args", { exact: true });
	await expect(args).toHaveValue("--host, 127.0.0.1, --port, 1234");
	await args.fill("--host, 0.0.0.0, --port, 9999");
	await engineSaveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const expectedArgs = ["--host", "0.0.0.0", "--port", "9999"];
	const savedPreferences = (await proofSnapshot(page)).preferences;
	expect(
		JSON.parse(savedPreferences["model.launch.engine.lemonade"] ?? "{}")
			.extra_args
	).toEqual(expectedArgs);

	await page.getByRole("button", { name: "Copy runtime args" }).click();
	await expect(page.getByText("Copied", { exact: true })).toBeVisible();
	await expect.poll(() => clipboardText(page)).toBe(expectedArgs.join("\n"));
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			evidenceDir,
			"desktop-model-launch-manual-runtime-copy.png"
		),
	});

	await page.reload();
	await selectProfile(page, "engine:lemonade");
	await openSection(page);
	await expect(page.getByLabel("Runtime args", { exact: true })).toHaveValue(
		expectedArgs.join(", ")
	);
});
