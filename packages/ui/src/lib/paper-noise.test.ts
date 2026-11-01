import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { encodePng } from "./og-prism.ts";
import { PAPER_NOISE_PNG_DATA_URI } from "./paper-noise.generated.ts";
import {
	decodePngGreen,
	type PaperNoise,
	paperNoise,
	sampleNoiseGreen,
} from "./paper-noise.ts";

/** The installed package's `noiseSrc`, read straight out of its dist. */
const installedNoiseSrc = (): string => {
	const require = createRequire(import.meta.url);
	const reactEntry = require.resolve("@paper-design/shaders-react");
	const shadersEntry = createRequire(reactEntry).resolve(
		"@paper-design/shaders"
	);
	const source = readFileSync(
		join(dirname(shadersEntry), "get-shader-noise-texture.js"),
		"utf8"
	);
	const match = /const noiseSrc = "([^"]+)"/.exec(source);
	if (!match?.[1]) {
		throw new Error("noiseSrc not found in @paper-design/shaders");
	}
	return match[1];
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = (c & 1) === 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
	}
	return c >>> 0;
});

const chunk = (type: string, data: Buffer): Buffer => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	let c = -1;
	for (const byte of body) {
		c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	}
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE((c ^ -1) >>> 0);
	return Buffer.concat([length, body, crc]);
};

const paeth = (a: number, b: number, c: number): number => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) {
		return a;
	}
	return pb <= pc ? b : c;
};

/** An indexed PNG whose rows cycle through all five filter types. */
const indexedPng = (
	width: number,
	height: number,
	indices: number[],
	palette: number[]
): Buffer => {
	const rows: number[] = [];
	for (let y = 0; y < height; y++) {
		const filter = y % 5;
		rows.push(filter);
		for (let x = 0; x < width; x++) {
			const at = (yy: number, xx: number) =>
				yy < 0 || xx < 0 ? 0 : (indices[yy * width + xx] ?? 0);
			const left = at(y, x - 1);
			const up = at(y - 1, x);
			const predicted = [
				0,
				left,
				up,
				Math.floor((left + up) / 2),
				paeth(left, up, at(y - 1, x - 1)),
			][filter];
			rows.push(((indices[y * width + x] ?? 0) - (predicted ?? 0)) & 0xff);
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 3;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("PLTE", Buffer.from(palette)),
		chunk("IDAT", deflateSync(Buffer.from(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
};

describe("paper noise texture", () => {
	it("is the exact texture the installed shader samples", () => {
		expect(PAPER_NOISE_PNG_DATA_URI).toBe(installedNoiseSrc());
	});

	it("decodes to a full 128x128 green channel", () => {
		const noise = paperNoise();
		expect(noise.width).toBe(128);
		expect(noise.height).toBe(128);
		expect(noise.green).toHaveLength(128 * 128);
		const distinct = new Set(noise.green);
		expect(distinct.size).toBeGreaterThan(64);
	});
});

describe("decodePngGreen", () => {
	it("undoes every PNG row filter on an indexed image", () => {
		const width = 7;
		const height = 10;
		const palette = Array.from({ length: 16 }, (_, i) => [
			i,
			i * 13,
			255 - i,
		]).flat();
		const indices = Array.from(
			{ length: width * height },
			(_, i) => (i * 7 + (i >> 3)) % 16
		);
		const decoded = decodePngGreen(indexedPng(width, height, indices, palette));
		expect(decoded.width).toBe(width);
		expect(Array.from(decoded.green)).toEqual(indices.map((i) => i * 13));
	});

	it("reads the green channel of an RGB image", () => {
		const rgb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		const decoded = decodePngGreen(encodePng(2, 2, rgb));
		expect(Array.from(decoded.green)).toEqual([2, 5, 8, 11]);
	});

	it("refuses shapes it does not decode", () => {
		const gray = encodePng(1, 1, new Uint8Array([0, 0, 0]));
		gray[25] = 0; // colour type: greyscale
		expect(() => decodePngGreen(gray)).toThrow();
	});
});

describe("sampleNoiseGreen", () => {
	const noise: PaperNoise = {
		green: new Uint8Array([0, 255, 51, 102]),
		height: 2,
		width: 2,
	};

	it("returns a texel at its centre", () => {
		expect(sampleNoiseGreen(noise, 0.25, 0.25)).toBeCloseTo(0, 6);
		expect(sampleNoiseGreen(noise, 0.75, 0.25)).toBeCloseTo(1, 6);
		expect(sampleNoiseGreen(noise, 0.25, 0.75)).toBeCloseTo(0.2, 6);
	});

	it("interpolates bilinearly between texel centres", () => {
		expect(sampleNoiseGreen(noise, 0.5, 0.25)).toBeCloseTo(0.5, 6);
		expect(sampleNoiseGreen(noise, 0.5, 0.5)).toBeCloseTo(
			(0 + 1 + 0.2 + 0.4) / 4,
			6
		);
	});

	it("clamps to the edge rather than wrapping", () => {
		expect(sampleNoiseGreen(noise, 0, 0.25)).toBeCloseTo(0, 6);
		expect(sampleNoiseGreen(noise, 0.999, 0.25)).toBeCloseTo(1, 6);
	});
});
