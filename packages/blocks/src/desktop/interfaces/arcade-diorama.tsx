/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	ArcadeActProps,
	type ArcadeActView,
	arcadePaths,
	arcadePlayer,
	type CabinetWords,
	cabinetWords,
} from "./arcade-acts.tsx";
import { Cabinet } from "./arcade-diorama-cabinet.tsx";
import {
	ClawMachine,
	garden,
	Hall,
	PrizeCounter,
} from "./arcade-diorama-hall.tsx";
import {
	type HallLayout,
	POSE_MARK,
	playerPose,
	playerSpot,
	SLAB,
} from "./arcade-diorama-layout.ts";
import { type Machine, machineSummary } from "./arcade-model.ts";
import type { CabinetSkin } from "./arcade-palette.ts";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import { Bushes, LampPosts, TreeGrove } from "./game3d-props.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";

export {
	ARCADE_RIM,
	type HallLayout,
	hallColumns,
	layoutHall,
	type PlacedCabinet,
	playerPose,
	playerSpot,
} from "./arcade-diorama-layout.ts";
export { reelIcon } from "./arcade-diorama-lettering.tsx";

/**
 * The Arcade as an isometric diorama on the game kit (game3d-stage.tsx):
 * a cut-away arcade hall on the island, its carpet starred, its walls
 * trimmed with neon tubes that glow at night, and one toon slot cabinet
 * per agent in rows across the floor, every screen turned to the camera:
 * three reels of bold pixel-art symbols for its latest conversations, a
 * jackpot topper that lights when a reply waits on you and a red lamp
 * when a run failed. Each agent stands beside their cabinet as a villager,
 * working the machine while it runs, waving at a jackpot and slumped by a
 * tilt; their name plate opens the machine.
 */

/** The act layer for the scene: who is on stage and how to draw them. */
export interface ArcadeSceneActs {
	onStage: readonly InterfaceAgentAct[];
	view: ArcadeActView;
}

export interface ArcadeDioramaProps {
	/** The act layer (a snapshot with `asks`); without it, today's floor. */
	acts?: ArcadeSceneActs | null;
	/** Replies waiting on you across the hall (the Collect booth's count). */
	collectable: number;
	hall: HallLayout;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onCollect: () => void;
	onSelect: (machineId: string) => void;
	/**
	 * Phones: each player's name plate rides above their cabinet's marquee
	 * instead of over their head, so it never covers the reels.
	 */
	platesAbove?: boolean;
	quality: RenderQuality;
	reduced: boolean;
	selectedId: string | null;
	shape: IslandShape;
	skinOf: (machine: Machine) => CabinetSkin;
	theme: Scene3dTheme;
}

/** The arcade diorama: island, garden, hall, cabinets, players and prizes. */
export function ArcadeDioramaScene({
	acts = null,
	collectable,
	platesAbove = false,
	hall,
	looks,
	night,
	onCollect,
	onSelect,
	quality,
	reduced,
	selectedId,
	shape,
	skinOf,
	theme,
}: ArcadeDioramaProps) {
	const tl = useLiteralMessages();
	const { halfDepth, halfWidth } = hall;
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(x) < halfWidth + 0.35 && Math.abs(z) < halfDepth + 0.35,
		[halfDepth, halfWidth]
	);
	const green = useMemo(
		() => garden(shape, halfWidth, halfDepth),
		[halfDepth, halfWidth, shape]
	);
	const lamps = useMemo<Vec3[]>(
		() => [
			[halfWidth + 0.5, 0, halfDepth + 0.4],
			[-halfWidth - 0.5, 0, halfDepth + 0.4],
		],
		[halfDepth, halfWidth]
	);
	const stations = useMemo(() => {
		const map = new Map<string, Vec3>();
		for (const cabinet of hall.cabinets) {
			const [x, z] = playerSpot(cabinet);
			map.set(cabinet.machine.agent.id, [x, SLAB, z]);
		}
		return map;
	}, [hall.cabinets]);
	const paths = useMemo(
		() => (hall.you ? arcadePaths(stations, hall.you.points, SLAB) : undefined),
		[hall.you, stations]
	);
	const onStage = useMemo(
		() => new Map((acts?.onStage ?? []).map((act) => [act.agentId, act])),
		[acts?.onStage]
	);
	const actView = acts?.view ?? null;
	const { workBubbles } = useGameKitSettings();
	const wordsOf = (agentId: string): CabinetWords | null => {
		const act = actView?.acts.get(agentId);
		return act && actView
			? cabinetWords(
					act,
					actView.snapshot,
					actView.nowMs,
					actView.clock,
					workBubbles
				)
			: null;
	};
	const players = useMemo<VillagerSpec[]>(
		() =>
			hall.cabinets.flatMap((cabinet) => {
				const { machine } = cabinet;
				const base = looks.get(machine.agent.id);
				if (!base) {
					return [];
				}
				const act = onStage.get(machine.agent.id);
				const [px, pz] = playerSpot(cabinet);
				if (act && actView && paths) {
					return arcadePlayer({
						act,
						base: {
							facing: cabinet.yaw - 1.15,
							id: machine.id,
							position: [px, SLAB, pz],
						},
						label: "Open the machine.",
						looks: base,
						paths,
						reduced,
						view: actView,
					});
				}
				const pose = playerPose(machine);
				// Beside the cabinet, turned three-quarters toward its screen
				// (still showing their face); turned out to wave or slump.
				const toScreen = cabinet.yaw - 1.15;
				const facing =
					pose === "needs-you" || pose === "failed" ? FACE_CAMERA : toScreen;
				return [
					{
						facing,
						id: machine.id,
						label: tl("{summary}. Open the machine", {
							summary: machineSummary(machine),
						}),
						looks: base,
						name: machine.name,
						pose,
						position: [px, SLAB, pz],
					},
				];
			}),
		[actView, hall.cabinets, looks, onStage, paths, reduced, tl]
	);
	// With acts, every player keeps its own plate (players walk to the
	// you-spot, so a plate above the cabinet would point at nobody).
	const above = platesAbove && !acts;
	return (
		<group>
			<IsoIsland shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reduced}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<LampPosts lamps={lamps} night={night} />
			<Hall halfDepth={halfDepth} halfWidth={halfWidth} night={night} />
			{hall.cabinets.map((cabinet) => {
				const looksOf = looks.get(cabinet.machine.agent.id);
				const skin = skinOf(cabinet.machine);
				return (
					<group
						key={cabinet.machine.id}
						onClick={(event) => {
							event.stopPropagation();
							onSelect(cabinet.machine.id);
						}}
						position={[cabinet.x, SLAB, cabinet.z]}
						rotation={[0, cabinet.yaw, 0]}
					>
						<Cabinet
							accent={looksOf?.accent ?? skin.trim}
							body={looksOf?.body ?? skin.body}
							machine={cabinet.machine}
							night={night}
							skin={skin}
							words={wordsOf(cabinet.machine.agent.id)}
						/>
					</group>
				);
			})}
			<PrizeCounter at={hall.counter} night={night} />
			<ClawMachine at={hall.claw} night={night} />
			{acts ? null : (
				// With acts, answers are tickets on the counter's tray instead.
				<IsoMarker
					at={[hall.counter[0], SLAB + 2.45, hall.counter[1] - 0.4]}
					label={
						collectable > 0
							? tl(
									"Prize counter: collect the reply that has waited longest, {collectable} waiting",
									{ collectable: String(collectable) }
								)
							: "Prize counter: nothing to collect"
					}
					onSelect={onCollect}
				>
					{tl("Collect {collectable}", { collectable: String(collectable) })}
				</IsoMarker>
			)}
			{acts && hall.you ? (
				<ArcadeActProps
					onStage={acts.onStage}
					reduced={reduced}
					stations={stations}
					view={acts.view}
					youLayout={hall.you.layout}
				/>
			) : null}
			{above
				? players.map((player) => {
						const cabinet = hall.cabinets.find(
							(item) => item.machine.id === player.id
						);
						if (!cabinet) {
							return null;
						}
						const mark = POSE_MARK[player.pose];
						return (
							<IsoMarker
								at={[cabinet.x, SLAB + 3.15, cabinet.z]}
								focusId={player.id}
								key={player.id}
								label={player.label}
								onSelect={() => onSelect(player.id)}
								pressed={selectedId === player.id}
							>
								{mark ? (
									<span
										aria-hidden="true"
										className={cn(
											"grid size-4 place-items-center rounded-full font-bold text-[11px] leading-none",
											mark.className
										)}
									>
										{mark.sign}
									</span>
								) : null}
								<span className="max-w-24 truncate">{player.name}</span>
							</IsoMarker>
						);
					})
				: null}
			<Villagers
				iconOnly={acts?.view.iconOnly ?? false}
				onSelect={above ? undefined : onSelect}
				paths={paths}
				plates={!above}
				reducedMotion={reduced}
				selectedId={selectedId}
				villagers={players}
			/>
		</group>
	);
}
