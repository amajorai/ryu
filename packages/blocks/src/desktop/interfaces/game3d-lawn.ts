import { type Scene3dTheme, sunDirection } from "./game3d-palette.ts";
import { linearRgb } from "./game3d-toon.ts";

/**
 * The lawn's color, shared by the ground mesh and the grass blades so a
 * blade's root is exactly the ground it grows from: two greens blended by a
 * low-frequency world-space noise (soft patches a few tiles across), and
 * the light that falls on flat ground, so unlit blades can match the
 * cel-lit terrain under them. Plain math, no three.js.
 */

export type Rgb = readonly [number, number, number];

/** The night fill light (see `SceneLights`): from the camera side. */
export const FILL_INTENSITY = 0.75;
export const FILL_DIRECTION: readonly [number, number, number] = [4, 6, 12];

function fade(t: number): number {
	return t * t * (3 - 2 * t);
}

/** Hash of an integer lattice point to 0..1. */
function lattice(x: number, z: number): number {
	const value = Math.sin(x * 127.1 + z * 311.7) * 43_758.5453;
	return value - Math.floor(value);
}

/** Smooth value noise in 0..1, one feature about every `period` tiles. */
export function lawnNoise(x: number, z: number, period = 5.5): number {
	const px = x / period;
	const pz = z / period;
	const ix = Math.floor(px);
	const iz = Math.floor(pz);
	const fx = fade(px - ix);
	const fz = fade(pz - iz);
	const top = lattice(ix, iz) + (lattice(ix + 1, iz) - lattice(ix, iz)) * fx;
	const bottom =
		lattice(ix, iz + 1) + (lattice(ix + 1, iz + 1) - lattice(ix, iz + 1)) * fx;
	// A second, finer octave breaks up the blobs.
	const fine = lattice(Math.floor(px * 2.7), Math.floor(pz * 2.7));
	return Math.min(
		1,
		Math.max(0, (top + (bottom - top) * fz) * 0.85 + fine * 0.15)
	);
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
	];
}

/** Linear-light albedo of the lawn at world (x, z), or `null` indoors. */
export function lawnAlbedo(
	theme: Scene3dTheme,
	x: number,
	z: number
): Rgb | null {
	if (!theme.lawn) {
		return null;
	}
	const [light, deep] = theme.lawn;
	const t = Math.min(1, Math.max(0, (lawnNoise(x, z) - 0.28) / 0.44));
	return mixRgb(linearRgb(light), linearRgb(deep), fade(t));
}

/** The cel ramp's value for light arriving `d` (cosine) above the surface. */
function ramp(d: number): number {
	return (d > 0.03 ? 0.7 : 0) + (d > 0.42 ? 0.3 : 0);
}

const TO_DIFFUSE = 1 / Math.PI;

/**
 * Light a flat, upward-facing cel-shaded surface receives under `theme`
 * (sun or moon, the night fill, the sky and the ambient term with the
 * theme's cool shade tint), in or out of a cast shadow: what the toon
 * material multiplies the ground's albedo by.
 */
export function groundLight(theme: Scene3dTheme, shaded: boolean): Rgb {
	const tint = linearRgb(theme.shadeTint);
	const sky = linearRgb(theme.hemiSky);
	const light: [number, number, number] = [0, 0, 0];
	for (let channel = 0; channel < 3; channel++) {
		const indirect =
			((sky[channel] ?? 0) * theme.hemiIntensity + theme.ambient) *
			TO_DIFFUSE *
			(tint[channel] ?? 1);
		light[channel] = indirect;
	}
	const addDirect = (
		color: string,
		intensity: number,
		direction: readonly [number, number, number]
	) => {
		const length = Math.hypot(...direction) || 1;
		const amount = ramp(direction[1] / length) * intensity * TO_DIFFUSE;
		const rgb = linearRgb(color);
		for (let channel = 0; channel < 3; channel++) {
			light[channel] = (light[channel] ?? 0) + (rgb[channel] ?? 0) * amount;
		}
	};
	if (!shaded) {
		addDirect(theme.sunColor, theme.sunIntensity, sunDirection(theme));
	}
	if (theme.fillLight) {
		addDirect(theme.fillLight, FILL_INTENSITY, FILL_DIRECTION);
	}
	return light;
}
