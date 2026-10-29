/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Fog, InstancedMesh, ShaderMaterial } from "three";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { groundLight, lawnAlbedo, type Rgb } from "./game3d-lawn.ts";
import { ToonMaterial, useBoundUniforms } from "./game3d-materials.tsx";
import { DOUBLE_SIDE, jitter, mathKit, pick } from "./game3d-math.ts";
import {
	ART_WHITE,
	FLORA_ART,
	type Scene3dTheme,
	type Vec3,
} from "./game3d-palette.ts";
import { CURVE_GLSL, CURVE_UNIFORMS, linearRgb } from "./game3d-toon.ts";
import { tileHash } from "./world-village.ts";

/**
 * Lush stylized grass: a dense carpet of short instanced blades swaying in
 * a gusting wind. Each blade's root is exactly the lit ground it grows from
 * (the same patchy two-green lawn, see game3d-lawn.ts), and it only warms
 * a little toward a yellow-green tip, so the tufts melt into the terrain
 * instead of reading as spiky weeds. A game says where lawn is
 * (`growBlades`) and draws the result (`GrassBlades`). Flower clusters
 * (pinwheel asters and drooping bell flowers) dot the lawns
 * (`FlowerClusters`).
 */

/** Half the blade's width at the root, in tiles (before per-blade scale). */
const BLADE_WIDTH = 0.044;
const WIND = 0.07;

/**
 * One tapered, curved blade, one unit tall: three segments narrowing to a
 * rounded point and arching forward, so up close it reads as a soft blade
 * of grass, not a paper spike.
 */
const BLADE_SEGMENTS: readonly [number, number, number][] = [
	// height, half-width (share of the root's), forward arch
	[0, 1, 0],
	[0.4, 0.86, 0.04],
	[0.75, 0.55, 0.11],
];
const BLADE_POSITIONS = new Float32Array([
	...BLADE_SEGMENTS.flatMap(([y, w, z]) => [
		-BLADE_WIDTH * w,
		y,
		z,
		BLADE_WIDTH * w,
		y,
		z,
	]),
	0,
	1,
	0.22,
]);
const BLADE_INDEX = new Uint16Array([
	0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6,
]);

const GRASS_VERTEX = /* glsl */ `
${CURVE_GLSL}
uniform float uTime;
uniform float uWind;
attribute vec2 aBlade;
varying float vHeight;
varying vec3 vRoot;
varying vec2 vBlade;
varying float vDepth;
void main() {
	vHeight = position.y;
	vBlade = aBlade;
	vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
	vec4 root = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	// Blades right under a close lens shrink away, so a two-shot never has
	// giant blades in the foreground.
	float near = smoothstep(2.4, 4.6, distance(cameraPosition, root.xyz));
	world.xyz = root.xyz + (world.xyz - root.xyz) * near;
	float gust = sin(uTime * 1.25 + root.x * 0.3 + root.z * 0.17);
	float ripple = sin(uTime * 2.8 + root.x * 1.7 - root.z * 1.3) * 0.35;
	float sway = (gust * 0.75 + ripple) * uWind * position.y * position.y;
	world.x += sway;
	world.z += sway * 0.45;
	world.y -= ryuCurveDrop(world.xz);
	#ifdef USE_INSTANCING_COLOR
		vRoot = instanceColor;
	#else
		vRoot = vec3(0.3, 0.6, 0.2);
	#endif
	vec4 mvPosition = viewMatrix * world;
	vDepth = -mvPosition.z;
	gl_Position = projectionMatrix * mvPosition;
}`;

const GRASS_FRAGMENT = /* glsl */ `
uniform vec3 uTipLit;
uniform vec3 uTipShade;
uniform vec3 uGlint;
uniform vec3 uFogColor;
uniform vec2 uFog;
varying float vHeight;
varying vec3 vRoot;
varying vec2 vBlade;
varying float vDepth;
void main() {
	float h = smoothstep(0.0, 1.0, vHeight);
	// The root is the ground itself; the tip only warms 40% of the way.
	vec3 tip = mix(vRoot, mix(uTipShade, uTipLit, vBlade.x), 0.4) * vBlade.y;
	vec3 col = mix(vRoot, tip, h);
	col += uGlint * vBlade.x * smoothstep(0.72, 1.0, vHeight);
	float fog = smoothstep(uFog.x, uFog.y, vDepth);
	gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

export interface Blade {
	/** Lean forward (outward from its tuft), radians. */
	lean: number;
	/** Small twist within the blade's own plane, radians. */
	roll: number;
	/** Lit ground color under the blade (linear), shadow included. */
	root: Rgb;
	/** 1 in sunlight, 0 in a cottage's shadow. */
	shade: number;
	size: number;
	turn: number;
	/** Brightness of the tip, about 1. */
	vary: number;
	x: number;
	z: number;
}

/** Blades per tuft: small, soft clumps rather than spiky fans. */
const TUFT_MIN = 3;
/** Up to this many more blades on top of `TUFT_MIN` (so 3 to 5). */
const TUFT_SPREAD = 3;
/** Shortest blade and the extra height a blade may add, in tiles. */
const BLADE_MIN = 0.056;
const BLADE_RANGE = 0.062;

/** A tile blades grow on: its grid coordinates, center and density. */
export interface LawnTile {
	cx: number;
	cz: number;
	/** Blades per tile scale with this (edges grow thicker). */
	weight: number;
	x: number;
	y: number;
}

/**
 * Grows tufts of blades over `tiles`: about `perTile` per tile (times its
 * weight), thinned to `max` in all. `keep` rejects tufts off the lawn and
 * `shadeOf` gives each tile's test for lying in shadow; every blade's root
 * is the lit lawn color under it.
 */
export function growBlades({
	keep,
	max,
	perTile,
	shadeOf,
	theme,
	tiles,
}: {
	keep: (tile: LawnTile, x: number, z: number) => boolean;
	max: number;
	perTile: number;
	shadeOf?: (tile: LawnTile) => (x: number, z: number) => boolean;
	theme: Scene3dTheme;
	tiles: readonly LawnTile[];
}): Blade[] {
	const total = tiles.reduce((sum, tile) => sum + tile.weight * perTile, 0);
	const density = Math.min(1, max / Math.max(1, total));
	const lit = groundLight(theme, false);
	const dark = groundLight(theme, true);
	const blades: Blade[] = [];
	for (const tile of tiles) {
		const count = Math.round(tile.weight * perTile * density);
		const { cx, cz } = tile;
		const shaded = shadeOf?.(tile);
		let index = 0;
		let tuft = 0;
		while (index < count) {
			const salt = tuft * 11;
			const tx = cx + (jitter(tile.x, tile.y, salt + 1) - 0.5) * 0.98;
			const tz = cz + (jitter(tile.x, tile.y, salt + 2) - 0.5) * 0.98;
			const size = Math.min(
				count - index,
				TUFT_MIN + Math.floor(jitter(tile.x, tile.y, salt + 3) * TUFT_SPREAD)
			);
			tuft += 1;
			index += size;
			if (!keep(tile, tx, tz)) {
				continue;
			}
			const shade = shaded?.(tx, tz) ? 0 : 1;
			const tall = 0.8 + jitter(tile.x, tile.y, salt + 5) * 0.4;
			for (let blade = 0; blade < size; blade++) {
				const seed = salt + blade * 3;
				const angle = jitter(tile.x, tile.y, seed + 4) * Math.PI * 2;
				const out = 0.02 + jitter(tile.x, tile.y, seed + 6) * 0.08;
				const x = tx + Math.sin(angle) * out;
				const z = tz + Math.cos(angle) * out;
				const albedo = lawnAlbedo(theme, x, z) ?? [0.2, 0.5, 0.15];
				const light = shade ? lit : dark;
				blades.push({
					lean: 0.05 + jitter(tile.x, tile.y, seed + 7) * 0.22,
					roll: (jitter(tile.x, tile.y, seed + 8) - 0.5) * 0.3,
					root: [
						albedo[0] * light[0],
						albedo[1] * light[1],
						albedo[2] * light[2],
					],
					shade,
					size:
						(BLADE_MIN + jitter(tile.x, tile.y, seed + 9) * BLADE_RANGE) * tall,
					turn: angle,
					vary: 0.92 + jitter(tile.x, tile.y, seed + 10) * 0.16,
					x,
					z,
				});
			}
		}
	}
	return blades;
}

/** `hex` lit by `light` (both linear), as a uniform value. */
function litColor(hex: string, light: Rgb): [number, number, number] {
	const [r, g, b] = linearRgb(hex);
	return [r * light[0], g * light[1], b * light[2]];
}

/**
 * The swaying lawn, from blades grown with `growBlades`. `reducedMotion`
 * stills the wind. Without scene fog the blades are never fogged.
 */
export function GrassBlades({
	blades,
	reducedMotion,
	theme,
}: {
	blades: readonly Blade[];
	reducedMotion: boolean;
	theme: Scene3dTheme;
}) {
	const ref = useRef<InstancedMesh>(null);
	const material = useRef<ShaderMaterial>(null);
	const tip = theme.grassBlades?.[1] ?? FLORA_ART.tipFallback;
	const allUniforms = useMemo(
		() => ({
			// The curve uniforms are shared objects, bent in step with the rest.
			...CURVE_UNIFORMS,
			uFog: { value: { x: 1e4, y: 2e4 } },
			uFogColor: { value: [1, 1, 1] },
			uGlint: {
				value: theme.night
					? [0, 0, 0]
					: litColor(FLORA_ART.glint, [0.05, 0.05, 0.05]),
			},
			uTime: { value: 0 },
			uTipLit: { value: litColor(tip, groundLight(theme, false)) },
			uTipShade: { value: litColor(tip, groundLight(theme, true)) },
			uWind: { value: WIND },
		}),
		[theme, tip]
	);
	useLayoutEffect(() => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		const { euler, matrix, position, quaternion, scale } = mathKit(mesh);
		const roots = new Float32Array(blades.length * 3);
		const extras = new Float32Array(blades.length * 2);
		for (const [index, blade] of blades.entries()) {
			position.set(blade.x, 0, blade.z);
			// Yaw first, then lean along the blade's own facing (its arch).
			quaternion.setFromEuler(
				euler.set(blade.lean, blade.turn, blade.roll, "YXZ")
			);
			scale.set(1, blade.size, 1);
			matrix.compose(position, quaternion, scale);
			mesh.setMatrixAt(index, matrix);
			roots.set(blade.root, index * 3);
			extras.set([blade.shade, blade.vary], index * 2);
		}
		// Per-blade attributes, as the same kind of attribute as the transforms.
		const Attribute = mesh.instanceMatrix.constructor as new (
			array: Float32Array,
			itemSize: number
		) => NonNullable<InstancedMesh["instanceColor"]>;
		mesh.instanceColor = new Attribute(roots, 3);
		mesh.geometry.setAttribute("aBlade", new Attribute(extras, 2));
		mesh.count = blades.length;
		mesh.instanceMatrix.needsUpdate = true;
		mesh.computeBoundingSphere();
	}, [blades]);
	useBoundUniforms(material, allUniforms);
	useFrame(({ clock, scene }) => {
		allUniforms.uTime.value = reducedMotion ? 0 : clock.elapsedTime;
		allUniforms.uWind.value = reducedMotion ? 0 : WIND;
		const fog = scene.fog as Fog | null;
		if (fog) {
			allUniforms.uFog.value.x = fog.near;
			allUniforms.uFog.value.y = fog.far;
			allUniforms.uFogColor.value = [fog.color.r, fog.color.g, fog.color.b];
		}
	});
	if (blades.length === 0 || !theme.grassBlades) {
		return null;
	}
	return (
		<instancedMesh
			args={[undefined, undefined, blades.length]}
			frustumCulled={false}
			key={blades.length}
			ref={ref}
		>
			<bufferGeometry>
				<bufferAttribute
					args={[BLADE_POSITIONS, 3]}
					attach="attributes-position"
				/>
				<bufferAttribute args={[BLADE_INDEX, 1]} attach="index" />
			</bufferGeometry>
			<shaderMaterial
				fragmentShader={GRASS_FRAGMENT}
				ref={material}
				side={DOUBLE_SIDE}
				uniforms={allUniforms}
				vertexShader={GRASS_VERTEX}
			/>
		</instancedMesh>
	);
}

const ASTER_PETALS = FLORA_ART.asterPetals;
const BELLS = FLORA_ART.bells;
const STEM = FLORA_ART.stem;
const FLOWER_INK = 0.008;

export interface FlowerParts {
	bells: InstanceSpec[];
	centers: InstanceSpec[];
	leaves: InstanceSpec[];
	petals: InstanceSpec[];
	stems: InstanceSpec[];
}

/**
 * A windwheel aster: five soft, rounded petals fanned like a pinwheel (each
 * one twisted about its own length) around a golden heart.
 */
function addAster(parts: FlowerParts, at: Vec3, seed: number, size: number) {
	const height = 0.19 * size;
	parts.stems.push({
		color: STEM,
		position: [at[0], height / 2, at[2]],
		scale: [0.011, height, 0.011],
	});
	const color = pick(ASTER_PETALS, seed);
	const turn = (seed % 90) * 0.02;
	for (let petal = 0; petal < 5; petal++) {
		const angle = turn + (petal * Math.PI * 2) / 5;
		parts.petals.push({
			color,
			position: [
				at[0] + Math.sin(angle) * 0.04 * size,
				height + 0.012,
				at[2] + Math.cos(angle) * 0.04 * size,
			],
			// Tipped up a little and twisted about its own length: a windwheel.
			rotation: [-0.22, angle, 0.55],
			scale: [0.026 * size, 0.009 * size, 0.046 * size],
		});
	}
	parts.centers.push({
		color: FLORA_ART.gold,
		position: [at[0], height + 0.022, at[2]],
		scale: [0.02 * size, 0.014 * size, 0.02 * size],
	});
}

/** A bell flower: an arched stem with two rounded bells hanging from it. */
function addBell(parts: FlowerParts, at: Vec3, seed: number, size: number) {
	const height = 0.22 * size;
	parts.stems.push({
		color: STEM,
		position: [at[0], height / 2, at[2]],
		rotation: [0, 0, 0.1],
		scale: [0.01, height, 0.01],
	});
	parts.leaves.push({
		color: STEM,
		position: [at[0] + 0.025 * size, 0.035 * size, at[2]],
		rotation: [0.3, seed, 0.9],
		scale: [0.018 * size, 0.05 * size, 0.008 * size],
	});
	const color = pick(BELLS, seed);
	for (let bell = 0; bell < 2; bell++) {
		const side = bell === 0 ? 1 : -1;
		parts.bells.push({
			color,
			position: [
				at[0] + side * 0.035 * size,
				height - 0.02 * size - bell * 0.05 * size,
				at[2] + 0.01,
			],
			rotation: [0, 0, side * 0.3],
			scale: [0.036 * size, 0.05 * size, 0.036 * size],
		});
	}
}

/** A flower patch: grid coordinates that seed it and where it grows. */
export interface FlowerPatch {
	at: Vec3;
	x: number;
	y: number;
}

/** Three to five flowers per patch, scattered within its tile. */
export function plantFlowers(patches: readonly FlowerPatch[]): FlowerParts {
	const parts: FlowerParts = {
		bells: [],
		centers: [],
		leaves: [],
		petals: [],
		stems: [],
	};
	for (const tile of patches) {
		const base = tile.at;
		const count = 3 + (tileHash(tile.x, tile.y) % 3);
		for (let index = 0; index < count; index++) {
			const seed = tileHash(tile.x + index * 7, tile.y - index);
			const at: Vec3 = [
				base[0] + (jitter(tile.x, tile.y, index * 3 + 11) - 0.5) * 0.8,
				base[1],
				base[2] + (jitter(tile.x, tile.y, index * 3 + 12) - 0.5) * 0.8,
			];
			const size = 0.95 + jitter(tile.x, tile.y, index + 13) * 0.45;
			if (seed % 2 === 0) {
				addAster(parts, at, seed, size);
			} else {
				addBell(parts, at, seed, size);
			}
		}
	}
	return parts;
}

/**
 * Bell cup: the top of a sphere down past its equator, open at the bottom,
 * so a bell is a smooth rounded dome rather than a faceted cone.
 */
const BELL_CUP = Math.PI * 0.64;

/** Wildflower clusters (see `plantFlowers`), soft and inked. */
export function FlowerClusters({
	patches,
}: {
	patches: readonly FlowerPatch[];
}) {
	const parts = useMemo(() => plantFlowers(patches), [patches]);
	return (
		<group>
			<InstancedParts items={parts.stems}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.leaves}>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts ink={FLOWER_INK} items={parts.petals}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial emissive={ART_WHITE} emissiveIntensity={0.08} />
			</InstancedParts>
			<InstancedParts items={parts.centers}>
				<sphereGeometry args={[1, 12, 8]} />
				<ToonMaterial
					emissive={FLORA_ART.centerGlow}
					emissiveIntensity={0.15}
				/>
			</InstancedParts>
			<InstancedParts ink={FLOWER_INK} items={parts.bells}>
				<sphereGeometry args={[1, 16, 10, 0, Math.PI * 2, 0, BELL_CUP]} />
				<ToonMaterial side={DOUBLE_SIDE} />
			</InstancedParts>
		</group>
	);
}
