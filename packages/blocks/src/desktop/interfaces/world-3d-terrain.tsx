import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	CLIFF_BOTTOM,
	FollowingPlane,
	MeshGeometry,
	Sea,
	smooth,
} from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import {
	cliffMesh,
	groundMesh,
	ISLAND_MARGIN,
	type IslandShape,
	islandShape,
	onIsland,
	roundedTile,
	shoreDistance,
	steppingStone,
} from "./game3d-island.ts";
import { lawnAlbedo, lawnNoise, mixRgb, type Rgb } from "./game3d-lawn.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { jitter, pick } from "./game3d-math.ts";
import {
	ART_CREAM,
	ART_WHITE,
	type Scene3dTheme,
	SHORE_ART,
	type Vec3,
} from "./game3d-palette.ts";
import {
	type PlantedTree,
	PROP_INK,
	TREE_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";
import type { TreeObstacle } from "./world-3d-focus.ts";
import { tileToWorld } from "./world-3d-theme.ts";
import {
	tileHash,
	tileKey,
	type VillageLayout,
	type VillageTree,
} from "./world-village.ts";

const SAND_DROP = 0.1;
/**
 * Path stones and plaza tiles: inset paving, standing only a sliver above
 * the ground so they read as laid tiles rather than floating slabs.
 */
const PAVER_HEIGHT = 0.016;
/** Path tiles nearly touch: about 0.04 tiles of grass between them. */
const PATH_TILE = 0.96;
const WALL_HEIGHT = 1.5;
/** How far past the grid the office walls stand, in tiles. */
const OFFICE_WALL_GAP = 1.6;

interface TerrainParts {
	/** Flat stamped shapes on the stones: petals and rounded diamonds. */
	diamonds: InstanceSpec[];
	pavers: InstanceSpec[];
	petals: InstanceSpec[];
	rocks: InstanceSpec[];
	/** Starfish arms on the beach. */
	stars: InstanceSpec[];
}

/**
 * "green" is the plaza's front row drawn as lawn with stepping stones
 * (outdoors), so one row of patterned tiles, not a paved square, leads the
 * eye into the village.
 */
type TileKind = "beach" | "grass" | "green" | "path" | "plaza" | "rim";

function tileKind(
	layout: WorldLayout,
	village: VillageLayout,
	x: number,
	y: number,
	theme: Scene3dTheme
): TileKind {
	const inside = x >= 0 && y >= 0 && x < layout.width && y < layout.height;
	if (!inside) {
		return y >= layout.height && theme.rim === "forest" ? "beach" : "rim";
	}
	if (!village.paths.has(tileKey(x, y))) {
		return "grass";
	}
	if (y === village.plaza.bottom && theme.rim === "forest") {
		return "green";
	}
	return y === village.plaza.top || y === village.plaza.bottom
		? "plaza"
		: "path";
}

/**
 * Grass tone from soft patches a few tiles across, with the odd single tile
 * breaking the pattern, so the lawn reads as grass and not a checkerboard.
 */
function grassTone(
	theme: Scene3dTheme,
	x: number,
	y: number,
	hash: number
): string {
	const patch = tileHash(Math.floor(x / 3) + 101, Math.floor(y / 3) - 57);
	return pick(theme.grass, hash % 5 === 0 ? hash : patch);
}

/** Four round petals and a heart: the stamp on custom-design stones. */
function addFlowerStamp(
	parts: TerrainParts,
	at: Vec3,
	size: number,
	petal: string,
	heart: string,
	turn: number
) {
	for (let index = 0; index < 4; index++) {
		const angle = turn + (index * Math.PI) / 2;
		parts.petals.push({
			color: petal,
			position: [
				at[0] + Math.cos(angle) * size,
				at[1],
				at[2] + Math.sin(angle) * size,
			],
			scale: [size * 0.78, 0.012, size * 0.78],
		});
	}
	parts.petals.push({
		color: heart,
		position: [at[0], at[1] + 0.002, at[2]],
		scale: [size * 0.62, 0.012, size * 0.62],
	});
}

/**
 * Plaza pattern tiles, island style: big rounded tiles alternating warm
 * beige and terracotta, stamped with a rounded diamond or a flower.
 */
function addPlazaTile(
	parts: TerrainParts,
	theme: Scene3dTheme,
	x: number,
	y: number,
	at: Vec3
) {
	const [base, tint, motif] = theme.plaza;
	const alternate = (x + y) % 2 === 0;
	parts.pavers.push({
		color: alternate ? tint : base,
		position: [at[0], -0.03, at[2]],
		scale: [0.97, PAVER_HEIGHT + 0.03, 0.97],
	});
	const top: Vec3 = [at[0], PAVER_HEIGHT + 0.001, at[2]];
	if (alternate) {
		addFlowerStamp(parts, top, 0.11, motif, base, Math.PI / 4);
		return;
	}
	parts.diamonds.push({
		color: tint,
		position: top,
		rotation: [0, Math.PI / 4, 0],
		scale: [0.36, 0.012, 0.36],
	});
	parts.diamonds.push({
		color: motif,
		position: [top[0], top[1] + 0.002, top[2]],
		rotation: [0, Math.PI / 4, 0],
		scale: [0.18, 0.012, 0.18],
	});
}

/** Custom-design path stones: soft rounded squares with a small flower. */
function addPathStone(
	parts: TerrainParts,
	theme: Scene3dTheme,
	hash: number,
	at: Vec3
) {
	const tilt = ((hash % 5) - 2) * 0.006;
	parts.pavers.push({
		color: pick(theme.path, hash),
		position: [at[0], -0.03, at[2]],
		rotation: [0, tilt, 0],
		scale: [PATH_TILE, PAVER_HEIGHT + 0.03, PATH_TILE],
	});
	addFlowerStamp(
		parts,
		[at[0], PAVER_HEIGHT + 0.001, at[2]],
		0.085,
		theme.plaza[1],
		theme.plaza[2],
		tilt + Math.PI / 4
	);
}

const SHELLS = SHORE_ART.shells;
const STARFISH = SHORE_ART.starfish;

/** A five-armed starfish lying on the sand: soft rounded arms. */
function addStarfish(parts: TerrainParts, at: Vec3, seed: number) {
	const color = pick(STARFISH, seed);
	const turn = (seed % 60) * 0.1;
	for (let arm = 0; arm < 5; arm++) {
		const angle = turn + (arm * Math.PI * 2) / 5;
		parts.stars.push({
			color,
			position: [
				at[0] + Math.sin(angle) * 0.055,
				at[1] + 0.012,
				at[2] + Math.cos(angle) * 0.055,
			],
			rotation: [0, angle, 0],
			scale: [0.03, 0.016, 0.065],
		});
	}
}

/** Shells, the odd pebble and a starfish scattered over the sand. */
function addBeachDetail(parts: TerrainParts, x: number, y: number, at: Vec3) {
	const hash = tileHash(x, y);
	if (hash % 4 === 3) {
		addStarfish(
			parts,
			[
				at[0] + (jitter(x, y, 90) - 0.5) * 0.5,
				at[1],
				at[2] + (jitter(x, y, 91) - 0.5) * 0.5,
			],
			hash
		);
	}
	if (hash % 5 === 0) {
		parts.rocks.push({
			color: SHORE_ART.rocks[hash % 2],
			position: [at[0], at[1] + 0.03, at[2]],
			rotation: [0, hash, 0],
			scale: [0.2, 0.12, 0.16],
		});
	}
	for (let index = 0; index < hash % 3; index++) {
		parts.rocks.push({
			color: pick(SHELLS, hash + index),
			position: [
				at[0] + (jitter(x, y, 70 + index) - 0.5) * 0.8,
				at[1] + 0.015,
				at[2] + (jitter(x, y, 80 + index) - 0.5) * 0.8,
			],
			rotation: [0, hash + index, 0],
			scale: [0.06, 0.025, 0.05],
		});
	}
}

function buildTerrain(
	layout: WorldLayout,
	village: VillageLayout,
	theme: Scene3dTheme,
	shape: IslandShape
): TerrainParts {
	const parts: TerrainParts = {
		diamonds: [],
		pavers: [],
		petals: [],
		rocks: [],
		stars: [],
	};
	const treeTiles = new Set(
		village.trees.map((tree) => tileKey(tree.x, tree.y))
	);
	const houseTiles = new Set<string>();
	for (const house of village.houses) {
		for (let dy = 0; dy < house.h; dy++) {
			for (let dx = 0; dx < house.w; dx++) {
				houseTiles.add(tileKey(house.x + dx, house.y + dy));
			}
		}
	}
	for (let y = -ISLAND_MARGIN; y < layout.height + ISLAND_MARGIN; y++) {
		for (let x = -ISLAND_MARGIN; x < layout.width + ISLAND_MARGIN; x++) {
			const kind = tileKind(layout, village, x, y, theme);
			const hash = tileHash(x, y);
			const at = tileToWorld(layout, { x, y });
			if (!onIsland(shape, at[0], at[2], 0.45)) {
				continue;
			}
			if (kind === "path") {
				addPathStone(parts, theme, hash, at);
				continue;
			}
			if (kind === "plaza") {
				addPlazaTile(parts, theme, x, y, at);
				continue;
			}
			if (kind === "green") {
				if (steppingStone(x)) {
					addPathStone(parts, theme, hash, at);
				}
				continue;
			}
			const key = tileKey(x, y);
			if (houseTiles.has(key) || treeTiles.has(key)) {
				continue;
			}
			if (kind === "beach") {
				addBeachDetail(parts, x, y, [at[0], -SAND_DROP, at[2]]);
			} else if (kind === "grass" && theme.lawn && hash % 23 === 0) {
				parts.rocks.push({
					color: SHORE_ART.rocksLawn[hash % 2],
					position: [at[0] + 0.2, 0.02, at[2] - 0.1],
					rotation: [0, hash, 0],
					scale: [0.16, 0.1, 0.13],
				});
			}
		}
	}
	return parts;
}

/** The ground's height: land at 0, the beach a step down, a rounded lip. */
function groundHeight(
	layout: WorldLayout,
	shape: IslandShape,
	beach: boolean
): (x: number, z: number) => number {
	const shoreZ = layout.height / 2;
	return (x, z) => {
		const sand = beach
			? smooth(shoreZ - 0.25, shoreZ + 0.35, z) * SAND_DROP
			: 0;
		const lip = smooth(-0.8, 0, shoreDistance(shape, x, z)) * 0.14;
		return -sand - lip;
	};
}

/**
 * Ground colors: lawn a shade darker than the blades (so the ground under
 * them never reads as a flat lime plane), soft dirt under the stones, warm
 * sand on the beach, darker where the waves reach.
 */
function groundColor(
	layout: WorldLayout,
	village: VillageLayout,
	theme: Scene3dTheme,
	shape: IslandShape
): (x: number, z: number) => Rgb {
	const cache = new Map<string, Rgb>();
	const dirt = linearRgb(theme.grout);
	const sand = linearRgb(theme.sand);
	const wet = linearRgb(theme.sandWet);
	const pale = mixRgb(sand, [1, 1, 1], 0.35);
	return (x, z) => {
		const tx = Math.round(x + (layout.width - 1) / 2);
		const ty = Math.round(z + (layout.height - 1) / 2);
		const kind = tileKind(layout, village, tx, ty, theme);
		if (kind === "beach") {
			// Soft drifts of paler sand, darkening where the waves reach.
			const dry = mixRgb(sand, pale, lawnNoise(x, z, 2.4) * 0.6);
			return mixRgb(dry, wet, smooth(-1.2, -0.2, shoreDistance(shape, x, z)));
		}
		if (kind === "plaza") {
			return dirt;
		}
		if (kind === "path") {
			// Grass slivers between the nearly touching path tiles.
			return lawnAlbedo(theme, x, z) ?? dirt;
		}
		// Outdoors the lawn is the same patchy green the blades grow from.
		const lawn = lawnAlbedo(theme, x, z);
		if (lawn) {
			return lawn;
		}
		const key = `${tx},${ty}`;
		let floor = cache.get(key);
		if (!floor) {
			floor = linearRgb(grassTone(theme, tx, ty, tileHash(tx, ty)));
			cache.set(key, floor);
		}
		return floor;
	};
}

const TILE_SHAPE = roundedTile(0.17, 4);
const DIAMOND_SHAPE = roundedTile(0.3, 4);

/**
 * The island: a rounded, wobbly-shored lawn with custom-design path stones,
 * a patterned plaza, a beach in front and a rocky cliff underneath, standing
 * in a sea that bends away with the world.
 */
export function Island({
	layout,
	theme,
	village,
}: {
	layout: WorldLayout;
	theme: Scene3dTheme;
	village: VillageLayout;
}) {
	const outdoors = theme.rim === "forest";
	const shape = useMemo(
		() => islandShape(layout, outdoors),
		[layout, outdoors]
	);
	const parts = useMemo(
		() => buildTerrain(layout, village, theme, shape),
		[layout, shape, theme, village]
	);
	const meshes = useMemo(() => {
		const height = groundHeight(layout, shape, Boolean(theme.water));
		const ground = groundMesh(
			shape,
			height,
			groundColor(layout, village, theme, shape)
		);
		const shoreZ = layout.height / 2 - 0.4;
		const lip = mixRgb(linearRgb(theme.grass[0]), linearRgb(theme.cliff), 0.35);
		const cliff = linearRgb(theme.cliff);
		const deep = linearRgb(theme.cliffDeep);
		const sand = linearRgb(theme.sand);
		const wet = linearRgb(theme.sandWet);
		const wall = cliffMesh(shape, height, CLIFF_BOTTOM, (_, z, t) => {
			if (theme.water && z > shoreZ) {
				return mixRgb(sand, wet, Math.min(1, t * 2.4));
			}
			if (t < 0.12) {
				return lip;
			}
			return mixRgb(cliff, deep, smooth(0.2, 1, t));
		});
		return { ground, wall };
	}, [layout, shape, theme, village]);
	return (
		<group>
			<mesh receiveShadow>
				<MeshGeometry data={meshes.ground} />
				<ToonMaterial planks={!outdoors} vertexColors />
			</mesh>
			<mesh receiveShadow>
				<MeshGeometry data={meshes.wall} />
				<ToonMaterial vertexColors />
			</mesh>
			<InstancedParts
				ink={PROP_INK * 0.7}
				inkColor={theme.path[0]}
				items={parts.pavers}
				receiveShadow
			>
				<MeshGeometry data={TILE_SHAPE} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.diamonds} receiveShadow>
				<MeshGeometry data={DIAMOND_SHAPE} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.petals} receiveShadow>
				<cylinderGeometry args={[1, 1, 1, 14]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts ink={PROP_INK * 0.5} items={parts.stars} receiveShadow>
				<sphereGeometry args={[1, 10, 6]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={SHORE_ART.rockInk}
				items={parts.rocks}
				receiveShadow
			>
				<sphereGeometry args={[1, 10, 7]} />
				<ToonMaterial />
			</InstancedParts>
			{theme.water ? (
				<Sea color={theme.water} shape={shape} />
			) : (
				<FollowingPlane color={theme.sky} y={CLIFF_BOTTOM - 0.7} />
			)}
			{theme.water ? <Pier layout={layout} theme={theme} /> : null}
			{theme.rim === "walls" ? (
				<OfficeWalls layout={layout} theme={theme} />
			) : null}
		</group>
	);
}

const UMBRELLA_STRIPES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** A little wooden jetty running from the beach out over the water. */
function Pier({ layout, theme }: { layout: WorldLayout; theme: Scene3dTheme }) {
	const parts = useMemo(() => {
		const column = Math.round(layout.width * 0.72);
		const [x] = tileToWorld(layout, { x: column, y: 0 });
		const start = tileToWorld(layout, { x: column, y: layout.height + 1 })[2];
		const length = ISLAND_MARGIN + 2.2;
		const planks: InstanceSpec[] = [];
		for (let along = 0; along < length; along += 0.27) {
			planks.push({
				color: Math.round(along / 0.27) % 3 === 0 ? theme.door : theme.trunk,
				position: [x, -0.04, start + along],
				rotation: [0, (jitter(column, along * 10, 3) - 0.5) * 0.04, 0],
				scale: [0.95, 0.06, 0.23],
			});
		}
		const posts: InstanceSpec[] = [];
		for (let along = 0.6; along < length; along += 1.3) {
			for (const side of [-1, 1]) {
				posts.push({
					color: theme.trunk,
					position: [x + side * 0.47, -0.55, start + along],
					scale: [0.07, 1.1, 0.07],
				});
			}
		}
		// A beach umbrella and a striped towel beside the jetty.
		// Off to the side, so the follow camera never has it in its face.
		const [ux, , uz] = tileToWorld(layout, { x: 1, y: layout.height + 1 });
		const towel: InstanceSpec[] = [0, 1, 2, 3, 4].map((stripe) => ({
			color: stripe % 2 === 0 ? ART_WHITE : SHORE_ART.towelStripe,
			position: [ux + 0.55, -0.085, uz - 0.36 + stripe * 0.18],
			scale: [0.5, 0.012, 0.18],
		}));
		posts.push({
			color: SHORE_ART.umbrellaPole,
			position: [ux, 0.45, uz],
			rotation: [0.12, 0, 0.1],
			scale: [0.025, 1.1, 0.025],
		});
		return {
			planks,
			posts,
			towel,
			umbrella: [ux + 0.05, 0.98, uz + 0.06] as Vec3,
		};
	}, [layout, theme]);
	return (
		<group>
			<InstancedParts castShadow items={parts.planks} receiveShadow>
				<boxGeometry />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.posts}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.towel} receiveShadow>
				<boxGeometry />
				<ToonMaterial />
			</InstancedParts>
			{/*
			 * The canopy casts no real shadow (from the follow camera only its
			 * shadow would be in view, a dark blob with no umbrella); a soft
			 * painted shade lies on the sand right under it instead.
			 */}
			<mesh
				position={[
					parts.umbrella[0] + 0.1,
					-SAND_DROP + 0.015,
					parts.umbrella[2],
				]}
				renderOrder={1}
				rotation={[-Math.PI / 2, 0, 0]}
				scale={[1, 0.82, 1]}
			>
				<circleGeometry args={[0.62, 32]} />
				<CurvedBasicMaterial
					color={SHORE_ART.shadow}
					depthWrite={false}
					opacity={0.22}
					polygonOffset
					polygonOffsetFactor={-2}
					transparent
				/>
			</mesh>
			<group position={parts.umbrella} rotation={[0.12, 0, 0.1]}>
				{UMBRELLA_STRIPES.map((stripe) => (
					<mesh key={stripe}>
						<coneGeometry
							args={[
								0.7,
								0.26,
								6,
								1,
								false,
								(stripe * Math.PI) / 4,
								Math.PI / 4,
							]}
						/>
						<ToonMaterial
							color={stripe % 2 === 0 ? ART_CREAM : SHORE_ART.lifebuoy}
						/>
					</mesh>
				))}
			</group>
		</group>
	);
}

/** Spacing of the office windows and potted plants along the walls. */
const WINDOW_EVERY = 3.4;
const WINDOW_WIDTH = 1.5;
const WINDOW_BOTTOM = 0.5;
const WINDOW_HEIGHT = 0.72;
const POT = SHORE_ART.pot;
const POT_LEAVES = SHORE_ART.potLeaves;

interface WallParts {
	frames: InstanceSpec[];
	glass: InstanceSpec[];
	leaves: InstanceSpec[];
	pots: InstanceSpec[];
	walls: { position: Vec3; size: Vec3 }[];
}

/**
 * One wall: from `from` to `to` (x, z) on the floor, facing `inward`, with
 * windows along it and a potted plant between each pair of windows.
 */
function addWall(
	parts: WallParts,
	from: [number, number],
	to: [number, number],
	inward: [number, number]
) {
	const dx = to[0] - from[0];
	const dz = to[1] - from[1];
	const length = Math.hypot(dx, dz);
	const along: [number, number] = [dx / length, dz / length];
	const yaw = Math.atan2(along[1], along[0]);
	parts.walls.push({
		position: [(from[0] + to[0]) / 2, WALL_HEIGHT / 2, (from[1] + to[1]) / 2],
		size: [Math.abs(dx) + 0.3, WALL_HEIGHT, Math.abs(dz) + 0.3],
	});
	const count = Math.max(1, Math.floor(length / WINDOW_EVERY));
	const start = (length - (count - 1) * WINDOW_EVERY) / 2;
	for (let index = 0; index < count; index++) {
		const t = start + index * WINDOW_EVERY;
		const x = from[0] + along[0] * t + inward[0] * 0.16;
		const z = from[1] + along[1] * t + inward[1] * 0.16;
		const y = WINDOW_BOTTOM + WINDOW_HEIGHT / 2;
		parts.frames.push({
			position: [x, y, z],
			rotation: [0, -yaw, 0],
			scale: [WINDOW_WIDTH + 0.14, WINDOW_HEIGHT + 0.14, 0.05],
		});
		parts.glass.push({
			position: [x + inward[0] * 0.03, y, z + inward[1] * 0.03],
			rotation: [0, -yaw, 0],
			scale: [WINDOW_WIDTH, WINDOW_HEIGHT, 0.02],
		});
		// Mullions: one upright and one cross bar.
		parts.frames.push(
			{
				position: [x + inward[0] * 0.05, y, z + inward[1] * 0.05],
				rotation: [0, -yaw, 0],
				scale: [0.05, WINDOW_HEIGHT, 0.03],
			},
			{
				position: [x + inward[0] * 0.05, y, z + inward[1] * 0.05],
				rotation: [0, -yaw, 0],
				scale: [WINDOW_WIDTH, 0.05, 0.03],
			}
		);
		if (index < count - 1) {
			const half = t + WINDOW_EVERY / 2;
			const px = from[0] + along[0] * half + inward[0] * 0.45;
			const pz = from[1] + along[1] * half + inward[1] * 0.45;
			parts.pots.push({
				color: POT,
				position: [px, 0.17, pz],
				scale: [0.18, 0.34, 0.18],
			});
			parts.leaves.push(
				{
					color: pick(POT_LEAVES, index),
					position: [px, 0.58, pz],
					scale: [0.3, 0.34, 0.3],
				},
				{
					color: pick(POT_LEAVES, index + 1),
					position: [px + 0.1, 0.84, pz - 0.04],
					scale: [0.19, 0.22, 0.19],
				}
			);
		}
	}
}

/**
 * Office theme: low walls close the floor on three sides, with tall
 * daylight windows and potted plants between them.
 */
function OfficeWalls({
	layout,
	theme,
}: {
	layout: WorldLayout;
	theme: Scene3dTheme;
}) {
	const parts = useMemo(() => {
		const halfWidth = layout.width / 2 + OFFICE_WALL_GAP;
		const halfDepth = layout.height / 2 + OFFICE_WALL_GAP;
		const back = -halfDepth;
		const front = halfDepth - 0.5;
		const result: WallParts = {
			frames: [],
			glass: [],
			leaves: [],
			pots: [],
			walls: [],
		};
		addWall(result, [-halfWidth, back], [halfWidth, back], [0, 1]);
		addWall(result, [-halfWidth, back], [-halfWidth, front], [1, 0]);
		addWall(result, [halfWidth, back], [halfWidth, front], [-1, 0]);
		return result;
	}, [layout]);
	return (
		<group>
			{parts.walls.map((wall) => (
				<group key={wall.position.join(",")} position={wall.position}>
					<mesh castShadow receiveShadow>
						<boxGeometry args={wall.size} />
						<ToonMaterial color={theme.wall} />
					</mesh>
					<mesh position={[0, -WALL_HEIGHT / 2 + 0.1, 0]}>
						<boxGeometry
							args={[wall.size[0] + 0.04, 0.2, wall.size[2] + 0.04]}
						/>
						<ToonMaterial color={theme.wallTrim} />
					</mesh>
					<mesh position={[0, WALL_HEIGHT / 2, 0]}>
						<boxGeometry
							args={[wall.size[0] + 0.08, 0.07, wall.size[2] + 0.08]}
						/>
						<ToonMaterial color={theme.wallTrim} />
					</mesh>
				</group>
			))}
			<InstancedParts ink={PROP_INK * 0.6} items={parts.frames}>
				<boxGeometry />
				<ToonMaterial color={ART_CREAM} />
			</InstancedParts>
			<InstancedParts items={parts.glass}>
				<boxGeometry />
				<ToonMaterial
					color={theme.windowIdle}
					emissive={theme.windowIdle}
					emissiveIntensity={0.55}
				/>
			</InstancedParts>
			<InstancedParts castShadow ink={PROP_INK} items={parts.pots}>
				<cylinderGeometry args={[1, 0.75, 1, 16]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={TREE_INK * 0.8} items={parts.leaves}>
				<sphereGeometry args={[1, 16, 12]} />
				<ToonMaterial />
			</InstancedParts>
		</group>
	);
}

/** Rim forest beyond the walkable grid, so the village reads as an island. */
function rimTrees(layout: WorldLayout, shape: IslandShape): VillageTree[] {
	const trees: VillageTree[] = [];
	for (let y = -ISLAND_MARGIN; y < layout.height + ISLAND_MARGIN; y++) {
		for (let x = -ISLAND_MARGIN; x < layout.width + ISLAND_MARGIN; x++) {
			const inside = x >= 0 && y >= 0 && x < layout.width && y < layout.height;
			if (inside || y >= layout.height) {
				continue;
			}
			const [wx, , wz] = tileToWorld(layout, { x, y });
			if (!onIsland(shape, wx, wz, 0.55)) {
				continue;
			}
			const hash = tileHash(x, y);
			const outer =
				x === -ISLAND_MARGIN || x === layout.width + ISLAND_MARGIN - 1;
			// The back rows thin out, so the bend of the horizon shows
			// through the tree line instead of a solid wall of canopies.
			let chance = outer ? 520 : 820;
			if (y === -ISLAND_MARGIN) {
				chance = 260;
			} else if (y === -ISLAND_MARGIN + 1) {
				chance = 560;
			}
			if (hash < chance) {
				trees.push({ variant: hash % 4, x, y });
			}
		}
	}
	return trees;
}

const NO_TREES: ReadonlySet<number> = new Set();

/** A tree as planted: where it stands, how big, and which kind. */
interface PlacedTree {
	at: Vec3;
	cedar: boolean;
	hash: number;
	scale: number;
	tree: VillageTree;
}

function placeTrees(
	layout: WorldLayout,
	village: VillageLayout,
	theme: Scene3dTheme
): PlacedTree[] {
	const all =
		theme.rim === "forest"
			? [...village.trees, ...rimTrees(layout, islandShape(layout, true))]
			: village.trees;
	return all.map((tree) => {
		const base = tileToWorld(layout, tree);
		const cedar = theme.rim === "forest" && tree.variant < 2;
		const scale = 0.85 + jitter(tree.x, tree.y, 11) * 0.4;
		return {
			at: [
				base[0] + (jitter(tree.x, tree.y, 7) - 0.5) * 0.3,
				0,
				base[2] + (jitter(tree.x, tree.y, 9) - 0.5) * 0.3,
			],
			cedar,
			hash: tileHash(tree.x, tree.y),
			scale: cedar && tree.variant === 1 ? scale * 1.15 : scale,
			tree,
		};
	});
}

/**
 * Every tree as a rough cylinder (trunk to crown), for the conversation
 * camera's line-of-sight test.
 */
export function treeObstacles(
	layout: WorldLayout,
	village: VillageLayout,
	theme: Scene3dTheme
): TreeObstacle[] {
	return placeTrees(layout, village, theme).map(({ at, cedar, scale }) => ({
		radius: (cedar ? 0.56 : 0.52) * scale,
		top: (cedar ? 1.55 : 1.5) * scale,
		x: at[0],
		z: at[2],
	}));
}

/** Cedars and lollipop fruit trees, cel-shaded with ink, all instanced. */
export function Trees({
	hidden = NO_TREES,
	layout,
	theme,
	village,
}: {
	/**
	 * Trees (by their index in `treeObstacles`) that step out of a
	 * conversation shot.
	 */
	hidden?: ReadonlySet<number>;
	layout: WorldLayout;
	theme: Scene3dTheme;
	village: VillageLayout;
}) {
	const planted = useMemo(
		() =>
			placeTrees(layout, village, theme).map<PlantedTree>(
				({ at, cedar, hash, scale, tree }) => {
					let kind: PlantedTree["kind"] = "fruit";
					if (cedar) {
						kind = "cedar";
					} else if (tree.variant === 3 && hash % 3 === 0) {
						kind = "blossom";
					}
					return { at, kind, scale, seed: hash };
				}
			),
		[layout, theme, village]
	);
	return <TreeGrove hidden={hidden} theme={theme} trees={planted} />;
}
