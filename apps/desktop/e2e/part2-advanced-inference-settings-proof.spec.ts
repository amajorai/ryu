// Continues advanced-inference-settings-proof.spec.ts (split under the file token limit); helpers live in advanced-inference-settings-proof.helpers.ts.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import type { SamplingConfig } from "../src/lib/api/inference.ts";
import {
	enginePreferencePath,
	enginePreferenceWrites,
	evidenceDir,
	expandEngineSamplingDefaults,
	failNextEngineSamplingSave,
	openEngineSettings,
	readProof,
	savedLocalInference,
} from "./advanced-inference-settings-proof.helpers.ts";

test.describe.configure({ timeout: 60_000 });

test("Ollama engine sampler controls validate and save exact defaults through failure, retry, and reload", async ({
	page,
}) => {
	await mkdir(evidenceDir, { recursive: true });
	await openEngineSettings(page, "ollama");
	const before = await readProof(page);
	expect(before.draft).toEqual(savedLocalInference);
	expect(before.preferences["inference.engine.ollama"]).toBe(
		JSON.stringify(savedLocalInference)
	);

	for (const label of [
		"Top K",
		"Min P",
		"Typical P",
		"Repeat penalty",
		"Repeat window",
		"Mirostat mode",
		"Mirostat tau",
		"Mirostat eta",
	]) {
		await expect(page.getByLabel(label)).toBeVisible();
	}

	const invalidCases: Array<{
		key: keyof SamplingConfig;
		label: string;
		message: string;
		value: string;
	}> = [
		{
			key: "top_k",
			label: "Top K",
			message: "Top K must be at least 0.",
			value: "-1",
		},
		{
			key: "top_k",
			label: "Top K",
			message: "Top K must be a whole number.",
			value: "1.5",
		},
		{
			key: "min_p",
			label: "Min P",
			message: "Min P must be no greater than 1.",
			value: "1.1",
		},
		{
			key: "typical_p",
			label: "Typical P",
			message: "Typical P must be at least 0.",
			value: "-0.1",
		},
		{
			key: "repeat_penalty",
			label: "Repeat penalty",
			message: "Repeat penalty must be at least 0.",
			value: "-0.1",
		},
		{
			key: "repeat_last_n",
			label: "Repeat window",
			message: "Repeat window must be at least 0.",
			value: "-1",
		},
		{
			key: "repeat_last_n",
			label: "Repeat window",
			message: "Repeat last N must be a whole number.",
			value: "2.5",
		},
		{
			key: "mirostat",
			label: "Mirostat mode",
			message: "Mirostat mode must be a whole number.",
			value: "1.5",
		},
		{
			key: "mirostat",
			label: "Mirostat mode",
			message: "Mirostat mode must be no greater than 2.",
			value: "3",
		},
		{
			key: "mirostat_tau",
			label: "Mirostat tau",
			message: "Mirostat tau must be at least 0.",
			value: "-0.1",
		},
		{
			key: "mirostat_eta",
			label: "Mirostat eta",
			message: "Mirostat eta must be at least 0.",
			value: "-0.1",
		},
	];
	for (const invalidCase of invalidCases) {
		const field = page.getByLabel(invalidCase.label);
		const savedValue = before.draft[invalidCase.key];
		if (!z.number().safeParse(savedValue).success) {
			throw new Error(`${invalidCase.label} fixture value must be numeric.`);
		}
		await field.fill(invalidCase.value);
		await expect(page.getByRole("alert")).toContainText(invalidCase.message);
		await expect(field).toHaveValue(invalidCase.value);
		expect((await readProof(page)).draft[invalidCase.key]).toBe(savedValue);
		await field.fill(String(savedValue));
		await expect(page.getByRole("alert")).toHaveCount(0);
	}

	const expected = structuredClone(before.draft);
	expected.top_k = 24;
	expected.min_p = 0.03;
	expected.typical_p = 0.88;
	expected.repeat_penalty = 1.08;
	expected.repeat_last_n = 96;
	expected.mirostat = 2;
	expected.mirostat_tau = 6.5;
	expected.mirostat_eta = 0.15;
	await page.getByLabel("Top K").fill("24");
	await page.getByLabel("Min P").fill("0.03");
	await page.getByLabel("Typical P").fill("0.88");
	await page.getByLabel("Repeat penalty").fill("1.08");
	await page.getByLabel("Repeat window").fill("96");
	await page.getByLabel("Mirostat mode").fill("2");
	await page.getByLabel("Mirostat tau").fill("6.5");
	await page.getByLabel("Mirostat eta").fill("0.15");
	expect((await readProof(page)).draft).toEqual(expected);

	const save = page.getByRole("button", {
		name: "Save sampling defaults",
		exact: true,
	});
	const extra = page.getByLabel("Extra body fields (JSON)");
	await extra.fill("{");
	await expect(page.getByRole("alert")).toContainText("Invalid JSON");
	await expect(save).toBeDisabled();
	expect((await readProof(page)).draft.extra).toEqual(before.draft.extra);
	await extra.fill(JSON.stringify(before.draft.extra, null, 2));
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(save).toBeEnabled();

	await failNextEngineSamplingSave(page, "ollama");
	await save.click();
	await expect(page.getByRole("alert")).toContainText(
		"/api/preferences/inference.engine.ollama failed: 503"
	);
	const failed = await readProof(page);
	expect(failed.draft).toEqual(expected);
	expect(failed.preferences["inference.engine.ollama"]).toBe(
		JSON.stringify(savedLocalInference)
	);
	expect(enginePreferenceWrites(failed, "ollama")).toEqual([
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: enginePreferencePath("ollama"),
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-ollama-sampling-save-error.png"),
	});

	await save.click();
	await expect(page.getByTestId("save-status")).toHaveText(
		"Saved for this engine"
	);
	const saved = await readProof(page);
	expect(saved.preferences["inference.engine.ollama"]).toBe(
		JSON.stringify(expected)
	);
	expect(enginePreferenceWrites(saved, "ollama")).toEqual([
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: enginePreferencePath("ollama"),
		},
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: enginePreferencePath("ollama"),
		},
	]);

	await page.reload();
	await expect(page.getByTestId("save-status")).toHaveText(
		"Loaded engine sampling defaults"
	);
	await expandEngineSamplingDefaults(page);
	const reloaded = await readProof(page);
	expect(reloaded.draft).toEqual(expected);
	expect(reloaded.preferences["inference.engine.ollama"]).toBe(
		JSON.stringify(expected)
	);
	await expect(page.getByLabel("Top K")).toHaveValue("24");
	await expect(page.getByLabel("Repeat window")).toHaveValue("96");
	await expect(page.getByLabel("Mirostat mode")).toHaveValue("2");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			evidenceDir,
			"desktop-ollama-sampling-defaults-reloaded.png"
		),
	});
});

test("MLX engine repetition penalty validates, saves to its own preference, and reloads", async ({
	page,
}) => {
	await mkdir(evidenceDir, { recursive: true });
	await openEngineSettings(page, "mlx");
	const before = await readProof(page);
	await expect(page.getByLabel("Repetition penalty")).toBeVisible();
	await expect(page.getByLabel("Top K")).toHaveCount(0);
	const repetitionPenalty = page.getByLabel("Repetition penalty");
	await repetitionPenalty.fill("-0.1");
	await expect(page.getByRole("alert")).toContainText(
		"Repeat penalty must be at least 0."
	);
	expect((await readProof(page)).draft.repeat_penalty).toBe(
		before.draft.repeat_penalty
	);
	await repetitionPenalty.fill("1.15");
	await expect(page.getByRole("alert")).toHaveCount(0);

	const expected = structuredClone(before.draft);
	expected.repeat_penalty = 1.15;
	const save = page.getByRole("button", {
		name: "Save sampling defaults",
		exact: true,
	});
	await save.click();
	await expect(page.getByTestId("save-status")).toHaveText(
		"Saved for this engine"
	);
	const saved = await readProof(page);
	expect(saved.draft).toEqual(expected);
	expect(saved.preferences["inference.engine.mlx"]).toBe(
		JSON.stringify(expected)
	);
	expect(enginePreferenceWrites(saved, "mlx")).toEqual([
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: enginePreferencePath("mlx"),
		},
	]);

	await page.reload();
	await expect(page.getByTestId("save-status")).toHaveText(
		"Loaded engine sampling defaults"
	);
	await expandEngineSamplingDefaults(page);
	expect((await readProof(page)).draft).toEqual(expected);
	await expect(page.getByLabel("Repetition penalty")).toHaveValue("1.15");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-mlx-repetition-default-reloaded.png"),
	});
});
