import { fnv1a, hueFill, xorshift32 } from "../components/dither-kit/pixel.ts";
import { encodePng } from "./og-prism.ts";
import {
	type PaperNoise,
	paperNoise,
	sampleNoiseGreen,
} from "./paper-noise.ts";

// The live pass's warp backdrop, rasterized for the social card.
//
// On screen a pass is printed on paper's `warp` shader (`PassCardShell` with
// `backdrop="warp"`): four stops — near-white, the member's hue, near-white, a
// companion hue — swirled by the shader and laid over the white face at 30%.
// The OG renderer has no GL context, so it used to approximate that with CSS
// gradients. The approximation had none of the near-white stops and stacked
// four 30% layers, so a shared link unfurled as a saturated wash in a shape
// the member's own card never has.
//
// This evaluates the shader itself instead: the same uniforms the live card
// passes, the same frame the card opens on (`u_time` 0, which is also the
// frame a reduced-motion viewer keeps), and paper's own noise texture
// (`paper-noise.ts`). Sample positions are in the live card's CSS pixels, so
// the swirl lands in the same place however large the raster draws the card.
//
// The values below mirror the `WARP_*` constants in `pass-card-shell.tsx`.
// They are copied rather than imported because that module is a client
// component (metal-fx, motion) that cannot load inside the rasterizer;
// `og-pass-warp.test.ts` fails if the two drift.

/** The uniforms `PassCardShell`'s `WarpBackdrop` hands paper's `Warp`. */
export const PASS_WARP = {
	distortion: 0.22,
	// The component defaults the live card does not override.
	proportion: 0.45,
	scale: 1.1,
	shapeScale: 0.1,
	softness: 1,
	swirl: 0.75,
	swirlIterations: 10,
} as const;

export const PASS_WARP_HUE_SPREAD = 42;
export const PASS_WARP_BASE_LIGHT = "#f2f2f4";
export const PASS_WARP_OPACITY_LIGHT = 0.3;

/** The live pass face, in CSS pixels (`w-80`, `min-h-[27rem]`). */
export const PASS_FACE_WIDTH_PX = 320;
export const PASS_FACE_HEIGHT_PX = 432;

const TWO_PI = Math.PI * 2;
/** The shader's own offset, so frame 0 is not the shader's blank first frame. */
const FIRST_FRAME_OFFSET = 118;
const NOISE_PERIOD = 100;

const fract = (value: number): number => value - Math.floor(value);
const clamp01 = (value: number): number =>
	value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * The hue `ditherAvatarHue(seed)` returns, re-derived from the same draw order
 * (32 bits, the mirror axis, then the hue) because `avatar.tsx` is a client
 * module. The test pins the two together.
 */
export const passWarpHue = (seed: string): number => {
	const rand = xorshift32(fnv1a(seed));
	for (let i = 0; i < 33; i++) {
		rand();
	}
	return Math.floor(rand() * 180) * 2;
};

const toHex = (channels: readonly number[]): string =>
	`#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** `hueHex` from `pass-card-shell.tsx`. */
export const passWarpHueHex = (hue: number): string => toHex(hueFill(hue));

/** The four stops the live card's warp is coloured with, light scheme. */
export const passWarpStops = (seed: string): string[] => {
	const hue = passWarpHue(seed);
	return [
		PASS_WARP_BASE_LIGHT,
		passWarpHueHex(hue),
		PASS_WARP_BASE_LIGHT,
		passWarpHueHex(hue + PASS_WARP_HUE_SPREAD),
	];
};

interface Rgb {
	b: number;
	g: number;
	r: number;
}

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

const parseHex = (hex: string): Rgb => {
	const match = HEX_COLOR.exec(hex.trim());
	if (!match?.[1]) {
		throw new Error(`og-pass-warp: expected a #rrggbb colour, got ${hex}`);
	}
	const value = Number.parseInt(match[1], 16);
	return {
		r: ((value >> 16) & 0xff) / 255,
		g: ((value >> 8) & 0xff) / 255,
		b: (value & 0xff) / 255,
	};
};

/** `randomG`: the lattice cell, folded through the 100-cell period, sampled. */
const randomG = (noise: PaperNoise, x: number, y: number): number =>
	sampleNoiseGreen(
		noise,
		fract(Math.floor(x) / NOISE_PERIOD + 0.5),
		fract(Math.floor(y) / NOISE_PERIOD + 0.5)
	);

const valueNoise = (noise: PaperNoise, x: number, y: number): number => {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const ux = fx * fx * (3 - 2 * fx);
	const uy = fy * fy * (3 - 2 * fy);
	const a = randomG(noise, ix, iy);
	const b = randomG(noise, ix + 1, iy);
	const c = randomG(noise, ix, iy + 1);
	const d = randomG(noise, ix + 1, iy + 1);
	const x1 = a + (b - a) * ux;
	const x2 = c + (d - c) * ux;
	return x1 + (x2 - x1) * uy;
};

/**
 * The warp's `checks` shape at one point of the face, in the face's CSS pixels
 * (origin top-left). `v_patternUV` with the component's sizing defaults is the
 * centred CSS-pixel position, y up, over the scale, x0.01.
 */
const sampleShape = (
	noise: PaperNoise,
	cssX: number,
	cssY: number,
	faceWidth: number,
	faceHeight: number,
	time: number
): number => {
	let uvX = ((cssX - faceWidth / 2) / PASS_WARP.scale) * 0.01 * 0.5;
	let uvY = ((faceHeight / 2 - cssY) / PASS_WARP.scale) * 0.01 * 0.5;
	const t = 0.0625 * (time + FIRST_FRAME_OFFSET);

	const n1 = valueNoise(noise, uvX + t, uvY + t);
	const n2 = valueNoise(noise, uvX * 2 - t, uvY * 2 - t);
	const angle = n1 * TWO_PI;
	uvX += 4 * PASS_WARP.distortion * n2 * Math.cos(angle);
	uvY += 4 * PASS_WARP.distortion * n2 * Math.sin(angle);

	// `for (i = 1; i <= 20)` breaking on `i >= swirlIterations`: nine passes.
	for (let i = 1; i < PASS_WARP.swirlIterations; i++) {
		uvX += (PASS_WARP.swirl / i) * Math.cos(t + i * 1.5 * uvY);
		uvY += (PASS_WARP.swirl / i) * Math.cos(t + i * uvX);
	}

	const checks = 0.5 + 3.5 * PASS_WARP.shapeScale;
	const bias = clamp01(PASS_WARP.proportion) - 0.5;
	return (
		0.5 +
		0.5 * Math.sin(uvX * checks) * Math.cos(uvY * checks) +
		0.48 * Math.sign(bias) * Math.sqrt(Math.abs(bias))
	);
};

/**
 * The colour ramp at full softness (the smoothstep branch is discarded by
 * `mix(stepped, m, u_softness)` when softness is 1, which the pass uses).
 */
const shade = (shape: number, stops: readonly Rgb[]): Rgb => {
	const first = stops[0] ?? { r: 1, g: 1, b: 1 };
	const mixer = shape * (stops.length - 1);
	let out = first;
	for (let i = 1; i < stops.length; i++) {
		const c = stops[i];
		if (!c) {
			break;
		}
		const m = clamp01(mixer - (i - 1));
		out = {
			r: out.r + (c.r - out.r) * m,
			g: out.g + (c.g - out.g) * m,
			b: out.b + (c.b - out.b) * m,
		};
	}
	return out;
};

export interface PassWarpOptions {
	/** Stop override — `PassCardShell.warpColors`. Defaults to the seeded stops. */
	colors?: readonly string[];
	/** Face size in CSS pixels; defaults to the pass's 320x432. */
	faceHeight?: number;
	faceWidth?: number;
	/** Raster size in pixels. Upscaling is fine: the field is low-frequency. */
	height: number;
	/** The back face's `-scale-x-100`. */
	mirrored?: boolean;
	/** How strongly it prints over the white face — `WARP_OPACITY_LIGHT`. */
	opacity?: number;
	seed: string;
	/** Shader time in seconds; 0 is the frame the live card opens on. */
	time?: number;
	width: number;
}

/** A sampled field, before PNG encoding. Exported for tests. */
export interface PassWarpRaster {
	height: number;
	rgb: Uint8Array;
	width: number;
}

/** The front face's field: the shader evaluated once per raster pixel. */
const renderField = (options: PassWarpOptions): PassWarpRaster => {
	const {
		faceHeight = PASS_FACE_HEIGHT_PX,
		faceWidth = PASS_FACE_WIDTH_PX,
		height,
		opacity = PASS_WARP_OPACITY_LIGHT,
		seed,
		time = 0,
		width,
	} = options;
	const stops = (options.colors ?? passWarpStops(seed)).map(parseHex);
	const noise = paperNoise();
	const alpha = clamp01(opacity);
	const onWhite = (channel: number): number =>
		Math.round(255 * (1 - alpha) + clamp01(channel) * 255 * alpha);

	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		const cssY = ((y + 0.5) / height) * faceHeight;
		for (let x = 0; x < width; x++) {
			const cssX = ((x + 0.5) / width) * faceWidth;
			const color = shade(
				sampleShape(noise, cssX, cssY, faceWidth, faceHeight, time),
				stops
			);
			const i = (y * width + x) * 3;
			rgb[i] = onWhite(color.r);
			rgb[i + 1] = onWhite(color.g);
			rgb[i + 2] = onWhite(color.b);
		}
	}
	return { height, rgb, width };
};

/** Column x of the mirrored face samples CSS `faceWidth - across(x)`, which is
 * exactly the front's column `width - 1 - x`: the back is a flip, not a rerun. */
const mirror = ({ height, rgb, width }: PassWarpRaster): PassWarpRaster => {
	const out = new Uint8Array(rgb.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const from = (y * width + (width - 1 - x)) * 3;
			const to = (y * width + x) * 3;
			out[to] = rgb[from] ?? 0;
			out[to + 1] = rgb[from + 1] ?? 0;
			out[to + 2] = rgb[from + 2] ?? 0;
		}
	}
	return { height, rgb: out, width };
};

/**
 * Recent front fields, keyed by everything but `mirrored`. A card draws the
 * same field twice (front, then the mirrored back), so the second face is a
 * flip of a cached field instead of a second pass of the shader. Small and
 * bounded: it only has to outlive one render.
 */
const FIELD_CACHE_LIMIT = 8;
const fieldCache = new Map<string, PassWarpRaster>();

const frontField = (options: PassWarpOptions): PassWarpRaster => {
	const key = JSON.stringify([
		options.seed,
		options.colors ?? null,
		options.faceWidth ?? PASS_FACE_WIDTH_PX,
		options.faceHeight ?? PASS_FACE_HEIGHT_PX,
		options.width,
		options.height,
		options.opacity ?? PASS_WARP_OPACITY_LIGHT,
		options.time ?? 0,
	]);
	const cached = fieldCache.get(key);
	if (cached) {
		return cached;
	}
	const field = renderField(options);
	fieldCache.set(key, field);
	if (fieldCache.size > FIELD_CACHE_LIMIT) {
		const oldest = fieldCache.keys().next().value;
		if (oldest !== undefined) {
			fieldCache.delete(oldest);
		}
	}
	return field;
};

/**
 * The backdrop as raw RGB, already composited onto the white card face. The
 * unmirrored field may be shared with the cache, so treat it as read-only.
 */
export const passWarpField = (options: PassWarpOptions): PassWarpRaster => {
	const front = frontField(options);
	return options.mirrored ? mirror(front) : front;
};

/**
 * The backdrop as a `data:image/png` URI for the OG renderer. Pure in its options, so
 * the year-long immutable cache in front of the OG routes stays safe.
 */
export const passWarpDataUri = (options: PassWarpOptions): string => {
	const { width, height, rgb } = passWarpField(options);
	return `data:image/png;base64,${encodePng(width, height, rgb).toString("base64")}`;
};
