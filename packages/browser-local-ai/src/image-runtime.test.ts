import { describe, expect, test } from "bun:test";
import { RawImage } from "@huggingface/transformers";

import {
	normalizeBrowserImageMask,
	normalizeBrowserImagePixels,
} from "./image-runtime.ts";

describe("browser image model outputs", () => {
	test("normalizes byte-range and binary masks", () => {
		const byteMask = new RawImage(new Uint8Array([0, 127, 128, 255]), 2, 2, 1);
		const binaryMask = new RawImage(new Uint8Array([0, 1, 0, 1]), 2, 2, 1);

		expect([...normalizeBrowserImageMask(byteMask)]).toEqual([0, 0, 1, 1]);
		expect([...normalizeBrowserImageMask(binaryMask)]).toEqual([0, 1, 0, 1]);
	});

	test("expands RGB output to opaque RGBA and preserves model alpha", () => {
		const rgb = new RawImage(new Uint8Array([10, 20, 30]), 1, 1, 3);
		const rgba = new RawImage(new Uint8Array([40, 50, 60, 120]), 1, 1, 4);

		expect([...normalizeBrowserImagePixels(rgb).data]).toEqual([
			10, 20, 30, 255,
		]);
		expect([...normalizeBrowserImagePixels(rgba).data]).toEqual([
			40, 50, 60, 120,
		]);
	});

	test("rejects malformed image masks rather than indexing outside the buffer", () => {
		const malformed = new RawImage(new Uint8Array([0]), 2, 1, 1);
		expect(() => normalizeBrowserImageMask(malformed)).toThrow("invalid mask");
	});
});
