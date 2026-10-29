/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type {
	Group,
	InstancedMesh,
	Points,
	ShaderMaterial,
	Vector3,
} from "three";
import { CurvedPointsMaterial, useBoundUniforms } from "./game3d-materials.tsx";
import {
	ADDITIVE_BLENDING,
	BACK_SIDE,
	jitter,
	mathKit,
} from "./game3d-math.ts";
import {
	ART_WHITE,
	hexAlpha,
	type Scene3dTheme,
	sunDirection,
	TOON_LIGHT,
	type Vec3,
} from "./game3d-palette.ts";
import { CURVE_UNIFORMS, linearRgb } from "./game3d-toon.ts";

/**
 * The anime sky: a gradient dome from a pale warm horizon up to a deep blue
 * zenith, framed to the part of the dome the curved world leaves in view, a
 * glowing sun disk (or a big moon and a starfield at night), stylized
 * cumulus banks along the horizon, and drifting light motes.
 */

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vDir = world.xyz - cameraPosition;
	gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 glow;
uniform vec3 diskColor;
uniform vec3 diskDir;
uniform float diskSize;
uniform float horizonElev;
uniform float span;
uniform float night;
uniform float time;
varying vec3 vDir;

float hash(vec3 p) {
	return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void main() {
	vec3 dir = normalize(vDir);
	float elev = asin(clamp(dir.y, -1.0, 1.0));
	float t = (elev - horizonElev) / span;
	float up = clamp(t, 0.0, 1.0);
	vec3 col = mix(horizon, zenith, smoothstep(0.0, 1.0, pow(up, 0.7)));
	// The warm haze hugging the horizon.
	col = mix(col, glow, exp(-max(t, 0.0) * 4.5) * 0.6);
	// Below the horizon line: the haze the fog fades the far world into.
	col = mix(col, mix(horizon, glow, 0.35), smoothstep(0.0, -0.4, t));
	// Sun or moon: a crisp disk (just past the bloom threshold, so only the
	// core glows) inside a smooth analytic halo that falls off as two soft
	// exponentials: no rings, no banding, nothing for the bloom to smear.
	float c = dot(dir, diskDir);
	vec3 side = normalize(cross(diskDir, vec3(0.0, 1.0, 0.0)));
	vec3 lift = cross(side, diskDir);
	float edge = fwidth(c) * 1.5 + 0.00002;
	float disk = smoothstep(diskSize - edge, diskSize + edge, c);
	float ang = acos(clamp(c, -1.0, 1.0));
	float r = acos(diskSize);
	float out_ = max(ang - r, 0.0);
	float halo = exp(-out_ / (r * 0.9)) * 0.16 + exp(-out_ / (r * 6.5)) * 0.07;
	// The moon's face: soft grey maria and a darker limb, so it reads as a
	// moon rather than a blown-out disk.
	vec2 moonUv = vec2(dot(dir, side), dot(dir, lift)) / max(sin(r), 0.0001);
	float mare = smoothstep(0.44, 0.16, length(moonUv - vec2(-0.26, 0.24)))
		+ smoothstep(0.34, 0.1, length(moonUv - vec2(0.27, -0.02))) * 0.85
		+ smoothstep(0.28, 0.06, length(moonUv - vec2(-0.06, -0.4))) * 0.7
		+ smoothstep(0.2, 0.04, length(moonUv - vec2(0.18, 0.42))) * 0.5;
	mare = clamp(mare, 0.0, 1.0) * (0.8 + 0.2 * hash(floor(dir * 520.0)));
	float limb = 1.0 - 0.2 * clamp(dot(moonUv, moonUv), 0.0, 1.0);
	float craters = mix(1.0, (1.0 - 0.26 * mare) * limb, night);
	col += diskColor * disk * craters;
	// The halo is warm by day and a cool silver glow at night; capped below
	// the bloom threshold so it stays a soft, clean gradient.
	col += min(diskColor, vec3(1.6)) * halo * (1.0 - night * 0.2);
	// Stars twinkle over the night sky.
	if (night > 0.5) {
		vec3 p = dir * 150.0;
		vec3 cell = floor(p);
		float h = hash(cell);
		float d = length(fract(p) - 0.5);
		float star = step(0.986, h) * smoothstep(0.22, 0.0, d);
		star *= 0.65 + 0.35 * sin(time * 2.0 + h * 60.0);
		col += vec3(1.0, 0.95, 0.85) * star * smoothstep(0.02, 0.3, t) * (h > 0.997 ? 3.0 : 1.2);
	}
	gl_FragColor = vec4(col, 1.0);
}`;

/**
 * The band of sky the camera sees this frame, in radians of elevation: from
 * the curved horizon to the top of the view. Written by the sky dome and
 * read by the clouds, so both sit in the same visible band.
 */
const SKY_BAND = { horizon: -0.2, span: 0.3 };

/** Elevation (radians) of the curved ground's horizon seen from the camera. */
function horizonElevation(eye: Vector3, forward: [number, number]): number {
	if (CURVE_UNIFORMS.ryuCurve.value <= 0) {
		return Math.atan2(-eye.y, 60);
	}
	const { ryuCurve, ryuCurveCenter } = CURVE_UNIFORMS;
	const k = ryuCurve.value;
	// How far behind the bend center the eye stands, along the view.
	const behind =
		(ryuCurveCenter.value.x - eye.x) * forward[0] +
		(ryuCurveCenter.value.y - eye.z) * forward[1];
	let best = -Math.PI / 2;
	for (let along = 0; along <= 140; along += 2) {
		const elevation = Math.atan2(-k * along * along - eye.y, along + behind);
		best = Math.max(best, elevation);
	}
	return best;
}

/** Zenith and horizon colors; the horizon doubles as the fog color. */
export function skyColors(theme: Scene3dTheme): {
	horizon: string;
	top: string;
} {
	return { horizon: theme.skyHorizon, top: theme.skyZenith };
}

/**
 * A gradient dome that follows the camera. Its gradient spans the band of
 * sky between the curved horizon and the top of the view, so the deep blue
 * always crowns the frame however the camera is tilted.
 */
export function SkyDome({
	reducedMotion,
	theme,
}: {
	reducedMotion: boolean;
	theme: Scene3dTheme;
}) {
	const ref = useRef<Group>(null);
	const material = useRef<ShaderMaterial>(null);
	const scratch = useRef<Vector3 | null>(null);
	const uniforms = useMemo(
		() => ({
			diskColor: { value: [...theme.sunDisk] },
			diskDir: { value: { x: 0.37, y: 0.18, z: -0.91 } },
			diskSize: { value: theme.night ? 0.9984 : 0.999_55 },
			glow: { value: linearRgb(theme.skyGlow) },
			horizon: { value: linearRgb(theme.skyHorizon) },
			horizonElev: { value: -0.2 },
			night: { value: theme.night ? 1 : 0 },
			span: { value: 0.3 },
			time: { value: 0 },
			zenith: { value: linearRgb(theme.skyZenith) },
		}),
		[theme]
	);
	useBoundUniforms(material, uniforms);
	useFrame(({ camera, clock }) => {
		ref.current?.position.copy(camera.position);
		scratch.current ??= camera.position.clone();
		const dir = camera.getWorldDirection(scratch.current);
		const flat = Math.hypot(dir.x, dir.z) || 1;
		const forward: [number, number] = [dir.x / flat, dir.z / flat];
		const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
		const halfFov =
			"fov" in camera ? (((camera.fov as number) / 2) * Math.PI) / 180 : 0.35;
		const horizon = horizonElevation(camera.position, forward);
		const top = pitch + halfFov;
		const span = Math.max(0.14, top - horizon);
		uniforms.horizonElev.value = horizon;
		uniforms.span.value = span;
		SKY_BAND.horizon = horizon;
		SKY_BAND.span = span;
		uniforms.time.value = reducedMotion ? 0 : clock.elapsedTime;
		// The sun hangs up and to the right of the view, the moon up and a
		// little to the left (clear of the minimap),
		// two thirds of the way up the visible sky.
		const yaw =
			Math.atan2(forward[0], -forward[1]) + (theme.night ? -0.24 : 0.38);
		const elevation = horizon + span * (theme.night ? 0.6 : 0.66);
		const disk = uniforms.diskDir.value;
		disk.x = Math.sin(yaw) * Math.cos(elevation);
		disk.y = Math.sin(elevation);
		disk.z = -Math.cos(yaw) * Math.cos(elevation);
	}, -0.5);
	return (
		<group ref={ref}>
			<mesh frustumCulled={false} renderOrder={-1}>
				<sphereGeometry args={[400, 32, 16]} />
				<shaderMaterial
					depthWrite={false}
					fog={false}
					fragmentShader={SKY_FRAGMENT}
					ref={material}
					side={BACK_SIDE}
					uniforms={uniforms}
					vertexShader={SKY_VERTEX}
				/>
			</mesh>
		</group>
	);
}

/**
 * Cumulus banks, placed in the sky the camera sees: yaw from straight ahead
 * (degrees, + to the right), height as a share of the visible sky band, and
 * angular width and height (degrees). The follow camera always frames the
 * first four fully, clear of the sun at the upper right; the rest wait to
 * the sides and behind for when the view is turned.
 */
const CLOUD_BANKS: readonly {
	/** Towering banks sit on the horizon, their feet behind the trees. */
	big?: boolean;
	height: number;
	rise: number;
	width: number;
	yaw: number;
}[] = [
	// Two towering banks framing the horizon left and right of the village.
	// The middle bank floats clear of the trees, so the curved horizon
	// shows as a strip of sea and sky between the tree line and the clouds.
	{ big: true, height: 8.5, rise: 0.5, width: 22, yaw: -30 },
	{ height: 3.4, rise: 1.15, width: 18, yaw: -2 },
	{ big: true, height: 5, rise: 0.5, width: 16, yaw: 33 },
	{ height: 3.2, rise: 1.5, width: 11, yaw: -14 },
	{ height: 2.6, rise: 1.65, width: 8, yaw: 12 },
	{ big: true, height: 7, rise: 0.44, width: 22, yaw: 80 },
	{ big: true, height: 7.5, rise: 0.44, width: 24, yaw: -84 },
	{ big: true, height: 8, rise: 0.44, width: 28, yaw: 145 },
	{ big: true, height: 7, rise: 0.44, width: 26, yaw: -150 },
];
/** How far out the cloud puffs stand, inside the sky dome. */
const CLOUD_RADIUS = 160;
/** Ink outline width, as a share of the distance from the lens. */
const CLOUD_INK = 0.0016;

interface CloudPuff {
	/** Across the bank and up from its base, in units of its height. */
	across: number;
	bank: number;
	size: number;
	up: number;
}

/** A cumulus bank: a flat base row, a domed middle and a tower or two. */
function cloudPuffs(): CloudPuff[] {
	const puffs: CloudPuff[] = [];
	for (const [bank, spec] of CLOUD_BANKS.entries()) {
		const aspect = spec.width / spec.height;
		const base = Math.max(4, Math.round(aspect * 1.6));
		for (let index = 0; index < base; index++) {
			const t = index / (base - 1) - 0.5;
			puffs.push({
				across: t * (aspect - 0.6),
				bank,
				size: 0.34 + jitter(bank, index, 3) * 0.08,
				up: 0.18,
			});
		}
		const domes = Math.max(3, Math.round(aspect * 0.9));
		for (let index = 0; index < domes; index++) {
			const t = index / (domes - 1) - 0.5;
			const peak = 1 - Math.abs(t) * 1.5;
			puffs.push({
				across: t * (aspect - 1.2) + (jitter(bank, index, 5) - 0.5) * 0.3,
				bank,
				size: 0.38 + peak * 0.14 + jitter(bank, index, 7) * 0.08,
				up: 0.45 + peak * 0.22,
			});
		}
		// The tower, a little off center.
		puffs.push({
			across: (jitter(bank, 9, 2) - 0.5) * aspect * 0.35,
			bank,
			size: 0.4,
			up: 0.78,
		});
	}
	return puffs;
}

const CLOUD_VERTEX = /* glsl */ `
uniform float uPush;
varying vec3 vNormal;
varying vec3 vView;
void main() {
	mat4 model = modelMatrix * instanceMatrix;
	vec3 n = normalize(mat3(model) * normal);
	vec4 world = model * vec4(position, 1.0);
	world.xyz += n * uPush * distance(cameraPosition, world.xyz);
	vNormal = n;
	vView = cameraPosition - world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}`;

/**
 * Cel-shaded cumulus: sunlit warm-white tops, lavender-blue shadow sides
 * (never grey) through a soft two-step ramp, and a bright rim where the
 * edge faces the sun.
 */
const CLOUD_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uUnder;
uniform vec3 uInk;
uniform vec3 uSun;
uniform float uPush;
varying vec3 vNormal;
varying vec3 vView;
void main() {
	if (uPush > 0.0) {
		gl_FragColor = vec4(uInk, 1.0);
		return;
	}
	vec3 n = normalize(vNormal);
	float up = dot(n, normalize(vec3(uSun.x * 0.6, 1.0, uSun.z * 0.6)));
	float w = fwidth(up) * 0.8 + 0.002;
	float lit = smoothstep(-0.18 - w, -0.18 + w, up);
	float mid = smoothstep(0.38 - w, 0.38 + w, up);
	vec3 col = mix(uUnder, mix(uTop * 0.93, uTop, mid), lit);
	float facing = 1.0 - abs(dot(n, normalize(vView)));
	float rim = smoothstep(0.55, 0.85, facing) * smoothstep(-0.2, 0.5, dot(n, uSun));
	gl_FragColor = vec4(col + vec3(0.1, 0.09, 0.07) * rim, 1.0);
}`;

/**
 * Big cel-shaded cumulus banks with ink outlines, standing in the band of
 * sky between the curved horizon and the top of the view (they travel with
 * the camera, like the sky, so they never sink behind the bend).
 */
export function Clouds({
	reducedMotion,
	theme,
}: {
	reducedMotion: boolean;
	theme: Scene3dTheme;
}) {
	const body = useRef<InstancedMesh>(null);
	const ink = useRef<InstancedMesh>(null);
	const bodyMaterial = useRef<ShaderMaterial>(null);
	const inkMaterial = useRef<ShaderMaterial>(null);
	const drift = useRef(0);
	const placed = useRef({ horizon: Number.NaN, span: 0, x: 0, y: 0, z: 0 });
	const puffs = useMemo(() => cloudPuffs(), []);
	const sun = sunDirection(theme);
	const sunLength = Math.hypot(...sun);
	const shared = useMemo(
		() => ({
			uInk: { value: linearRgb(TOON_LIGHT.cloudInk) },
			uSun: {
				value: {
					x: sun[0] / sunLength,
					y: sun[1] / sunLength,
					z: sun[2] / sunLength,
				},
			},
			uTop: { value: [1.12, 1.08, 1.0] },
			uUnder: { value: linearRgb(TOON_LIGHT.cloudUnder) },
		}),
		[sun, sunLength]
	);
	const bodyUniforms = useMemo(
		() => ({ ...shared, uPush: { value: 0 } }),
		[shared]
	);
	const inkUniforms = useMemo(
		() => ({ ...shared, uPush: { value: CLOUD_INK } }),
		[shared]
	);
	useBoundUniforms(bodyMaterial, bodyUniforms);
	useBoundUniforms(inkMaterial, inkUniforms);
	useFrame(({ camera }, delta) => {
		const mesh = body.current;
		if (!mesh) {
			return;
		}
		if (!reducedMotion) {
			drift.current += delta * 0.12;
		}
		const last = placed.current;
		const { x, y, z } = camera.position;
		const moved =
			Math.abs(last.horizon - SKY_BAND.horizon) > 0.0015 ||
			Math.abs(last.span - SKY_BAND.span) > 0.0015 ||
			Math.hypot(last.x - x, last.y - y, last.z - z) > 0.05 ||
			!reducedMotion;
		if (!moved) {
			return;
		}
		placed.current = {
			horizon: SKY_BAND.horizon,
			span: SKY_BAND.span,
			x,
			y,
			z,
		};
		const { matrix, position, scale } = mathKit(mesh);
		const degree = Math.PI / 180;
		for (const [index, puff] of puffs.entries()) {
			const bank = CLOUD_BANKS[puff.bank];
			if (!bank) {
				continue;
			}
			const height = bank.height * degree;
			// Big banks stand on the tree line (about half way up the band
			// over the curved ground's horizon), their base row sunk behind it.
			const rise = bank.big
				? SKY_BAND.horizon + SKY_BAND.span * bank.rise - height * 0.3
				: SKY_BAND.horizon +
					Math.max(height * 0.25, SKY_BAND.span * bank.rise - height * 0.5);
			const yaw =
				(bank.yaw + drift.current * (puff.bank % 2 === 0 ? 1 : -1) * 0.2) *
					degree +
				puff.across * height;
			const elevation = rise + puff.up * height;
			const radius = puff.size * height * CLOUD_RADIUS;
			position.set(
				x + Math.sin(yaw) * Math.cos(elevation) * CLOUD_RADIUS,
				y + Math.sin(elevation) * CLOUD_RADIUS,
				z - Math.cos(yaw) * Math.cos(elevation) * CLOUD_RADIUS
			);
			// Flatter at the base, rounder up top.
			scale.set(radius * 1.15, radius * (puff.up < 0.3 ? 0.7 : 0.95), radius);
			matrix.makeScale(scale.x, scale.y, scale.z).setPosition(position);
			mesh.setMatrixAt(index, matrix);
		}
		mesh.instanceMatrix.needsUpdate = true;
		const hull = ink.current;
		if (hull && hull.instanceMatrix !== mesh.instanceMatrix) {
			hull.instanceMatrix = mesh.instanceMatrix;
		}
	}, -0.45);
	return (
		<group>
			<instancedMesh
				args={[undefined, undefined, puffs.length]}
				frustumCulled={false}
				ref={ink}
				renderOrder={-0.5}
			>
				<sphereGeometry args={[1, 18, 12]} />
				<shaderMaterial
					depthWrite={false}
					fog={false}
					fragmentShader={CLOUD_FRAGMENT}
					ref={inkMaterial}
					side={BACK_SIDE}
					uniforms={inkUniforms}
					vertexShader={CLOUD_VERTEX}
				/>
			</instancedMesh>
			<instancedMesh
				args={[undefined, undefined, puffs.length]}
				frustumCulled={false}
				ref={body}
				renderOrder={-0.4}
			>
				<sphereGeometry args={[1, 18, 12]} />
				<shaderMaterial
					fog={false}
					fragmentShader={CLOUD_FRAGMENT}
					ref={bodyMaterial}
					uniforms={bodyUniforms}
					vertexShader={CLOUD_VERTEX}
				/>
			</instancedMesh>
		</group>
	);
}

/**
 * Soft round sprite (pollen, fireflies, lamp glow) drawn once on a small
 * canvas; each user wraps it in its own `<canvasTexture>`.
 */
export function useGlowCanvas(): HTMLCanvasElement | null {
	return useMemo(() => {
		if (typeof document === "undefined") {
			return null;
		}
		const canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 64;
		const context = canvas.getContext("2d");
		if (!context) {
			return null;
		}
		const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
		gradient.addColorStop(0, hexAlpha(ART_WHITE, 1));
		gradient.addColorStop(0.3, hexAlpha(ART_WHITE, 0.6));
		gradient.addColorStop(1, hexAlpha(ART_WHITE, 0));
		context.fillStyle = gradient;
		context.fillRect(0, 0, 64, 64);
		return canvas;
	}, []);
}

/**
 * Light motes: pollen and sparkles drifting in the sun by day, fireflies
 * blinking low over the grass at night. Bright enough to bloom.
 */
export function Glimmers({
	count,
	glow,
	height,
	spots = [],
	theme,
	width,
}: {
	count: number;
	glow: HTMLCanvasElement | null;
	height: number;
	/** Places most motes gather around (lamps and flower beds at night). */
	spots?: readonly Vec3[];
	theme: Scene3dTheme;
	width: number;
}) {
	const ref = useRef<Points>(null);
	const fireflies = theme.night;
	const color = theme.glimmer;
	const seeds = useMemo(
		() =>
			Array.from({ length: count }, (_, index) => {
				const spot =
					spots.length > 0 && index % 3 !== 0
						? spots[index % spots.length]
						: undefined;
				const x = spot
					? spot[0] + (jitter(index, 1, 7) - 0.5) * 2.6
					: (jitter(index, 1, 7) - 0.5) * (width + 4);
				const z = spot
					? spot[2] + (jitter(index, 3, 9) - 0.5) * 2.2
					: (jitter(index, 3, 9) - 0.5) * (height + 4);
				return {
					phase: jitter(index, 5, 3) * Math.PI * 2,
					x,
					y:
						(fireflies ? 0.3 : 0.6) +
						jitter(index, 2, 8) * (fireflies ? 1.2 : 2.6),
					z,
				};
			}),
		[count, fireflies, height, spots, width]
	);
	const positions = useMemo(() => {
		const array = new Float32Array(count * 3);
		for (const [index, seed] of seeds.entries()) {
			array.set([seed.x, seed.y, seed.z], index * 3);
		}
		return array;
	}, [count, seeds]);
	useFrame(({ clock }) => {
		const points = ref.current;
		if (!points) {
			return;
		}
		const time = clock.elapsedTime;
		const attribute = points.geometry.getAttribute("position");
		const drift = fireflies ? 0.6 : 1.4;
		for (const [index, seed] of seeds.entries()) {
			attribute.setXYZ(
				index,
				seed.x + Math.sin(time * 0.3 + seed.phase) * drift,
				seed.y +
					Math.sin(time * (fireflies ? 1.1 : 0.5) + seed.phase * 2) * 0.25,
				seed.z + Math.cos(time * 0.25 + seed.phase) * drift
			);
		}
		attribute.needsUpdate = true;
		const material = points.material;
		if (!Array.isArray(material)) {
			material.opacity = fireflies
				? 0.75 + Math.sin(time * 2.2) * 0.25
				: 0.8 + Math.sin(time * 0.9) * 0.15;
		}
	});
	if (!glow || count === 0) {
		return null;
	}
	return (
		<points frustumCulled={false} ref={ref}>
			<bufferGeometry>
				<bufferAttribute args={[positions, 3]} attach="attributes-position" />
			</bufferGeometry>
			<CurvedPointsMaterial
				blending={ADDITIVE_BLENDING}
				color={[...color]}
				depthWrite={false}
				size={fireflies ? 0.3 : 0.1}
				sizeAttenuation
				toneMapped={false}
				transparent
			>
				<canvasTexture args={[glow]} attach="map" />
			</CurvedPointsMaterial>
		</points>
	);
}
