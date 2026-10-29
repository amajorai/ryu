/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { roundedTile } from "./game3d-island.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { DOUBLE_SIDE, jitter, pick } from "./game3d-math.ts";
import {
	ART_WHITE,
	PROP_ART,
	type Scene3dTheme,
	SHORE_ART,
	type Vec3,
} from "./game3d-palette.ts";
import { cedarTier } from "./game3d-shapes.ts";

/**
 * The kit's props, every kind instanced (one draw call per part, plus its
 * ink outline), cel-shaded in the shared palette:
 *
 * - `TreeGrove`: cedars and lollipop fruit or blossom trees;
 * - `Bushes`: round shrubs;
 * - `Fences`: picket or rail fences along runs;
 * - `LampPosts`: iron lamps, lit at night;
 * - `Benches`, `Crates`, `Signs` (the board only: put the words on a plate);
 * - `PathStones`: rounded paving stones, `Rocks`, and a `Pond`.
 *
 * Every prop takes plain world points, so a game lays its diorama out in
 * world units and hands each kind its list.
 */

/** Ink outline widths, in world units at a dozen tiles from the lens. */
export const TREE_INK = 0.03;
export const PROP_INK = 0.022;

/** Cedar tiers: lathed with a rounded tip and a curled lip, never faceted. */
const CEDAR_SHAPE = cedarTier(22);
const STONE_SHAPE = roundedTile(0.17, 4);

export interface TreeParts {
	canopies: InstanceSpec[];
	cones: InstanceSpec[];
	fruit: InstanceSpec[];
	trunks: InstanceSpec[];
}

/** A cedar: a stout trunk under three soft, stacked tiers. */
function addCedar(
	parts: TreeParts,
	theme: Scene3dTheme,
	at: Vec3,
	s: number,
	seed: number
) {
	const leaves = pick(theme.pineLeaves, seed);
	parts.trunks.push({
		color: theme.trunk,
		position: [at[0], at[1] + 0.2 * s, at[2]],
		scale: [0.11 * s, 0.4 * s, 0.11 * s],
	});
	const tiers: [number, number, number][] = [
		[0.56, 0.62, 0.62],
		[0.44, 0.54, 0.98],
		[0.3, 0.46, 1.3],
	];
	for (const [radius, height, y] of tiers) {
		parts.cones.push({
			color: leaves,
			position: [at[0], at[1] + y * s, at[2]],
			rotation: [0, seed + y, 0],
			scale: [radius * s, height * s, radius * s],
		});
	}
}

/** Fruit colors: apples, oranges, peaches, pears. */
const FRUIT = SHORE_ART.fruit;

/**
 * A lollipop fruit tree: a short trunk under one big round canopy, hung
 * with fruit (or blossom-pink with no fruit).
 */
function addFruitTree(
	parts: TreeParts,
	theme: Scene3dTheme,
	at: Vec3,
	s: number,
	seed: number,
	blossom: boolean
) {
	const leaves = blossom ? theme.blossom : pick(theme.treeLeaves, seed);
	const potted = theme.rim === "walls";
	parts.trunks.push({
		color: theme.trunk,
		position: [at[0], at[1] + (potted ? 0.16 : 0.32) * s, at[2]],
		scale: potted
			? [0.24 * s, 0.32 * s, 0.24 * s]
			: [0.1 * s, 0.64 * s, 0.1 * s],
	});
	const canopyY = at[1] + (potted ? 0.66 : 0.98) * s;
	const radius = 0.52 * s;
	parts.canopies.push({
		color: leaves,
		position: [at[0], canopyY, at[2]],
		scale: [radius, radius * 0.92, radius],
	});
	if (blossom || potted) {
		return;
	}
	const fruit = pick(FRUIT, Math.floor(seed / 4));
	for (let index = 0; index < 3; index++) {
		const angle = seed * 0.37 + index * 2.1;
		const lift = 0.05 + (index % 2) * 0.22;
		parts.fruit.push({
			color: fruit,
			position: [
				at[0] + Math.sin(angle) * radius * 0.9,
				canopyY - lift * s,
				at[2] + Math.cos(angle) * radius * 0.9,
			],
			scale: 0.075 * s,
		});
	}
}

/** A tree as planted: where, how big, which kind and its random seed. */
export interface PlantedTree {
	at: Vec3;
	kind: "blossom" | "cedar" | "fruit";
	scale: number;
	seed: number;
}

/** Every tree's parts, leaving out the `hidden` ones (by index). */
export function growTrees(
	trees: readonly PlantedTree[],
	theme: Scene3dTheme,
	hidden: ReadonlySet<number>
): TreeParts {
	const parts: TreeParts = { canopies: [], cones: [], fruit: [], trunks: [] };
	for (const [index, { at, kind, scale, seed }] of trees.entries()) {
		if (hidden.has(index)) {
			continue;
		}
		if (kind === "cedar") {
			addCedar(parts, theme, at, scale, seed);
		} else {
			addFruitTree(parts, theme, at, scale, seed, kind === "blossom");
		}
	}
	return parts;
}

const NO_TREES: ReadonlySet<number> = new Set();

/** Cedars and lollipop fruit trees, cel-shaded with ink, all instanced. */
export function TreeGrove({
	hidden = NO_TREES,
	theme,
	trees,
}: {
	/** Trees (by index) left out, e.g. stepping out of a close-up. */
	hidden?: ReadonlySet<number>;
	theme: Scene3dTheme;
	trees: readonly PlantedTree[];
}) {
	const parts = useMemo(
		() => growTrees(trees, theme, hidden),
		[hidden, theme, trees]
	);
	return (
		<group>
			<InstancedParts
				castShadow
				fade
				ink={TREE_INK * 0.8}
				items={parts.trunks}
				receiveShadow
			>
				<cylinderGeometry args={[0.75, 1, 1, 14]} />
				<ToonMaterial fade />
			</InstancedParts>
			<InstancedParts
				castShadow
				fade
				ink={TREE_INK}
				items={parts.cones}
				receiveShadow
			>
				<MeshGeometry data={CEDAR_SHAPE} />
				<ToonMaterial fade />
			</InstancedParts>
			<InstancedParts
				castShadow
				fade
				ink={TREE_INK}
				items={parts.canopies}
				receiveShadow
			>
				<sphereGeometry args={[1, 28, 20]} />
				<ToonMaterial fade />
			</InstancedParts>
			<InstancedParts fade ink={PROP_INK * 0.7} items={parts.fruit}>
				<sphereGeometry args={[1, 12, 9]} />
				<ToonMaterial emissive={ART_WHITE} emissiveIntensity={0.05} fade />
			</InstancedParts>
		</group>
	);
}

/** A shrub: where it grows, how big, and its seed. */
export interface PlacedBush {
	at: Vec3;
	scale?: number;
	seed: number;
}

/** Round shrubs: three soft overlapping balls each, in the lawn's greens. */
export function Bushes({
	bushes,
	theme,
}: {
	bushes: readonly PlacedBush[];
	theme: Scene3dTheme;
}) {
	const balls = useMemo(() => {
		const items: InstanceSpec[] = [];
		for (const { at, scale = 1, seed } of bushes) {
			const color = pick(theme.treeLeaves, seed);
			for (let index = 0; index < 3; index++) {
				const angle = seed * 0.7 + index * 2.1;
				const radius = (0.26 - index * 0.04) * scale;
				items.push({
					color,
					position: [
						at[0] + Math.sin(angle) * 0.14 * scale,
						at[1] + radius * 0.85,
						at[2] + Math.cos(angle) * 0.14 * scale,
					],
					scale: [radius, radius * 0.9, radius],
				});
			}
		}
		return items;
	}, [bushes, theme]);
	return (
		<InstancedParts castShadow ink={TREE_INK * 0.8} items={balls} receiveShadow>
			<sphereGeometry args={[1, 18, 12]} />
			<ToonMaterial />
		</InstancedParts>
	);
}

/** A straight fence run between two ground points. */
export interface FenceRun {
	from: Vec3;
	to: Vec3;
}

const POST_SPACING = 0.42;

/**
 * Fences along runs: a post every ~0.4 units with two rails between, in
 * white pickets (`picket`) or plain wood.
 */
export function Fences({
	runs,
	style = "picket",
}: {
	runs: readonly FenceRun[];
	style?: "picket" | "wood";
}) {
	const color = style === "picket" ? PROP_ART.fence : PROP_ART.fenceWood;
	const parts = useMemo(() => {
		const posts: InstanceSpec[] = [];
		const rails: InstanceSpec[] = [];
		for (const { from, to } of runs) {
			const dx = to[0] - from[0];
			const dz = to[2] - from[2];
			const length = Math.hypot(dx, dz);
			const count = Math.max(1, Math.round(length / POST_SPACING));
			const yaw = Math.atan2(dx, dz);
			for (let index = 0; index <= count; index++) {
				const t = index / count;
				posts.push({
					position: [from[0] + dx * t, from[1] + 0.2, from[2] + dz * t],
					rotation: [0, yaw, 0],
					scale: [0.07, 0.4, 0.07],
				});
			}
			for (const height of [0.14, 0.3]) {
				rails.push({
					position: [from[0] + dx / 2, from[1] + height, from[2] + dz / 2],
					rotation: [0, yaw, 0],
					scale: [0.035, 0.05, length],
				});
			}
		}
		return { posts, rails };
	}, [runs]);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={color}
				items={parts.posts}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={color} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={color}
				items={parts.rails}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={color} />
			</InstancedParts>
		</group>
	);
}

const LAMP_HEIGHT = 1.05;
/** At most this many lamps cast real light at night (the rest just glow). */
const MAX_LAMP_LIGHTS = 6;

/** Iron lamp posts; at night the bulbs glow and the nearest few light up. */
export function LampPosts({
	lamps,
	night,
}: {
	lamps: readonly Vec3[];
	night: boolean;
}) {
	const parts = useMemo(
		() => ({
			bulbs: lamps.map<InstanceSpec>((at) => ({
				position: [at[0], at[1] + LAMP_HEIGHT + 0.07, at[2]],
				scale: 0.085,
			})),
			caps: lamps.map<InstanceSpec>((at) => ({
				position: [at[0], at[1] + LAMP_HEIGHT + 0.17, at[2]],
				scale: [0.12, 0.08, 0.12],
			})),
			posts: lamps.map<InstanceSpec>((at) => ({
				position: [at[0], at[1] + LAMP_HEIGHT / 2, at[2]],
				scale: [0.04, LAMP_HEIGHT, 0.04],
			})),
		}),
		[lamps]
	);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={PROP_ART.lampIron}
				items={parts.posts}
			>
				<cylinderGeometry args={[1, 1.3, 1, 8]} />
				<ToonMaterial color={PROP_ART.lampIron} />
			</InstancedParts>
			<InstancedParts
				ink={PROP_INK * 0.6}
				inkColor={PROP_ART.lampIron}
				items={parts.caps}
			>
				<coneGeometry args={[1, 1, 8]} />
				<ToonMaterial color={PROP_ART.lampIron} />
			</InstancedParts>
			<InstancedParts items={parts.bulbs}>
				<sphereGeometry args={[1, 12, 9]} />
				{night ? (
					<CurvedBasicMaterial color={[2.6, 2.1, 1.3]} toneMapped={false} />
				) : (
					<ToonMaterial color={PROP_ART.lampBulb} />
				)}
			</InstancedParts>
			{night
				? lamps
						.slice(0, MAX_LAMP_LIGHTS)
						.map((at) => (
							<pointLight
								color={PROP_ART.lampLight}
								decay={2}
								distance={4.5}
								intensity={3.2}
								key={at.join(",")}
								position={[at[0], at[1] + LAMP_HEIGHT, at[2]]}
							/>
						))
				: null}
		</group>
	);
}

/** Something placed on the ground, turned about its vertical axis. */
export interface PlacedProp {
	at: Vec3;
	scale?: number;
	yaw?: number;
}

/** Turns a local offset by `yaw` and moves it to `at`. */
function placed(prop: PlacedProp, local: Vec3): Vec3 {
	const yaw = prop.yaw ?? 0;
	const s = prop.scale ?? 1;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return [
		prop.at[0] + (local[0] * cos + local[2] * sin) * s,
		prop.at[1] + local[1] * s,
		prop.at[2] + (-local[0] * sin + local[2] * cos) * s,
	];
}

/** One box-shaped part of a prop, in the prop's own frame. */
function propBox(prop: PlacedProp, local: Vec3, size: Vec3): InstanceSpec {
	const s = prop.scale ?? 1;
	return {
		position: placed(prop, local),
		rotation: [0, prop.yaw ?? 0, 0],
		scale: [size[0] * s, size[1] * s, size[2] * s],
	};
}

/** Wooden park benches: a seat, a back and two legs each. */
export function Benches({ benches }: { benches: readonly PlacedProp[] }) {
	const boxes = useMemo(
		() =>
			benches.flatMap((bench) => [
				propBox(bench, [0, 0.26, 0], [0.9, 0.06, 0.3]),
				propBox(bench, [0, 0.46, -0.14], [0.9, 0.18, 0.05]),
				propBox(bench, [-0.36, 0.12, 0], [0.06, 0.24, 0.26]),
				propBox(bench, [0.36, 0.12, 0], [0.06, 0.24, 0.26]),
			]),
		[benches]
	);
	return (
		<InstancedParts
			castShadow
			ink={PROP_INK * 0.7}
			inkColor={PROP_ART.bench}
			items={boxes}
			receiveShadow
		>
			<boxGeometry args={[1, 1, 1]} />
			<ToonMaterial color={PROP_ART.bench} />
		</InstancedParts>
	);
}

/** Wooden crates with darker bands. */
export function Crates({ crates }: { crates: readonly PlacedProp[] }) {
	const parts = useMemo(
		() => ({
			bands: crates.flatMap((crate) => [
				propBox(crate, [0, 0.08, 0], [0.47, 0.06, 0.47]),
				propBox(crate, [0, 0.36, 0], [0.47, 0.06, 0.47]),
			]),
			boxes: crates.map((crate) =>
				propBox(crate, [0, 0.22, 0], [0.44, 0.44, 0.44])
			),
		}),
		[crates]
	);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PROP_ART.crate}
				items={parts.boxes}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={PROP_ART.crate} />
			</InstancedParts>
			<InstancedParts items={parts.bands}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={PROP_ART.crateBand} />
			</InstancedParts>
		</group>
	);
}

/** Sign boards on a post (the words go on a HUD plate over them). */
export function Signs({ signs }: { signs: readonly PlacedProp[] }) {
	const parts = useMemo(
		() => ({
			boards: signs.map((sign) =>
				propBox(sign, [0, 0.62, 0], [0.7, 0.32, 0.06])
			),
			posts: signs.map((sign) => propBox(sign, [0, 0.3, 0], [0.07, 0.6, 0.07])),
		}),
		[signs]
	);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PROP_ART.sign}
				items={parts.boards}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={PROP_ART.sign} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.posts}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={PROP_ART.signPost} />
			</InstancedParts>
		</group>
	);
}

/** Rounded paving stones, a sliver above the ground, in the path's tones. */
export function PathStones({
	night,
	size = 0.8,
	stones,
}: {
	night: boolean;
	size?: number;
	stones: readonly Vec3[];
}) {
	const items = useMemo(() => {
		const tones = night ? PROP_ART.stonesNight : PROP_ART.stones;
		return stones.map<InstanceSpec>((at, index) => ({
			color: pick(tones, index * 7 + Math.round(at[0] * 3 + at[2] * 5)),
			position: [at[0], at[1] + 0.005, at[2]],
			rotation: [0, (jitter(index, 3, 5) - 0.5) * 0.3, 0],
			scale: [size, 0.02, size],
		}));
	}, [night, size, stones]);
	return (
		<InstancedParts
			ink={PROP_INK * 0.6}
			inkColor={PROP_ART.stones[0]}
			items={items}
			receiveShadow
		>
			<MeshGeometry data={STONE_SHAPE} />
			<ToonMaterial />
		</InstancedParts>
	);
}

/** Pebbles and boulders: soft squashed balls. */
export function Rocks({ rocks }: { rocks: readonly PlacedProp[] }) {
	const items = useMemo(
		() =>
			rocks.map<InstanceSpec>((rock, index) => {
				const s = rock.scale ?? 1;
				return {
					color: pick(PROP_ART.rocks, index),
					position: [rock.at[0], rock.at[1] + 0.05 * s, rock.at[2]],
					rotation: [0, rock.yaw ?? index, 0],
					scale: [0.22 * s, 0.14 * s, 0.18 * s],
				};
			}),
		[rocks]
	);
	return (
		<InstancedParts
			castShadow
			ink={PROP_INK}
			inkColor={SHORE_ART.rockInk}
			items={items}
			receiveShadow
		>
			<sphereGeometry args={[1, 10, 7]} />
			<ToonMaterial />
		</InstancedParts>
	);
}

const POND_STONES = 14;
const LILY_PADS = 4;

/**
 * A round pond: still water a step below the lawn, a ring of rounded
 * stones, lily pads (one in flower) and a few reeds.
 */
export function Pond({
	at,
	night,
	radius,
}: {
	at: Vec3;
	night: boolean;
	radius: number;
}) {
	const parts = useMemo(() => {
		const stones: InstanceSpec[] = [];
		for (let index = 0; index < POND_STONES; index++) {
			const angle = (index / POND_STONES) * Math.PI * 2;
			const r = radius + 0.06 + jitter(index, 1, 2) * 0.08;
			stones.push({
				color: pick(PROP_ART.rocks, index),
				position: [
					at[0] + Math.cos(angle) * r,
					at[1] + 0.03,
					at[2] + Math.sin(angle) * r,
				],
				rotation: [0, angle, 0],
				scale: [0.2, 0.1, 0.15],
			});
		}
		const pads: InstanceSpec[] = [];
		for (let index = 0; index < LILY_PADS; index++) {
			const angle = index * 1.9 + 0.4;
			const r = radius * (0.35 + jitter(index, 2, 3) * 0.4);
			pads.push({
				position: [
					at[0] + Math.cos(angle) * r,
					at[1] + 0.03,
					at[2] + Math.sin(angle) * r,
				],
				rotation: [0, angle, 0],
				scale: [0.16, 0.012, 0.16],
			});
		}
		const reeds: InstanceSpec[] = [];
		for (let index = 0; index < 5; index++) {
			const angle = 3.6 + index * 0.18;
			reeds.push({
				position: [
					at[0] + Math.cos(angle) * radius * 0.92,
					at[1] + 0.12,
					at[2] + Math.sin(angle) * radius * 0.92,
				],
				rotation: [(index % 2) * 0.12, 0, (index - 2) * 0.08],
				scale: [0.02, 0.38 + (index % 3) * 0.08, 0.02],
			});
		}
		return { pads, reeds, stones };
	}, [at, radius]);
	const flower = parts.pads[0]?.position;
	return (
		<group>
			<mesh position={[at[0], at[1] + 0.012, at[2]]} receiveShadow>
				<cylinderGeometry args={[radius, radius, 0.02, 40]} />
				<ToonMaterial
					color={night ? PROP_ART.pondNight : PROP_ART.pondDay}
					emissive={ART_WHITE}
					emissiveIntensity={night ? 0.02 : 0.08}
				/>
			</mesh>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={SHORE_ART.rockInk}
				items={parts.stones}
				receiveShadow
			>
				<sphereGeometry args={[1, 10, 7]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.pads}>
				<cylinderGeometry args={[1, 1, 1, 16, 1, false, 0.3, Math.PI * 1.85]} />
				<ToonMaterial color={PROP_ART.lily} side={DOUBLE_SIDE} />
			</InstancedParts>
			<InstancedParts items={parts.reeds}>
				<cylinderGeometry args={[1, 1, 1, 5]} />
				<ToonMaterial color={PROP_ART.reed} />
			</InstancedParts>
			{flower ? (
				<mesh position={[flower[0], flower[1] + 0.05, flower[2]]}>
					<sphereGeometry args={[0.06, 12, 8]} />
					<ToonMaterial color={PROP_ART.lilyFlower} />
				</mesh>
			) : null}
		</group>
	);
}
