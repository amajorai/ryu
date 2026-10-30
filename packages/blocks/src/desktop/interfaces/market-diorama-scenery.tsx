/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import type { FlowerPatch } from "./game3d-grass.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland, roundedTile } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { jitter, pick } from "./game3d-math.ts";
import {
	type PlacedBush,
	type PlacedProp,
	type PlantedTree,
	PROP_INK,
} from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";
import {
	LOT_SIZE,
	type MarketRect,
	type MarketSquare,
	PAVEMENT_DEPTH,
	toWorld,
	type Vec3,
} from "./market-model.ts";
import { type MarketArt, swatch } from "./market-palette.ts";

/** The Market diorama's ground, paving, scenery, bunting and fountain. */

export const STONE = roundedTile(0.17, 4);

export function inRect(
	x: number,
	z: number,
	rect: MarketRect,
	grow = 0
): boolean {
	return (
		x >= rect.minX - grow &&
		x <= rect.maxX + grow &&
		z >= rect.minZ - grow &&
		z <= rect.maxZ + grow
	);
}

/** The paved ground: the square, the shop rows' pavement and footprints. */
export function pavedAreas(market: MarketSquare) {
	const { square } = market;
	const reach = LOT_SIZE.general.depth + 0.35;
	return {
		/** Under the back row and the left row, and the corner between. */
		rows: [
			{
				maxX: square.maxX,
				maxZ: square.minZ + PAVEMENT_DEPTH,
				minX: square.minX - reach,
				minZ: square.minZ - reach,
			},
			{
				maxX: square.minX + PAVEMENT_DEPTH,
				maxZ: square.maxZ,
				minX: square.minX - reach,
				minZ: square.minZ - reach,
			},
		] satisfies MarketRect[],
		square,
	};
}

/** Cobbles over the square and flagstones along the shop fronts. */
export function paving(market: MarketSquare, art: MarketArt): InstanceSpec[] {
	const { rows, square } = pavedAreas(market);
	const stones: InstanceSpec[] = [];
	for (let z = square.minZ + 0.2; z < square.maxZ - 0.1; z += 0.36) {
		const row = Math.round(z / 0.36);
		for (let x = square.minX + 0.2; x < square.maxX - 0.1; x += 0.4) {
			const sx = x + (row % 2) * 0.2;
			if (rows.some((rect) => inRect(sx, z, rect, 0.1))) {
				continue;
			}
			stones.push({
				color: pick(art.cobble, Math.round(sx * 7 + z * 13)),
				position: [sx, 0.004, z],
				rotation: [0, (jitter(Math.round(sx * 5), row, 3) - 0.5) * 0.3, 0],
				scale: [0.34, 0.03, 0.3],
			});
		}
	}
	const flag = (x: number, z: number) =>
		stones.push({
			color: pick(art.cobble, Math.round(x * 3 + z * 5)),
			position: [x, 0.004, z],
			scale: [0.66, 0.025, 0.66],
		});
	for (let x = square.minX + 0.4; x < square.maxX - 0.2; x += 0.74) {
		flag(x, square.minZ + PAVEMENT_DEPTH - 0.4);
	}
	for (
		let z = square.minZ + PAVEMENT_DEPTH + 0.34;
		z < square.maxZ - 0.2;
		z += 0.74
	) {
		flag(square.minX + PAVEMENT_DEPTH - 0.4, z);
	}
	return stones;
}

/** Ground paint: pavement under the shops, the square's bed. */
export function groundPaint(market: MarketSquare, art: MarketArt) {
	const { rows, square } = pavedAreas(market);
	const pavement: Rgb = linearRgb(art.pavement);
	const street: Rgb = linearRgb(art.street);
	return (x: number, z: number): Rgb | null => {
		if (rows.some((rect) => inRect(x, z, rect))) {
			return pavement;
		}
		if (inRect(x, z, square)) {
			return street;
		}
		return null;
	};
}

interface Scenery {
	benches: PlacedProp[];
	bunting: { from: Vec3; to: Vec3 }[];
	bushes: PlacedBush[];
	crates: PlacedProp[];
	flowers: FlowerPatch[];
	lamps: Vec3[];
	pole: Vec3;
	trees: PlantedTree[];
}

const POLE_HEIGHT = 3.3;

/**
 * Lamps between the shops, a fountain in the square, its pole strung with bunting to
 * every facade, benches, planters and crates of goods along the square's
 * open edges, and trees and shrubs on the lawn around it.
 */
export function scenery(market: MarketSquare, shape: IslandShape): Scenery {
	const { square } = market;
	const pole: Vec3 = [
		(square.minX + square.maxX) / 2 + 0.7,
		0,
		(square.minZ + square.maxZ) / 2 + 0.7,
	];
	const out: Scenery = {
		benches: [],
		bunting: [],
		bushes: [],
		crates: [],
		flowers: [],
		lamps: [],
		pole,
		trees: [],
	};
	const top: Vec3 = [pole[0], POLE_HEIGHT - 0.15, pole[2]];
	for (const [index, lot] of market.lots.entries()) {
		const { front, x } = lot.frame;
		const half = lot.size.width / 2;
		const y =
			lot.shop.kind === "stall" ? lot.size.height + 0.45 : lot.size.height;
		for (const side of [-1, 1]) {
			out.bunting.push({
				from: toWorld(lot.facing, [x + side * (half - 0.15), y, front + 0.08]),
				to: top,
			});
		}
		// Lamps in the gaps between shops, at the pavement's edge.
		const next = market.lots[index + 1];
		if (next && next.facing === lot.facing) {
			const gap = (x + next.frame.x) / 2;
			out.lamps.push(toWorld(lot.facing, [gap, 0, 1.25]));
		}
	}
	// The open edges: benches facing in, planters and crates of goods.
	const right = square.maxX + 0.55;
	const front = square.maxZ + 0.55;
	for (let z = square.minZ + 1.4, step = 0; z < square.maxZ - 0.6; z += 1.9) {
		if (step % 2 === 0) {
			out.benches.push({ at: [right, 0, z], yaw: -Math.PI / 2 });
		} else {
			out.bushes.push({ at: [right, 0, z], scale: 0.8, seed: step * 7 + 3 });
			out.flowers.push({ at: [right + 0.2, 0, z + 0.4], x: step, y: 21 });
		}
		step += 1;
	}
	for (let x = square.minX + 1.6, step = 0; x < square.maxX - 0.6; x += 1.9) {
		if (step % 2 === 1) {
			out.benches.push({ at: [x, 0, front], yaw: Math.PI });
		} else {
			out.crates.push(
				{ at: [x - 0.28, 0, front], yaw: 0.2 },
				{ at: [x + 0.26, 0, front + 0.08], yaw: -0.3 },
				{ at: [x, 0.44, front + 0.04], scale: 0.8, yaw: 0.6 }
			);
		}
		step += 1;
	}
	out.lamps.push(
		[square.maxX + 0.3, 0, square.maxZ + 0.3],
		[square.maxX + 0.3, 0, square.minZ + 0.4],
		[square.minX + 0.4, 0, square.maxZ + 0.3]
	);
	const { rows } = pavedAreas(market);
	const columns = Math.ceil(shape.halfWidth);
	const lines = Math.ceil(shape.halfDepth);
	for (let y = -lines; y <= lines; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.6;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.6;
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				inRect(fx, fz, square, 1.3) ||
				rows.some((rect) => inRect(fx, fz, rect, 0.5))
			) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (hash < 0.45) {
				out.trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.18 ? "cedar" : hash > 0.36 ? "blossom" : "fruit",
					scale: 0.85 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.62) {
				out.bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.82) {
				out.flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return out;
}

const FLAG_SPACING = 0.36;

/**
 * The XYZ Euler turn that lays a part's local z axis along (dx, dy, dz):
 * for that order, local z lands on (sin b, -cos b sin a, cos b cos a).
 */
function cordTurn(dx: number, dy: number, dz: number, length: number): Vec3 {
	const b = Math.asin(Math.max(-1, Math.min(1, dx / length)));
	const a = Math.atan2(-dy, dz);
	return [a, b, 0];
}

/** Pennant strings with a little sag, and bulbs that light up at night. */
export function Bunting({
	art,
	night,
	pole,
	runs,
}: {
	art: MarketArt;
	night: boolean;
	pole: Vec3;
	runs: readonly { from: Vec3; to: Vec3 }[];
}) {
	const parts = useMemo(() => {
		const cords: InstanceSpec[] = [];
		const flags: InstanceSpec[] = [];
		const bulbs: InstanceSpec[] = [];
		let seed = 0;
		for (const { from, to } of runs) {
			const dx = to[0] - from[0];
			const dy = to[1] - from[1];
			const dz = to[2] - from[2];
			const length = Math.hypot(dx, dy, dz);
			const count = Math.max(2, Math.round(length / FLAG_SPACING));
			const sag = Math.min(0.35, length * 0.06);
			const point = (t: number): Vec3 => [
				from[0] + dx * t,
				from[1] + dy * t - Math.sin(Math.PI * t) * sag,
				from[2] + dz * t,
			];
			const yaw = Math.atan2(dx, dz);
			for (let index = 0; index < count; index++) {
				const a = point(index / count);
				const b = point((index + 1) / count);
				const mx = (a[0] + b[0]) / 2;
				const my = (a[1] + b[1]) / 2;
				const mz = (a[2] + b[2]) / 2;
				const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
				cords.push({
					position: [mx, my, mz],
					rotation: cordTurn(b[0] - a[0], b[1] - a[1], b[2] - a[2], span),
					scale: [0.012, 0.012, span],
				});
				flags.push({
					color: swatch(art.bunting, seed),
					position: [mx, my - 0.1, mz],
					rotation: [Math.PI, Math.PI / 2 - yaw, 0],
					scale: [0.11, 0.2, 0.01],
				});
				if (index % 2 === 0) {
					bulbs.push({ position: [a[0], a[1] - 0.03, a[2]], scale: 0.035 });
				}
				seed += 1;
			}
		}
		const sticks: InstanceSpec[] = [
			{
				position: [pole[0], POLE_HEIGHT / 2, pole[2]],
				scale: [0.07, POLE_HEIGHT, 0.07],
			},
		];
		const finials: InstanceSpec[] = [
			{ position: [pole[0], POLE_HEIGHT + 0.06, pole[2]], scale: 0.12 },
		];
		return { bulbs, cords, finials, flags, sticks };
	}, [art, pole, runs]);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.cord}
				items={parts.sticks}
			>
				<cylinderGeometry args={[1, 1, 1, 10]} />
				<ToonMaterial color={art.pole} />
			</InstancedParts>
			<InstancedParts items={parts.finials}>
				<sphereGeometry args={[1, 12, 8]} />
				<ToonMaterial color={art.knob} />
			</InstancedParts>
			<InstancedParts items={parts.cords}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cord} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.flags}>
				<coneGeometry args={[1, 1, 3]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.bulbs}>
				<sphereGeometry args={[1, 10, 8]} />
				{night ? (
					<CurvedBasicMaterial color={art.bulb} toneMapped={false} />
				) : (
					<ToonMaterial color={art.bulb} />
				)}
			</InstancedParts>
		</group>
	);
}

/**
 * The fountain in the square's middle: a round stone basin of water, a
 * column with a bowl, and the bunting pole rising out of it.
 */
export function Fountain({
	art,
	at,
	night,
}: {
	art: MarketArt;
	at: Vec3;
	night: boolean;
}) {
	const water = (
		<CurvedBasicMaterial
			color={art.water}
			opacity={night ? 0.85 : 0.9}
			toneMapped={false}
			transparent
		/>
	);
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={art.stone}
				ink={PROP_INK}
				position={[0, 0.17, 0]}
				receiveShadow
			>
				<cylinderGeometry args={[1.0, 1.05, 0.34, 32]} />
			</ToonMesh>
			<mesh position={[0, 0.3, 0]} rotation={[-Math.PI / 2, 0, 0]}>
				<circleGeometry args={[0.86, 32]} />
				{water}
			</mesh>
			<ToonMesh
				color={art.stoneDark}
				ink={PROP_INK * 0.7}
				position={[0, 0.65, 0]}
			>
				<cylinderGeometry args={[0.1, 0.16, 0.8, 14]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={art.stone}
				ink={PROP_INK}
				position={[0, 1.05, 0]}
			>
				<cylinderGeometry args={[0.44, 0.2, 0.16, 24]} />
			</ToonMesh>
			<mesh position={[0, 1.135, 0]} rotation={[-Math.PI / 2, 0, 0]}>
				<circleGeometry args={[0.38, 24]} />
				{water}
			</mesh>
		</group>
	);
}
