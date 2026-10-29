/* eslint-disable react/no-unknown-property */
import { BellRing, Store } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland, roundedTile } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import type { LifePaths } from "./game3d-life.ts";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { jitter, pick } from "./game3d-math.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	Crates,
	LampPosts,
	type PlacedBush,
	type PlacedProp,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	LOT_SIZE,
	type MarketLot,
	type MarketRect,
	type MarketShop,
	type MarketSquare,
	PAVEMENT_DEPTH,
	shopLabel,
	toWorld,
	type Vec3,
} from "./market-model.ts";
import { type MarketArt, swatch } from "./market-palette.ts";
import { MarketShops } from "./market-shops.tsx";

/**
 * The Market as an isometric diorama on the game kit (game3d-stage.tsx): a
 * market square on the island. Every project is a shop and every team a
 * striped stall, in two rows round a cobbled square; their shopkeepers (the
 * agents, as the kit's villagers) stand out front, and a queue of customers
 * waits at a shop for each conversation that needs you. A fountain in the
 * square carries a pole strung with bunting to every facade, lamps stand between the
 * shops, and benches, planters and crates of goods line the open edges,
 * with trees all round. Each shop's painted signboard carries its plate
 * (the shop's control); shopkeepers' name plates open a new order with them.
 */

/** A keeper's pose from the orders they are serving at this shop. */
export function keeperPose(shop: MarketShop, agentId: string): VillagerPose {
	const mine = shop.orders.filter((order) => order.agent?.id === agentId);
	if (mine.some((order) => order.status === "attention")) {
		return "failed";
	}
	const agent = shop.agents.find((item) => item.id === agentId);
	if (
		agent?.status === "working" ||
		mine.some((order) => order.status === "working")
	) {
		return "working";
	}
	if (mine.some((order) => order.status === "your-turn")) {
		return "needs-you";
	}
	if (mine.some((order) => order.status === "waiting")) {
		return "waiting";
	}
	return "idle";
}

const POSE_WORDS: Record<VillagerPose, string> = {
	failed: "a run failed",
	idle: "idle",
	"needs-you": "waiting on you",
	waiting: "waiting for a reply",
	working: "working",
};

/** Villager ids are per shop: one agent can keep two shops. */
export function keeperId(shopId: string, agentId: string): string {
	return `${shopId}\n${agentId}`;
}

const STONE = roundedTile(0.17, 4);

function inRect(x: number, z: number, rect: MarketRect, grow = 0): boolean {
	return (
		x >= rect.minX - grow &&
		x <= rect.maxX + grow &&
		z >= rect.minZ - grow &&
		z <= rect.maxZ + grow
	);
}

/** The paved ground: the square, the shop rows' pavement and footprints. */
function pavedAreas(market: MarketSquare) {
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
function paving(market: MarketSquare, art: MarketArt): InstanceSpec[] {
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
function groundPaint(market: MarketSquare, art: MarketArt) {
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
function scenery(market: MarketSquare, shape: IslandShape): Scenery {
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
function Bunting({
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
function Fountain({
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

/** The act layer's cast and props, when the snapshot carries acts. */
export interface MarketActors {
	/** Each shop's busy flag from its keepers' acts, for its lit windows. */
	busy: ReadonlyMap<string, boolean>;
	/** Upcoming runs queueing at their shops (no plates). */
	customers: VillagerSpec[];
	/** Exempt plates collapse to glyphs on narrow stages. */
	iconOnly: boolean;
	/** Shopkeepers driven by their acts (and their helpers). */
	keepers: VillagerSpec[];
	/** Each shop's blocking asks, for its sign. */
	needYou: ReadonlyMap<string, number>;
	paths: LifePaths;
	/** The cross queue, your stall and each station's cues. */
	props: ReactNode;
	/** Each shop's door sign from its keepers' acts (`shopSign`). */
	signs: ReadonlyMap<string, string>;
}

export interface MarketDioramaProps {
	/** With the act layer: keepers act out their agents' state. */
	actors?: MarketActors;
	art: MarketArt;
	block: MarketSquare;
	/** Pennant strings over the square (the `bunting` setting); on by default. */
	bunting?: boolean;
	customerLooks: ReadonlyMap<string, MemberLooks>;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpenKeeper: (shopId: string, agentId: string) => void;
	onOpenShop: (shopId: string) => void;
	quality: RenderQuality;
	reducedMotion: boolean;
	selectedShopId: string | null;
	shape: IslandShape;
	theme: Scene3dTheme;
}

/** The customer standing for a waiting order: stable per conversation. */
export function customerId(threadId: string): string {
	return `customer:${threadId}`;
}

/** The orders a shop's queue shows, front of the queue first. */
function queueOrders(lot: MarketLot) {
	return lot.shop.orders
		.filter(
			(order) => order.status === "attention" || order.status === "your-turn"
		)
		.slice(0, lot.queue.length);
}

/** The market block diorama: island, street, shops, keepers and queues. */
export function MarketDioramaScene({
	actors,
	art,
	block,
	bunting = true,
	customerLooks,
	looks,
	night,
	onOpenKeeper,
	onOpenShop,
	quality,
	reducedMotion,
	selectedShopId,
	shape,
	theme,
}: MarketDioramaProps) {
	const paint = useMemo(() => groundPaint(block, art), [art, block]);
	const avoid = useMemo(() => {
		const { rows, square } = pavedAreas(block);
		return (x: number, z: number) =>
			inRect(x, z, square, 0.2) || rows.some((rect) => inRect(x, z, rect, 0.3));
	}, [block]);
	const stones = useMemo(() => paving(block, art), [art, block]);
	const decor = useMemo(() => scenery(block, shape), [block, shape]);
	const pastKeepers = useMemo<VillagerSpec[]>(
		() =>
			block.lots.flatMap((lot) =>
				lot.keepers.flatMap((position, index) => {
					const agent = lot.shop.agents[index];
					const base = agent ? looks.get(agent.id) : undefined;
					if (!(agent && base)) {
						return [];
					}
					const pose = keeperPose(lot.shop, agent.id);
					return [
						{
							facing: FACE_CAMERA,
							id: keeperId(lot.shop.id, agent.id),
							label: `${agent.name}, shopkeeper at ${lot.shop.name}, ${POSE_WORDS[pose]}. Place an order with ${agent.name}`,
							looks: {
								...base,
								tool: pose === "working" ? ("basket" as const) : undefined,
							},
							name: agent.name,
							pose,
							position,
						},
					];
				})
			),
		[block, looks]
	);
	const pastCustomers = useMemo<VillagerSpec[]>(
		() =>
			block.lots.flatMap((lot) =>
				queueOrders(lot).flatMap((order, index) => {
					const id = customerId(order.thread.id);
					const base = customerLooks.get(id);
					const position = lot.queue[index];
					if (!(base && position)) {
						return [];
					}
					return [
						{
							facing:
								lot.facing === "south" ? -Math.PI / 2 + 0.45 : Math.PI - 0.45,
							id,
							label: `A customer waiting at ${lot.shop.name}`,
							looks: base,
							name: "",
							pose: "waiting" as const,
							position,
						},
					];
				})
			),
		[block, customerLooks]
	);
	const keepers = actors?.keepers ?? pastKeepers;
	const customers = actors?.customers ?? pastCustomers;
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<InstancedParts items={stones} receiveShadow>
				<MeshGeometry data={STONE} />
				<ToonMaterial />
			</InstancedParts>
			<TreeGrove theme={theme} trees={decor.trees} />
			<Bushes bushes={decor.bushes} theme={theme} />
			<FlowerClusters patches={decor.flowers} />
			<Benches benches={decor.benches} />
			<Crates crates={decor.crates} />
			<LampPosts lamps={decor.lamps} night={night} />
			<Fountain art={art} at={decor.pole} night={night} />
			{bunting ? (
				<Bunting
					art={art}
					night={night}
					pole={decor.pole}
					runs={decor.bunting}
				/>
			) : null}
			<MarketShops
				art={art}
				busy={actors?.busy}
				facing="south"
				lots={block.lots}
				night={night}
			/>
			<MarketShops
				art={art}
				busy={actors?.busy}
				facing="east"
				lots={block.lots}
				night={night}
			/>
			{block.lots.map((lot) => {
				const waiting = actors
					? (actors.needYou.get(lot.shop.id) ?? 0)
					: lot.shop.waitingOnYou;
				return (
					<IsoMarker
						at={lot.badge}
						icon={<Store aria-hidden="true" className="size-3.5" />}
						iconOnly={actors?.iconOnly}
						key={lot.shop.id}
						label={
							actors
								? shopLabel(
										{
											...lot.shop,
											busy: actors.busy.get(lot.shop.id) ?? false,
											sign: actors.signs.get(lot.shop.id),
										},
										actors.needYou.get(lot.shop.id) ?? 0
									)
								: shopLabel(lot.shop)
						}
						onSelect={() => onOpenShop(lot.shop.id)}
						pressed={selectedShopId === lot.shop.id}
					>
						{waiting > 0 ? (
							<span className="flex items-center gap-0.5 tabular-nums">
								<BellRing aria-hidden="true" className="size-3.5" />
								{waiting}
							</span>
						) : (
							<Store aria-hidden="true" className="size-3.5" />
						)}
					</IsoMarker>
				);
			})}
			<Villagers
				iconOnly={actors?.iconOnly}
				onSelect={(id) => {
					const [shopId, agentId] = id.split("\n");
					if (shopId && agentId) {
						onOpenKeeper(shopId, agentId);
					}
				}}
				paths={actors?.paths}
				reducedMotion={reducedMotion}
				villagers={keepers}
			/>
			<Villagers
				plates={false}
				reducedMotion={reducedMotion}
				villagers={customers}
			/>
			{actors?.props ?? null}
		</group>
	);
}
