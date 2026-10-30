/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";
import {
	SLAB,
	TILE,
	tileToWorld,
	WALL_HEIGHT,
	WALL_THICK,
} from "./warehouse-diorama-layout.ts";
import { FLOOR } from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

/** The building: slab, safety lines, walls, windows, roller door, lamps. */
export function Building({
	art,
	night,
}: {
	art: WarehouseArt;
	night: boolean;
}) {
	const half = { d: (FLOOR.depth / 2) * TILE, w: (FLOOR.width / 2) * TILE };
	const parts = useMemo(() => {
		const lines: InstanceSpec[] = [];
		// Walkway lines down the cross aisle and round the dock.
		const line = (from: Vec3, to: Vec3) => {
			const dx = to[0] - from[0];
			const dz = to[2] - from[2];
			lines.push({
				position: [(from[0] + to[0]) / 2, SLAB + 0.004, (from[2] + to[2]) / 2],
				scale: [Math.abs(dx) + 0.05, 0.008, Math.abs(dz) + 0.05],
			});
		};
		line(tileToWorld(9.0, 0.3), tileToWorld(9.0, 13.7));
		line(tileToWorld(9.0, 7.6), tileToWorld(15.8, 7.6));
		line(tileToWorld(13.1, 8.3), tileToWorld(13.1, 11.5));
		line(tileToWorld(13.1, 11.5), tileToWorld(15.3, 11.5));
		line(tileToWorld(10.2, 0.1), tileToWorld(10.2, 2.2));
		line(tileToWorld(10.2, 2.2), tileToWorld(14.6, 2.2));
		const windows: InstanceSpec[] = [];
		for (let x = 0.8; x < FLOOR.width - 6.5; x += 1.9) {
			const [wx] = tileToWorld(x + 0.7, 0);
			windows.push({
				position: [
					wx,
					SLAB + WALL_HEIGHT - 0.45,
					-half.d + WALL_THICK / 2 + 0.01,
				],
				scale: [1.0, 0.42, 0.02],
			});
		}
		for (let y = 1.2; y < FLOOR.depth - 0.5; y += 2.1) {
			const [, , wz] = tileToWorld(0, y + 0.6);
			windows.push({
				position: [
					-half.w + WALL_THICK / 2 + 0.01,
					SLAB + WALL_HEIGHT - 0.45,
					wz,
				],
				scale: [0.02, 0.42, 1.0],
			});
		}
		const lamps: Vec3[] = [];
		for (let x = 2; x < FLOOR.width; x += 4) {
			for (let y = 2.5; y < FLOOR.depth; y += 4.5) {
				lamps.push(tileToWorld(x, y, 2.1));
			}
		}
		return { lamps, lines, windows };
	}, [half.d, half.w]);
	const door = tileToWorld(12.4, 0);
	return (
		<group>
			<RoundedBox
				args={[half.w * 2 + 0.2, SLAB, half.d * 2 + 0.2]}
				position={[0, SLAB / 2, 0]}
				radius={0.05}
				receiveShadow
			>
				<ToonMaterial color={art.floor} />
			</RoundedBox>
			<InstancedParts items={parts.lines}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.safety} />
			</InstancedParts>
			{/* Back and left walls over a painted dado. */}
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, -half.d]}
				receiveShadow
			>
				<boxGeometry args={[half.w * 2 + 0.2, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[0, SLAB + 0.45, -half.d + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[half.w * 2 + 0.2, 0.9, 0.02]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[-half.w, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, half.d * 2 + 0.2]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[-half.w + WALL_THICK / 2 + 0.01, SLAB + 0.45, 0]}
			>
				<boxGeometry args={[0.02, 0.9, half.d * 2 + 0.2]} />
			</ToonMesh>
			<InstancedParts items={parts.windows}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial
					color={art.window}
					emissive={art.window}
					emissiveIntensity={night ? 0.4 : 0.3}
				/>
			</InstancedParts>
			{/* The roller door at the receiving bay: slats and a frame. */}
			<group position={[door[0], SLAB, -half.d + WALL_THICK / 2 + 0.02]}>
				<ToonMesh color={art.safetyDark} position={[0, 0.95, 0]}>
					<boxGeometry args={[3.0, 1.9, 0.03]} />
				</ToonMesh>
				{[0.2, 0.5, 0.8, 1.1, 1.4, 1.7].map((y) => (
					<ToonMesh color={art.door} key={y} position={[0, y, 0.025]}>
						<boxGeometry args={[2.8, 0.24, 0.02]} />
					</ToonMesh>
				))}
			</group>
			{/* Hanging work lights. */}
			{parts.lamps.map((at) => (
				<group key={`${at[0]}:${at[2]}`} position={at}>
					<ToonMesh color={art.lampShade} rotation={[Math.PI, 0, 0]}>
						<coneGeometry args={[0.2, 0.14, 14, 1, true]} />
					</ToonMesh>
					<mesh position={[0, -0.05, 0]}>
						<sphereGeometry args={[0.06, 10, 8]} />
						{night ? (
							<CurvedBasicMaterial color={art.lamp} toneMapped={false} />
						) : (
							<ToonMaterial color={art.lamp} />
						)}
					</mesh>
				</group>
			))}
			{night
				? parts.lamps
						.slice(0, 4)
						.map((at) => (
							<pointLight
								color={art.lamp}
								decay={2}
								distance={5}
								intensity={1.4}
								key={`light:${at[0]}:${at[2]}`}
								position={[at[0], at[1] - 0.2, at[2]]}
							/>
						))
				: null}
		</group>
	);
}
