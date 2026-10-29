import type {
	BufferAttribute,
	BufferGeometry,
	Material,
	WebGLProgramParametersWithUniforms,
} from "three";
import { TOON_LIGHT } from "./game3d-palette.ts";

/**
 * The 3D world's look, shared by every material in the scene:
 *
 * - the rolling-log world curvature (the ground bends away toward the
 *   horizon around the point the camera follows), applied in the vertex
 *   shader of every material through one patch so terrain, grass, trees,
 *   cottages and villagers all bend together;
 * - anime cel shading: a two-band light ramp with anti-aliased steps, cool
 *   tinted shade (never black) and a fresnel rim light on characters;
 * - ink outlines drawn as inverted hulls pushed out in world space, tinted
 *   from the surface color so they read as dark hue lines, not black.
 *
 * Shadows are cast and received in unbent space (the shadow pass and the
 * receivers' shadow coordinates both skip the bend), so they stay put.
 *
 * Like the rest of the world's 3D modules this file imports `three` for
 * types only (see game3d-math.ts): uniform values are plain `{x, y}` and
 * `[r, g, b]` values, which three uploads as they are.
 */

type Rgb = [number, number, number];

/** `#rrggbb` (or `#rgb`) to linear-light RGB, the space shaders work in. */
export function linearRgb(hex: string): Rgb {
	const full =
		hex.length === 4
			? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
			: hex;
	const channel = (offset: number) => {
		const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
		return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return [channel(1), channel(3), channel(5)];
}

/** Side-to-side bend relative to the forward bend: a log, gently a ball. */
const SIDE_BEND = 0.22;

/** Uniforms every curved material shares (the same objects, updated once). */
export const CURVE_UNIFORMS = {
	ryuCurve: { value: 0 },
	ryuCurveCenter: { value: { x: 0, y: 0 } },
	ryuCurveDir: { value: { x: 0, y: -1 } },
};

/** Per-theme look values, shared the same way. */
export const LOOK_UNIFORMS = {
	ryuInk: { value: linearRgb(TOON_LIGHT.ink) },
	ryuRimColor: { value: linearRgb(TOON_LIGHT.rim) },
	ryuShadeTint: { value: linearRgb(TOON_LIGHT.shadeTint) },
	/** Toward the key light, in world space (the rim only lights that side). */
	ryuSunDir: { value: { x: -0.4, y: 0.7, z: 0.57 } },
};

/**
 * Screen-door fade for scenery standing between the lens and the player
 * (trees and cottages): a circle on screen around the player, and the view
 * depth the player stands at. Radius 0 turns it off.
 */
export const FADE_UNIFORMS = {
	ryuFadeCenter: { value: { x: 0, y: 0 } },
	ryuFadeDepth: { value: 0 },
	/**
	 * During a conversation shot, scenery nearer the lens than this view
	 * depth (trees and cottages in the foreground) melts away, so nothing
	 * stands between the lens and the pair; 0 is off.
	 */
	ryuFadeNear: { value: 0 },
	ryuFadeRadius: { value: 0 },
};

/** Sets the shared look for a theme: ink, rim light, shade tint and sun. */
export function setLook(look: {
	ink: string;
	rimLight: string;
	shadeTint: string;
	sun: readonly [number, number, number];
}): void {
	LOOK_UNIFORMS.ryuInk.value = linearRgb(look.ink);
	LOOK_UNIFORMS.ryuRimColor.value = linearRgb(look.rimLight);
	LOOK_UNIFORMS.ryuShadeTint.value = linearRgb(look.shadeTint);
	const [x, y, z] = look.sun;
	const length = Math.hypot(x, y, z) || 1;
	LOOK_UNIFORMS.ryuSunDir.value = {
		x: x / length,
		y: y / length,
		z: z / length,
	};
}

/** How far the ground at (x, z) drops below flat: the CPU twin of the shader. */
export function curveDrop(x: number, z: number): number {
	const { ryuCurve, ryuCurveCenter, ryuCurveDir } = CURVE_UNIFORMS;
	const rx = x - ryuCurveCenter.value.x;
	const rz = z - ryuCurveCenter.value.y;
	const along = rx * ryuCurveDir.value.x + rz * ryuCurveDir.value.y;
	const side = -rx * ryuCurveDir.value.y + rz * ryuCurveDir.value.x;
	return ryuCurve.value * (along * along + SIDE_BEND * side * side);
}

export const CURVE_GLSL = /* glsl */ `
uniform float ryuCurve;
uniform vec2 ryuCurveCenter;
uniform vec2 ryuCurveDir;
float ryuCurveDrop(vec2 xz) {
	vec2 rel = xz - ryuCurveCenter;
	float along = dot(rel, ryuCurveDir);
	float side = dot(rel, vec2(-ryuCurveDir.y, ryuCurveDir.x));
	return ryuCurve * (along * along + ${SIDE_BEND.toFixed(3)} * side * side);
}
`;

/** World position (instanced or not), outline push, bend, then project. */
const PROJECT_GLSL = /* glsl */ `
vec4 ryuWorld = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
	ryuWorld = instanceMatrix * ryuWorld;
#endif
ryuWorld = modelMatrix * ryuWorld;
#ifdef RYU_SIDING
	vRyuHeight = ryuWorld.y;
#endif
#ifdef RYU_PLANKS
	vRyuFloor = ryuWorld.xz;
#endif
#ifdef RYU_INK
	mat3 ryuBasis = mat3(modelMatrix);
	#ifdef USE_INSTANCING
		ryuBasis = ryuBasis * mat3(instanceMatrix);
	#endif
	vec3 ryuOut = normalize(ryuBasis * normal);
	float ryuDistance = isOrthographic ? 22.0 : distance(cameraPosition, ryuWorld.xyz);
	ryuWorld.xyz += ryuOut * ryuInkWidth * clamp(ryuDistance * 0.085, 0.55, 3.2);
#endif
#ifndef RYU_FLAT
	ryuWorld.y -= ryuCurveDrop(ryuWorld.xz);
#endif
vec4 mvPosition = viewMatrix * ryuWorld;
#ifdef RYU_FADE
	vRyuDepth = -mvPosition.z;
#endif
gl_Position = projectionMatrix * mvPosition;
`;

/** Declarations for the screen-door fade, in both shader stages. */
const FADE_VARYING = "varying float vRyuDepth;";

const FADE_PARS = /* glsl */ `
${FADE_VARYING}
uniform vec2 ryuFadeCenter;
uniform float ryuFadeDepth;
uniform float ryuFadeNear;
uniform float ryuFadeRadius;
float ryuBayer(vec2 p) {
	vec2 q = mod(floor(p), 4.0);
	float a = mod(q.x + q.y * 2.0, 4.0);
	float b = mod(q.x, 2.0) * 2.0 + mod(q.y, 2.0);
	return (a * 4.0 + b + 0.5) / 16.0;
}
`;

/**
 * Drops about two thirds of the pixels (an ordered dither, so it reads as
 * see-through rather than holes) of anything in front of the player and
 * inside the circle around them on screen.
 */
const FADE_GLSL = /* glsl */ `
#ifdef RYU_FADE
	if (ryuFadeNear > 0.0 && vRyuDepth < ryuFadeNear) {
		float ryuNearKeep = smoothstep(ryuFadeNear - 1.4, ryuFadeNear, vRyuDepth);
		if (ryuBayer(gl_FragCoord.xy) > ryuNearKeep) discard;
	}
	if (ryuFadeRadius > 0.0 && vRyuDepth < ryuFadeDepth - 0.7) {
		float ryuEdge = length(gl_FragCoord.xy - ryuFadeCenter) / ryuFadeRadius;
		float ryuKeep = mix(0.32, 1.0, smoothstep(0.7, 1.0, ryuEdge));
		if (ryuBayer(gl_FragCoord.xy) > ryuKeep) discard;
	}
#endif
`;

/**
 * Two light bands (shade, mid, lit) with steps smoothed over one pixel, in
 * place of three's gradient-map lookup.
 */
const RAMP_GLSL = /* glsl */ `
vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) {
	float d = dot(normal, lightDirection);
#ifdef RYU_FACE
	// Faces never take the terminator: one soft gradient, never dark.
	return vec3(mix(0.66, 1.0, smoothstep(-0.6, 0.5, d)));
#endif
	float w = fwidth(d) * 0.8 + 0.002;
	float lit = smoothstep(0.03 - w, 0.03 + w, d);
	float full = smoothstep(0.42 - w, 0.42 + w, d);
	return vec3(lit * 0.7 + full * 0.3);
}
`;

/**
 * A one-sided rim: a thin fresnel edge on the side facing the key light
 * only, tinted by the theme (warm by day, lilac at night), so it reads as
 * light catching an edge rather than a halo. Hair also gets an anime sheen
 * band across its crown.
 */
const RIM_GLSL = /* glsl */ `
#if defined(RYU_RIM) || defined(RYU_SHEEN)
	vec3 ryuN = normalize(normal);
#endif
#ifdef RYU_RIM
	vec3 ryuView = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
	float ryuFacing = 1.0 - clamp(dot(ryuN, ryuView), 0.0, 1.0);
	vec3 ryuSunView = normalize((viewMatrix * vec4(ryuSunDir, 0.0)).xyz);
	float ryuSunSide = smoothstep(-0.1, 0.4, dot(ryuN, ryuSunView));
	outgoingLight += ryuRimColor * smoothstep(0.72, 0.9, ryuFacing) * ryuSunSide * RYU_RIM;
#endif
#ifdef RYU_SHEEN
	// A jagged "angel ring": the band's edges zigzag around the head, so it
	// reads as light on separate locks, not a stripe on a helmet.
	float ryuWave = sin(atan(ryuN.x, ryuN.z) * 13.0) * 0.07;
	float ryuBand = smoothstep(0.4 + ryuWave, 0.46 + ryuWave, ryuN.y) * (1.0 - smoothstep(0.56 - ryuWave, 0.62 - ryuWave, ryuN.y));
	outgoingLight += mix(diffuseColor.rgb, vec3(1.0), 0.45) * ryuBand * RYU_SHEEN;
#endif
#include <opaque_fragment>
`;

/**
 * The kit's cel light as standalone GLSL, for scenes with their own shader
 * materials (the Aquarium, Planets) so they light like the rest of the
 * kit: `ryuCel(d)` is the same two-band ramp (0, 0.7, 1) with steps
 * smoothed over a pixel; `ryuCelShade(cel)` is the cool tint the shaded
 * side takes instead of going dark; `ryuGlint(x)` turns a soft specular
 * term into a crisp anime highlight; `ryuRimBand(f)` a thin rim band.
 */
export const CEL_GLSL = /* glsl */ `
float ryuCel(float d) {
	float w = fwidth(d) * 0.8 + 0.002;
	float lit = smoothstep(0.03 - w, 0.03 + w, d);
	float full = smoothstep(0.42 - w, 0.42 + w, d);
	return lit * 0.7 + full * 0.3;
}
vec3 ryuCelShade(float cel) {
	return mix(vec3(0.78, 0.82, 1.0), vec3(1.0), cel);
}
float ryuGlint(float x) {
	float w = fwidth(x) + 0.01;
	return smoothstep(0.5 - w, 0.5 + w, x);
}
float ryuRimBand(float facing) {
	float w = fwidth(facing) + 0.01;
	return smoothstep(0.72 - w, 0.72 + w, facing);
}
`;

type Shader = WebGLProgramParametersWithUniforms;

/**
 * The face-normal trick: on the front of the head, normals lean toward the
 * head's forward axis (+Z), so light falls on the whole face as one plane.
 * The back and the crown keep their own normals (the rim still works).
 */
const FACE_NORMAL_GLSL = /* glsl */ `
float ryuFront = smoothstep(-0.25, 0.35, objectNormal.z);
vec3 ryuForward = normalize(vec3(objectNormal.x * 0.3, objectNormal.y * 0.3 + 0.25, 1.0));
objectNormal = normalize(mix(objectNormal, ryuForward, ryuFront));
`;

/** Shade is tinted cool; on a face it is a soft blush instead. */
const SHADE_TINT_GLSL = /* glsl */ `#include <lights_fragment_end>
#ifdef RYU_FACE
reflectedLight.indirectDiffuse *= mix(ryuShadeTint, vec3(1.06, 0.92, 0.94), 0.75);
#else
reflectedLight.indirectDiffuse *= ryuShadeTint;
#endif`;

function addCurve(shader: Shader) {
	Object.assign(shader.uniforms, CURVE_UNIFORMS);
	shader.vertexShader = shader.vertexShader
		.replace("#include <common>", `#include <common>\n${CURVE_GLSL}`)
		.replace("#include <project_vertex>", PROJECT_GLSL);
}

/** Adds the screen-door fade to a material that already has the curve. */
function addFade(shader: Shader) {
	Object.assign(shader.uniforms, FADE_UNIFORMS);
	shader.defines = { ...shader.defines, RYU_FADE: "" };
	shader.vertexShader = shader.vertexShader.replace(
		"#include <common>",
		`#include <common>\n${FADE_VARYING}`
	);
	shader.fragmentShader = shader.fragmentShader
		.replace("#include <common>", `#include <common>\n${FADE_PARS}`)
		.replace(
			"#include <clipping_planes_fragment>",
			`#include <clipping_planes_fragment>\n${FADE_GLSL}`
		);
}

/**
 * Painted clapboard for cottage walls: horizontal siding lines, a darker
 * skirting board just above the stone footing, and a soft occlusion
 * gradient toward the ground, all from the surface's height above the
 * ground (so instanced walls share one material).
 */
const SIDING_GLSL = /* glsl */ `
#ifdef RYU_SIDING
	float ryuBoard = fract((vRyuHeight - 0.16) / 0.125);
	float ryuEdge = fwidth(vRyuHeight) / 0.125 * 1.2 + 0.03;
	float ryuGroove = 1.0 - smoothstep(0.0, ryuEdge, ryuBoard);
	diffuseColor.rgb *= 1.0 - ryuGroove * 0.1 * step(0.3, vRyuHeight);
	float ryuPx = fwidth(vRyuHeight) + 0.002;
	diffuseColor.rgb *= mix(0.68, 1.0, smoothstep(0.27 - ryuPx, 0.27 + ryuPx, vRyuHeight));
	diffuseColor.rgb *= mix(0.86, 1.0, smoothstep(0.28, 0.9, vRyuHeight));
#endif
`;

/**
 * Wooden floorboards for the office: boards a third of a tile wide running
 * across the room, two tiles long with staggered joints, each a slightly
 * different tone, with thin anti-aliased seams.
 */
const PLANKS_GLSL = /* glsl */ `
#ifdef RYU_PLANKS
	vec2 ryuP = vRyuFloor * vec2(0.5, 3.0);
	float ryuRow = floor(ryuP.y);
	ryuP.x += fract(sin(ryuRow * 12.9898) * 43758.5453);
	vec2 ryuF = fract(ryuP);
	vec2 ryuW = fwidth(ryuP) * 1.3 + 0.004;
	float ryuSeam = max(
		1.0 - smoothstep(0.0, ryuW.y, ryuF.y),
		1.0 - smoothstep(0.0, ryuW.x, ryuF.x)
	);
	float ryuTone = 0.93 + 0.07 * fract(sin((ryuRow * 7.0 + floor(ryuP.x)) * 78.233) * 43758.5453);
	diffuseColor.rgb *= ryuTone * (1.0 - ryuSeam * 0.18);
#endif
`;

export interface ToonOptions {
	/** Bends with the world (default); `false` for sky objects. */
	curve?: boolean;
	/**
	 * Anime face shading (the face-normal trick): the front of the head is
	 * lit as if it faced straight ahead, with one soft, warm gradient, so a
	 * face is never split into a lit half and a dark half.
	 */
	face?: boolean;
	/** Screen-door fade when standing between the lens and the player. */
	fade?: boolean;
	/** Wooden floorboards (the office floor). */
	planks?: boolean;
	/** Strength of the fresnel rim light (characters); 0 for none. */
	rim?: number;
	/** Strength of the anime sheen band (hair); 0 for none. */
	sheen?: number;
	/** Clapboard siding, a skirting board and ground occlusion (walls). */
	siding?: boolean;
}

/** Patches a `MeshToonMaterial`: curvature, soft two-band ramp, shade tint, rim. */
export function toonPatch({
	curve = true,
	face = false,
	fade = false,
	planks = false,
	rim = 0,
	sheen = 0,
	siding = false,
}: ToonOptions = {}) {
	return {
		customProgramCacheKey: () =>
			`ryu-toon-${rim}-${sheen}-${fade ? 1 : 0}-${curve ? 1 : 0}-${siding ? 1 : 0}-${planks ? 1 : 0}-${face ? 1 : 0}`,
		onBeforeCompile: (shader: Shader) => {
			addCurve(shader);
			Object.assign(shader.uniforms, LOOK_UNIFORMS);
			const defines: Record<string, string> = {};
			if (rim > 0) {
				defines.RYU_RIM = rim.toFixed(3);
			}
			if (sheen > 0) {
				defines.RYU_SHEEN = sheen.toFixed(3);
			}
			if (!curve) {
				defines.RYU_FLAT = "";
			}
			if (face) {
				defines.RYU_FACE = "";
				shader.vertexShader = shader.vertexShader.replace(
					"#include <beginnormal_vertex>",
					`#include <beginnormal_vertex>\n${FACE_NORMAL_GLSL}`
				);
			}
			if (siding) {
				defines.RYU_SIDING = "";
				shader.vertexShader = shader.vertexShader.replace(
					"#include <common>",
					"#include <common>\nvarying float vRyuHeight;"
				);
				shader.fragmentShader = shader.fragmentShader
					.replace(
						"#include <common>",
						"#include <common>\nvarying float vRyuHeight;"
					)
					.replace(
						"#include <color_fragment>",
						`#include <color_fragment>\n${SIDING_GLSL}`
					);
			}
			if (planks) {
				defines.RYU_PLANKS = "";
				shader.vertexShader = shader.vertexShader.replace(
					"#include <common>",
					"#include <common>\nvarying vec2 vRyuFloor;"
				);
				shader.fragmentShader = shader.fragmentShader
					.replace(
						"#include <common>",
						"#include <common>\nvarying vec2 vRyuFloor;"
					)
					.replace(
						"#include <color_fragment>",
						`#include <color_fragment>\n${PLANKS_GLSL}`
					);
			}
			shader.defines = { ...shader.defines, ...defines };
			shader.fragmentShader = shader.fragmentShader
				.replace(
					"#include <common>",
					"#include <common>\nuniform vec3 ryuRimColor;\nuniform vec3 ryuShadeTint;\nuniform vec3 ryuSunDir;"
				)
				.replace("#include <gradientmap_pars_fragment>", RAMP_GLSL)
				.replace("#include <lights_fragment_end>", SHADE_TINT_GLSL)
				.replace("#include <opaque_fragment>", RIM_GLSL);
			if (fade) {
				addFade(shader);
			}
		},
	};
}

/** Patches any built-in material's vertex stage with the curvature only. */
export function curvePatch(key = "basic") {
	return {
		customProgramCacheKey: () => `ryu-curve-${key}`,
		onBeforeCompile: (shader: Shader) => addCurve(shader),
	};
}

/**
 * Point sprites that bend with the world and stay small close to the lens:
 * past `near` world units they shrink to a few pixels and fade out, so a
 * mote drifting by the camera never covers a face.
 */
export function pointsPatch(near = 4) {
	return {
		customProgramCacheKey: () => `ryu-points-${near}`,
		onBeforeCompile: (shader: Shader) => {
			addCurve(shader);
			shader.vertexShader = shader.vertexShader
				.replace(
					"#include <common>",
					"#include <common>\nvarying float vRyuNear;"
				)
				.replace(
					"#include <worldpos_vertex>",
					`#include <worldpos_vertex>
float ryuDepth = -mvPosition.z;
vRyuNear = smoothstep(${(near * 0.5).toFixed(2)}, ${near.toFixed(2)}, ryuDepth);
gl_PointSize = min(gl_PointSize, mix(3.0, 26.0, vRyuNear));`
				);
			shader.fragmentShader = shader.fragmentShader
				.replace(
					"#include <common>",
					"#include <common>\nvarying float vRyuNear;"
				)
				.replace(
					"#include <alphatest_fragment>",
					"#include <alphatest_fragment>\ndiffuseColor.a *= vRyuNear;"
				);
		},
	};
}

/**
 * Patches a back-face `MeshBasicMaterial` into an ink outline: pushed out
 * along smoothed normals by `width` (world units at ~12 tiles away, kept
 * about as thick on screen at other distances), colored a dark shade of the
 * surface under it.
 */
export function inkPatch(width: number, fade = false) {
	return {
		customProgramCacheKey: () => `ryu-ink-${fade ? 1 : 0}`,
		onBeforeCompile: (shader: Shader) => {
			addCurve(shader);
			if (fade) {
				addFade(shader);
			}
			shader.uniforms.ryuInkWidth = { value: width };
			shader.uniforms.ryuInk = LOOK_UNIFORMS.ryuInk;
			shader.defines = { ...shader.defines, RYU_INK: "" };
			shader.vertexShader = shader.vertexShader.replace(
				"#include <common>",
				"#include <common>\nuniform float ryuInkWidth;"
			);
			shader.fragmentShader = shader.fragmentShader
				.replace("#include <common>", "#include <common>\nuniform vec3 ryuInk;")
				.replace(
					"#include <color_fragment>",
					"#include <color_fragment>\ndiffuseColor.rgb = diffuseColor.rgb * 0.24 + ryuInk * 0.62;"
				);
		},
	};
}

/**
 * The hull an outline is drawn from: the same shape with the normals of
 * every vertex that shares a position averaged (welding seams and hard
 * corners), so pushing out along them never opens gaps at corners.
 */
export function hullGeometry(source: BufferGeometry): BufferGeometry {
	const geometry = source.clone();
	for (const name of Object.keys(geometry.attributes)) {
		if (name !== "position" && name !== "normal") {
			geometry.deleteAttribute(name);
		}
	}
	if (!geometry.getAttribute("normal")) {
		geometry.computeVertexNormals();
	}
	const position = geometry.getAttribute("position") as BufferAttribute;
	const normal = geometry.getAttribute("normal") as BufferAttribute;
	const sums = new Map<string, Rgb>();
	const keys: string[] = [];
	for (let index = 0; index < position.count; index++) {
		const key = [
			Math.round(position.getX(index) * 1000),
			Math.round(position.getY(index) * 1000),
			Math.round(position.getZ(index) * 1000),
		].join(",");
		keys.push(key);
		const sum = sums.get(key) ?? [0, 0, 0];
		sum[0] += normal.getX(index);
		sum[1] += normal.getY(index);
		sum[2] += normal.getZ(index);
		sums.set(key, sum);
	}
	for (const [index, key] of keys.entries()) {
		const [x, y, z] = sums.get(key) ?? [0, 1, 0];
		const length = Math.hypot(x, y, z) || 1;
		normal.setXYZ(index, x / length, y / length, z / length);
	}
	normal.needsUpdate = true;
	return geometry;
}

/** Applies a patch's hooks to a material created elsewhere (e.g. by JSX). */
export function applyPatch(
	material: Material,
	patch: {
		customProgramCacheKey: () => string;
		onBeforeCompile: (shader: Shader) => void;
	}
): void {
	material.onBeforeCompile = patch.onBeforeCompile;
	material.customProgramCacheKey = patch.customProgramCacheKey;
	material.needsUpdate = true;
}

/** How hard the GPU may be pushed: a software rasterizer gets the light set. */
export type RenderQuality = "high" | "low";

export interface WebGLProbe {
	quality: RenderQuality;
	supported: boolean;
}

const SOFTWARE_RENDERER =
	/swiftshader|llvmpipe|softpipe|software|basic render/i;

/** Checks for WebGL once, and whether it runs on a software rasterizer. */
export function probeWebGL(): WebGLProbe {
	try {
		const canvas = document.createElement("canvas");
		const gl = (canvas.getContext("webgl2") ??
			canvas.getContext("webgl")) as WebGLRenderingContext | null;
		if (!gl) {
			return { quality: "low", supported: false };
		}
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer = String(
			gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
		);
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return {
			quality: SOFTWARE_RENDERER.test(renderer) ? "low" : "high",
			supported: true,
		};
	} catch {
		return { quality: "low", supported: false };
	}
}

/** Budgets per quality level. */
export const QUALITY = {
	high: {
		bloomScale: 0.5,
		dpr: [1, 2] as [number, number],
		grassPerTile: 100,
		maxGrass: 170_000,
		pollen: 90,
		shadowMap: 2048,
	},
	low: {
		bloomScale: 0.35,
		dpr: [1, 1] as [number, number],
		grassPerTile: 40,
		maxGrass: 40_000,
		pollen: 40,
		shadowMap: 1024,
	},
} as const;
