import { expect, type Page } from "@playwright/test";
import type { SamplingConfig } from "../src/lib/api/inference.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for advanced-inference-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/advanced-inference-settings-proof.html";
export const AGENT_PATH = "/api/agents/advanced-inference-proof";
export const evidenceDir = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface ProofRequest {
	body: unknown;
	method: string;
	path: string;
}

export interface ProofAgent {
	inference: SamplingConfig;
	locked: boolean;
}

export interface ProofSnapshot {
	agent: ProofAgent;
	calls: ProofRequest[];
	draft: SamplingConfig;
	preferences: Record<string, string>;
}

export interface ProofWindow extends Window {
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

export const savedLocalInference: SamplingConfig = {
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

export const completeLocalInference: SamplingConfig = {
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

export async function openSettings(page: Page, query = "") {
	await page.goto(`${STORY_URL}${query}`);
	await expect(
		page.getByRole("button", { name: "Advanced inference", exact: true })
	).toBeVisible();
}

export async function openSection(page: Page) {
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

export async function readProof(page: Page): Promise<ProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: advanced-inference-settings-proof.tsx installs __advancedInferenceProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__advancedInferenceProof.snapshot()
	);
}

export async function failNextSave(page: Page) {
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

export function saveButton(page: Page) {
	return page.getByRole("button", { name: "Save", exact: true });
}

export function enginePreferencePath(engineId: string) {
	return `/api/preferences/inference.engine.${engineId}`;
}

export function enginePreferenceWrites(
	snapshot: ProofSnapshot,
	engineId: string
) {
	return snapshot.calls.filter(
		(call) =>
			call.method === "PUT" && call.path === enginePreferencePath(engineId)
	);
}

export async function expandEngineSamplingDefaults(page: Page) {
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

export async function openEngineSettings(page: Page, engineId: string) {
	await page.goto(`${STORY_URL}?scope=engine&engine=${engineId}`);
	await expect(page.getByTestId("save-status")).toHaveText(
		"Loaded engine sampling defaults"
	);
	await expandEngineSamplingDefaults(page);
}

export async function failNextEngineSamplingSave(page: Page, engineId: string) {
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
