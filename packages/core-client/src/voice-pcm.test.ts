import { expect, test } from "bun:test";
import { audioLevel, downsample, floatToPcm16 } from "./voice-pcm.ts";

test("downsample returns the input unchanged when the rate does not drop", () => {
	const input = new Float32Array([0.1, 0.2, 0.3]);
	expect(downsample(input, 16_000, 16_000)).toBe(input);
	expect(downsample(input, 16_000, 48_000)).toBe(input);
});

test("downsample interpolates linearly to the lower rate", () => {
	const input = new Float32Array([0, 1, 2, 3, 4, 5]);
	expect([...downsample(input, 48_000, 16_000)]).toEqual([0, 3]);
	const half = downsample(new Float32Array([0, 1, 0, 1]), 32_000, 16_000);
	expect([...half]).toEqual([0, 0]);
	const fractional = downsample(new Float32Array([0, 1, 2]), 3, 2);
	expect([...fractional]).toEqual([0, 1.5]);
});

test("floatToPcm16 writes clamped little-endian samples", () => {
	const view = new DataView(
		floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]))
	);
	expect(view.byteLength).toBe(12);
	expect(view.getInt16(0, true)).toBe(0);
	expect(view.getInt16(2, true)).toBe(32_767);
	expect(view.getInt16(4, true)).toBe(-32_768);
	expect(view.getInt16(6, true)).toBe(32_767);
	expect(view.getInt16(8, true)).toBe(-32_768);
	expect(view.getInt16(10, true)).toBe(16_383);
});

test("audioLevel scales RMS for the meter and caps it at 1", () => {
	expect(audioLevel(new Float32Array([]))).toBe(0);
	expect(audioLevel(new Float32Array([0, 0]))).toBe(0);
	expect(audioLevel(new Float32Array([0.1, -0.1]))).toBeCloseTo(0.5, 6);
	expect(audioLevel(new Float32Array([0.9, -0.9]))).toBe(1);
});
