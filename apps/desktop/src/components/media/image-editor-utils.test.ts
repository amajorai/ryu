import { describe, expect, test } from "bun:test";

import {
	imageDimensionError,
	isEditableImageType,
	normalizedImagePoint,
} from "./image-editor-utils.ts";

describe("image editor input bounds", () => {
	test("allows supported raster image types and rejects SVG", () => {
		expect(isEditableImageType("image/png")).toBe(true);
		expect(isEditableImageType("image/jpeg")).toBe(true);
		expect(isEditableImageType("image/svg+xml")).toBe(false);
		expect(isEditableImageType("application/octet-stream")).toBe(false);
	});

	test("rejects invalid and excessive image dimensions", () => {
		expect(imageDimensionError(0, 10)).toContain("positive whole numbers");
		expect(imageDimensionError(16_001, 1)).toContain("per side");
		expect(imageDimensionError(8000, 8000)).toContain("too large");
		expect(imageDimensionError(4000, 3000)).toBeNull();
	});

	test("maps pointer coordinates to normalized image coordinates", () => {
		expect(
			normalizedImagePoint(150, 80, {
				left: 50,
				top: 30,
				width: 200,
				height: 100,
			})
		).toEqual({ x: 0.5, y: 0.5 });
		expect(
			normalizedImagePoint(500, 200, {
				left: 50,
				top: 30,
				width: 200,
				height: 100,
			})
		).toEqual({ x: 1, y: 1 });
	});
});
