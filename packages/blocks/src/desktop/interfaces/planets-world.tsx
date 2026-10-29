/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { type RefObject, useMemo, useRef } from "react";
import type { Group } from "three";
import { type CottageSpec, Cottages, doorWood } from "./game3d-cottages.tsx";
import { ToonMaterial } from "./game3d-materials.tsx";
import {
	type AgentSwatch,
	type Scene3dTheme,
	sunDirection,
	type Vec3,
} from "./game3d-palette.ts";
import { type PlantedTree, TreeGrove } from "./game3d-props.tsx";
import { CURVE_UNIFORMS, FADE_UNIFORMS, setLook } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import type { Planet } from "./planets-model.ts";
import { PLANET_WORLD_ART, type PlanetsPalette } from "./planets-palette.ts";

/**
 * The toon pieces of the Planets orrery, drawn with the game kit: the
 * light the kit's cel materials need, the little world on top of each
 * planet (a grassy cap with the agent's cottage, two trees and the agent's
 * villager standing on it), and the friendly star's face and petal rays.
 */

/** The kit's light, for the kit pieces riding on the planets. */
export function PlanetsKitLight({ theme }: { theme: Scene3dTheme }) {
	// The orrery is flat (no world bend, no fade) and lit like the dioramas.
	CURVE_UNIFORMS.ryuCurve.value = 0;
	FADE_UNIFORMS.ryuFadeRadius.value = 0;
	FADE_UNIFORMS.ryuFadeNear.value = 0;
	const sun = sunDirection(theme);
	useMemo(() => setLook({ ...theme, sun }), [sun, theme]);
	return (
		<>
			<hemisphereLight
				args={[theme.hemiSky, theme.hemiGround, theme.hemiIntensity]}
			/>
			<ambientLight intensity={theme.ambient} />
			<directionalLight
				color={theme.sunColor}
				intensity={theme.sunIntensity}
				position={[sun[0] * 40, sun[1] * 40, sun[2] * 40]}
			/>
		</>
	);
}

/** How a planet's villager stands: working, waving at you, or idle. */
export function planetPose(planet: Planet): VillagerPose {
	if (planet.counts.attention > 0) {
		return "failed";
	}
	if (planet.counts["your-turn"] > 0) {
		return "needs-you";
	}
	return planet.working ? "working" : "idle";
}

/** The cap's half-angle from the pole: how much of the top is grass. */
const CAP = 0.7;
/** The world on top, in villager units, is this share of the radius. */
const WORLD_SCALE = 0.54;

/** How far a spot `away` from the pole sinks below the top of a sphere. */
function sink(radius: number, away: number): number {
	return radius - Math.sqrt(Math.max(0, radius * radius - away * away));
}

export function PlanetTop({
	looks,
	night,
	palette,
	planet,
	reduced,
	swatch,
	theme,
}: {
	looks: MemberLooks | undefined;
	night: boolean;
	palette: PlanetsPalette;
	planet: Planet;
	reduced: boolean;
	swatch: AgentSwatch;
	theme: Scene3dTheme;
}) {
	const art = PLANET_WORLD_ART[palette.mode];
	const { radius } = planet;
	const turn = useRef<Group>(null);
	// The little world turns to face the camera (its door and villager
	// toward the viewer), wherever the planet is on its orbit.
	useFrame(({ camera }) => {
		const group = turn.current;
		const at = group?.parent?.matrixWorld.elements;
		if (!(group && at)) {
			return;
		}
		group.rotation.y = Math.atan2(
			camera.position.x - (at[12] ?? 0),
			camera.position.z - (at[14] ?? 0)
		);
	});
	const k = radius * WORLD_SCALE;
	// The sphere's radius in villager units, to settle things on the curve.
	const r = radius / k;
	const cottages = useMemo<CottageSpec[]>(
		() => [
			{
				chimneySide: 1,
				door: doorWood(planet.index * 7 + 3),
				lit: planet.working || night,
				origin: [-0.55, -sink(r, 0.75), -0.45],
				porch: false,
				scale: 0.42,
				seed: planet.index * 13 + 5,
				swatch,
			},
		],
		[night, planet.index, planet.working, r, swatch]
	);
	const trees = useMemo<PlantedTree[]>(
		() => [
			{
				at: [1.05, -sink(r, 1.15), -0.45],
				kind: planet.index % 2 === 0 ? "cedar" : "fruit",
				scale: 0.55,
				seed: planet.index * 31 + 1,
			},
			{
				at: [-1.25, -sink(r, 1.3), 0.5],
				kind: "blossom",
				scale: 0.45,
				seed: planet.index * 17 + 9,
			},
		],
		[planet.index, r]
	);
	const villagers = useMemo<VillagerSpec[]>(
		() =>
			looks
				? [
						{
							id: planet.id,
							label: planet.name,
							looks,
							name: planet.name,
							facing: 0,
							pose: planetPose(planet),
							position: [0.55, -sink(r, 0.9), 0.7],
						},
					]
				: [],
		[looks, planet, r]
	);
	return (
		<group>
			<mesh raycast={() => null}>
				<sphereGeometry
					args={[radius * 1.012, 40, 10, 0, Math.PI * 2, 0, CAP]}
				/>
				<ToonMaterial color={art.cap} />
			</mesh>
			<mesh raycast={() => null}>
				<sphereGeometry
					args={[radius * 1.006, 40, 2, 0, Math.PI * 2, CAP - 0.02, 0.06]}
				/>
				<ToonMaterial color={art.capEdge} />
			</mesh>
			<group position={[0, radius * 1.01, 0]} ref={turn} scale={k}>
				<Cottages
					cottages={cottages}
					lamps={false}
					reducedMotion={reduced}
					theme={theme}
				/>
				<TreeGrove theme={theme} trees={trees} />
				<Villagers
					plates={false}
					reducedMotion={reduced}
					villagers={villagers}
				/>
			</group>
		</group>
	);
}

const RAYS = Array.from({ length: 12 }, (_, index) => index);

/**
 * The star's friendly face and petal rays: a billboard that always looks
 * at the camera, sitting on the star's surface.
 */
export function SunFace({
	palette,
	radius,
	reduced,
	time,
}: {
	palette: PlanetsPalette;
	radius: number;
	reduced: boolean;
	time: RefObject<{ time: number }>;
}) {
	const art = PLANET_WORLD_ART[palette.mode];
	const face = useRef<Group>(null);
	const rays = useRef<Group>(null);
	useFrame(({ camera }) => {
		face.current?.quaternion.copy(camera.quaternion);
		if (rays.current && !reduced) {
			rays.current.rotation.z = time.current.time * 0.12;
		}
	});
	// Spots on the face sit on the sphere: lift them to its surface.
	const onSurface = (x: number, y: number): Vec3 => [
		x * radius,
		y * radius,
		Math.sqrt(Math.max(0, 1 - x * x - y * y)) * radius + radius * 0.01,
	];
	return (
		<group ref={face}>
			<group ref={rays}>
				{RAYS.map((index) => {
					const angle = (index / RAYS.length) * Math.PI * 2;
					const long = index % 2 === 0;
					const reach = radius * (long ? 1.42 : 1.3);
					return (
						<mesh
							key={index}
							position={[
								Math.cos(angle) * reach,
								Math.sin(angle) * reach,
								-radius * 0.2,
							]}
							raycast={() => null}
							rotation={[0, 0, angle - Math.PI / 2]}
							scale={[1, 1, 0.35]}
						>
							<coneGeometry
								args={[radius * 0.2, radius * (long ? 0.5 : 0.36), 4]}
							/>
							<meshBasicMaterial color={long ? art.ray : art.rayTip} />
						</mesh>
					);
				})}
			</group>
			{[-1, 1].map((side) => (
				<group key={side}>
					<mesh
						position={onSurface(0.3 * side, 0.12)}
						raycast={() => null}
						scale={[0.1 * radius, 0.16 * radius, 0.04 * radius]}
					>
						<sphereGeometry args={[1, 16, 12]} />
						<meshBasicMaterial color={art.eye} />
					</mesh>
					<mesh
						position={onSurface(0.47 * side, -0.14)}
						raycast={() => null}
						scale={[0.13 * radius, 0.08 * radius, 0.02 * radius]}
					>
						<sphereGeometry args={[1, 16, 10]} />
						<meshBasicMaterial color={art.cheek} opacity={0.75} transparent />
					</mesh>
				</group>
			))}
			<mesh
				position={onSurface(0, -0.12)}
				raycast={() => null}
				rotation={[0, 0, Math.PI]}
			>
				<torusGeometry args={[radius * 0.2, radius * 0.035, 8, 20, Math.PI]} />
				<meshBasicMaterial color={art.eye} />
			</mesh>
		</group>
	);
}
