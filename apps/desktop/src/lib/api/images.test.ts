import { describe, expect, test } from "bun:test";

import {
	buildImageResizePrompt,
	DEFAULT_IMAGE_RESIZE_ENGINE,
	imageResizeAspectLabel,
	imageResizeDimensions,
	imageResizeDimensionsForEngine,
	imageResizeSizeHint,
	localImageResizeDimensions,
	resolveImageResizeRoute,
} from "./image-resize.ts";

describe("AI image resize", () => {
	test("defaults to the swappable local image model", () => {
		expect(DEFAULT_IMAGE_RESIZE_ENGINE).toBe("local");
	});

	test("uses the selected canvas ratio for the model size hint", () => {
		expect(imageResizeSizeHint("square", 640, 480)).toBe("1536x1536");
		expect(imageResizeSizeHint("landscape", 640, 480)).toBe("1536x1024");
		expect(imageResizeSizeHint("portrait", 640, 480)).toBe("1024x1536");
		expect(imageResizeSizeHint("widescreen", 640, 480)).toBe("1536x864");
		expect(imageResizeSizeHint("story", 640, 480)).toBe("864x1536");
		expect(imageResizeSizeHint("original", 640, 480)).toBe("1536x1152");
		expect(imageResizeDimensions("widescreen", 640, 480)).toEqual({
			height: 864,
			width: 1536,
		});
	});

	test("keeps arbitrary original ratios aligned to local diffusion dimensions", () => {
		const dimensions = imageResizeDimensions("original", 1000, 5000);
		expect(dimensions).toEqual({ height: 1536, width: 304 });
		expect(dimensions.width % 8).toBe(0);
		expect(dimensions.height % 8).toBe(0);
	});

	test("selects SDXL canvas sizes that preserve the chosen ratio without engine padding", () => {
		expect(localImageResizeDimensions("widescreen", 640, 480)).toEqual({
			height: 832,
			width: 1472,
		});
		expect(localImageResizeDimensions("widescreen", 640, 480, 1024)).toEqual({
			height: 576,
			width: 1024,
		});
	});

	test("shows aspect labels and target resolutions for the selected engine", () => {
		expect(imageResizeAspectLabel("original", 640, 480)).toBe("4:3");
		expect(imageResizeAspectLabel("widescreen", 640, 480)).toBe("16:9");
		expect(
			imageResizeDimensionsForEngine("local", "widescreen", 640, 480)
		).toEqual({ height: 832, width: 1472 });
		expect(
			imageResizeDimensionsForEngine("gateway", "widescreen", 640, 480)
		).toEqual({ height: 864, width: 1536 });
	});

	test("builds an outpainting prompt with optional user guidance", () => {
		const prompt = buildImageResizePrompt(
			"widescreen",
			640,
			480,
			"  continue the sunset  "
		);

		expect(prompt).toContain("Generatively expand");
		expect(prompt).toContain("widescreen");
		expect(prompt).toContain("Additional guidance: continue the sunset");
		expect(prompt).toContain("Do not crop or stretch the source");
	});

	test("uses only a configured cloud image provider and trims its model id", () => {
		expect(
			resolveImageResizeRoute({
				model: " google/gemini-image ",
				provider: " OpenRouter ",
			})
		).toEqual({ model: "google/gemini-image", provider: "openrouter" });
		expect(resolveImageResizeRoute({ provider: "fal" })).toEqual({
			provider: "fal",
		});
	});

	test("rejects missing or unsupported image routes", () => {
		expect(() => resolveImageResizeRoute(undefined)).toThrow(
			"AI Resize needs an image provider"
		);
		expect(() => resolveImageResizeRoute({ provider: "openai" })).toThrow(
			"AI Resize supports the OpenRouter, Replicate, or fal"
		);
		expect(() =>
			resolveImageResizeRoute({ provider: "replicate", model: 17 })
		).toThrow("The configured image model id is invalid");
	});

	test("rejects invalid source dimensions", () => {
		expect(() => imageResizeSizeHint("square", 0, 480)).toThrow(
			"AI Resize needs valid source image dimensions"
		);
	});
});
