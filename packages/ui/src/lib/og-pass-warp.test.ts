import { describe, expect, it } from "bun:test";
import { ditherAvatarHue } from "../components/dither-kit/avatar.tsx";
import {
	hueHex,
	WARP_BASE_LIGHT,
	WARP_DISTORTION,
	WARP_HUE_SPREAD,
	WARP_OPACITY_LIGHT,
	WARP_SCALE,
	WARP_SOFTNESS,
	WARP_SWIRL,
} from "../components/pass-card-shell.tsx";
import {
	CARD_HEIGHT_PX,
	CARD_WIDTH_PX,
} from "../components/pass-studio/paint.ts";
import {
	PASS_FACE_HEIGHT_PX,
	PASS_FACE_WIDTH_PX,
	PASS_WARP,
	PASS_WARP_BASE_LIGHT,
	PASS_WARP_HUE_SPREAD,
	PASS_WARP_OPACITY_LIGHT,
	passWarpDataUri,
	passWarpField,
	passWarpHue,
	passWarpStops,
} from "./og-pass-warp.ts";

const SEEDS = ["jay", "Jay Doe", "ryu", "Member", "alice", "a".repeat(64), ""];

/**
 * Ground truth: pixels read back from paper's real `Warp` shader, rendered by
 * Chromium's WebGL2 (SwiftShader) at 320x432 CSS px, frame 0, with the live
 * pass's uniforms and `passWarpStops(seed)` — [x, y, r, g, b], uncomposited.
 * If the CPU port drifts from the GPU (sampling, noise, swirl, ramp), these
 * stop matching.
 */
const GPU_SAMPLES: Record<string, [number, number, number, number, number][]> =
	{
		jay: [
			[20, 20, 72, 239, 212],
			[160, 216, 73, 239, 212],
			[300, 60, 92, 239, 215],
			[60, 400, 134, 240, 223],
			[240, 330, 204, 241, 237],
			[100, 150, 81, 239, 214],
		],
		"Jay Doe": [
			[20, 20, 239, 72, 189],
			[160, 216, 239, 73, 189],
			[300, 60, 239, 92, 195],
			[60, 400, 240, 134, 209],
			[240, 330, 241, 204, 232],
			[100, 150, 239, 81, 192],
		],
		ryu: [
			[20, 20, 77, 72, 239],
			[160, 216, 79, 73, 239],
			[300, 60, 96, 92, 240],
			[60, 400, 137, 134, 241],
			[240, 330, 206, 204, 243],
			[100, 150, 86, 81, 240],
		],
	};

/** The GPU dithers its output a little (`colorBandingFix`) and runs mediump. */
const GPU_TOLERANCE = 4;

const pixel = (
	field: { rgb: Uint8Array; width: number },
	x: number,
	y: number
): number[] => {
	const i = (y * field.width + x) * 3;
	return [field.rgb[i] ?? -1, field.rgb[i + 1] ?? -1, field.rgb[i + 2] ?? -1];
};

describe("pass warp constants", () => {
	it("mirror the live card's shader uniforms and palette", () => {
		expect(PASS_WARP.distortion).toBe(WARP_DISTORTION);
		expect(PASS_WARP.scale).toBe(WARP_SCALE);
		expect(PASS_WARP.softness).toBe(WARP_SOFTNESS);
		expect(PASS_WARP.swirl).toBe(WARP_SWIRL);
		expect(PASS_WARP_HUE_SPREAD).toBe(WARP_HUE_SPREAD);
		expect(PASS_WARP_BASE_LIGHT).toBe(WARP_BASE_LIGHT);
		expect(PASS_WARP_OPACITY_LIGHT).toBe(WARP_OPACITY_LIGHT);
	});

	it("samples the face the pass studio renders the shader at", () => {
		expect(PASS_FACE_WIDTH_PX).toBe(CARD_WIDTH_PX);
		expect(PASS_FACE_HEIGHT_PX).toBe(CARD_HEIGHT_PX);
	});

	it("derives the same hue and stops as the live card for any seed", () => {
		for (const seed of SEEDS) {
			const hue = ditherAvatarHue(seed);
			expect(passWarpHue(seed)).toBe(hue);
			expect(passWarpStops(seed)).toEqual([
				WARP_BASE_LIGHT,
				hueHex(hue),
				WARP_BASE_LIGHT,
				hueHex(hue + WARP_HUE_SPREAD),
			]);
		}
	});
});

describe("passWarpField", () => {
	it("reproduces the GPU shader's pixels at the live card's size", () => {
		for (const [seed, samples] of Object.entries(GPU_SAMPLES)) {
			const field = passWarpField({
				height: PASS_FACE_HEIGHT_PX,
				opacity: 1,
				seed,
				width: PASS_FACE_WIDTH_PX,
			});
			for (const [x, y, ...gpu] of samples) {
				const cpu = pixel(field, x, y);
				for (let channel = 0; channel < 3; channel++) {
					expect(
						Math.abs((cpu[channel] ?? 0) - (gpu[channel] ?? 0))
					).toBeLessThanOrEqual(GPU_TOLERANCE);
				}
			}
		}
	});

	it("composites onto the white face at the live opacity", () => {
		const raw = passWarpField({
			height: 54,
			opacity: 1,
			seed: "jay",
			width: 40,
		});
		const face = passWarpField({ height: 54, seed: "jay", width: 40 });
		for (let i = 0; i < raw.rgb.length; i++) {
			const expected = Math.round(
				255 * (1 - WARP_OPACITY_LIGHT) + (raw.rgb[i] ?? 0) * WARP_OPACITY_LIGHT
			);
			expect(Math.abs((face.rgb[i] ?? 0) - expected)).toBeLessThanOrEqual(1);
		}
	});

	it("keeps the near-white base stops, so the face is not one wash", () => {
		// The regression this replaced: CSS blooms with no `#f2f2f4` stop tinted
		// every pixel of the face. The shader leaves broad near-white bands.
		const { rgb } = passWarpField({ height: 108, seed: "jay", width: 80 });
		let nearWhite = 0;
		for (let i = 0; i < rgb.length; i += 3) {
			if (Math.min(rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0) >= 240) {
				nearWhite++;
			}
		}
		expect(nearWhite / (rgb.length / 3)).toBeGreaterThan(0.15);
	});

	it("mirrors the back face as the front's reflection", () => {
		const front = passWarpField({ height: 30, seed: "ryu", width: 24 });
		const back = passWarpField({
			height: 30,
			mirrored: true,
			seed: "ryu",
			width: 24,
		});
		for (let y = 0; y < 30; y++) {
			for (let x = 0; x < 24; x++) {
				expect(pixel(back, x, y)).toEqual(pixel(front, 23 - x, y));
			}
		}
	});

	it("samples in live-card space, whatever size the raster is", () => {
		const small = passWarpField({
			height: 216,
			opacity: 1,
			seed: "jay",
			width: 160,
		});
		const full = passWarpField({
			height: 432,
			opacity: 1,
			seed: "jay",
			width: 320,
		});
		// Field pixel (80, 108) of the half-size raster is centred on CSS
		// (160.5, 216.5); compare against a GPU sample taken at (160, 216).
		const gpu = GPU_SAMPLES.jay?.[1]?.slice(2) ?? [];
		const half = pixel(small, 80, 108);
		for (let channel = 0; channel < 3; channel++) {
			expect(
				Math.abs((half[channel] ?? 0) - (gpu[channel] ?? 0))
			).toBeLessThanOrEqual(GPU_TOLERANCE + 2);
		}
		expect(full.width).toBe(320);
	});

	it("honours a stop override, and rejects a non-hex stop", () => {
		const flat = passWarpField({
			colors: ["#ff0000", "#ff0000"],
			height: 4,
			opacity: 1,
			seed: "jay",
			width: 4,
		});
		expect(pixel(flat, 2, 2)).toEqual([255, 0, 0]);
		expect(() =>
			passWarpField({ colors: ["red"], height: 1, seed: "jay", width: 1 })
		).toThrow();
	});
});

describe("passWarpDataUri", () => {
	it("is a PNG data URI that is byte-identical for the same options", () => {
		const options = { height: 40, seed: "jay", width: 30 };
		const uri = passWarpDataUri(options);
		expect(uri.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
		expect(passWarpDataUri(options)).toBe(uri);
		expect(passWarpDataUri({ ...options, seed: "alice" })).not.toBe(uri);
	});
});
