/* eslint-disable react/no-unknown-property */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { DirectionalLight } from "three";
import { ISLAND_MARGIN } from "./game3d-island.ts";
import { FILL_DIRECTION, FILL_INTENSITY } from "./game3d-lawn.ts";
import { CurvedPointsMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, jitter } from "./game3d-math.ts";
import {
	type Scene3dTheme,
	sunDirection,
	type Vec3,
} from "./game3d-palette.ts";

/**
 * Sky light plus one shadow-casting sun (or moon), its shadow camera fitted
 * to the island so the whole diorama gets crisp, soft-edged shadows. The
 * cel ramp turns them into clean bands; the shared shade tint keeps the
 * shaded side cool blue or purple, never black.
 */
export function SceneLights({
	shadowMap,
	span,
	theme,
}: {
	shadowMap: number;
	span: number;
	theme: Scene3dTheme;
}) {
	const sun = useRef<DirectionalLight>(null);
	const reach = span / 2 + ISLAND_MARGIN + 2;
	const direction = sunDirection(theme);
	const position: Vec3 = [
		direction[0] * 30,
		direction[1] * 30,
		direction[2] * 30,
	];
	useEffect(() => {
		const light = sun.current;
		if (!light) {
			return;
		}
		const camera = light.shadow.camera;
		camera.left = -reach;
		camera.right = reach;
		camera.top = reach;
		camera.bottom = -reach;
		camera.near = 1;
		camera.far = 90;
		camera.updateProjectionMatrix();
		light.shadow.needsUpdate = true;
	}, [reach]);
	const mapSize = span > 24 ? shadowMap * 2 : shadowMap;
	return (
		<>
			<hemisphereLight
				args={[theme.hemiSky, theme.hemiGround, theme.hemiIntensity]}
			/>
			<ambientLight intensity={theme.ambient} />
			<directionalLight
				castShadow
				color={theme.sunColor}
				intensity={theme.sunIntensity}
				position={position}
				ref={sun}
				shadow-bias={-0.0004}
				shadow-mapSize={[mapSize, mapSize]}
				shadow-normalBias={0.03}
				shadow-radius={3}
			/>
			{theme.fillLight ? (
				// Soft moonlit fill from the camera side keeps faces readable;
				// near neutral, so the night is indigo without turning every
				// color blue.
				<directionalLight
					color={theme.fillLight}
					intensity={FILL_INTENSITY}
					position={[...FILL_DIRECTION]}
				/>
			) : null}
		</>
	);
}

const STAR_COUNT = 160;

/**
 * Night: stars mirrored on the still sea around the island, so the frame
 * reads as a starry night even looking down.
 */
export function SeaStars({
	glow,
	span,
}: {
	glow: HTMLCanvasElement | null;
	span: number;
}) {
	const positions = useMemo(() => {
		const buffer = new Float32Array(STAR_COUNT * 3);
		const reach = span * 1.6 + 12;
		for (let index = 0; index < STAR_COUNT; index++) {
			const angle = jitter(index, 5, 1) * Math.PI * 2;
			const radius = span / 2 + 3 + jitter(index, 7, 3) * reach;
			buffer.set(
				[Math.cos(angle) * radius, -0.9, Math.sin(angle) * radius],
				index * 3
			);
		}
		return buffer;
	}, [span]);
	if (!glow) {
		return null;
	}
	return (
		<points frustumCulled={false}>
			<bufferGeometry>
				<bufferAttribute args={[positions, 3]} attach="attributes-position" />
			</bufferGeometry>
			<CurvedPointsMaterial
				blending={ADDITIVE_BLENDING}
				color={[1.6, 1.6, 1.9]}
				depthWrite={false}
				opacity={0.8}
				size={4}
				sizeAttenuation={false}
				toneMapped={false}
				transparent
			>
				<canvasTexture args={[glow]} attach="map" />
			</CurvedPointsMaterial>
		</points>
	);
}

/** Calls `onReady` once the first frame is on the canvas. */
export function FirstFrame({ onReady }: { onReady: () => void }) {
	const done = useRef(false);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		invalidate();
	}, [invalidate]);
	useFrame(() => {
		if (done.current) {
			return;
		}
		done.current = true;
		setTimeout(onReady, 0);
	});
	return null;
}

/** Keeps a demand-driven canvas drawing while it animates. */
export function KeepDrawing({ active }: { active: boolean }) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		if (active) {
			invalidate();
		}
	}, [active, invalidate]);
	return null;
}
