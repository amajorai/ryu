import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { SamplingConfig } from "../src/lib/api/inference.ts";
import { capturedJsonField } from "./captured-json-observations.ts";

const STORY_URL = "/advanced-inference-settings-proof.html";
const AGENT_PATH = "/api/agents/advanced-inference-proof";
const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface ProofRequest {
	body: unknown;
	method: string;
	path: string;
}

interface ProofAgent {
	inference: SamplingConfig;
	locked: boolean;
}

interface ProofSnapshot {
	agent: ProofAgent;
	calls: ProofRequest[];
	draft: SamplingConfig;
	preferences: Record<string, string>;
}

interface ProofWindow extends Window {
	__advancedInferenceProof: {
		calls: () => ProofRequest[];
		draft: () => SamplingConfig;
		failNext: (failure: {
			message: string;
			method: string;
			path: string;
			status: number;
		}) => void;
		snapshot: () => ProofSnapshot;
	};
}

const savedLocalInference: SamplingConfig = {
	dry_allowed_length: 3,
	dry_base: 1.7,
	dry_multiplier: 1.15,
	dry_penalty_last_n: 64,
	dynatemp_exponent: 1.3,
	dynatemp_range: 0.2,
	extra: { min_keep: 1 },
	frequency_penalty: 0.1,
	grammar: 'root ::= "yes" | "no"',
	logit_bias: { "42": -5 },
	max_tokens: 128,
	min_p: 0.05,
	mirostat: 1,
	mirostat_eta: 0.1,
	mirostat_tau: 5,
	prefill: "{\n",
	presence_penalty: 0.2,
	repeat_last_n: 48,
	repeat_penalty: 1.05,
	response_format: { type: "json_object" },
	samplers: "penalties;dry;top_k;top_p;min_p;temperature",
	seed: 41,
	stop: ["<END>"],
	temperature: 0.7,
	top_k: 40,
	top_n_sigma: 0.5,
	top_p: 0.85,
	typical_p: 0.8,
	xtc_probability: 0.1,
	xtc_threshold: 0.4,
};

const completeLocalInference: SamplingConfig = {
	dry_allowed_length: 4,
	dry_base: 1.8,
	dry_multiplier: 1.25,
	dry_penalty_last_n: 128,
	dynatemp_exponent: 1.25,
	dynatemp_range: 0.3,
	extra: { min_keep: 2, n_threads: 8 },
	frequency_penalty: 0.35,
	grammar: 'root ::= "yes" | "no"',
	logit_bias: { "42": -100, "50256": 25 },
	max_tokens: 512,
	min_p: 0.03,
	mirostat: 2,
	mirostat_eta: 0.15,
	mirostat_tau: 6.5,
	prefill: "{",
	presence_penalty: -0.2,
	repeat_last_n: 96,
	repeat_penalty: 1.08,
	response_format: {
		json_schema: {
			name: "answer",
			schema: { properties: { answer: { type: "string" } }, type: "object" },
		},
		type: "json_schema",
	},
	samplers: "penalties;dry;top_k;min_p;temperature",
	seed: 123,
	stop: ["STOP_A", "STOP_B", "STOP_C"],
	temperature: 0.65,
	top_k: 24,
	top_n_sigma: 0.4,
	top_p: 0.92,
	typical_p: 0.88,
	xtc_probability: 0.2,
	xtc_threshold: 0.45,
};

async function openSettings(page: Page, query = "") {
	await page.goto(`${STORY_URL}${query}`);
	await expect(
		page.getByRole("button", { name: "Advanced inference", exact: true })
	).toBeVisible();
}

async function openSection(page: Page) {
	const toggle = page.getByRole("button", {
		name: "Advanced inference",
		exact: true,
	});
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await toggle.focus();
	await toggle.press("Space");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function readProof(page: Page): Promise<ProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: advanced-inference-settings-proof.tsx installs __advancedInferenceProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__advancedInferenceProof.snapshot()
	);
}

async function failNextSave(page: Page) {
	await page.evaluate(() => {
		/* SAFETY: advanced-inference-settings-proof.tsx installs __advancedInferenceProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__advancedInferenceProof.failNext({
			message: "Agent update permission denied",
			method: "PUT",
			path: "/api/agents/advanced-inference-proof",
			status: 403,
		});
	});
}

function saveButton(page: Page) {
	return page.getByRole("button", { name: "Save", exact: true });
}

function enginePreferencePath(engineId: string) {
	return `/api/preferences/inference.engine.${engineId}`;
}

function enginePreferenceWrites(snapshot: ProofSnapshot, engineId: string) {
	return snapshot.calls.filter(
		(call) =>
			call.method === "PUT" && call.path === enginePreferencePath(engineId)
	);
}

async function expandEngineSamplingDefaults(page: Page) {
	const toggle = page.getByRole("button", {
		name: "Sampling defaults",
		exact: true,
	});
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByRole("region", { name: "Engine sampling defaults" })
	).toBeVisible();
}

async function openEngineSettings(page: Page, engineId: string) {
	await page.goto(`${STORY_URL}?scope=engine&engine=${engineId}`);
	await expect(page.getByTestId("save-status")).toHaveText(
		"Loaded engine sampling defaults"
	);
	await expandEngineSamplingDefaults(page);
}

async function failNextEngineSamplingSave(page: Page, engineId: string) {
	await page.evaluate((path) => {
		/* SAFETY: advanced-inference-settings-proof.tsx installs __advancedInferenceProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__advancedInferenceProof.failNext({
			message: "Temporary preference write failure",
			method: "PUT",
			path,
			status: 503,
		});
	}, enginePreferencePath(engineId));
}

test.describe.configure({ timeout: 60_000 });

test("local sampler controls save their complete exact payload, retry failures, and reload", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openSettings(page);
	await openSection(page);

	for (const label of [
		"Temperature",
		"Top P",
		"Max tokens",
		"Seed",
		"Top K",
		"Min P",
		"Typical P",
		"Top-N sigma",
		"Stop sequences",
		"Frequency penalty",
		"Presence penalty",
		"Repeat penalty",
		"Repeat last N",
		"Mode",
		"Tau (target entropy)",
		"Eta (learning rate)",
		"DynaTemp range",
		"DynaTemp exponent",
		"XTC probability",
		"XTC threshold",
		"DRY multiplier",
		"DRY base",
		"DRY allowed length",
		"DRY penalty last N",
		"Sampler order",
		"Prefill",
		"Response format (JSON)",
		"Logit bias (JSON)",
		"Grammar (GBNF, llama.cpp)",
		"Extra body fields (JSON)",
	]) {
		await expect(page.getByLabel(label)).toBeVisible();
	}

	await page.getByLabel("Temperature").fill("0.65");
	await page.getByLabel("Top P").fill("0.92");
	await page.getByLabel("Max tokens").fill("512");
	await page.getByLabel("Seed").fill("123");
	await page.getByLabel("Top K").fill("24");
	await page.getByLabel("Min P").fill("0.03");
	await page.getByLabel("Typical P").fill("0.88");
	await page.getByLabel("Top-N sigma").fill("0.4");
	await page.getByLabel("Stop sequences").fill(" STOP_A, STOP_B, STOP_C , , ");
	await page.getByLabel("Frequency penalty").fill("0.35");
	await page.getByLabel("Presence penalty").fill("-0.2");
	await page.getByLabel("Repeat penalty").fill("1.08");
	await page.getByLabel("Repeat last N").fill("96");
	await page.getByRole("combobox", { name: "Mode" }).click();
	await page.getByRole("option", { name: "Mirostat 2" }).click();
	await page.getByLabel("Tau (target entropy)").fill("6.5");
	await page.getByLabel("Eta (learning rate)").fill("0.15");
	await page.getByLabel("DynaTemp range").fill("0.3");
	await page.getByLabel("DynaTemp exponent").fill("1.25");
	await page.getByLabel("XTC probability").fill("0.2");
	await page.getByLabel("XTC threshold").fill("0.45");
	await page.getByLabel("DRY multiplier").fill("1.25");
	await page.getByLabel("DRY base").fill("1.8");
	await page.getByLabel("DRY allowed length").fill("4");
	await page.getByLabel("DRY penalty last N").fill("128");
	await page
		.getByLabel("Sampler order")
		.fill("penalties;dry;top_k;min_p;temperature");
	await page.getByLabel("Prefill").fill("{");
	await page
		.getByLabel("Response format (JSON)")
		.fill(JSON.stringify(completeLocalInference.response_format, null, 2));
	await page
		.getByLabel("Logit bias (JSON)")
		.fill(JSON.stringify(completeLocalInference.logit_bias, null, 2));
	await page
		.getByLabel("Grammar (GBNF, llama.cpp)")
		.fill('root ::= "yes" | "no"');
	await page
		.getByLabel("Extra body fields (JSON)")
		.fill(JSON.stringify(completeLocalInference.extra, null, 2));
	expect((await readProof(page)).draft).toEqual(completeLocalInference);

	await failNextSave(page);
	await saveButton(page).click();
	await expect(
		page.getByText("/api/agents/advanced-inference-proof failed: 403", {
			exact: true,
		})
	).toBeVisible();
	expect((await readProof(page)).draft).toEqual(completeLocalInference);
	expect((await readProof(page)).agent.inference).toEqual(savedLocalInference);

	await saveButton(page).click();
	await expect(page.getByTestId("save-status")).toHaveText(
		"Saved to the agent record"
	);
	const saveCalls = (await readProof(page)).calls.filter(
		(call) => call.method === "PUT" && call.path === AGENT_PATH
	);
	expect(saveCalls).toHaveLength(2);
	const expectedBody = {
		description:
			"Exercise production sampling controls against a local fixture.",
		engine: "ollama",
		inference: completeLocalInference,
		model: null,
		name: "Inference test agent",
		system_prompt: "Answer clearly and use the saved sampling defaults.",
		title: "Inference",
		tools: [],
	};
	expect(saveCalls[0]?.body).toEqual(expectedBody);
	expect(saveCalls[1]?.body).toEqual(expectedBody);
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "desktop-advanced-inference-settings.png"),
	});

	await page.reload();
	await openSection(page);
	expect((await readProof(page)).draft).toEqual(completeLocalInference);
	await expect(page.getByLabel("Stop sequences")).toHaveValue(
		"STOP_A, STOP_B, STOP_C"
	);
	await expect(page.getByLabel("Temperature")).toHaveValue("0.65");
	await expect(page.getByLabel("Max tokens")).toHaveValue("512");
	await expect(page.getByLabel("Sampler order")).toHaveValue(
		"penalties;dry;top_k;min_p;temperature"
	);
	expect(pageErrors).toEqual([]);
});

test("numeric ranges and integer fields reject invalid edits without corrupting saved values", async ({
	page,
}) => {
	await openSettings(page);
	await openSection(page);
	const invalidCases: Array<{
		label: string;
		message: string;
		original: string;
		value: string;
	}> = [
		{
			label: "Temperature",
			message: "Temperature must be no greater than 2.",
			original: "0.7",
			value: "2.05",
		},
		{
			label: "Temperature",
			message: "Temperature must be at least 0.",
			original: "0.7",
			value: "-0.05",
		},
		{
			label: "Top P",
			message: "Top P must be no greater than 1.",
			original: "0.85",
			value: "1.1",
		},
		{
			label: "Max tokens",
			message: "Max tokens must be at least 1.",
			original: "128",
			value: "0",
		},
		{
			label: "Max tokens",
			message: "Max tokens must be a whole number.",
			original: "128",
			value: "1.5",
		},
		{
			label: "Seed",
			message: "Seed must be a whole number.",
			original: "41",
			value: "1.5",
		},
		{
			label: "Top K",
			message: "Top K must be at least 0.",
			original: "40",
			value: "-1",
		},
		{
			label: "Min P",
			message: "Min P must be no greater than 1.",
			original: "0.05",
			value: "1.1",
		},
		{
			label: "Typical P",
			message: "Typical P must be at least 0.",
			original: "0.8",
			value: "-0.1",
		},
		{
			label: "Frequency penalty",
			message: "Frequency penalty must be no greater than 2.",
			original: "0.1",
			value: "2.1",
		},
		{
			label: "Presence penalty",
			message: "Presence penalty must be at least -2.",
			original: "0.2",
			value: "-2.1",
		},
		{
			label: "Repeat last N",
			message: "Repeat last N must be a whole number.",
			original: "48",
			value: "2.5",
		},
		{
			label: "XTC probability",
			message: "XTC probability must be no greater than 1.",
			original: "0.1",
			value: "1.1",
		},
		{
			label: "DRY allowed length",
			message: "DRY allowed length must be a whole number.",
			original: "3",
			value: "2.5",
		},
		{
			label: "DRY penalty last N",
			message: "DRY penalty last N must be a whole number.",
			original: "64",
			value: "3.5",
		},
	];

	for (const invalidCase of invalidCases) {
		const field = page.getByLabel(invalidCase.label);
		await field.fill(invalidCase.value);
		await expect(page.getByRole("alert")).toContainText(invalidCase.message);
		await expect(field).toHaveValue(invalidCase.value);
		const snapshot = await readProof(page);
		// SAFETY: Every invalidCases label above is an authored key in this complete local label table; its corresponding literal value is a real SamplingConfig key used to compare the controlled draft field.
		const fieldKey = {
			"DRY allowed length": "dry_allowed_length",
			"DRY penalty last N": "dry_penalty_last_n",
			"Frequency penalty": "frequency_penalty",
			"Max tokens": "max_tokens",
			"Min P": "min_p",
			"Presence penalty": "presence_penalty",
			"Repeat last N": "repeat_last_n",
			Seed: "seed",
			Temperature: "temperature",
			"Top K": "top_k",
			"Top P": "top_p",
			"Typical P": "typical_p",
			"XTC probability": "xtc_probability",
		}[invalidCase.label] as keyof SamplingConfig;
		expect(snapshot.draft[fieldKey]).toBe(Number(invalidCase.original));
		await field.fill(invalidCase.original);
		await expect(page.getByRole("alert")).toHaveCount(0);
	}

	await page.getByLabel("Temperature").fill("2");
	await page.getByLabel("Top P").fill("0");
	await page.getByLabel("Max tokens").fill("1");
	await page.getByLabel("Seed").fill("0");
	await page.getByLabel("Top K").fill("0");
	const draft = (await readProof(page)).draft;
	expect(draft).toMatchObject({
		max_tokens: 1,
		seed: 0,
		temperature: 2,
		top_k: 0,
		top_p: 0,
	});

	await saveButton(page).click();
	const write = (await readProof(page)).calls.find(
		(call) => call.method === "PUT"
	);
	expect(write?.body).toMatchObject({ inference: draft });
	expect(JSON.stringify(write?.body)).not.toContain("2.05");
});

test("JSON fields preserve their last valid object, validate logit-bias values, and clear optional keys", async ({
	page,
}) => {
	await openSettings(page);
	await openSection(page);

	const responseFormat = page.getByLabel("Response format (JSON)");
	await responseFormat.fill("{");
	await expect(page.getByRole("alert")).toContainText("Invalid JSON");
	expect((await readProof(page)).draft.response_format).toEqual({
		type: "json_object",
	});
	await responseFormat.fill("[]");
	await expect(page.getByRole("alert")).toContainText("Must be a JSON object");
	await responseFormat.fill(
		JSON.stringify({ type: "json_schema", json_schema: { name: "reply" } })
	);
	await expect(page.getByRole("alert")).toHaveCount(0);

	const logitBias = page.getByLabel("Logit bias (JSON)");
	await logitBias.fill('{"42":"2"}');
	await expect(page.getByRole("alert")).toContainText(
		"Bias values must be numbers from -100 to 100."
	);
	expect((await readProof(page)).draft.logit_bias).toEqual({ "42": -5 });
	await logitBias.fill('{"token":2}');
	await expect(page.getByRole("alert")).toContainText(
		"Token IDs must be non-negative integers."
	);
	await logitBias.fill('{"42":101}');
	await expect(page.getByRole("alert")).toContainText(
		"Bias values must be numbers from -100 to 100."
	);
	await logitBias.fill('{"42":-100,"17":100}');
	await expect(page.getByRole("alert")).toHaveCount(0);

	const extra = page.getByLabel("Extra body fields (JSON)");
	await extra.fill("not-json");
	await expect(page.getByRole("alert")).toContainText("Invalid JSON");
	expect((await readProof(page)).draft.extra).toEqual({ min_keep: 1 });
	await extra.fill("null");
	await expect(page.getByRole("alert")).toContainText("Must be a JSON object");
	await extra.fill('{"min_keep":4,"custom_mode":"fast"}');
	await expect(page.getByRole("alert")).toHaveCount(0);
	await extra.fill("");
	expect((await readProof(page)).draft.extra).toBeUndefined();
	await responseFormat.fill("");
	await logitBias.fill("");
	expect((await readProof(page)).draft).not.toHaveProperty("response_format");
	expect((await readProof(page)).draft).not.toHaveProperty("logit_bias");

	await saveButton(page).click();
	const write = (await readProof(page)).calls.find(
		(call) => call.method === "PUT"
	);
	expect(write?.body).toMatchObject({
		inference: {
			temperature: 0.7,
		},
	});
	const inference = capturedJsonField(write?.body, "inference");
	expect(inference).not.toHaveProperty("extra");
	expect(inference).not.toHaveProperty("response_format");
	expect(inference).not.toHaveProperty("logit_bias");
});

test("remote engines show standard sampling controls and hide local-only samplers", async ({
	page,
}) => {
	await openSettings(page, "?engine=remote");
	await openSection(page);
	for (const label of [
		"Temperature",
		"Top P",
		"Max tokens",
		"Seed",
		"Stop sequences",
		"Frequency penalty",
		"Presence penalty",
		"Prefill",
		"Response format (JSON)",
		"Logit bias (JSON)",
		"Extra body fields (JSON)",
	]) {
		await expect(page.getByLabel(label)).toBeVisible();
	}
	for (const localLabel of [
		"Top K",
		"Min P",
		"Typical P",
		"Top-N sigma",
		"Mode",
		"Tau (target entropy)",
		"Eta (learning rate)",
		"DynaTemp range",
		"XTC probability",
		"DRY multiplier",
		"Sampler order",
		"Grammar (GBNF, llama.cpp)",
	]) {
		await expect(page.getByLabel(localLabel)).toHaveCount(0);
	}
	await expect(
		page.getByText(/Bind this agent to a local engine/u)
	).toBeVisible();

	await page.getByLabel("Temperature").fill("1.2");
	await saveButton(page).click();
	const write = (await readProof(page)).calls.find(
		(call) => call.method === "PUT"
	);
	expect(write?.body).toEqual({
		description:
			"Exercise production sampling controls against a local fixture.",
		engine: "acp:claude",
		inference: {
			frequency_penalty: 0,
			max_tokens: 256,
			prefill: "",
			presence_penalty: 0,
			response_format: { type: "json_object" },
			seed: 7,
			stop: [],
			temperature: 1.2,
			top_p: 0.9,
		},
		model: null,
		name: "Inference test agent",
		system_prompt: "Answer clearly and use the saved sampling defaults.",
		title: "Inference",
		tools: [],
	});
});

test("locked agents cannot edit sampling controls or save", async ({
	page,
}) => {
	await openSettings(page, "?locked=true");
	await openSection(page);
	await expect(page.getByLabel("Temperature")).toBeDisabled();
	await expect(page.getByLabel("Response format (JSON)")).toBeDisabled();
	await expect(page.getByLabel("Extra body fields (JSON)")).toBeDisabled();
	await expect(page.getByRole("combobox", { name: "Mode" })).toBeDisabled();
	await expect(saveButton(page)).toBeDisabled();
	await expect(
		page.getByText("This agent is locked. Unlock it to make changes.")
	).toBeVisible();
	expect((await readProof(page)).calls).toEqual([
		{ body: undefined, method: "GET", path: AGENT_PATH },
	]);
});

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
