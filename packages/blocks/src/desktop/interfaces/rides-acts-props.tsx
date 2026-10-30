/* eslint-disable react/no-unknown-property */
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import type { Group, MeshBasicMaterial } from "three";
import type { Vec3 } from "./game3d-palette.ts";
import { RIDES_ACT_3D } from "./rides-palette.ts";

/**
 * A car broken down: its hazard lights at the four corners, blinking (lit
 * steady under reduced motion). An interrupted run is pulled over, not
 * broken: no hazards (its grey alarm says so).
 */
export function Hazards({ at, reduced }: { at: Vec3; reduced: boolean }) {
	const lamps = useRef<(MeshBasicMaterial | null)[]>([]);
	const invalidate = useThree((state) => state.invalidate);
	// Reduced motion lights them steady, even if a blink left them off.
	useLayoutEffect(() => {
		if (!reduced) {
			return;
		}
		for (const lamp of lamps.current) {
			// Outside a canvas (tests) the ref is not a three.js material.
			lamp?.color?.set(RIDES_ACT_3D.hazard);
		}
		invalidate();
	}, [invalidate, reduced]);
	useFrame(({ clock }) => {
		if (reduced) {
			return;
		}
		const on = Math.floor(clock.elapsedTime * 2) % 2 === 0;
		for (const lamp of lamps.current) {
			lamp?.color.set(on ? RIDES_ACT_3D.hazard : RIDES_ACT_3D.hazardOff);
		}
	});
	const corners: [number, number][] = [
		[-0.32, -0.5],
		[0.32, -0.5],
		[-0.32, 0.5],
		[0.32, 0.5],
	];
	return (
		<group position={at}>
			{corners.map(([x, z], index) => (
				<mesh key={`${x}:${z}`} position={[x, 0.3, z]}>
					<sphereGeometry args={[0.07, 10, 8]} />
					<meshBasicMaterial
						color={RIDES_ACT_3D.hazard}
						ref={(material) => {
							lamps.current[index] = material;
						}}
						toneMapped={false}
					/>
				</mesh>
			))}
		</group>
	);
}

/** Ahead of a car and to its kerb side, along its heading: on the road. */
export function byNose(at: Vec3, yaw: number): Vec3 {
	const side = 0.42;
	const ahead = 0.85;
	return [
		at[0] + side * Math.cos(yaw) + ahead * Math.sin(yaw),
		at[1],
		at[2] - side * Math.sin(yaw) + ahead * Math.cos(yaw),
	];
}

/**
 * A car pulled up at the kerb honks for you: sound arcs off its nose,
 * pulsing, or drawn still under reduced motion.
 */
export function Honk({
	at,
	reduced,
	yaw,
}: {
	at: Vec3;
	reduced: boolean;
	yaw: number;
}) {
	const group = useRef<Group>(null);
	// Reduced motion draws the arcs still at their full size.
	useLayoutEffect(() => {
		if (reduced) {
			group.current?.scale?.setScalar(1);
		}
	}, [reduced]);
	useFrame(({ clock }) => {
		if (reduced || !group.current) {
			return;
		}
		const beat = (clock.elapsedTime * 1.6) % 1;
		group.current.scale.setScalar(0.8 + beat * 0.4);
	});
	return (
		<group position={at} ref={group} rotation={[0, yaw, 0]}>
			{[0.18, 0.32].map((radius) => (
				<mesh
					key={radius}
					position={[0, 0.55, 0]}
					rotation={[0, -Math.PI / 4, 0]}
				>
					<torusGeometry args={[radius, 0.025, 6, 12, Math.PI / 2]} />
					<meshBasicMaterial color={RIDES_ACT_3D.honk} toneMapped={false} />
				</mesh>
			))}
		</group>
	);
}

/** A working car's lit sign on its roof (its words ride the car's plate). */
export function RoofSign({ at, yaw }: { at: Vec3; yaw: number }) {
	return (
		<mesh position={[at[0], at[1] + 0.95, at[2]]} rotation={[0, yaw, 0]}>
			<boxGeometry args={[0.46, 0.2, 0.12]} />
			<meshBasicMaterial color={RIDES_ACT_3D.roofSign} toneMapped={false} />
		</mesh>
	);
}

/** The red light a limited driver waits at, by its car's front. */
export function RedLight({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<mesh position={[0, 0.55, 0]}>
				<cylinderGeometry args={[0.03, 0.03, 1.1, 8]} />
				<meshBasicMaterial color={RIDES_ACT_3D.lightPost} />
			</mesh>
			<mesh position={[0, 1.25, 0]}>
				<boxGeometry args={[0.2, 0.5, 0.14]} />
				<meshBasicMaterial color={RIDES_ACT_3D.lightBox} />
			</mesh>
			{[0.14, -0.02, -0.18].map((y, index) => (
				<mesh key={y} position={[0, 1.25 + y, 0.075]}>
					<sphereGeometry args={[0.055, 10, 8]} />
					<meshBasicMaterial
						color={index === 0 ? RIDES_ACT_3D.redLight : RIDES_ACT_3D.lightOff}
						toneMapped={false}
					/>
				</mesh>
			))}
		</group>
	);
}
