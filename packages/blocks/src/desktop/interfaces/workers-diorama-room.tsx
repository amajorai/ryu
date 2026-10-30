/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";
import {
	BISTRO,
	SLAB,
	WALL_HEIGHT,
	WALL_THICK,
} from "./workers-diorama-geometry.ts";
import type { OfficePlan } from "./workers-model.ts";
import { swatch, type WorkersArt } from "./workers-palette.ts";

const PLANK = 1.8;
const BOARD = 0.42;

/** Staggered floor boards in two tones, clipped to the room. */
function plankRows(plan: OfficePlan, art: WorkersArt): InstanceSpec[] {
	const planks: InstanceSpec[] = [];
	const { halfDepth, halfWidth } = plan;
	const rows = Math.floor((halfDepth * 2) / BOARD);
	for (let row = 0; row < rows; row++) {
		const z = -halfDepth + BOARD / 2 + row * BOARD;
		const start = -halfWidth - (row % 2 ? PLANK / 2 : 0);
		for (let x = start, seed = row; x < halfWidth; x += PLANK, seed++) {
			const from = Math.max(x, -halfWidth);
			const to = Math.min(x + PLANK, halfWidth);
			if (to - from < 0.05) {
				continue;
			}
			planks.push({
				color: art.floor[seed % 2],
				position: [(from + to) / 2, SLAB + 0.004, z],
				scale: [to - from - 0.02, 0.012, BOARD - 0.02],
			});
		}
	}
	return planks;
}

/** Window panes along a wall: frames, mullions and glass. */
function windowsAlong(
	plan: OfficePlan,
	wall: "back" | "left"
): { frames: InstanceSpec[]; glass: InstanceSpec[] } {
	const frames: InstanceSpec[] = [];
	const glass: InstanceSpec[] = [];
	const span = wall === "back" ? plan.halfWidth : plan.halfDepth;
	const count = Math.max(2, Math.floor((span * 2) / 1.7));
	const pitch = (span * 2) / count;
	const bottom = SLAB + 0.8;
	const height = 1.25;
	for (let index = 0; index < count; index++) {
		const along = -span + pitch * (index + 0.5);
		const width = pitch - 0.5;
		const at: Vec3 =
			wall === "back"
				? [along, bottom + height / 2, -plan.halfDepth + WALL_THICK / 2 + 0.01]
				: [-plan.halfWidth + WALL_THICK / 2 + 0.01, bottom + height / 2, along];
		const size = (w: number, h: number, d: number): Vec3 =>
			wall === "back" ? [w, h, d] : [d, h, w];
		frames.push({
			position: at,
			scale: size(width + 0.12, height + 0.12, 0.04),
		});
		glass.push({
			position:
				wall === "back"
					? [at[0], at[1], at[2] + 0.025]
					: [at[0] + 0.025, at[1], at[2]],
			scale: size(width, height, 0.02),
		});
		// A mullion down the middle and a transom across.
		frames.push(
			{
				position:
					wall === "back"
						? [at[0], at[1], at[2] + 0.04]
						: [at[0] + 0.04, at[1], at[2]],
				scale: size(0.05, height, 0.02),
			},
			{
				position:
					wall === "back"
						? [at[0], at[1] + height * 0.22, at[2] + 0.04]
						: [at[0] + 0.04, at[1] + height * 0.22, at[2]],
				scale: size(width, 0.05, 0.02),
			}
		);
	}
	return { frames, glass };
}

/** The cut-away room: slab, plank floor, rug, walls, windows, whiteboard. */
export function Room({
	art,
	night,
	plan,
}: {
	art: WorkersArt;
	night: boolean;
	plan: OfficePlan;
}) {
	const { halfDepth, halfWidth, rug } = plan;
	const planks = useMemo(() => plankRows(plan, art), [art, plan]);
	const panes = useMemo(() => {
		const back = windowsAlong(plan, "back");
		const left = windowsAlong(plan, "left");
		return {
			frames: [...back.frames, ...left.frames],
			glass: [...back.glass, ...left.glass],
		};
	}, [plan]);
	return (
		<group>
			<RoundedBox
				args={[halfWidth * 2 + 0.3, SLAB, halfDepth * 2 + 0.3]}
				position={[0, SLAB / 2, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={art.floorEdge} />
			</RoundedBox>
			<InstancedParts items={planks} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<RoundedBox
				args={[rug.halfWidth * 2 + 0.2, 0.02, rug.halfDepth * 2 + 0.2]}
				position={[rug.x, SLAB + 0.014, rug.z]}
				radius={0.01}
				receiveShadow
			>
				<ToonMaterial color={art.rugBorder} />
			</RoundedBox>
			<RoundedBox
				args={[rug.halfWidth * 2, 0.024, rug.halfDepth * 2]}
				position={[rug.x, SLAB + 0.016, rug.z]}
				radius={0.01}
				receiveShadow
			>
				<ToonMaterial color={art.rug} />
			</RoundedBox>
			{/* Back and left walls: painted upper wall over a wainscot. */}
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, -halfDepth]}
				receiveShadow
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[0, SLAB + 0.36, -halfDepth + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, 0.72, 0.02]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[-halfWidth, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[-halfWidth + WALL_THICK / 2 + 0.01, SLAB + 0.36, 0]}
			>
				<boxGeometry args={[0.02, 0.72, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<InstancedParts items={panes.frames}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.windowFrame} />
			</InstancedParts>
			<InstancedParts items={panes.glass}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial
					color={art.window}
					emissive={art.window}
					emissiveIntensity={night ? 0.5 : 0.35}
				/>
			</InstancedParts>
		</group>
	);
}

/** The coffee corner: a counter with a machine and mugs, a water cooler, a bistro table. */
export function CoffeeCorner({
	art,
	at,
}: {
	art: WorkersArt;
	at: { x: number; z: number };
}) {
	const y = SLAB;
	const mugs = useMemo<InstanceSpec[]>(
		() =>
			[0, 1, 2].map((index) => ({
				color: swatch(art.mugs, index + 1),
				position: [at.x + 0.25 + index * 0.17, y + 0.68, at.z + 0.05],
				scale: [0.05, 0.1, 0.05],
			})),
		[art, at, y]
	);
	return (
		<group>
			<ToonMesh
				castShadow
				color={art.counter}
				ink={PROP_INK}
				position={[at.x, y + 0.3, at.z]}
				receiveShadow
			>
				<boxGeometry args={[1.7, 0.6, 0.6]} />
			</ToonMesh>
			<ToonMesh color={art.counterTop} position={[at.x, y + 0.62, at.z]}>
				<boxGeometry args={[1.78, 0.05, 0.66]} />
			</ToonMesh>
			{/* The coffee machine, its drip tray and a fresh cup. */}
			<ToonMesh
				castShadow
				color={art.machine}
				ink={PROP_INK}
				position={[at.x - 0.45, y + 0.86, at.z - 0.05]}
			>
				<boxGeometry args={[0.42, 0.44, 0.36]} />
			</ToonMesh>
			<ToonMesh
				color={art.coffee}
				position={[at.x - 0.45, y + 0.72, at.z + 0.1]}
			>
				<cylinderGeometry args={[0.05, 0.04, 0.09, 12]} />
			</ToonMesh>
			<InstancedParts castShadow items={mugs}>
				<cylinderGeometry args={[1, 0.85, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			{/* A water cooler beside the counter. */}
			<group position={[at.x + 1.15, y, at.z + 0.05]}>
				<ToonMesh
					castShadow
					color={art.counterTop}
					ink={PROP_INK}
					position={[0, 0.4, 0]}
				>
					<boxGeometry args={[0.34, 0.8, 0.34]} />
				</ToonMesh>
				<ToonMesh color={art.water} position={[0, 0.98, 0]}>
					<cylinderGeometry args={[0.15, 0.15, 0.36, 16]} />
				</ToonMesh>
			</group>
			{/* A round bistro table with two stools in front. */}
			<group position={[at.x + BISTRO[0], y, at.z + BISTRO[1]]}>
				<ToonMesh
					castShadow
					color={art.counterTop}
					ink={PROP_INK}
					position={[0, 0.5, 0]}
				>
					<cylinderGeometry args={[0.34, 0.34, 0.05, 20]} />
				</ToonMesh>
				<ToonMesh color={art.chairBase} position={[0, 0.25, 0]}>
					<cylinderGeometry args={[0.035, 0.035, 0.5, 8]} />
				</ToonMesh>
				{[-1, 1].map((side) => (
					<ToonMesh
						castShadow
						color={art.counter}
						key={side}
						position={[side * 0.55, 0.2, 0.05]}
					>
						<cylinderGeometry args={[0.15, 0.13, 0.4, 14]} />
					</ToonMesh>
				))}
			</group>
		</group>
	);
}

/** A bookshelf and a whiteboard along the left wall. */
export function LeftWall({ art, plan }: { art: WorkersArt; plan: OfficePlan }) {
	const x = -plan.halfWidth + WALL_THICK / 2;
	const shelfZ = plan.halfDepth - 1.0;
	const books = useMemo<InstanceSpec[]>(() => {
		const items: InstanceSpec[] = [];
		for (const [level, y] of [0.42, 0.86, 1.3].entries()) {
			for (let index = 0; index < 7; index++) {
				if (jitter(index, level, 4) < 0.2) {
					continue;
				}
				const tall = 0.24 + jitter(index, level, 6) * 0.1;
				items.push({
					color: swatch(art.books, index + level * 2),
					position: [
						x + 0.2,
						SLAB + y + tall / 2,
						shelfZ - 0.42 + index * 0.13,
					],
					scale: [0.22, tall, 0.1],
				});
			}
		}
		return items;
	}, [art, shelfZ, x]);
	return (
		<group>
			<ToonMesh
				castShadow
				color={art.shelf}
				ink={PROP_INK}
				position={[x + 0.2, SLAB + 0.85, shelfZ]}
				receiveShadow
			>
				<boxGeometry args={[0.32, 1.7, 1.05]} />
			</ToonMesh>
			{[0.4, 0.84, 1.28].map((y) => (
				<ToonMesh
					color={art.counterTop}
					key={y}
					position={[x + 0.37, SLAB + y, shelfZ]}
				>
					<boxGeometry args={[0.02, 0.04, 1.0]} />
				</ToonMesh>
			))}
			<InstancedParts castShadow items={books}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
		</group>
	);
}
