/* eslint-disable react/no-unknown-property */
import { RoundedBoxGeometry } from "@react-three/drei";
import { useMemo } from "react";
import { MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import type { MeshData } from "./game3d-island.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import { PROP_INK } from "./game3d-props.tsx";
import { type RidesArt, swatch } from "./rides-palette.ts";
import type { RidesCityPlan, Vec3, WorldRect } from "./rides-scene.ts";

/** Below this the city's slabs and buildings sit; the kerb's height. */
const KERB = 0.06;

/** A unit triangular prism (base -0.5..0.5 on x at y 0, apex at y 1). */
function prismData(): MeshData {
	const position: number[] = [];
	const normal: number[] = [];
	const index: number[] = [];
	const face = (points: Vec3[], n: Vec3) => {
		const base = position.length / 3;
		for (const point of points) {
			position.push(...point);
			normal.push(...n);
		}
		for (let corner = 1; corner < points.length - 1; corner++) {
			index.push(base, base + corner, base + corner + 1);
		}
	};
	const slope = Math.hypot(1, 0.5);
	face(
		[
			[-0.5, 0, 0.5],
			[0.5, 0, 0.5],
			[0, 1, 0.5],
		],
		[0, 0, 1]
	);
	face(
		[
			[0.5, 0, -0.5],
			[-0.5, 0, -0.5],
			[0, 1, -0.5],
		],
		[0, 0, -1]
	);
	face(
		[
			[0.5, 0, 0.5],
			[0.5, 0, -0.5],
			[0, 1, -0.5],
			[0, 1, 0.5],
		],
		[1 / slope, 0.5 / slope, 0]
	);
	face(
		[
			[-0.5, 0, -0.5],
			[-0.5, 0, 0.5],
			[0, 1, 0.5],
			[0, 1, -0.5],
		],
		[-1 / slope, 0.5 / slope, 0]
	);
	return {
		index: new Uint32Array(index),
		normal: new Float32Array(normal),
		position: new Float32Array(position),
	};
}

const PRISM = prismData();

export function inRect(
	x: number,
	z: number,
	rect: WorldRect,
	grow = 0
): boolean {
	return (
		x >= rect.minX - grow &&
		x <= rect.maxX + grow &&
		z >= rect.minZ - grow &&
		z <= rect.maxZ + grow
	);
}

interface CityParts {
	glass: InstanceSpec[];
	litGlass: InstanceSpec[];
	prisms: InstanceSpec[];
	roofs: InstanceSpec[];
	slabs: InstanceSpec[];
	walls: InstanceSpec[];
}

/** Every block's slab, building, roof and window, ready to instance. */
function cityParts(
	plan: RidesCityPlan,
	art: RidesArt,
	night: boolean
): CityParts {
	const parts: CityParts = {
		glass: [],
		litGlass: [],
		prisms: [],
		roofs: [],
		slabs: [],
		walls: [],
	};
	for (const { rect } of plan.blocks) {
		parts.slabs.push({
			color: art.pavement,
			position: [
				(rect.minX + rect.maxX) / 2,
				KERB / 2,
				(rect.minZ + rect.maxZ) / 2,
			],
			scale: [rect.maxX - rect.minX, KERB, rect.maxZ - rect.minZ],
		});
	}
	for (const lot of plan.lots) {
		const [x, y, z] = lot.at;
		const wall = swatch(art.walls, lot.seed);
		const roof = swatch(art.roofs, lot.seed >> 3);
		parts.walls.push({
			color: wall,
			position: [x, y + lot.height / 2, z],
			scale: [lot.width, lot.height, lot.depth],
		});
		if (lot.kind === "house") {
			parts.prisms.push({
				color: wall,
				position: [x, y + lot.height, z],
				scale: [lot.width, 0.3, lot.depth],
			});
			const tilt = Math.atan2(0.3, lot.width / 2);
			const slope = Math.hypot(lot.width / 2 + 0.06, 0.3);
			for (const side of [-1, 1]) {
				parts.roofs.push({
					color: roof,
					position: [
						x + side * (lot.width / 4 + 0.015),
						y + lot.height + 0.16,
						z,
					],
					rotation: [0, 0, -side * tilt],
					scale: [slope, 0.05, lot.depth + 0.1],
				});
			}
		} else {
			parts.roofs.push({
				color: roof,
				position: [x, y + lot.height + 0.03, z],
				scale: [lot.width + 0.06, 0.06, lot.depth + 0.06],
			});
		}
		// Windows on the two faces the camera sees (+z and +x).
		const floors =
			lot.kind === "tower"
				? Math.max(1, Math.floor((lot.height - 0.2) / 0.27))
				: 1;
		for (let floor = 0; floor < floors; floor++) {
			const wy = y + 0.25 + floor * 0.27;
			for (const face of ["z", "x"] as const) {
				const span = face === "z" ? lot.width : lot.depth;
				const count = Math.max(1, Math.floor((span - 0.08) / 0.2));
				for (let index = 0; index < count; index++) {
					const along = -span / 2 + (span / count) * (index + 0.5);
					const lit = night
						? jitter(Math.round(x * 10) + index, floor, lot.seed % 7) > 0.25
						: false;
					const spec: InstanceSpec =
						face === "z"
							? {
									position: [x + along, wy, z + lot.depth / 2 + 0.006],
									scale: [0.1, 0.13, 0.012],
								}
							: {
									position: [x + lot.width / 2 + 0.006, wy, z + along],
									scale: [0.012, 0.13, 0.1],
								};
					if (lit) {
						parts.litGlass.push(spec);
					} else {
						parts.glass.push({ ...spec, color: art.glass });
					}
				}
			}
		}
	}
	return parts;
}

/** The blocks and their buildings, every part instanced. */
export function CityBlocks({
	art,
	night,
	plan,
}: {
	art: RidesArt;
	night: boolean;
	plan: RidesCityPlan;
}) {
	const parts = useMemo(() => cityParts(plan, art, night), [art, night, plan]);
	return (
		<group>
			<InstancedParts
				ink={PROP_INK * 0.5}
				inkColor={art.kerb}
				items={parts.slabs}
				receiveShadow
			>
				<RoundedBoxGeometry args={[1, 1, 1]} radius={0.02} smoothness={2} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.pinPost}
				items={parts.walls}
				receiveShadow
			>
				<RoundedBoxGeometry args={[1, 1, 1]} radius={0.04} smoothness={2} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.prisms} receiveShadow>
				<MeshGeometry data={PRISM} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.pinPost}
				items={parts.roofs}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.glass}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial emissive={art.glass} emissiveIntensity={0.2} />
			</InstancedParts>
			<InstancedParts items={parts.litGlass}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial color={art.litGlass} toneMapped={false} />
			</InstancedParts>
		</group>
	);
}

/** Bridges, lane dashes and the little street lamps. */
export function Streets({
	art,
	night,
	plan,
}: {
	art: RidesArt;
	night: boolean;
	plan: RidesCityPlan;
}) {
	const parts = useMemo(() => {
		const decks: InstanceSpec[] = [];
		const rails: InstanceSpec[] = [];
		for (const bridge of plan.bridges) {
			decks.push({
				position: [bridge.x, 0.03, bridge.z],
				scale: [bridge.width, 0.08, bridge.length],
			});
			for (const side of [-1, 1]) {
				rails.push({
					position: [
						bridge.x + side * (bridge.width / 2 - 0.03),
						0.13,
						bridge.z,
					],
					scale: [0.05, 0.12, bridge.length],
				});
			}
		}
		const dashes = plan.dashes.map<InstanceSpec>(({ along, at }) => ({
			position: at,
			scale: along === "z" ? [0.05, 0.01, 0.22] : [0.22, 0.01, 0.05],
		}));
		const posts = plan.scenery.lamps.map<InstanceSpec>((at) => ({
			position: [at[0], at[1] + 0.28, at[2]],
			scale: [0.025, 0.56, 0.025],
		}));
		const bulbs = plan.scenery.lamps.map<InstanceSpec>((at) => ({
			position: [at[0], at[1] + 0.6, at[2]],
			scale: 0.055,
		}));
		return { bulbs, dashes, decks, posts, rails };
	}, [plan]);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.pinPost}
				items={parts.decks}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.bridge} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.rails}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.bridgeRail} />
			</InstancedParts>
			<InstancedParts items={parts.dashes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.dash} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.posts}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial color={art.pinPost} />
			</InstancedParts>
			<InstancedParts items={parts.bulbs}>
				<sphereGeometry args={[1, 10, 8]} />
				{night ? (
					<CurvedBasicMaterial color={art.carLight} toneMapped={false} />
				) : (
					<ToonMaterial color={art.carLight} />
				)}
			</InstancedParts>
		</group>
	);
}
