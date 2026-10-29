import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
	DEFAULT_IMAGE_EDITOR_MODELS,
	getImageEditorModelPreferences,
	parseImageEditorModelPreferences,
	saveImageEditorModelPreferences,
} from "./image-editor-models.ts";

const STORAGE_KEY = "ryu_image_editor_models_v1";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

afterEach(() => {
	localStorage.removeItem(STORAGE_KEY);
});

describe("image editor model preferences", () => {
	test("uses separate local defaults and recovers malformed values", () => {
		expect(getImageEditorModelPreferences()).toEqual(
			DEFAULT_IMAGE_EDITOR_MODELS
		);
		expect(
			parseImageEditorModelPreferences({
				backgroundRemovalModelId: "https://example.com/model",
				segmentationModelId: "acme/valid-segmenter",
			})
		).toEqual({
			backgroundRemovalModelId:
				DEFAULT_IMAGE_EDITOR_MODELS.backgroundRemovalModelId,
			segmentationModelId: "acme/valid-segmenter",
		});
		expect(parseImageEditorModelPreferences("bad json shape")).toEqual(
			DEFAULT_IMAGE_EDITOR_MODELS
		);
	});

	test("persists independently swappable task models", () => {
		const preferences = {
			backgroundRemovalModelId: "studio/remover",
			segmentationModelId: "studio/segmenter",
		};
		expect(saveImageEditorModelPreferences(preferences)).toBe(true);
		expect(getImageEditorModelPreferences()).toEqual(preferences);
	});

	test("refuses URL and path values for model identifiers", () => {
		expect(
			saveImageEditorModelPreferences({
				backgroundRemovalModelId: "acme/remover",
				segmentationModelId: "../outside/model",
			})
		).toBe(false);
		expect(getImageEditorModelPreferences()).toEqual(
			DEFAULT_IMAGE_EDITOR_MODELS
		);
	});
});
