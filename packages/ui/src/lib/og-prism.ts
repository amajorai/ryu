import { deflateSync } from "node:zlib";
import { fnv1a, xorshift32 } from "../components/dither-kit/pixel.ts";
import { PRISM_OG_COLORS } from "./prism-colors.ts";

// The Prism backdrop behind every social card. This server-safe generator lives in the shared UI package so all OG surfaces use the same background.
//
// On the site this look is the `warp` shader (`ShaderBackground`, which wraps
// @paper-design/shaders-react) — a WebGL fragment shader running per frame. A
// social card is a static raster produced by takumi, which has no GL context,
// no canvas, and (per the note in `pass-card.tsx`) no dependable CSS gradient.
// So the shader is re-derived here on the CPU: the same maths as
// `warpFragmentShader`, evaluated once per pixel of a small field, encoded as a
// PNG and handed to takumi as a data URI. `og-card.tsx` stretches that field
// over the whole 1200x630 canvas — takumi resamples it smoothly, and the
// pattern is low-frequency enough that the upscale is invisible.
//
// Two departures from the GL original, both deliberate:
//
//   * `randomG` samples the green channel of a bundled noise texture. Decoding
//     that PNG here would mean shipping a decoder to feed an encoder, for a
//     field whose colours are randomised anyway — so the lattice is hashed with
//     paper's own `hash21` instead. Statistically the same value-noise, a
//     different (but equally arbitrary) grain.
//   * `fwidth`/`smoothstep` antialiasing in the colour loop is dead code at
//     `softness: 1` — the shader's own `mix(stepped, m, u_softness)` discards
//     it — and screen-space derivatives have no meaning off the GPU. Prism runs
//     at full softness, so that branch is simply absent.

/**
 * Prism, as the site's animated gradient defines it: paper's Warp with the
 * checks shape, full softness and a heavy swirl. Everything here is fixed so
 * every default OG card shares one deterministic backdrop.
 *
 * The 0-100 sliders the component exposes are the real uniforms x100
 * (`swirl: 80` is `0.8`, `shapeSize: 10` is `0.1`), so these are the slider
 * defaults already divided back down.
 */
const PRISM = {
	distortion: 0.12,
	proportion: 0.35,
	rotation: 0,
	scale: 1,
	shapeScale: 0.1,
	softness: 1,
	swirl: 0.8,
	swirlIterations: 10,
} as const;

/** The field is upscaled to the full card, so it only needs the broad strokes. */
const FIELD_WIDTH = 300;
const FIELD_HEIGHT = 158;

/** The canvas the field is *addressed* in — the shader's pattern scale is in
 * device pixels, so sampling a 300px grid of a 1200px card is not the same as
 * rendering a 300px card. Sample positions stay in card space. */
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

/**
 * How strongly the field prints on the card.
 *
 * The card uses white type, and the colours below are picked at random — at
 * full strength some rolls would be unreadable. Blending toward white keeps
 * the wash pastel and the backdrop consistent. Baked into the pixel, never
 * expressed as an `opacity` or an `rgba()` fill: `pass-card.tsx` records that
 * takumi honours neither reliably.
 */
const PEAK_ALPHA = 0.4;

/** How far around the wheel a card's four stops are allowed to fan out. */
const HUE_SPREAD_MIN = 70;
const HUE_SPREAD_MAX = 165;
/** The window of shader time a card's frozen frame is drawn from. */
const TIME_RANGE = 2000;
const COLOR_COUNT = 4;
const OG_PRISM_FRAME_TIME = TIME_RANGE / 2;
const OG_PRISM_PEAK_ALPHA = 0.58;

const TWO_PI = Math.PI * 2;
/** The shader's own offset, so frame 0 is not the shader's blank first frame. */
const FIRST_FRAME_OFFSET = 118;
/** Period of the noise lattice — `randomG` folds coordinates through 100. */
const NOISE_PERIOD = 100;

const fract = (value: number): number => value - Math.floor(value);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (value: number): number =>
	value < 0 ? 0 : value > 1 ? 1 : value;

/** `hash21` from paper's shader-utils, standing in for the noise texture. */
const hash21 = (x: number, y: number): number => {
	let px = fract(x * 0.318_309_9) + 0.1;
	let py = fract(y * 0.367_879_4) + 0.1;
	const d = px * (px + 19.19) + py * (py + 19.19);
	px += d;
	py += d;
	return fract(px * py);
};

/** The value-noise lattice, tiled on the same 100-cell period as the texture. */
const randomG = (x: number, y: number): number => {
	const ix = ((Math.floor(x) % NOISE_PERIOD) + NOISE_PERIOD) % NOISE_PERIOD;
	const iy = ((Math.floor(y) % NOISE_PERIOD) + NOISE_PERIOD) % NOISE_PERIOD;
	return hash21(ix, iy);
};

const valueNoise = (x: number, y: number): number => {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const ux = fx * fx * (3 - 2 * fx);
	const uy = fy * fy * (3 - 2 * fy);
	const x1 = mix(randomG(ix, iy), randomG(ix + 1, iy), ux);
	const x2 = mix(randomG(ix, iy + 1), randomG(ix + 1, iy + 1), ux);
	return mix(x1, x2, uy);
};

export interface PrismColor {
	b: number;
	g: number;
	r: number;
}

/** HSL in 0-360 / 0-1 / 0-1 to the 0-1 channels the shader mixes in. */
const hslToRgb = (h: number, s: number, l: number): PrismColor => {
	const hue = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	let rgb: [number, number, number];
	if (hue < 60) {
		rgb = [c, x, 0];
	} else if (hue < 120) {
		rgb = [x, c, 0];
	} else if (hue < 180) {
		rgb = [0, c, x];
	} else if (hue < 240) {
		rgb = [0, x, c];
	} else if (hue < 300) {
		rgb = [x, 0, c];
	} else {
		rgb = [c, 0, x];
	}
	return { r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m };
};

export interface PrismRoll {
	colors: PrismColor[];
	time: number;
}

/**
 * The one thing a card actually chooses: its colours and the moment it froze.
 *
 * Seeded rather than truly random, and that is not a detail. Both OG routes
 * answer `Cache-Control: immutable, max-age=31536000`, so a per-request roll
 * would be frozen by the CDN on whichever one it happened to cache first —
 * "random" in name only, and non-reproducible in dev, in tests and across
 * regions. The shared card passes one fixed brand seed, so every page gets the
 * same gradient and every render gets the same one.
 */
export const prismRoll = (seed: string): PrismRoll => {
	const rand = xorshift32(fnv1a(`prism:${seed}`));
	const baseHue = rand() * 360;
	const spread =
		(HUE_SPREAD_MIN + rand() * (HUE_SPREAD_MAX - HUE_SPREAD_MIN)) *
		(rand() < 0.5 ? -1 : 1);
	const saturation = 0.72 + rand() * 0.24;
	const lightness = 0.5 + rand() * 0.12;
	const time = rand() * TIME_RANGE;

	const colors = Array.from({ length: COLOR_COUNT }, (_, i) =>
		hslToRgb(
			baseHue + (spread * i) / (COLOR_COUNT - 1),
			saturation,
			// A gentle ramp across the stops so the field reads as depth rather
			// than as four flat bands of one tone.
			lightness + (i % 2 === 0 ? -0.06 : 0.06)
		)
	);

	return { colors, time };
};

/** The warp field, one 0-1 scalar per sample, before any colour is applied. */
const sampleWarp = (px: number, py: number, time: number): number => {
	// v_patternUV, with the pattern-sizing defaults the component ships (fit
	// "none", no world size, no offset, origin centred, pixel ratio 1) folded
	// out: the box origin and every offset term vanish, leaving the NDC half-
	// coordinate scaled by the resolution, divided by scale, rotated, and taken
	// down by the shader's fixed x100 precision multiplier.
	const ndcX = (px / CARD_WIDTH) * 2 - 1;
	const ndcY = 1 - (py / CARD_HEIGHT) * 2;
	const rawX = (ndcX * 0.5 * CARD_WIDTH) / PRISM.scale;
	const rawY = (ndcY * 0.5 * CARD_HEIGHT) / PRISM.scale;
	const theta = (PRISM.rotation * Math.PI) / 180;
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);
	const patternX = (cosT * rawX - sinT * rawY) * 0.01;
	const patternY = (sinT * rawX + cosT * rawY) * 0.01;

	let uvX = patternX * 0.5;
	let uvY = patternY * 0.5;

	const t = 0.0625 * (time + FIRST_FRAME_OFFSET);

	const n1 = valueNoise(uvX + t, uvY + t);
	const n2 = valueNoise(uvX * 2 - t, uvY * 2 - t);
	const angle = n1 * TWO_PI;
	uvX += 4 * PRISM.distortion * n2 * Math.cos(angle);
	uvY += 4 * PRISM.distortion * n2 * Math.sin(angle);

	// The shader's loop runs `for (i = 1; i <= 20)` and breaks on
	// `i >= swirlIterations`, so ten iterations means nine passes.
	for (let i = 1; i <= 20; i++) {
		if (i >= PRISM.swirlIterations) {
			break;
		}
		uvX += (PRISM.swirl / i) * Math.cos(t + i * 1.5 * uvY);
		// The `* 1` mirrors the shader's own `iFloat * 1. * uv.x`. Kept so the
		// two lines read as the pair they are — not dead arithmetic to simplify.
		uvY += (PRISM.swirl / i) * Math.cos(t + i * 1 * uvX);
	}

	const checksScale = 0.5 + 3.5 * PRISM.shapeScale;
	const proportion = clamp01(PRISM.proportion);
	const bias = proportion - 0.5;
	return (
		0.5 +
		0.5 * Math.sin(uvX * checksScale) * Math.cos(uvY * checksScale) +
		0.48 * Math.sign(bias) * Math.sqrt(Math.abs(bias))
	);
};

/** The shader's colour ramp: walk the stops, mixing by the shape's position. */
const shadeAt = (sample: number, colors: PrismColor[]): PrismColor => {
	const first = colors[0];
	if (!first) {
		return { r: 1, g: 1, b: 1 };
	}
	const mixer = sample * (colors.length - 1);
	let out = { ...first };
	for (let i = 1; i < colors.length; i++) {
		const c = colors[i];
		if (!c) {
			break;
		}
		const m = clamp01(mixer - (i - 1));
		out = {
			r: mix(out.r, c.r, m),
			g: mix(out.g, c.g, m),
			b: mix(out.b, c.b, m),
		};
	}
	return out;
};

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) === 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

const crc32 = (bytes: Buffer): number => {
	let c = -1;
	for (const byte of bytes) {
		c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	}
	return (c ^ -1) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
};

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_BIT_DEPTH = 8;
const PNG_COLOR_TYPE_RGB = 2;

/**
 * A minimal 8-bit RGB PNG, filter type 0 on every row.
 *
 * Hand-rolled on `node:zlib` rather than pulled from a package: the OG surfaces
 * need exactly one image written exactly one way, and an encoder that is
 * thirty lines of spec is cheaper to own than a dependency in a Docker build
 * that is already fragile about native modules.
 */
const encodePng = (width: number, height: number, rgb: Uint8Array): Buffer => {
	const stride = width * 3;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		raw[rowStart] = 0;
		for (let i = 0; i < stride; i++) {
			raw[rowStart + 1 + i] = rgb[y * stride + i] ?? 0;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = PNG_BIT_DEPTH;
	header[9] = PNG_COLOR_TYPE_RGB;
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
};

/** Composite a 0-1 channel onto white at the requested strength. */
const onWhite = (channel: number, peakAlpha = PEAK_ALPHA): number =>
	Math.round(255 - (255 - clamp01(channel) * 255) * peakAlpha);

/** A sampled social-card field, before its native PNG encoding. */
export interface PrismRaster {
	height: number;
	rgb: Uint8Array;
	width: number;
}

/** The Prism field for one seed, as raw RGB bytes. Exported for tests. */
export const prismField = (seed: string): PrismRaster => {
	const { colors, time } = prismRoll(seed);
	const rgb = new Uint8Array(FIELD_WIDTH * FIELD_HEIGHT * 3);
	for (let y = 0; y < FIELD_HEIGHT; y++) {
		// Sample at the centre of the card-space cell this field pixel covers.
		const py = ((y + 0.5) / FIELD_HEIGHT) * CARD_HEIGHT;
		for (let x = 0; x < FIELD_WIDTH; x++) {
			const px = ((x + 0.5) / FIELD_WIDTH) * CARD_WIDTH;
			const { r, g, b } = shadeAt(sampleWarp(px, py, time), colors);
			const i = (y * FIELD_WIDTH + x) * 3;
			rgb[i] = onWhite(r);
			rgb[i + 1] = onWhite(g);
			rgb[i + 2] = onWhite(b);
		}
	}
	return { height: FIELD_HEIGHT, rgb, width: FIELD_WIDTH };
};

/**
 * The Prism backdrop for a card, as a `data:image/png` URI ready to hand to
 * takumi. Same seed in, byte-identical image out — the immutable cache in front
 * of both OG routes depends on it.
 */
export const prismBackgroundDataUri = (seed: string): string => {
	const { width, height, rgb } = prismField(seed);
	return `data:image/png;base64,${encodePng(width, height, rgb).toString("base64")}`;
};

/** A deterministic Prism frame using the component's white-and-blue palette. */
export const ogPrismField = (): PrismRaster => {
	const colors = PRISM_OG_COLORS.map((hex) => ({
		r: Number.parseInt(hex.slice(1, 3), 16) / 255,
		g: Number.parseInt(hex.slice(3, 5), 16) / 255,
		b: Number.parseInt(hex.slice(5, 7), 16) / 255,
	}));
	const warpSamples = new Float64Array(FIELD_WIDTH * FIELD_HEIGHT);
	let minimum = Number.POSITIVE_INFINITY;
	let maximum = Number.NEGATIVE_INFINITY;
	for (let y = 0; y < FIELD_HEIGHT; y++) {
		for (let x = 0; x < FIELD_WIDTH; x++) {
			const sample = sampleWarp(
				((x + 0.5) / FIELD_WIDTH) * CARD_WIDTH,
				((y + 0.5) / FIELD_HEIGHT) * CARD_HEIGHT,
				OG_PRISM_FRAME_TIME
			);
			warpSamples[y * FIELD_WIDTH + x] = sample;
			minimum = Math.min(minimum, sample);
			maximum = Math.max(maximum, sample);
		}
	}

	const rgb = new Uint8Array(FIELD_WIDTH * FIELD_HEIGHT * 3);
	const range = maximum - minimum || 1;
	for (let i = 0; i < warpSamples.length; i++) {
		// Freeze halfway through the shader's sampling window so the card opens
		// on an already-active frame. Keep the blue recognizable while white
		// replaces the original dark stop.
		const color = shadeAt(
			((warpSamples[i] ?? minimum) - minimum) / range,
			colors
		);
		rgb[i * 3] = onWhite(color.r, OG_PRISM_PEAK_ALPHA);
		rgb[i * 3 + 1] = onWhite(color.g, OG_PRISM_PEAK_ALPHA);
		rgb[i * 3 + 2] = onWhite(color.b, OG_PRISM_PEAK_ALPHA);
	}
	return { height: FIELD_HEIGHT, rgb, width: FIELD_WIDTH };
};

/** The white-and-blue Prism frame as a data URI for the shared social card. */
export const ogPrismBackgroundDataUri = (): string => {
	const { width, height, rgb } = ogPrismField();
	return `data:image/png;base64,${encodePng(width, height, rgb).toString("base64")}`;
};

export { PRISM_OG_COLORS } from "./prism-colors.ts";
