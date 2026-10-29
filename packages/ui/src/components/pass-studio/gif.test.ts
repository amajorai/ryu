/// <reference path="../../types/gifenc.d.ts" />
import { describe, expect, test } from "bun:test";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { PASS_FORMATS } from "./formats.ts";
import { GIF_FPS, GIF_SHORT_EDGE, gifSize } from "./gif.ts";

describe("gifSize", () => {
	test("pins every share format's short edge and keeps its ratio", () => {
		for (const format of PASS_FORMATS) {
			const size = gifSize(format.width, format.height);
			expect(Math.min(size.width, size.height)).toBe(GIF_SHORT_EDGE);
			expect(size.width / size.height).toBeCloseTo(
				format.width / format.height,
				2
			);
		}
	});

	test("never upscales a frame smaller than the target", () => {
		expect(gifSize(200, 300)).toEqual({ height: 300, width: 200 });
	});
});

test("the frame delay is a whole number of GIF centiseconds", () => {
	expect((100 / GIF_FPS) % 1).toBe(0);
});

test("the encoder pipeline writes a looping GIF89a", () => {
	const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(200);
	const palette = quantize(rgba, 256);
	const encoder = GIFEncoder();
	encoder.writeFrame(applyPalette(rgba, palette), 4, 4, {
		delay: 50,
		palette,
		repeat: 0,
	});
	encoder.finish();
	const bytes = encoder.bytes();
	expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
	expect(new TextDecoder().decode(bytes)).toContain("NETSCAPE2.0");
});
