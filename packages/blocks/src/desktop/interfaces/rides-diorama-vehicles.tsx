/* eslint-disable react/no-unknown-property */
import { RoundedBoxGeometry } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { PROP_INK } from "./game3d-props.tsx";
import type { RidesArt } from "./rides-palette.ts";
import type { CarSpot, Vec3 } from "./rides-scene.ts";

/** Cars and pins are drawn a size up, so they read over the rooftops. */
const CAR_SCALE = 2.4;

/** A small rounded toon car in its driver's colour, gliding to its spot. */
export function Car({
	art,
	body,
	ghost,
	night,
	reducedMotion,
	spot,
}: {
	art: RidesArt;
	body: string;
	ghost: boolean;
	night: boolean;
	reducedMotion: boolean;
	spot: CarSpot;
}) {
	const ref = useRef<Group>(null);
	const target = useRef(spot);
	target.current = spot;
	const invalidate = useThree((state) => state.invalidate);
	// Under reduced motion the car is where its plate is on the same frame.
	useLayoutEffect(() => {
		const group = ref.current;
		if (!(reducedMotion && group)) {
			return;
		}
		group.position.set(spot.at[0], spot.at[1], spot.at[2]);
		group.rotation.y = spot.yaw;
		invalidate();
	}, [invalidate, reducedMotion, spot.at, spot.yaw]);
	useFrame((_, delta) => {
		const group = ref.current;
		if (!group) {
			return;
		}
		const { at, yaw } = target.current;
		const ease = reducedMotion ? 1 : Math.min(1, delta * 2.5);
		group.position.x += (at[0] - group.position.x) * ease;
		group.position.z += (at[2] - group.position.z) * ease;
		group.position.y = at[1];
		let turn = yaw - group.rotation.y;
		turn = Math.atan2(Math.sin(turn), Math.cos(turn));
		group.rotation.y += turn * ease;
	});
	const opacity = ghost ? 0.45 : 1;
	return (
		<group
			position={spot.at}
			ref={ref}
			rotation={[0, spot.yaw, 0]}
			scale={CAR_SCALE}
		>
			<mesh castShadow position={[0, 0.13, 0]}>
				<RoundedBoxGeometry
					args={[0.32, 0.15, 0.6]}
					radius={0.06}
					smoothness={3}
				/>
				<ToonMaterial color={body} opacity={opacity} transparent={ghost} />
			</mesh>
			<mesh castShadow position={[0, 0.24, -0.04]}>
				<RoundedBoxGeometry
					args={[0.27, 0.13, 0.32]}
					radius={0.05}
					smoothness={3}
				/>
				<ToonMaterial
					color={art.carGlass}
					opacity={opacity}
					transparent={ghost}
				/>
			</mesh>
			<mesh position={[0, 0.31, -0.04]}>
				<boxGeometry args={[0.24, 0.025, 0.26]} />
				<ToonMaterial color={body} opacity={opacity} transparent={ghost} />
			</mesh>
			{/* The roof light: lit while the car is on a trip. */}
			<mesh position={[0, 0.345, -0.04]}>
				<boxGeometry args={[0.12, 0.05, 0.07]} />
				{ghost ? (
					<ToonMaterial color={art.carLight} opacity={opacity} transparent />
				) : (
					<CurvedBasicMaterial color={art.carLight} toneMapped={false} />
				)}
			</mesh>
			{[-1, 1].map((side) =>
				[-1, 1].map((end) => (
					<mesh
						key={`${side}:${end}`}
						position={[side * 0.15, 0.06, end * 0.19]}
						rotation={[0, 0, Math.PI / 2]}
					>
						<cylinderGeometry args={[0.06, 0.06, 0.05, 12]} />
						<ToonMaterial
							color={art.carWheel}
							opacity={opacity}
							transparent={ghost}
						/>
					</mesh>
				))
			)}
			{[-1, 1].map((side) => (
				<group key={side}>
					<mesh position={[side * 0.1, 0.14, 0.3]}>
						<sphereGeometry args={[0.03, 8, 6]} />
						{night && !ghost ? (
							<CurvedBasicMaterial color={art.carLight} toneMapped={false} />
						) : (
							<ToonMaterial color={art.carLight} />
						)}
					</mesh>
					<mesh position={[side * 0.11, 0.14, -0.3]}>
						<boxGeometry args={[0.06, 0.03, 0.01]} />
						<ToonMaterial color={art.carTail} />
					</mesh>
				</group>
			))}
		</group>
	);
}

/** A trip's destination pin: a post with a flag in the trip's colour. */
export function Pins({
	art,
	pins,
}: {
	art: RidesArt;
	pins: readonly { at: Vec3; color: string }[];
}) {
	const parts = useMemo(
		() => ({
			flags: pins.map<InstanceSpec>(({ at, color }) => ({
				color,
				position: [at[0] + 0.24, at[1] + 1.2, at[2]],
				scale: [0.46, 0.3, 0.05],
			})),
			heads: pins.map<InstanceSpec>(({ at }) => ({
				position: [at[0], at[1] + 1.38, at[2]],
				scale: 0.08,
			})),
			posts: pins.map<InstanceSpec>(({ at }) => ({
				position: [at[0], at[1] + 0.68, at[2]],
				scale: [0.05, 1.36, 0.05],
			})),
		}),
		[pins]
	);
	return (
		<group>
			<InstancedParts castShadow items={parts.posts}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial color={art.pinPost} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.pinPost}
				items={parts.flags}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.heads}>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial color={art.pinPost} />
			</InstancedParts>
		</group>
	);
}

/** Routes as flat ribbons on the road, the selected one bright. */
export function Routes({
	ribbons,
}: {
	ribbons: readonly { color: string; path: Vec3[]; width: number }[];
}) {
	const items = useMemo(() => {
		const out: InstanceSpec[] = [];
		for (const { color, path, width } of ribbons) {
			for (let index = 1; index < path.length; index++) {
				const from = path[index - 1];
				const to = path[index];
				if (!(from && to)) {
					continue;
				}
				const dx = to[0] - from[0];
				const dz = to[2] - from[2];
				const length = Math.hypot(dx, dz);
				if (length < 0.01) {
					continue;
				}
				out.push({
					color,
					position: [(from[0] + to[0]) / 2, from[1], (from[2] + to[2]) / 2],
					rotation: [0, Math.atan2(dx, dz), 0],
					scale: [width, 0.012, length + width],
				});
			}
		}
		return out;
	}, [ribbons]);
	return (
		<InstancedParts items={items}>
			<boxGeometry args={[1, 1, 1]} />
			<CurvedBasicMaterial toneMapped={false} />
		</InstancedParts>
	);
}
