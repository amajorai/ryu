import { inflateSync } from "node:zlib";
import { PAPER_NOISE_PNG_DATA_URI } from "./paper-noise.generated.ts";

// The noise texture paper's warp shader samples, read on the CPU.
//
// `og-prism.ts` stands a hash in for this texture, which is fine for a backdrop
// whose colours are rolled at random anyway. A pass is different: the raster
// has to be the SAME field the member sees on their live card, swirl for swirl,
// so it has to read the same noise. This decodes the package's own PNG once and
// answers `texture(u_noiseTexture, uv).g` the way the GPU does — bilinear,
// clamped to the edge, which is how `ShaderMount` uploads it.

const PNG_SIGNATURE_BYTES = 8;
const COLOR_TYPE_INDEXED = 3;
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;

/** The green channel of the decoded texture, row-major from the top row. */
export interface PaperNoise {
	green: Uint8Array;
	height: number;
	width: number;
}

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

/** Undo PNG's per-row filters in place; `bpp` is bytes per pixel. */
const unfilter = (
	raw: Buffer,
	width: number,
	height: number,
	bpp: number
): Uint8Array => {
	const stride = width * bpp;
	const out = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] ?? 0;
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		const prev = row - stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[src + x] ?? 0;
			const left = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
			const up = y > 0 ? (out[prev + x] ?? 0) : 0;
			const upLeft = y > 0 && x >= bpp ? (out[prev + x - bpp] ?? 0) : 0;
			let predicted = 0;
			if (filter === 1) {
				predicted = left;
			} else if (filter === 2) {
				predicted = up;
			} else if (filter === 3) {
				predicted = Math.floor((left + up) / 2);
			} else if (filter === 4) {
				predicted = paeth(left, up, upLeft);
			}
			out[row + x] = (value + predicted) & 0xff;
		}
	}
	return out;
};

/**
 * Decode an 8-bit PNG (indexed, RGB or RGBA — the shapes paper has shipped) to
 * its green channel. Not a general decoder: no interlacing, no 16-bit, which is
 * fine for one known asset and is asserted rather than assumed.
 */
export const decodePngGreen = (png: Buffer): PaperNoise => {
	let offset = PNG_SIGNATURE_BYTES;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let palette: Buffer | null = null;
	const idat: Buffer[] = [];
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const bitDepth = data[8];
			colorType = data[9] ?? -1;
			if (bitDepth !== 8 || data[12] !== 0) {
				throw new Error("paper noise: expected a non-interlaced 8-bit PNG");
			}
		} else if (type === "PLTE") {
			palette = data;
		} else if (type === "IDAT") {
			idat.push(data);
		}
		offset += length + 12;
	}

	const bpp =
		colorType === COLOR_TYPE_INDEXED
			? 1
			: colorType === COLOR_TYPE_RGB
				? 3
				: colorType === COLOR_TYPE_RGBA
					? 4
					: 0;
	if (bpp === 0 || width === 0 || height === 0) {
		throw new Error(`paper noise: unsupported PNG colour type ${colorType}`);
	}
	const pixels = unfilter(inflateSync(Buffer.concat(idat)), width, height, bpp);
	const green = new Uint8Array(width * height);
	for (let i = 0; i < green.length; i++) {
		if (colorType === COLOR_TYPE_INDEXED) {
			if (!palette) {
				throw new Error("paper noise: indexed PNG without a palette");
			}
			green[i] = palette[(pixels[i] ?? 0) * 3 + 1] ?? 0;
		} else {
			green[i] = pixels[i * bpp + 1] ?? 0;
		}
	}
	return { green, height, width };
};

let cached: PaperNoise | null = null;

/** The shader's noise texture, decoded once per process. */
export const paperNoise = (): PaperNoise => {
	if (!cached) {
		const base64 = PAPER_NOISE_PNG_DATA_URI.slice(
			PAPER_NOISE_PNG_DATA_URI.indexOf(",") + 1
		);
		cached = decodePngGreen(Buffer.from(base64, "base64"));
	}
	return cached;
};

const texel = (noise: PaperNoise, x: number, y: number): number => {
	const cx = Math.min(noise.width - 1, Math.max(0, x));
	const cy = Math.min(noise.height - 1, Math.max(0, y));
	return (noise.green[cy * noise.width + cx] ?? 0) / 255;
};

/**
 * `texture(u_noiseTexture, uv).g` for `uv` in 0-1: LINEAR filtering between the
 * four nearest texel centres, CLAMP_TO_EDGE at the border.
 */
export const sampleNoiseGreen = (
	noise: PaperNoise,
	u: number,
	v: number
): number => {
	const x = u * noise.width - 0.5;
	const y = v * noise.height - 0.5;
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const top = texel(noise, x0, y0) * (1 - fx) + texel(noise, x0 + 1, y0) * fx;
	const bottom =
		texel(noise, x0, y0 + 1) * (1 - fx) + texel(noise, x0 + 1, y0 + 1) * fx;
	return top * (1 - fy) + bottom * fy;
};
