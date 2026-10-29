import { describe, expect, test } from "bun:test";

import {
	browserModelCapabilities,
	browserModelCatalog,
	CURATED_BROWSER_IMAGE_MODELS,
	CURATED_BROWSER_MODELS,
	createBrowserModelDefinition,
	DEFAULT_BROWSER_IMAGE_MODELS,
	DEFAULT_BROWSER_MODEL_ID,
	isValidBrowserModelId,
} from "./catalog.ts";

describe("browser model catalog", () => {
	test("keeps a safe curated default", () => {
		expect(DEFAULT_BROWSER_MODEL_ID).toBe(
			"onnx-community/SmolLM2-135M-Instruct-ONNX-MHA"
		);
		expect(
			CURATED_BROWSER_MODELS.every((model) => model.task === "text-generation")
		).toBe(true);
	});

	test("keeps separate defaults for browser image-processing tasks", () => {
		expect(DEFAULT_BROWSER_IMAGE_MODELS).toEqual({
			"background-removal": "Xenova/modnet",
			"image-segmentation": "Xenova/detr-resnet-50-panoptic",
		});
		for (const task of ["image-segmentation", "background-removal"] as const) {
			const model = CURATED_BROWSER_IMAGE_MODELS[task][0];
			expect(model?.task).toBe(task);
			expect(model?.id === DEFAULT_BROWSER_IMAGE_MODELS[task]).toBe(true);
		}
	});

	test("rejects URLs and traversal-looking model ids", () => {
		for (const modelId of [
			"https://huggingface.co/acme/model",
			"../secret/model",
			"acme/model/revision",
			"acme model",
		]) {
			expect(isValidBrowserModelId(modelId)).toBe(false);
		}
		expect(isValidBrowserModelId("acme/model-name_q4")).toBe(true);
	});

	test("does not grant actions to unreviewed custom models", () => {
		expect(browserModelCapabilities("acme/model").actionSupport).toBe(false);
		expect(browserModelCapabilities("acme/qwen-model").actionSupport).toBe(
			true
		);
		expect(createBrowserModelDefinition("acme/model").curated).toBe(false);
	});

	test("merges runtime status into the curated catalog", () => {
		const catalog = browserModelCatalog(
			new Map([
				[
					DEFAULT_BROWSER_MODEL_ID,
					{ status: "preparing", statusMessage: "Downloading" },
				],
			])
		);
		expect(catalog[0]).toMatchObject({
			id: DEFAULT_BROWSER_MODEL_ID,
			status: "preparing",
			statusMessage: "Downloading",
		});
	});
});
