import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	alphaPath,
	armFailure,
	betaPath,
	completeLaunchConfig,
	engineSaveButton,
	evidenceDir,
	holdNextRead,
	MODEL_ALPHA,
	MODEL_BETA,
	openSection,
	openSettings,
	proofCalls,
	proofSnapshot,
	readAlphaConfig,
	refreshModelConfig,
	releaseRead,
	saveButton,
	selectProfile,
} from "./model-launch-config-settings-proof.helpers.ts";

test.describe.configure({ timeout: 60_000 });

test("launch config loads lazily, saves exact values, retries errors, and restores after reload", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openSettings(page);
	expect(await proofCalls(page)).toEqual([]);
	await holdNextRead(page);
	const toggle = page.getByRole("button", { name: /Engine \/ Hardware/u });
	await toggle.click();
	await expect(page.getByText("Loading config…")).toBeVisible();
	await expect.poll(async () => (await proofCalls(page)).length).toBe(1);
	await releaseRead(page);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");

	for (const label of [
		"Context size",
		"GPU layers",
		"Batch size",
		"uBatch size",
		"Threads",
		"Flash attention",
		"Cache type K",
		"Cache type V",
		"Lock in RAM",
		"No mmap",
		"Parallel slots",
		"Cache reuse",
		"Unified KV cache",
		"Continuous batching",
		"Keep all experts on CPU (--cpu-moe)",
		"CPU MoE layers (--n-cpu-moe)",
		"Override tensor",
		"Enable Jinja (--jinja)",
		"Chat template file",
		"Speculative type",
		"Draft model",
		"Draft max",
		"Draft min",
		"Speculative algorithm",
		"GPU memory utilization",
		"Mem fraction static",
		"Tensor parallel",
		"Dtype",
		"Quantization",
		"KV cache dtype",
		"Extra args",
	]) {
		await expect(page.getByLabel(label, { exact: true }).first()).toBeVisible();
	}

	await page.getByLabel("Context size").fill("12288");
	await page.getByLabel("GPU layers").fill("-1");
	await page.getByLabel("Batch size", { exact: true }).fill("1024");
	await page.getByLabel("uBatch size", { exact: true }).fill("256");
	await page.getByLabel("Threads").fill("16");
	await page.getByRole("combobox", { name: "Flash attention" }).click();
	await page.getByRole("option", { name: "On", exact: true }).click();
	await page.getByLabel("Cache type K").fill("q8_0");
	await page.getByLabel("Cache type V").fill("f16");
	await page.getByRole("switch", { name: "Lock in RAM" }).click();
	await page.getByRole("switch", { name: "No mmap" }).click();
	await page.getByLabel("Parallel slots").fill("6");
	await page.getByLabel("Cache reuse").fill("512");
	await page.getByRole("switch", { name: "Unified KV cache" }).click();
	await page.getByRole("switch", { name: "Continuous batching" }).click();
	await page
		.getByRole("switch", { name: "Keep all experts on CPU (--cpu-moe)" })
		.click();
	await page.getByLabel("CPU MoE layers (--n-cpu-moe)").fill("8");
	await page.getByLabel("Override tensor").fill(".ffn_.*_exps.=CPU");
	await page.getByRole("switch", { name: "Enable Jinja (--jinja)" }).click();
	await page.getByLabel("Chat template file").fill("/models/chat.jinja");
	await page.getByRole("combobox", { name: "Speculative type" }).click();
	await page.getByRole("option", { name: "n-gram cache", exact: true }).click();
	await page.getByLabel("Draft model").first().fill("/models/draft.gguf");
	await page.getByLabel("Draft max").fill("8");
	await page.getByLabel("Draft min").fill("2");
	await page.getByLabel("Speculative algorithm").fill("eagle");
	await page.getByLabel("GPU memory utilization").fill("0.95");
	await page.getByLabel("Mem fraction static").fill("0.85");
	await page.getByLabel("Tensor parallel").fill("4");
	await page.getByLabel("Dtype", { exact: true }).fill("bfloat16");
	await page.getByLabel("Quantization").fill("awq");
	await page.getByLabel("KV cache dtype").fill("fp8");
	await page
		.getByLabel("Extra args")
		.fill("--spec-type, ngram-cache, --priority, 1");

	await armFailure(page, "PUT", alphaPath, "launch config write denied", 403);
	await saveButton(page).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not save: launch config write denied"
	);
	await expect(page.getByLabel("Context size")).toHaveValue("12288");
	expect((await proofSnapshot(page)).configs[MODEL_ALPHA]).toMatchObject({
		ctx_size: 8192,
		flash_attn: "auto",
	});

	await saveButton(page).click();
	await expect(saveButton(page)).toBeEnabled();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const expectedConfig = completeLaunchConfig;
	const alphaWrites = (await proofCalls(page)).filter(
		(call) => call.method === "PUT" && call.path === alphaPath
	);
	expect(alphaWrites).toHaveLength(2);
	expect(alphaWrites[0]?.body).toEqual(expectedConfig);
	expect(alphaWrites[1]?.body).toEqual(expectedConfig);
	expect((await proofSnapshot(page)).configs[MODEL_ALPHA]).toEqual(
		expectedConfig
	);

	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-model-launch-config-settings.png"),
	});
	await page.reload();
	await openSection(page);
	expect((await proofSnapshot(page)).configs[MODEL_ALPHA]).toEqual(
		expectedConfig
	);
	await expect(page.getByLabel("Context size")).toHaveValue("12288");
	await expect(page.getByLabel("Cache type K")).toHaveValue("q8_0");
	await expect(page.getByLabel("Extra args")).toHaveValue(
		"--spec-type, ngram-cache, --priority, 1"
	);
	expect(pageErrors).toEqual([]);
});

test("numeric and enum validation prevents invalid payloads and restores per-model settings", async ({
	page,
}) => {
	await openSettings(page);
	await openSection(page);
	const invalidCases = [
		{
			label: "Context size",
			message: "Context size must be at least 0.",
			value: "-1",
		},
		{
			label: "GPU layers",
			message: "GPU layers must be a whole number.",
			value: "1.5",
		},
		{
			label: "Batch size",
			message: "Batch size must be a whole number.",
			value: "2.5",
		},
		{
			label: "Parallel slots",
			message: "Parallel slots must be at least 1.",
			value: "0",
		},
		{
			label: "Cache reuse",
			message: "Cache reuse must be at least 0.",
			value: "-1",
		},
		{
			label: "CPU MoE layers (--n-cpu-moe)",
			message: "CPU MoE layers must be a whole number.",
			value: "2.5",
		},
		{
			label: "Draft max",
			message: "Draft max must be a whole number.",
			value: "2.5",
		},
		{
			label: "Draft min",
			message: "Draft min must be a whole number.",
			value: "1.5",
		},
		{
			label: "GPU memory utilization",
			message: "GPU memory utilization must be no greater than 1.",
			value: "1.1",
		},
		{
			label: "Mem fraction static",
			message: "Mem fraction static must be at least 0.",
			value: "-0.1",
		},
		{
			label: "Tensor parallel",
			message: "Tensor parallel must be a whole number.",
			value: "1.5",
		},
	] as const;
	const originalValues = {
		"Batch size": "256",
		"Cache reuse": "256",
		"CPU MoE layers (--n-cpu-moe)": "0",
		"Context size": "8192",
		"Draft max": "4",
		"Draft min": "2",
		"GPU layers": "-1",
		"GPU memory utilization": "0.8",
		"Mem fraction static": "0.75",
		"Parallel slots": "4",
		"Tensor parallel": "2",
	};
	for (const invalidCase of invalidCases) {
		const input = page.getByRole("spinbutton", {
			name: invalidCase.label,
			exact: true,
		});
		await input.fill(invalidCase.value);
		await expect(page.getByRole("alert")).toContainText(invalidCase.message);
		await expect(input).toHaveValue(invalidCase.value);
		await expect(saveButton(page)).toBeDisabled();
		await input.fill(originalValues[invalidCase.label]);
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(saveButton(page)).toBeEnabled();
	}

	await page.getByLabel("Context size").fill("0");
	await page.getByLabel("Parallel slots").fill("1");
	await page.getByLabel("Cache reuse").fill("0");
	await page.getByLabel("GPU memory utilization").fill("0");
	await page.getByLabel("Mem fraction static").fill("1");
	await page.getByRole("combobox", { name: "Flash attention" }).click();
	await page.getByRole("option", { name: "Off", exact: true }).click();
	await page.getByRole("combobox", { name: "Flash attention" }).click();
	await page.getByRole("option", { name: "Default", exact: true }).click();
	await page.getByRole("combobox", { name: "Speculative type" }).click();
	await page
		.getByRole("option", { name: "MTP (draft-mtp)", exact: true })
		.click();
	await page.getByRole("combobox", { name: "Speculative type" }).click();
	await page
		.getByRole("option", { name: "Default", exact: true })
		.last()
		.click();
	await saveButton(page).click();
	const save = (await proofCalls(page)).find(
		(call) => call.method === "PUT" && call.path === alphaPath
	);
	const expectedConfig = Object.fromEntries(
		Object.entries(readAlphaConfig()).filter(
			([key]) => key !== "flash_attn" && key !== "spec_type"
		)
	);
	expect(save?.body).toEqual({
		...expectedConfig,
		cache_reuse: 0,
		ctx_size: 0,
		gpu_memory_utilization: 0,
		mem_fraction_static: 1,
		parallel: 1,
	});
	const persisted = (await proofSnapshot(page)).configs[MODEL_ALPHA];
	expect(persisted).not.toHaveProperty("flash_attn");
	expect(persisted).not.toHaveProperty("spec_type");
});

test("switching model profiles isolates the query, draft, save path, and reload state", async ({
	page,
}) => {
	await openSettings(page);
	await openSection(page);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await page.getByLabel("Model profile fixture").selectOption(MODEL_BETA);
	await expect(page.getByLabel("Context size")).toHaveValue("16384");
	await expect(page.getByLabel("Threads")).toHaveValue("16");
	await page.getByLabel("Threads").fill("32");
	await saveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const betaWrite = (await proofCalls(page)).find(
		(call) => call.method === "PUT" && call.path === betaPath
	);
	expect(betaWrite?.body).toEqual({
		ctx_size: 16_384,
		flash_attn: "off",
		parallel: 2,
		threads: 32,
	});
	const snapshot = await proofSnapshot(page);
	expect(snapshot.configs[MODEL_ALPHA].ctx_size).toBe(8192);
	expect(snapshot.configs[MODEL_ALPHA].threads).toBe(8);
	expect(snapshot.configs[MODEL_BETA].threads).toBe(32);

	await page.getByLabel("Model profile fixture").selectOption(MODEL_ALPHA);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await expect(page.getByLabel("Threads")).toHaveValue("8");
	await page.reload();
	await openSection(page);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await page.getByLabel("Model profile fixture").selectOption(MODEL_BETA);
	await expect(page.getByLabel("Threads")).toHaveValue("32");
	const reads = (await proofCalls(page)).filter(
		(call) => call.method === "GET"
	);
	expect(reads.some((call) => call.path === alphaPath)).toBe(true);
	expect(reads.some((call) => call.path === betaPath)).toBe(true);
});

test("503 read failures keep config protected until Retry loads the saved model state", async ({
	page,
}) => {
	await openSettings(page);
	await armFailure(page, "GET", alphaPath, "launch config unavailable", 503);
	await openSection(page);
	await expect(page.getByRole("alert")).toHaveText(
		"Could not load model launch config: launch config unavailable"
	);
	await expect(
		page.getByRole("button", { name: "Retry model config" })
	).toBeVisible();
	await expect(page.getByLabel("Context size")).toHaveCount(0);
	await expect(saveButton(page)).toHaveCount(0);
	expect((await proofSnapshot(page)).configs[MODEL_ALPHA].ctx_size).toBe(8192);
	expect(
		(await proofCalls(page)).filter((call) => call.method === "PUT")
	).toEqual([]);

	await page.getByRole("button", { name: "Retry model config" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await expect(saveButton(page)).toBeEnabled();
	expect(
		(await proofCalls(page)).filter((call) => call.method === "GET")
	).toEqual([
		{ body: undefined, method: "GET", path: alphaPath },
		{ body: undefined, method: "GET", path: alphaPath },
	]);

	await armFailure(
		page,
		"GET",
		alphaPath,
		"launch config refresh unavailable",
		503
	);
	await refreshModelConfig(page, MODEL_ALPHA);
	await expect(page.getByRole("alert")).toHaveText(
		"Could not refresh model launch config: launch config refresh unavailable"
	);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await expect(saveButton(page)).toBeDisabled();
	await page.getByRole("button", { name: "Retry model config" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByLabel("Context size")).toHaveValue("8192");
	await expect(saveButton(page)).toBeEnabled();
	expect(
		(await proofCalls(page)).filter((call) => call.method === "GET")
	).toHaveLength(4);
	expect((await proofSnapshot(page)).configs[MODEL_ALPHA].ctx_size).toBe(8192);
});

test("404 from an older backend keeps the documented empty-default save path", async ({
	page,
}) => {
	await openSettings(page);
	await armFailure(page, "GET", alphaPath, "route_not_found", 404);
	await openSection(page);
	await expect(page.getByLabel("Context size")).toHaveValue("");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(saveButton(page)).toBeEnabled();
	await page.getByLabel("Context size").fill("4096");
	await saveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const write = (await proofCalls(page)).find(
		(call) => call.method === "PUT" && call.path === alphaPath
	);
	expect(write?.body).toEqual({ ctx_size: 4096 });
	expect((await proofSnapshot(page)).configs[MODEL_ALPHA]).toEqual({
		ctx_size: 4096,
	});
});

test("inline Jinja editor saves, reloads, and clears the optional template", async ({
	page,
}) => {
	await openSettings(page);
	await selectProfile(page, "engine:llamacpp");
	await openSection(page);
	await expect(
		page.getByRole("switch", { name: "Enable Jinja (--jinja)" })
	).not.toBeChecked();
	const draftMin = page.getByLabel("Draft min", { exact: true });
	const draftPMin = page.getByLabel("Draft P min", { exact: true });
	await expect(draftMin).toHaveValue("2");
	await expect(draftPMin).toHaveValue("0.2");
	await draftMin.fill("1.5");
	await expect(page.getByRole("alert")).toHaveText(
		"Draft min must be a whole number."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await draftMin.fill("-1");
	await expect(page.getByRole("alert")).toHaveText(
		"Draft min must be at least 0."
	);
	await draftMin.fill("0");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await draftPMin.fill("1.1");
	await expect(page.getByRole("alert")).toHaveText(
		"Draft P min must be no greater than 1."
	);
	await expect(engineSaveButton(page)).toBeDisabled();
	await draftPMin.fill("0.5");
	await expect(page.getByRole("alert")).toHaveCount(0);

	const template = "{{- if .System }}\n{{ .System }}\n{{- end }}";
	await page.getByRole("switch", { name: "Enable Jinja (--jinja)" }).click();
	await page.getByLabel("Chat template file").fill("/models/custom-chat.jinja");
	await page.getByLabel("Inline Jinja template").fill(template);
	await engineSaveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();

	const expectedConfig = {
		chat_template: template,
		chat_template_file: "/models/custom-chat.jinja",
		draft_max: 6,
		draft_min: 0,
		draft_p_min: 0.5,
		jinja: true,
		spec_type: "ngram-simple",
	};
	const preferences = (await proofSnapshot(page)).preferences;
	expect(
		JSON.parse(preferences["model.launch.engine.llamacpp"] ?? "{}")
	).toEqual(expectedConfig);
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-model-launch-inline-jinja.png"),
	});

	await page.reload();
	await selectProfile(page, "engine:llamacpp");
	await openSection(page);
	await expect(
		page.getByRole("switch", { name: "Enable Jinja (--jinja)" })
	).toBeChecked();
	await expect(page.getByLabel("Chat template file")).toHaveValue(
		"/models/custom-chat.jinja"
	);
	await expect(page.getByLabel("Inline Jinja template")).toHaveValue(template);
	await expect(draftMin).toHaveValue("0");
	await expect(draftPMin).toHaveValue("0.5");

	await page.getByLabel("Inline Jinja template").fill("");
	await engineSaveButton(page).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const { chat_template, ...clearedConfig } = expectedConfig;
	expect(chat_template).toBe(template);
	expect(
		JSON.parse(
			(await proofSnapshot(page)).preferences["model.launch.engine.llamacpp"] ??
				"{}"
		)
	).toEqual(clearedConfig);
	await page.reload();
	await selectProfile(page, "engine:llamacpp");
	await openSection(page);
	await expect(page.getByLabel("Inline Jinja template")).toHaveValue("");
});
