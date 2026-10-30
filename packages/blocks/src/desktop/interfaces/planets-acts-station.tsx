/* eslint-disable react/no-unknown-property */

import { useFrame } from "@react-three/fiber";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { type ReactNode, type RefObject, useRef } from "react";
import type { Group } from "three";
import { isRedBlocker, type YouSlot } from "./game3d-acts.ts";
import {
	type ActSim,
	STATION_DEPTH,
	STATION_UNIT_PX,
	screenPoint,
	type Vec3,
} from "./planets-acts-layout.ts";
import { FOV, type Planet } from "./planets-model.ts";
import { PLANETS_ACT } from "./planets-palette.ts";

/** The Planets act layer's station and planet-sign meshes (see planets-acts.tsx). */

export const tint = (color: string, opacity = 1) => (
	<meshBasicMaterial
		color={color}
		opacity={opacity}
		toneMapped={false}
		transparent={opacity < 1}
	/>
);

/**
 * Holds the station's group in front of the camera at its anchor: each
 * frame after the camera moves (priority -1, mounted after the camera
 * rig), at a fixed depth and a fixed pixel scale.
 */
export function StationRig({
	anchor,
	rig,
}: {
	anchor: [number, number];
	rig: RefObject<Group | null>;
}) {
	useFrame(({ camera, size }) => {
		const group = rig.current;
		if (!group || size.height <= 0) {
			return;
		}
		const x = size.width - anchor[0];
		const y = size.height - anchor[1];
		const ray = camera.position.clone();
		ray
			.set((x / size.width) * 2 - 1, 1 - (y / size.height) * 2, 0.5)
			.unproject(camera)
			.sub(camera.position)
			.normalize();
		const forward = camera.getWorldDirection(camera.position.clone());
		const along = STATION_DEPTH / Math.max(0.2, ray.dot(forward));
		group.position.copy(camera.position).addScaledVector(ray, along);
		group.quaternion.copy(camera.quaternion);
		const perPx =
			(2 * STATION_DEPTH * Math.tan(((FOV / 2) * Math.PI) / 180)) / size.height;
		group.scale.setScalar(perPx * STATION_UNIT_PX);
	}, -1);
	return null;
}

/**
 * The station's hull: a truss through the berths, pads and solar wings (a
 * phone's strip: a spine down the berths, without wings).
 */
export function StationHull({ berths }: { berths: Record<YouSlot, Vec3> }) {
	const points = Object.values(berths);
	const xs = points.map((point) => point[0]);
	const ys = [...new Set(points.map((point) => point[1]))];
	const strip = new Set(xs).size === 1;
	const left = Math.min(...xs) - 1.2;
	const right = Math.max(...xs) + 1.2;
	const top = Math.max(...ys) - 0.45;
	const bottom = Math.min(...ys) - 0.45;
	const pads = points.map((point) => (
		<mesh
			key={`pad-${point[0]}:${point[1]}`}
			position={[point[0], point[1] - 0.45, 0]}
		>
			<boxGeometry args={[1.1, 0.24, 0.5]} />
			{tint(PLANETS_ACT.berth)}
		</mesh>
	));
	if (strip) {
		const x = xs[0] ?? 0;
		return (
			<group>
				<mesh position={[x, (top + bottom) / 2, -0.3]}>
					<boxGeometry args={[0.16, top - bottom, 0.16]} />
					{tint(PLANETS_ACT.hullDark)}
				</mesh>
				{pads}
			</group>
		);
	}
	return (
		<group>
			{ys.map((y) => (
				<mesh key={`truss-${y}`} position={[(left + right) / 2, y - 0.45, 0]}>
					<boxGeometry args={[right - left, 0.16, 0.16]} />
					{tint(PLANETS_ACT.hullDark)}
				</mesh>
			))}
			{/* The solar wings at both ends. */}
			{[left - 0.55, right + 0.55].map((x) => (
				<mesh key={`wing-${x}`} position={[x, ys[0] ?? 0, -0.1]}>
					<boxGeometry args={[0.9, 1.6, 0.04]} />
					{tint(PLANETS_ACT.satellitePanel)}
				</mesh>
			))}
			{pads}
			<mesh position={[(left + right) / 2, top, -0.2]}>
				<cylinderGeometry args={[0.55, 0.55, 0.5, 16]} />
				{tint(PLANETS_ACT.hull)}
			</mesh>
		</group>
	);
}

/** A ring light round a berth that drains (clockwise) as the ask waits. */
export function RingLight({ at, level }: { at: Vec3; level: number }) {
	const arc = Math.max(0.08, Math.min(1, level)) * Math.PI * 2;
	return (
		<group position={at}>
			<mesh>
				<torusGeometry args={[0.62, 0.035, 6, 40]} />
				{tint(PLANETS_ACT.berth, 0.7)}
			</mesh>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<torusGeometry args={[0.62, 0.07, 6, 40, arc]} />
				{tint(level < 0.25 ? PLANETS_ACT.ringLow : PLANETS_ACT.ringLight)}
			</mesh>
		</group>
	);
}

/** A probe: a small body with two panels, in its ask kind's colour. */
function ProbeShape({ color }: { color: string }) {
	return (
		<group>
			<mesh>
				<boxGeometry args={[0.36, 0.36, 0.36]} />
				{tint(color)}
			</mesh>
			{[-0.42, 0.42].map((x) => (
				<mesh key={x} position={[x, 0, 0]}>
					<boxGeometry args={[0.42, 0.2, 0.03]} />
					{tint(PLANETS_ACT.satellitePanel)}
				</mesh>
			))}
		</group>
	);
}

const LAUNCH_SECONDS = 1.6;
/** A probe leaving its planet spans this share of the planet's width. */
const LAUNCH_SHARE = 0.55;
/** The probe's span in its own units (body and both panels). */
const PROBE_SPAN = 1.26;

/**
 * A probe flying from its planet to its berth (in the world, so it crosses
 * the sky), then docked. It leaves at a size set by its planet's drawn
 * width and grows on screen, steadily, to its berth's size (the station is
 * far nearer the camera than the planets, so the size eases in pixels, not
 * in world units). Reduced motion docks it at once.
 */
export function ProbeFlight({
	agentId,
	berth,
	color,
	radius,
	reduced,
	rig,
	sim,
}: {
	agentId: string;
	berth: Vec3;
	color: string;
	/** The planet's radius (before the overview swell). */
	radius: number;
	reduced: boolean;
	rig: RefObject<Group | null>;
	sim: RefObject<ActSim>;
}) {
	const probe = useRef<Group>(null);
	const start = useRef<number | null>(null);
	useFrame(({ camera, clock, size }) => {
		const group = probe.current;
		const station = rig.current;
		const home = sim.current.positions.get(agentId);
		if (!(group && station) || size.height <= 0) {
			return;
		}
		start.current ??= clock.elapsedTime;
		const t = reduced
			? 1
			: Math.min(1, (clock.elapsedTime - start.current) / LAUNCH_SECONDS);
		const eased = 1 - (1 - t) ** 3;
		const docked = group.position.clone().set(...berth);
		station.localToWorld(docked);
		const from = home ?? [docked.x, docked.y, docked.z];
		group.position.set(
			from[0] + (docked.x - from[0]) * eased,
			from[1] + (docked.y - from[1]) * eased,
			from[2] + (docked.z - from[2]) * eased
		);
		group.quaternion.copy(station.quaternion);
		// World units per pixel at a point's depth in front of the camera.
		const forward = camera.getWorldDirection(docked.clone());
		const halfTan = Math.tan(((FOV / 2) * Math.PI) / 180);
		const perPx = (x: number, y: number, z: number) =>
			(2 *
				Math.max(
					0.1,
					(x - camera.position.x) * forward.x +
						(y - camera.position.y) * forward.y +
						(z - camera.position.z) * forward.z
				) *
				halfTan) /
			size.height;
		const startUnitPx =
			(2 * radius * sim.current.bodyScale * LAUNCH_SHARE) /
			PROBE_SPAN /
			perPx(from[0], from[1], from[2]);
		const unitPx = startUnitPx + (STATION_UNIT_PX - startUnitPx) * eased;
		const at = group.position;
		group.scale.setScalar(unitPx * perPx(at.x, at.y, at.z));
		group.visible = home !== undefined || t >= 1;
	}, -1);
	return (
		<group ref={probe}>
			<ProbeShape color={color} />
		</group>
	);
}

const BLINK_SECONDS = 0.9;

/** The cargo capsule of a ready answer: it blinks while unread. */
export function CargoCapsule({ at, reduced }: { at: Vec3; reduced: boolean }) {
	const light = useRef<Group>(null);
	useFrame(({ clock }) => {
		if (light.current) {
			light.current.visible =
				reduced || Math.floor(clock.elapsedTime / BLINK_SECONDS) % 2 === 0;
		}
	});
	return (
		<group position={[at[0] - 1.05, at[1] + 0.3, at[2]]}>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<capsuleGeometry args={[0.24, 0.5, 4, 10]} />
				{tint(PLANETS_ACT.capsule)}
			</mesh>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<torusGeometry args={[0.25, 0.05, 6, 16]} />
				{tint(PLANETS_ACT.capsuleBand)}
			</mesh>
			<group ref={light}>
				<mesh position={[0, 0.38, 0]}>
					<sphereGeometry args={[0.09, 10, 8]} />
					{tint(PLANETS_ACT.ringLight)}
				</mesh>
			</group>
		</group>
	);
}

/**
 * Follows a planet each frame: its centre, scaled to its drawn radius, so
 * the pieces inside are placed in planet radii.
 */
export function PlanetFollow({
	children,
	planet,
	sim,
}: {
	children: ReactNode;
	planet: Planet;
	sim: RefObject<ActSim>;
}) {
	const group = useRef<Group>(null);
	useFrame(() => {
		const node = group.current;
		const at = sim.current.positions.get(planet.id);
		if (!(node && at)) {
			return;
		}
		node.position.set(...at);
		node.scale.setScalar(planet.radius * sim.current.bodyScale);
	}, -1);
	return <group ref={group}>{children}</group>;
}

/** A satellite on an orbit marker round a working world (still when reduced). */
function WorkingSatellite({
	reduced,
	tilt,
}: {
	reduced: boolean;
	tilt: number;
}) {
	const spin = useRef<Group>(null);
	useFrame((_, delta) => {
		if (spin.current && !reduced) {
			spin.current.rotation.y += Math.min(delta, 0.1) * 0.8;
		}
	});
	return (
		<group rotation={[tilt, 0, 0.2]}>
			<mesh rotation={[Math.PI / 2, 0, 0]}>
				<torusGeometry args={[1.55, 0.025, 4, 64]} />
				{tint(PLANETS_ACT.satellite, 0.55)}
			</mesh>
			<group ref={spin} rotation={[0, 0.9, 0]}>
				<group position={[1.55, 0, 0]} scale={0.32}>
					<ProbeShape color={PLANETS_ACT.satellite} />
				</group>
			</group>
		</group>
	);
}

/** The signs at a planet for its act: storm band, dark moon, eclipse, satellite. */
export function PlanetSigns({
	act,
	azimuth,
	column,
	reduced,
}: {
	act: InterfaceAgentAct;
	azimuth: number;
	column: boolean;
	reduced: boolean;
}) {
	const failed = act.blockers.some((blocker) => isRedBlocker(blocker));
	const interrupted =
		!failed && act.blockers.some((blocker) => blocker.kind === "interrupted");
	return (
		<group>
			{failed ? (
				<mesh rotation={[Math.PI / 2 - 0.25, 0, 0]}>
					<torusGeometry args={[1.04, 0.11, 8, 48]} />
					{tint(PLANETS_ACT.storm, 0.9)}
				</mesh>
			) : null}
			{interrupted ? (
				<mesh position={screenPoint(azimuth, column, 1.25, 0.85, 0.4)}>
					<sphereGeometry args={[0.3, 16, 12]} />
					{tint(PLANETS_ACT.darkMoon)}
				</mesh>
			) : null}
			{act.act === "limited" ? (
				// The eclipse: a shadow drawn over the near face of the world.
				<mesh position={screenPoint(azimuth, column, 0.45, 0.1, 0.6)}>
					<sphereGeometry args={[0.92, 24, 16]} />
					{tint(PLANETS_ACT.eclipse, 0.62)}
				</mesh>
			) : null}
			{act.act === "working" && !act.stalled ? (
				<WorkingSatellite reduced={reduced} tilt={column ? 0.4 : 0.15} />
			) : null}
		</group>
	);
}

/** A progress pip's radius on screen, px. */
