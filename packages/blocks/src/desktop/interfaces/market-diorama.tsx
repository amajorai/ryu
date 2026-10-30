/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import { BellRing, Store } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts } from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import type { Scene3dTheme } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	Crates,
	LampPosts,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	Bunting,
	Fountain,
	groundPaint,
	inRect,
	pavedAreas,
	paving,
	STONE,
	scenery,
} from "./market-diorama-scenery.tsx";
import {
	type MarketLot,
	type MarketShop,
	type MarketSquare,
	shopLabel,
} from "./market-model.ts";
import type { MarketArt } from "./market-palette.ts";
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

/** Villager ids are per shop: one agent can keep two shops. */
export function keeperId(shopId: string, agentId: string): string {
	return `${shopId}\n${agentId}`;
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
	const tl = useLiteralMessages();
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
							label: tl(
								"{name}, shopkeeper at {shop}, {pose, select, failed {a run failed} needs-you {waiting on you} waiting {waiting for a reply} working {working} other {idle}}. Place an order with {name}",
								{ name: agent.name, pose, shop: lot.shop.name }
							),
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
		[block, looks, tl]
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
							label: tl("A customer waiting at {name}", {
								name: lot.shop.name,
							}),
							looks: base,
							name: "",
							pose: "waiting" as const,
							position,
						},
					];
				})
			),
		[block, customerLooks, tl]
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
