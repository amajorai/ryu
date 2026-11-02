import { expect, type Page } from "@playwright/test";
import type { LaunchConfig } from "../src/lib/api/inference.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for model-launch-config-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/model-launch-config-settings-proof.html";
export const MODEL_ALPHA = "owner/model-a-q4";
export const MODEL_BETA = "team/model-b-q5";
export const alphaPath = "/api/models/owner%2Fmodel-a-q4/launch-config";
export const betaPath = "/api/models/team%2Fmodel-b-q5/launch-config";
export const evidenceDir = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

export interface LaunchSnapshot {
	calls: RequestRecord[];
	configs: Record<string, LaunchConfig>;
	preferences: Record<string, string>;
}

export interface ProofWindow extends Window {
	__modelLaunchConfigProof: {
		armFailure: (failure: {
			message: string;
			method: string;
			path: string;
			status: number;
		}) => void;
		calls: () => RequestRecord[];
		holdNextRead: () => void;
		releasePendingRead: () => void;
		refresh: (modelId: string) => Promise<void>;
		snapshot: () => LaunchSnapshot;
	};
}

export const completeLaunchConfig: LaunchConfig = {
	batch_size: 1024,
	cache_reuse: 512,
	cache_type_k: "q8_0",
	cache_type_v: "f16",
	chat_template_file: "/models/chat.jinja",
	cont_batching: false,
	cpu_moe: true,
	ctx_size: 12_288,
	draft_max: 8,
	draft_min: 2,
	draft_model: "/models/draft.gguf",
	dtype: "bfloat16",
	extra_args: ["--spec-type", "ngram-cache", "--priority", "1"],
	flash_attn: "on",
	gpu_layers: -1,
	gpu_memory_utilization: 0.95,
	jinja: true,
	kv_cache_dtype: "fp8",
	kv_unified: true,
	mem_fraction_static: 0.85,
	mlock: true,
	n_cpu_moe: 8,
	no_mmap: true,
	override_tensor: ".ffn_.*_exps.=CPU",
	parallel: 6,
	quantization: "awq",
	spec_type: "ngram-cache",
	speculative_algorithm: "eagle",
	tensor_parallel: 4,
	threads: 16,
	ubatch_size: 256,
};

export async function openSettings(page: Page) {
	await page.goto(STORY_URL);
	await expect(
		page.getByRole("button", {
			name: /Engine \/ Hardware|Engine launch settings/u,
		})
	).toBeVisible();
}

export async function openSection(page: Page) {
	const toggle = page.getByRole("button", {
		name: /Engine \/ Hardware|Engine launch settings/u,
	});
	await toggle.focus();
	await toggle.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

export async function proofSnapshot(page: Page): Promise<LaunchSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: model-launch-config-settings-proof.tsx installs __modelLaunchConfigProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__modelLaunchConfigProof.snapshot()
	);
}

export async function proofCalls(page: Page): Promise<RequestRecord[]> {
	return await page.evaluate(() =>
		/* SAFETY: model-launch-config-settings-proof.tsx installs __modelLaunchConfigProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__modelLaunchConfigProof.calls()
	);
}

export async function armFailure(
	page: Page,
	method: string,
	path: string,
	message: string,
	status: number
) {
	await page.evaluate(
		({ failureMessage, failureMethod, failurePath, failureStatus }) => {
			/* SAFETY: model-launch-config-settings-proof.tsx installs __modelLaunchConfigProof before this proof page is evaluated. */ (
				window as ProofWindow
			).__modelLaunchConfigProof.armFailure({
				message: failureMessage,
				method: failureMethod,
				path: failurePath,
				status: failureStatus,
			});
		},
		{
			failureMessage: message,
			failureMethod: method,
			failurePath: path,
			failureStatus: status,
		}
	);
}

export async function holdNextRead(page: Page) {
	await page.evaluate(() => {
		/* SAFETY: model-launch-config-settings-proof.tsx installs __modelLaunchConfigProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__modelLaunchConfigProof.holdNextRead();
	});
}

export async function releaseRead(page: Page) {
	await page.evaluate(() => {
		/* SAFETY: model-launch-config-settings-proof.tsx installs __modelLaunchConfigProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__modelLaunchConfigProof.releasePendingRead();
	});
}

export async function refreshModelConfig(page: Page, modelId: string) {
	await page.evaluate(async (targetModelId) => {
		await /* SAFETY: model-launch-config-settings-proof.tsx installs __modelLaunchConfigProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__modelLaunchConfigProof.refresh(targetModelId);
	}, modelId);
}

export function saveButton(page: Page) {
	return page.getByRole("button", {
		name: "Save model launch settings",
		exact: true,
	});
}

export function engineSaveButton(page: Page) {
	return page.getByRole("button", {
		name: "Save engine launch settings",
		exact: true,
	});
}

export async function selectProfile(page: Page, profile: string) {
	await page.getByLabel("Model profile fixture").selectOption(profile);
}

export async function clipboardText(page: Page): Promise<string> {
	return await page.evaluate(() => navigator.clipboard.readText());
}

export function readAlphaConfig(): LaunchConfig {
	return {
		batch_size: 256,
		cache_reuse: 256,
		cache_type_k: "q8_0",
		cache_type_v: "f16",
		chat_template_file: "",
		cont_batching: true,
		cpu_moe: false,
		ctx_size: 8192,
		draft_max: 4,
		draft_min: 2,
		dtype: "float16",
		extra_args: ["--threads", "8"],
		flash_attn: "auto",
		gpu_layers: -1,
		gpu_memory_utilization: 0.8,
		jinja: false,
		kv_cache_dtype: "fp8",
		kv_unified: false,
		mem_fraction_static: 0.75,
		mlock: false,
		n_cpu_moe: 0,
		no_mmap: false,
		override_tensor: "",
		parallel: 4,
		quantization: "q4_k_m",
		spec_type: "ngram-simple",
		speculative_algorithm: "ngram",
		tensor_parallel: 2,
		threads: 8,
		ubatch_size: 128,
	};
}

declare global {
	interface Window {
		__modelLaunchConfigProof: {
			armFailure: (failure: {
				message: string;
				method: string;
				path: string;
				status: number;
			}) => void;
			calls: () => RequestRecord[];
			holdNextRead: () => void;
			releasePendingRead: () => void;
			refresh: (modelId: string) => Promise<void>;
			snapshot: () => LaunchSnapshot;
		};
	}
}
