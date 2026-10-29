/**
 * GLSL for the Planets scene. Every material is a small shader that writes
 * display colors directly (the canvas runs without tone mapping), so the art
 * palette's colors land on screen as authored in both moods. The star sits at
 * the origin and is the only light: surfaces shade from `-vWorld`, in the
 * 3D game kit's cel bands (`CEL_GLSL`) so the worlds match the kit's toon
 * look: a lit face, a mid band and a cool-tinted night side, never black.
 */

import { CEL_GLSL } from "./game3d-toon.ts";

const NOISE = /* glsl */ `
#ifndef OCTAVES
#define OCTAVES 5
#endif
float hash31(vec3 p) {
	p = fract(p * 0.3183099 + 0.1);
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
	vec3 i = floor(x);
	vec3 f = fract(x);
	f = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
			mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
		mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
			mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
		f.z);
}
float fbm(vec3 p) {
	float value = 0.0;
	float amplitude = 0.5;
	for (int i = 0; i < OCTAVES; i++) {
		value += amplitude * noise3(p);
		p = p * 2.03 + vec3(1.7, 9.2, 3.1);
		amplitude *= 0.5;
	}
	return value;
}
`;

/**
 * A visited planet's own orbit stops short of its disc (as in an orrery), so
 * the stretch of line that runs toward the camera never scores across the
 * planet. `uHole` is the disc in drawing-buffer pixels (x, y, radius); a zero
 * radius turns it off.
 */
const HOLE = /* glsl */ `
float holeFade() {
	if (uHole.z <= 0.0) {
		return 1.0;
	}
	float d = distance(gl_FragCoord.xy, uHole.xy);
	return smoothstep(uHole.z * 1.04, uHole.z * 1.32, d);
}
`;

export const SURFACE_VERTEX = /* glsl */ `
varying vec3 vObject;
varying vec3 vNormalWorld;
varying vec3 vWorld;
void main() {
	vObject = position;
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	vNormalWorld = normalize(mat3(modelMatrix) * normal);
	gl_Position = projectionMatrix * viewMatrix * world;
}`;

/**
 * Procedural planet surfaces by kind: 0 rocky, 1 gas, 2 ice, 3 ocean,
 * 4 ringed (banded like a gas giant, calmer). A soft terminator, a lifted
 * night side (more in light themes) and an atmosphere rim lit from the star.
 */
export const PLANET_FRAGMENT = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uAtmosphere;
uniform float uAtmosphereStrength;
uniform float uKind;
uniform float uNight;
uniform float uSeed;
uniform float uTime;
varying vec3 vObject;
varying vec3 vNormalWorld;
varying vec3 vWorld;
${NOISE}
${CEL_GLSL}
void main() {
	// A toon world in its agent's colour: soft latitude bands (lighter and
	// deeper tones of the same hue), gently wobbled so they read hand-drawn.
	vec3 p = normalize(vObject);
	float wobble = noise3(p * 2.4 + vec3(uSeed * 7.1, uSeed * 3.3, uSeed * 5.7)) - 0.5;
	float lat = p.y + wobble * 0.16;
	float stripes = uKind < 0.5 ? 2.5 : (uKind < 1.5 ? 4.5 : 3.5);
	float band = sin(lat * stripes * 3.14159 + uSeed * 6.0);
	vec3 base = mix(uA, uB, smoothstep(0.35, 0.55, band) * 0.8);
	base = mix(base, uC, smoothstep(0.45, 0.65, -band) * 0.45);
	vec3 n = normalize(vNormalWorld);
	vec3 toSun = normalize(-vWorld);
	float facing = dot(n, toSun);
	float lit = ryuCel(facing + 0.12);
	vec3 color = base * mix(uNight, 1.06, lit) * ryuCelShade(lit);
	// A faint fill from the sky, so a night side keeps its world's colours.
	color += base * 0.06 * (1.0 - lit);
	vec3 view = normalize(cameraPosition - vWorld);
	float edge = 1.0 - max(dot(n, view), 0.0);
	float rim = ryuRimBand(edge) * 0.55 + pow(edge, 2.6) * 0.45;
	color += uAtmosphere * rim * uAtmosphereStrength * (0.3 + 0.7 * smoothstep(-0.4, 0.4, facing));
	gl_FragColor = vec4(color, 1.0);
}`;

/** Moons: a status color, lit from the star, with an emissive core when lit up. */
export const MOON_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uNight;
uniform float uSeed;
uniform float uStatus;
uniform float uFar;
varying vec3 vObject;
varying vec3 vNormalWorld;
varying vec3 vWorld;
${NOISE}
${CEL_GLSL}
void main() {
	// A small flat toon world in its status colour, lit by the star; the
	// colour shows as a rim of light so it still reads on the night side.
	vec3 base = uColor;
	vec3 normal = normalize(vNormalWorld);
	float diffuse = max(dot(normal, normalize(-vWorld)), 0.0);
	float terminator = ryuCel(diffuse);
	// A moon with a status keeps a lit floor, so its colour holds when seen
	// from its night side (a visit often looks from the star's far side).
	vec3 shaded = base * (uNight * 0.45 + 0.08 + 0.3 * uStatus + terminator * (0.8 - 0.25 * uStatus));
	// A status glows from within, so the colour holds on the night side too.
	shaded += uColor * (0.32 * uStatus);
	vec3 view = normalize(cameraPosition - vWorld);
	float rim = pow(1.0 - max(dot(normal, view), 0.0), 3.0);
	vec3 color = shaded + uColor * rim * (0.35 + 0.75 * uStatus);
	// Far off, a moon is a few pixels: let its status color carry it.
	color = mix(color, uColor * (0.9 + 0.25 * diffuse), uFar * (0.35 + 0.5 * uStatus));
	gl_FragColor = vec4(color, 1.0);
}`;

/** The star: a flat toon sun, a warm core inside two cel bands toward the rim. */
export const SUN_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uEdge;
uniform float uTime;
varying vec3 vObject;
varying vec3 vNormalWorld;
varying vec3 vWorld;
void main() {
	vec3 view = normalize(cameraPosition - vWorld);
	float mu = max(dot(normalize(vNormalWorld), view), 0.0);
	vec3 color = mix(uEdge, uMid, smoothstep(0.2, 0.26, mu));
	color = mix(color, uCore, smoothstep(0.62, 0.68, mu) * 0.75);
	gl_FragColor = vec4(color, 1.0);
}`;

/**
 * A camera-facing quad of `uSize` scene units, centred on its object.
 * `uPush` slides it back along the view ray by that many units (scaled up so
 * it looks the same size): a planet's haze then sits behind its own moons
 * instead of washing over the ones on its far side.
 */
export const BILLBOARD_VERTEX = /* glsl */ `
uniform float uSize;
uniform float uPush;
varying vec2 vUv;
void main() {
	vUv = uv;
	vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	float depth = max(-center.z, 1e-3);
	float stretch = (depth + uPush) / depth;
	center.xyz *= stretch;
	center.xy += position.xy * uSize * stretch;
	gl_Position = projectionMatrix * center;
}`;

/** A soft glow (the star's corona, an atmosphere, a lit moon), with faint rays. */
export const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uFalloff;
uniform float uRays;
uniform float uTime;
varying vec2 vUv;
void main() {
	vec2 q = vUv - 0.5;
	float d = length(q) * 2.0;
	float glow = pow(max(1.0 - d, 0.0), uFalloff);
	float angle = atan(q.y, q.x);
	float rays = 0.5 + 0.5 * sin(angle * 9.0 + uTime * 0.07) * sin(angle * 5.0 - uTime * 0.05);
	glow *= 1.0 + uRays * rays * smoothstep(0.15, 0.6, d);
	gl_FragColor = vec4(uColor, clamp(glow * uAlpha, 0.0, 1.0));
}`;

/** A thin camera-facing ring: selection and hover around a planet. */
export const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uWidth;
varying vec2 vUv;
void main() {
	float d = length(vUv - 0.5) * 2.0;
	float ring = smoothstep(0.92 - uWidth, 0.92, d) * (1.0 - smoothstep(0.92, 0.92 + uWidth * 0.6, d));
	gl_FragColor = vec4(uColor, ring * uAlpha);
}`;

export const RING_VERTEX = /* glsl */ `
varying vec2 vLocal;
varying vec3 vWorld;
void main() {
	vLocal = position.xy;
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}`;

/** Planetary rings: banded dust with gaps, brighter on the star's side. */
export const RING_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uInner;
uniform float uOuter;
uniform float uSeed;
uniform float uNight;
varying vec2 vLocal;
varying vec3 vWorld;
${NOISE}
void main() {
	float r = (length(vLocal) - uInner) / (uOuter - uInner);
	float bands = 0.55 + 0.45 * sin(r * 46.0 + uSeed * 6.0) * sin(r * 13.0 + 1.3);
	float gap = smoothstep(0.02, 0.05, abs(r - 0.62));
	float edge = smoothstep(0.0, 0.08, r) * (1.0 - smoothstep(0.9, 1.0, r));
	float grain = 0.8 + 0.4 * noise3(vec3(r * 80.0, uSeed, 0.0));
	// Dense enough to cross the planet's face visibly, with darker lanes so
	// the near arc reads against a body of the same hue.
	float alpha = (0.4 + 0.6 * bands) * gap * edge * grain * 0.95;
	vec3 color = uColor * mix(uNight + 0.2, 1.08, 0.35 + 0.65 * bands);
	gl_FragColor = vec4(color, alpha);
}`;

export const LINE_VERTEX = /* glsl */ `
varying float vDepth;
void main() {
	vec4 view = modelViewMatrix * vec4(position, 1.0);
	vDepth = -view.z;
	gl_Position = projectionMatrix * view;
}`;

/** Orbit lines: a flat tint that fades a little with distance. */
export const LINE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uFar;
uniform vec3 uHole;
varying float vDepth;
${HOLE}
void main() {
	float fade = 1.0 - 0.45 * smoothstep(uFar * 0.5, uFar * 1.4, vDepth);
	gl_FragColor = vec4(uColor, uAlpha * fade * holeFade());
}`;

/** Stars: round soft points that twinkle (held still under reduced motion). */
export const STAR_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aTone;
attribute float aPhase;
uniform float uPixelRatio;
uniform float uTime;
varying float vTone;
varying float vTwinkle;
void main() {
	vTone = aTone;
	vTwinkle = 0.72 + 0.28 * sin(uTime * (0.6 + aPhase) + aPhase * 40.0);
	vec4 view = modelViewMatrix * vec4(position, 1.0);
	gl_PointSize = aSize * uPixelRatio;
	gl_Position = projectionMatrix * view;
}`;

export const STAR_FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
varying float vTone;
varying float vTwinkle;
void main() {
	float d = length(gl_PointCoord - 0.5) * 2.0;
	float disc = pow(max(1.0 - d, 0.0), 1.6);
	gl_FragColor = vec4(mix(uColorA, uColorB, vTone), disc * vTwinkle * uOpacity);
}`;

/** The faint dust disc on the orbital plane, warm near the star. */
export const DISC_VERTEX = /* glsl */ `
varying vec2 vLocal;
void main() {
	vLocal = position.xy;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const DISC_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uRadius;
varying vec2 vLocal;
void main() {
	float r = length(vLocal) / uRadius;
	float glow = pow(max(1.0 - r, 0.0), 2.4);
	gl_FragColor = vec4(uColor, glow * uAlpha);
}`;

/** A soft band along a team's shared orbit (ring geometry in its own plane). */
export const BAND_VERTEX = /* glsl */ `
varying float vRadius;
varying float vDepth;
void main() {
	vRadius = length(position.xy);
	vec4 view = modelViewMatrix * vec4(position, 1.0);
	vDepth = -view.z;
	gl_Position = projectionMatrix * view;
}`;

export const BAND_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uFar;
uniform float uHalf;
uniform float uRadius;
uniform vec3 uHole;
varying float vRadius;
varying float vDepth;
${HOLE}
void main() {
	float t = clamp(abs(vRadius - uRadius) / uHalf, 0.0, 1.0);
	float body = (1.0 - t * t) * (1.0 - t * t);
	float fade = 1.0 - 0.45 * smoothstep(uFar * 0.5, uFar * 1.4, vDepth);
	gl_FragColor = vec4(uColor, uAlpha * body * fade * holeFade());
}`;
