/* eslint-disable react/no-unknown-property */

import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Ellipsis, Hourglass, Plus, Reply, Star } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import type { Group } from "three";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, type MeshData, onIsland } from "./game3d-island.ts";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Bushes,
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import { PathActProps, type PathActScene } from "./path-acts.tsx";
import type { PathStopState, PathUnit } from "./path-model.ts";
import { PATH_3D } from "./path-palette.ts";
import { stopAction, stopMeta, stopTitle } from "./path-stop.tsx";
import {
	type PathWorld,
	trailDistance,
	type WorldStone,
} from "./path-world.ts";

/**
 * The Path diorama (see path-world.ts for the layout): a terraced hill on
 * an island with a narrow dirt trail winding up it in switchbacks, stairs
 * where it climbs onto the next terrace, and a chunky stepping-stone pad
 * per conversation whose state shows on the pad itself: a golden glow and
 * a check flag once done, a beacon (and the villager mascot) on the stop
 * to do next, a bouncing "!" where you are needed, a grey mossy stone
 * while it waits. A chunky wooden signpost starts each unit and a summit
 * flag crowns the hill. Every pad and signpost carries a kit plate that is
 * its control.
 */

const TRAIL_HALF_WIDTH = 0.46;
const PAD_RADIUS = 0.56;
const CURRENT_RADIUS = 0.74;
const PAD_HEIGHT = 0.32;
/** The mascot stands a head taller than the other villagers. */
const MASCOT_SCALE = 1.3;
const VILLAGER_HEIGHT = 1.62;

const TOP_COLOR: Record<PathStopState, keyof typeof PATH_3D> = {
	attention: "attention",
	current: "current",
	done: "done",
	fresh: "fresh",
	reply: "reply",
	waiting: "waiting",
	working: "working",
};

/** The mascot's pose from the stop it stands at. */
const POSE: Record<PathStopState, VillagerPose> = {
	attention: "failed",
	current: "needs-you",
	done: "idle",
	fresh: "idle",
	reply: "needs-you",
	waiting: "waiting",
	working: "working",
};

/** Stops that ask for you: a bouncing "!" and their title always shown. */
function needsYou(state: PathStopState): boolean {
	return state === "attention" || state === "reply";
}

function color(key: keyof typeof PATH_3D): string {
	const value = PATH_3D[key];
	return typeof value === "string" ? value : (value[0] ?? "");
}

/** The narrow trail as a ribbon on the ground, its edges blending into grass. */
function trailRibbon(
	world: PathWorld,
	night: boolean,
	theme: Scene3dTheme
): MeshData {
	const dirt = linearRgb(night ? PATH_3D.trailNight : PATH_3D.trail);
	const grass = linearRgb(theme.grass[0]);
	const edge = [0, 1, 2].map(
		(channel) => (dirt[channel] ?? 0) * 0.7 + (grass[channel] ?? 0) * 0.3
	);
	const count = world.trail.length;
	// A solid dirt band with a thin soft edge blending into the grass.
	const offsets = [
		-TRAIL_HALF_WIDTH,
		-TRAIL_HALF_WIDTH * 0.72,
		TRAIL_HALF_WIDTH * 0.72,
		TRAIL_HALF_WIDTH,
	];
	const lanes = offsets.length;
	const position = new Float32Array(count * lanes * 3);
	const normal = new Float32Array(count * lanes * 3);
	const colors = new Float32Array(count * lanes * 3);
	for (let index = 0; index < count; index++) {
		const point = world.trail[index] ?? [0, 0];
		const before = world.trail[Math.max(0, index - 1)] ?? point;
		const after = world.trail[Math.min(count - 1, index + 1)] ?? point;
		const dx = after[0] - before[0];
		const dz = after[1] - before[1];
		const length = Math.hypot(dx, dz) || 1;
		const nx = -dz / length;
		const nz = dx / length;
		const y = (world.trailHeights[index] ?? 0) + 0.07;
		for (const [lane, offset] of offsets.entries()) {
			const base = (index * lanes + lane) * 3;
			position[base] = point[0] + nx * offset;
			position[base + 1] = y;
			position[base + 2] = point[1] + nz * offset;
			normal[base + 1] = 1;
			const tone = lane === 0 || lane === lanes - 1 ? edge : dirt;
			colors[base] = tone[0] ?? 0;
			colors[base + 1] = tone[1] ?? 0;
			colors[base + 2] = tone[2] ?? 0;
		}
	}
	const strips = lanes - 1;
	const index = new Uint32Array(Math.max(0, count - 1) * strips * 6);
	for (let step = 0; step < count - 1; step++) {
		for (let lane = 0; lane < strips; lane++) {
			const a = step * lanes + lane;
			const b = a + lanes;
			index.set([a, a + 1, b, a + 1, b + 1, b], (step * strips + lane) * 6);
		}
	}
	return { color: colors, index, normal, position };
}

/** The hill's terraces: an earth riser under a grass top for each. */
function terraceParts(world: PathWorld, theme: Scene3dTheme) {
	const bodies: InstanceSpec[] = [];
	const tops: InstanceSpec[] = [];
	const { maxX, minX } = world.width;
	const back = world.bounds.minZ + 0.6;
	for (const terrace of world.terraces) {
		const depth = terrace.front - back;
		const x = (minX + maxX) / 2;
		const z = (terrace.front + back) / 2;
		bodies.push({
			color: theme.cliff,
			position: [x, terrace.height / 2, z],
			scale: [maxX - minX, terrace.height, depth],
		});
		tops.push({
			color: theme.grass[terrace.row % theme.grass.length],
			position: [x, terrace.height - 0.04, z - 0.01],
			scale: [maxX - minX + 0.06, 0.1, depth + 0.06],
		});
	}
	return { bodies, tops };
}

/** Stone steps where the trail climbs a terrace. */
function stairParts(world: PathWorld): InstanceSpec[] {
	const steps: InstanceSpec[] = [];
	for (const stair of world.stairs) {
		const dx = Math.sin(stair.yaw);
		const dz = Math.cos(stair.yaw);
		const rise = stair.to - stair.from;
		for (let step = 0; step < 3; step++) {
			const top = stair.from + (rise * (step + 1)) / 3;
			const along = (step - 1) * 0.24;
			steps.push({
				color: PATH_3D.stone,
				position: [
					stair.at[0] + dx * along,
					(stair.from + top) / 2,
					stair.at[1] + dz * along,
				],
				rotation: [0, stair.yaw, 0],
				scale: [0.78, top - stair.from + 0.02, 0.26],
			});
		}
	}
	return steps;
}

/** The pads: chunky stone bodies, coloured tops, flags, moss and glows. */
function padParts(world: PathWorld, night: boolean) {
	const bodies: InstanceSpec[] = [];
	const tops: InstanceSpec[] = [];
	const glows: InstanceSpec[] = [];
	const poles: InstanceSpec[] = [];
	const flags: InstanceSpec[] = [];
	const moss: InstanceSpec[] = [];
	for (const stone of world.stones) {
		const [x, z] = stone.at;
		const { state } = stone.stop;
		const radius = state === "current" ? CURRENT_RADIUS : PAD_RADIUS;
		bodies.push({
			color: night ? PATH_3D.stoneNight : PATH_3D.stone,
			position: [x, stone.y + PAD_HEIGHT / 2, z],
			rotation: [0, stone.index, 0],
			scale: [radius, PAD_HEIGHT, radius],
		});
		const top: InstanceSpec = {
			color: color(TOP_COLOR[state]),
			position: [x, stone.y + PAD_HEIGHT + 0.012, z],
			scale: [radius * 0.8, 0.03, radius * 0.8],
		};
		// Done and current pads glow; the rest are painted stone.
		if (state === "done" || state === "current") {
			glows.push(top);
		} else {
			tops.push(top);
		}
		if (state === "done") {
			const fx = x - 0.4;
			const fz = z - 0.28;
			poles.push({
				position: [fx, stone.y + PAD_HEIGHT + 0.35, fz],
				scale: [0.03, 0.7, 0.03],
			});
			flags.push({
				color: PATH_3D.done,
				position: [fx + 0.17, stone.y + PAD_HEIGHT + 0.6, fz],
				rotation: [0, Math.PI / 4, 0],
				scale: [0.32, 0.2, 0.03],
			});
		}
		if (state === "waiting" || state === "fresh") {
			for (let tuft = 0; tuft < 3; tuft++) {
				const angle = stone.index * 1.7 + tuft * 2.1;
				moss.push({
					color: PATH_3D.moss,
					position: [
						x + Math.cos(angle) * radius * 0.62,
						stone.y + PAD_HEIGHT + 0.02,
						z + Math.sin(angle) * radius * 0.62,
					],
					scale: [0.16, 0.05, 0.12],
				});
			}
		}
	}
	return { bodies, flags, glows, moss, poles, tops };
}

/** Chunky signposts: a thick post, a capped board in the unit's colour. */
function signParts(world: PathWorld) {
	const posts: InstanceSpec[] = [];
	const boards: InstanceSpec[] = [];
	for (const sign of world.signs) {
		const [x, z] = sign.at;
		posts.push({
			color: PATH_3D.signPost,
			position: [x, sign.y + 0.62, z],
			scale: [0.16, 1.24, 0.16],
		});
		boards.push(
			{
				color:
					PATH_3D.signBoards[(sign.unit.index - 1) % PATH_3D.signBoards.length],
				position: [x, sign.y + 1.06, z + 0.06],
				rotation: [0, Math.PI / 4, 0],
				scale: [1.3, 0.5, 0.12],
			},
			{
				color: PATH_3D.signPost,
				position: [x, sign.y + 1.36, z + 0.06],
				rotation: [0, Math.PI / 4, 0],
				scale: [1.42, 0.08, 0.18],
			}
		);
	}
	return { boards, posts };
}

/** The summit: a cairn of stones and a tall flag. */
function summitParts(world: PathWorld) {
	const [x, z] = world.finish;
	const y = world.finishY;
	return {
		cairn: [
			{ position: [x, y + 0.2, z], scale: [0.55, 0.4, 0.5] },
			{ position: [x + 0.08, y + 0.52, z - 0.04], scale: [0.36, 0.3, 0.34] },
			{ position: [x - 0.04, y + 0.76, z], scale: [0.22, 0.2, 0.22] },
		] as InstanceSpec[],
		cloth: [
			{
				color: PATH_3D.flag,
				position: [x + 0.36, y + 1.95, z],
				rotation: [0, Math.PI / 4, 0],
				scale: [0.7, 0.42, 0.05],
			},
		] as InstanceSpec[],
		pole: [
			{
				color: PATH_3D.flagPole,
				position: [x, y + 1.25, z],
				scale: [0.05, 1.9, 0.05],
			},
		] as InstanceSpec[],
	};
}

/** Woods at the back and sides, shrubs and flowers, on the hill's levels. */
function scenery(world: PathWorld, shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	const groundAt = (x: number, z: number) => {
		if (x < world.width.minX || x > world.width.maxX) {
			return 0;
		}
		let height = 0;
		for (const terrace of world.terraces) {
			if (z < terrace.front - 0.15) {
				height = Math.max(height, terrace.height);
			}
		}
		return height;
	};
	const nearRiser = (x: number, z: number) =>
		x > world.width.minX - 0.3 &&
		x < world.width.maxX + 0.3 &&
		world.terraces.some((terrace) => Math.abs(z - terrace.front) < 0.35);
	const signNear = (x: number, z: number) =>
		world.signs.some((sign) => Math.hypot(sign.at[0] - x, sign.at[1] - z) < 1);
	const summitNear = (x: number, z: number) =>
		Math.hypot(world.finish[0] - x, world.finish[1] - z) < 1.4;
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				signNear(fx, fz) ||
				summitNear(fx, fz) ||
				nearRiser(fx, fz)
			) {
				continue;
			}
			const clearance = trailDistance(world.trail, fx, fz);
			const ground = groundAt(fx, fz);
			const outside =
				fz < world.bounds.minZ + 0.9 ||
				fx < world.width.minX - 0.4 ||
				fx > world.width.maxX + 0.4;
			const front = fz > world.bounds.maxZ - 2.4;
			if (outside && !front && clearance > 1.9 && hash < 0.5) {
				let kind: PlantedTree["kind"] = "fruit";
				if (hash < 0.28) {
					kind = "cedar";
				} else if (hash > 0.46) {
					kind = "blossom";
				}
				trees.push({
					at: [fx, ground, fz],
					kind,
					scale: 0.8 + jitter(x, y, 9) * 0.35,
					seed: Math.round(hash * 1000),
				});
			} else if (clearance > 1.05 && hash > 0.86) {
				bushes.push({ at: [fx, ground, fz], scale: 0.75, seed: x * 31 + y });
			} else if (clearance > 0.75 && hash > 0.62) {
				flowers.push({ at: [fx, ground, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/** A red "!" bobbing over a pad that needs you (still under reduced motion). */
function Exclaim({ at, reducedMotion }: { at: Vec3; reducedMotion: boolean }) {
	const ref = useRef<Group>(null);
	useFrame(({ clock }) => {
		const group = ref.current;
		if (!group || reducedMotion) {
			return;
		}
		group.position.y =
			at[1] + Math.abs(Math.sin(clock.elapsedTime * 3.2)) * 0.22;
	});
	return (
		<group position={at} ref={ref} rotation={[0, Math.PI / 4, 0]}>
			<ToonMesh
				castShadow
				color={PATH_3D.attention}
				ink={PROP_INK}
				position={[0, 0.34, 0]}
			>
				<boxGeometry args={[0.13, 0.4, 0.13]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={PATH_3D.attention}
				ink={PROP_INK}
				position={[0, 0.04, 0]}
			>
				<sphereGeometry args={[0.085, 12, 10]} />
			</ToonMesh>
		</group>
	);
}

/** The marker over a pad: its state's mark, and whether its title is pinned. */
function stoneMark(stone: WorldStone): {
	body: ReactNode;
	className?: string;
	pinned: boolean;
} {
	const { state } = stone.stop;
	const icon = "size-3.5 shrink-0";
	const pinned = state === "current" || needsYou(state);
	switch (state) {
		case "current":
			return {
				body: <Star aria-hidden="true" className={`${icon} fill-current`} />,
				className: "bg-(--gk-warn) text-(--gk-edge) h-8 text-[14px]",
				pinned,
			};
		case "attention":
			return {
				body: (
					<span aria-hidden="true" className="px-0.5 font-black">
						!
					</span>
				),
				className: "bg-(--gk-bad) text-white",
				pinned,
			};
		case "done":
			return {
				body: <Check aria-hidden="true" className={icon} strokeWidth={3.5} />,
				className: "bg-(--gk-gold) text-(--gk-edge)",
				pinned,
			};
		case "reply":
			return {
				body: <Reply aria-hidden="true" className={icon} strokeWidth={3} />,
				className: "bg-(--gk-info) text-white",
				pinned,
			};
		case "working":
			return {
				body: <Ellipsis aria-hidden="true" className={icon} strokeWidth={3} />,
				className: "bg-(--gk-good) text-white",
				pinned,
			};
		case "waiting":
			return {
				body: (
					<Hourglass aria-hidden="true" className={icon} strokeWidth={2.75} />
				),
				className: "text-(--gk-ink-muted)",
				pinned,
			};
		default:
			return {
				body: <Star aria-hidden="true" className={icon} strokeWidth={2.75} />,
				className: "text-(--gk-ink-muted)",
				pinned,
			};
	}
}

/** A stone's mark height with acts: just over the pad. */
const ACT_STONE_LIFT = PAD_HEIGHT + 0.3;

/** How high a stop's plate floats: over the mascot's head on the current one. */
function plateLift(stone: WorldStone): number {
	return stone.stop.state === "current"
		? PAD_HEIGHT + VILLAGER_HEIGHT * MASCOT_SCALE + 0.45
		: PAD_HEIGHT + 0.62;
}

/** The camera's pitch, for guessing where plates land on screen. */
const PITCH = 0.56;
/** Roughly how wide a plate is, in world units, for so many characters. */
const plateWidth = (characters: number) => 0.9 + characters * 0.13;

/** Where a world point lands on screen, in world units (camera at 45°). */
function onScreen(x: number, y: number, z: number): [number, number] {
	return [
		(x - z) * Math.SQRT1_2,
		y * Math.cos(PITCH) - (x + z) * Math.SQRT1_2 * Math.sin(PITCH),
	];
}

/**
 * The signposts whose plates would land on a stop plate that is always
 * shown: those keep only their number and "+", their name on hover and
 * focus, so the plates never stack.
 */
function crowdedSigns(world: PathWorld): Set<string> {
	const pinned = world.stones
		.filter(
			(stone) => stone.stop.state === "current" || needsYou(stone.stop.state)
		)
		.map((stone) => {
			const [sx, sy] = onScreen(
				stone.at[0],
				stone.y + plateLift(stone),
				stone.at[1]
			);
			const characters = Math.min(26, stopTitle(stone.stop).length + 8);
			return { sx, sy, width: plateWidth(characters) };
		});
	const crowded = new Set<string>();
	for (const sign of world.signs) {
		const [sx, sy] = onScreen(sign.at[0], sign.y + 1.06, sign.at[1]);
		const width = plateWidth(sign.unit.title.length + 3);
		const hit = pinned.some(
			(plate) =>
				Math.abs(plate.sx - sx) < (plate.width + width) / 2 &&
				Math.abs(plate.sy - sy) < 0.62
		);
		if (hit) {
			crowded.add(sign.unit.id);
		}
	}
	return crowded;
}

/** Shows a plate's title on hover and focus (pinned plates always show it). */
const REVEAL_TITLE = "[&:is(:hover,:focus-visible)_[data-plate-title]]:inline";

export interface PathDioramaProps {
	activeThreadId: string | null;
	/** The act layer: hikers act out their acts; the stops carry its props. */
	actScene?: PathActScene | null;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpen: (threadId: string) => void;
	onStart: (unit: PathUnit) => void;
	quality: RenderQuality;
	reducedMotion: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
	world: PathWorld;
}

/**
 * The arrow keys' order for unit signs: each sign just before its unit's
 * first stop, so the keys walk the trail sign, stops, next sign.
 */
function trailOrder(world: PathWorld): Map<string, number> {
	const order = new Map<string, number>();
	for (const stone of world.stones) {
		const first = order.get(stone.unit.id);
		if (first === undefined || stone.index - 0.5 < first) {
			order.set(stone.unit.id, stone.index - 0.5);
		}
	}
	for (const sign of world.signs) {
		if (!order.has(sign.unit.id)) {
			order.set(sign.unit.id, world.stones.length + order.size);
		}
	}
	return order;
}

export function PathDiorama({
	actScene = null,
	activeThreadId,
	looks,
	night,
	onOpen,
	onStart,
	quality,
	reducedMotion,
	shape,
	theme,
	world,
}: PathDioramaProps) {
	const ribbon = useMemo(
		() => trailRibbon(world, night, theme),
		[night, theme, world]
	);
	const avoid = useMemo(() => {
		const firstFront = world.terraces[0]?.front ?? Number.NEGATIVE_INFINITY;
		return (x: number, z: number) =>
			trailDistance(world.trail, x, z) < TRAIL_HALF_WIDTH + 0.12 ||
			(z < firstFront + 0.2 &&
				x > world.width.minX - 0.2 &&
				x < world.width.maxX + 0.2) ||
			world.signs.some(
				(sign) => Math.hypot(sign.at[0] - x, sign.at[1] - z) < 0.3
			);
	}, [world]);
	const terraces = useMemo(() => terraceParts(world, theme), [theme, world]);
	const stairs = useMemo(() => stairParts(world), [world]);
	const pads = useMemo(() => padParts(world, night), [night, world]);
	const signs = useMemo(() => signParts(world), [world]);
	const summit = useMemo(() => summitParts(world), [world]);
	const green = useMemo(() => scenery(world, shape), [shape, world]);
	const mascot = world.mascot;
	const villagers = useMemo<VillagerSpec[]>(() => {
		const agent = mascot?.stone.stop.agents[0];
		const base = agent ? looks.get(agent.id) : undefined;
		if (!(mascot && agent && base)) {
			return [];
		}
		return [
			{
				id: mascot.stone.stop.thread.id,
				label: `${agent.name}: ${stopAction(mascot.stone.stop)} ${stopTitle(mascot.stone.stop)}`,
				looks: base,
				name: agent.name,
				pose: POSE[mascot.stone.stop.state],
				position: [mascot.at[0], mascot.stone.y + PAD_HEIGHT, mascot.at[1]],
				scale: MASCOT_SCALE,
			},
		];
	}, [looks, mascot]);
	const beacon = world.stones.find((stone) => stone.stop.state === "current");
	const crowded = useMemo(() => crowdedSigns(world), [world]);
	const signOrder = useMemo(() => trailOrder(world), [world]);
	return (
		<group>
			<IsoIsland shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			{/* The terraced hill. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={theme.cliff}
				items={terraces.bodies}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={terraces.tops} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			{/* The trail and its stairs. */}
			<mesh receiveShadow>
				<MeshGeometry data={ribbon} />
				<ToonMaterial polygonOffset polygonOffsetFactor={-2} vertexColors />
			</mesh>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.stoneSide}
				items={stairs}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{/* The pads, by state. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.stoneSide}
				items={pads.bodies}
				receiveShadow
			>
				<cylinderGeometry args={[1, 1.08, 1, 9]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={pads.tops} receiveShadow>
				<cylinderGeometry args={[1, 1, 1, 24]} />
				<ToonMaterial rim={0.2} />
			</InstancedParts>
			<InstancedParts items={pads.glows}>
				<cylinderGeometry args={[1, 1, 1, 24]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={pads.moss}>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={pads.poles}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial color={PATH_3D.flagPole} />
			</InstancedParts>
			<InstancedParts castShadow items={pads.flags}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			{beacon ? (
				<mesh
					position={[beacon.at[0], beacon.y + PAD_HEIGHT + 1.6, beacon.at[1]]}
				>
					<cylinderGeometry args={[0.42, 0.62, 3.2, 24, 1, true]} />
					<CurvedBasicMaterial
						blending={ADDITIVE_BLENDING}
						color={PATH_3D.current}
						depthWrite={false}
						opacity={0.2}
						toneMapped={false}
						transparent
					/>
				</mesh>
			) : null}
			{world.stones
				.filter((stone) => needsYou(stone.stop.state))
				.map((stone) => (
					<Exclaim
						at={[stone.at[0], stone.y + PAD_HEIGHT + 0.35, stone.at[1]]}
						key={stone.stop.thread.id}
						reducedMotion={reducedMotion}
					/>
				))}
			{/* Signposts and the summit. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.signPost}
				items={signs.posts}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial planks />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.signPost}
				items={signs.boards}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial planks />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.stoneSide}
				items={summit.cairn}
				receiveShadow
			>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial color={PATH_3D.stone} />
			</InstancedParts>
			<InstancedParts castShadow items={summit.pole}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.flag}
				items={summit.cloth}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{actScene ? (
				<>
					{/* With acts each agent's hiker plate is its one target. */}
					<Villagers
						iconOnly={actScene.handlers.iconOnly}
						paths={actScene.paths}
						reducedMotion={reducedMotion}
						villagers={actScene.villagers}
					/>
					<PathActProps
						acts={actScene.acts}
						handlers={actScene.handlers}
						offStage={actScene.offStage}
						onStage={actScene.onStage}
						owners={actScene.owners}
						slots={actScene.slots}
						stones={actScene.stones}
						world={world}
					/>
				</>
			) : (
				// Decorative: the stone's own plate is the control.
				<Villagers
					plates={false}
					reducedMotion={reducedMotion}
					villagers={villagers}
				/>
			)}
			{/* With acts the unit signs step aside (the HUD's New thread starts
			    one): the stops' props and the hikers' plates need the room. */}
			{(actScene ? [] : world.signs).map((sign) => (
				<IsoMarker
					at={[sign.at[0], sign.y + 1.06, sign.at[1]]}
					className={cn("h-8 text-[14px]", REVEAL_TITLE)}
					key={sign.unit.id}
					label={`Unit ${sign.unit.index}, ${sign.unit.title}: start a new thread here`}
					onSelect={() => onStart(sign.unit)}
					order={signOrder.get(sign.unit.id)}
				>
					<span className="text-(--gk-ink-muted) tabular-nums">
						{sign.unit.index}
					</span>
					<span
						className={
							actScene || crowded.has(sign.unit.id) ? "hidden" : "inline"
						}
						data-plate-title=""
					>
						{sign.unit.title}
					</span>
					<Plus
						aria-hidden="true"
						className="size-4 text-(--gk-ink-muted)"
						strokeWidth={3}
					/>
				</IsoMarker>
			))}
			{/* Later plates draw over earlier ones: the pinned stops come last. */}
			{[...world.stones]
				.sort(
					(a, b) => Number(stoneMark(a).pinned) - Number(stoneMark(b).pinned)
				)
				.map((stone) => {
					const mark = stoneMark(stone);
					const title = stopTitle(stone.stop);
					const current = stone.stop.state === "current";
					const action = current ? `${stopAction(stone.stop)}: ` : "";
					// With acts no mascot stands on the stone: its mark sits low, under
					// the hikers' plates and alarms.
					const lift = actScene ? ACT_STONE_LIFT : plateLift(stone);
					return (
						<IsoMarker
							at={[stone.at[0], stone.y + lift, stone.at[1]]}
							className={cn(mark.className, REVEAL_TITLE)}
							key={stone.stop.thread.id}
							label={`${action}${title}. ${stopMeta(stone.stop)}.`}
							onSelect={() => onOpen(stone.stop.thread.id)}
							order={stone.index}
							pressed={stone.stop.thread.id === activeThreadId}
						>
							{mark.body}
							<span
								// With acts the hikers and their props carry the words:
								// the stones keep only their marks.
								className={cn(
									"max-w-40 truncate",
									mark.pinned && !actScene ? "inline" : "hidden"
								)}
								data-plate-title=""
							>
								{current ? `${stopAction(stone.stop)}: ${title}` : title}
							</span>
						</IsoMarker>
					);
				})}
		</group>
	);
}
