/* eslint-disable react/no-unknown-property */

import { translate as tr } from "@ryu/i18n/lite";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	bedsByAgent,
	type FarmActHandlers,
	FarmBedActs,
	FarmPorchActs,
	porchSpots,
} from "./farm-acts.tsx";
import { cropParts } from "./farm-diorama-crops.ts";
import {
	Barn,
	bedParts,
	fenceRuns,
	groundPaint,
	HayBales,
	Silo,
	scenery,
} from "./farm-diorama-yard.tsx";
import {
	type CropStage,
	type FarmCrop,
	type FarmDiorama,
	type FarmPlot,
	inRect,
	plotMood,
	stageName,
} from "./farm-model.ts";
import { plotLabel } from "./farm-model-labels.ts";
import { FARM_3D } from "./farm-palette.ts";
import type { OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts } from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Bushes,
	Fences,
	LampPosts,
	PathStones,
	Pond,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
	type VillagerTool,
} from "./game3d-villager.tsx";
import { threadStatusLabel } from "./interface-renderer.ts";

/**
 * The Farm as an isometric diorama on the game kit (see game3d-stage.tsx):
 * an island farm with a red barn, a silo and hay by the pond, fenced fields
 * (one per project) and open plots, and one raised bed per agent whose
 * crops are its conversations. A crop's growth is its conversation's
 * state: a sprout with a water drop while it waits on the agent, a leafy
 * plant while the agent works, fruit when it is your turn, and a withered
 * brown plant when a run failed. Each plot's farmer is its agent, posed by
 * the plot's most urgent crop; their name plate opens the plot.
 */

const CROP_INK = PROP_INK * 0.6;

/** A farmer's pose from the plot's most urgent crop. */
const POSE_BY_MOOD: Record<CropStage, VillagerPose> = {
	fallow: "idle",
	growing: "working",
	ripe: "needs-you",
	seed: "waiting",
	withered: "failed",
};

export { cropParts } from "./farm-diorama-crops.ts";

/** A farmer's name plate: the plot, then its ripe count or its mood. */
function farmerLabel(
	plot: FarmPlot,
	mood: CropStage,
	tl: LiteralMessage
): string {
	const name = plotLabel(plot, tl);
	const ripe = plot.crops.filter((crop) => crop.stage === "ripe").length;
	if (ripe > 0) {
		return tl(
			"{plot}, {count, plural, one {{countText} ripe} other {{countText} ripe}}",
			{ count: ripe, countText: String(ripe), plot: name }
		);
	}
	switch (mood) {
		case "fallow":
			return tl("{plot}, fallow", { plot: name });
		case "growing":
			return tl("{plot}, growing", { plot: name });
		case "ripe":
			return tl("{plot}, ripe", { plot: name });
		case "seed":
			return tl("{plot}, seeded", { plot: name });
		default:
			return tl("{plot}, withered", { plot: name });
	}
}

/**
 * The act layer, when the host sends asks (farm-acts.tsx): the farmers'
 * act villagers, their waypoints, and the props at the beds and the porch.
 * Without it the farm draws today's poses.
 */
export interface FarmActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** `benchOf`: where each limited farmer sits. */
	benches: ReadonlyMap<string, string>;
	handlers: FarmActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	paths: LifePaths;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	villagers: readonly VillagerSpec[];
}

export interface FarmDioramaProps {
	actScene?: FarmActScene | null;
	diorama: FarmDiorama;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpenBarn: () => void;
	onOpenCrop: (threadId: string) => void;
	onOpenPlot: (plotId: string) => void;
	quality: RenderQuality;
	reducedMotion: boolean;
	selectedPlotId: string | null;
	shape: IslandShape;
	theme: Scene3dTheme;
}

const TOOLS: readonly VillagerTool[] = ["can", "hoe", "basket"];

/** The farm's diorama: island, barn yard, fields, beds, crops and farmers. */
export function FarmDioramaScene({
	actScene = null,
	diorama,
	looks,
	night,
	onOpenBarn,
	onOpenCrop,
	onOpenPlot,
	quality,
	reducedMotion,
	selectedPlotId,
	shape,
	theme,
}: FarmDioramaProps) {
	const tl = useLiteralMessages();
	const paint = useMemo(() => groundPaint(diorama, night), [diorama, night]);
	const avoid = useMemo(() => {
		const barn = diorama.barn;
		return (x: number, z: number) =>
			inRect(barn, x, z, 0.3) ||
			paint(x, z) !== null ||
			diorama.beds.some(({ bed }) => inRect(bed, x, z, 0.15)) ||
			Math.hypot(x - diorama.silo[0], z - diorama.silo[1]) < 0.7 ||
			Math.hypot(x - diorama.pond.x, z - diorama.pond.z) <
				diorama.pond.radius + 0.25;
	}, [diorama, paint]);
	const crops = useMemo(
		() => diorama.beds.flatMap((placed) => placed.crops),
		[diorama]
	);
	const parts = useMemo(() => cropParts(crops), [crops]);
	const beds = useMemo(() => bedParts(diorama.beds, night), [diorama, night]);
	const green = useMemo(() => scenery(diorama, shape), [diorama, shape]);
	const fences = useMemo(
		() =>
			diorama.fields.flatMap(({ fence }) => (fence ? fenceRuns(fence) : [])),
		[diorama]
	);
	const lamps = useMemo<Vec3[]>(() => {
		const points: Vec3[] = [
			[diorama.barn.maxX + 0.3, 0, diorama.barn.maxZ + 0.3],
		];
		for (const path of diorama.paths) {
			points.push([path.minX + 0.3, 0, path.minZ - 0.1]);
			points.push([path.maxX - 0.3, 0, path.maxZ + 0.1]);
		}
		return points;
	}, [diorama]);
	const stones = useMemo<Vec3[]>(() => {
		// Stepping stones from the barn door down to the front of the farm.
		const x = (diorama.barn.minX + diorama.barn.maxX) / 2;
		const points: Vec3[] = [];
		for (
			let z = diorama.barn.maxZ + 0.5;
			z < diorama.bounds.maxZ + 1.5;
			z += 0.75
		) {
			if (!diorama.beds.some(({ bed }) => inRect(bed, x, z, 0.4))) {
				points.push([x + Math.sin(z * 2.1) * 0.12, 0, z]);
			}
		}
		return points;
	}, [diorama]);
	const villagers = useMemo<VillagerSpec[]>(() => {
		const list: VillagerSpec[] = [];
		for (const [index, { farmer, plot }] of diorama.beds.entries()) {
			const agent = plot.agent;
			const base = agent ? looks.get(agent.id) : undefined;
			if (!(agent && base)) {
				continue;
			}
			const mood = plotMood(plot);
			const pose = POSE_BY_MOOD[mood];
			list.push({
				// Facing the bed (to its left) while it works.
				facing: pose === "working" ? -Math.PI / 2.6 : undefined,
				id: plot.id,
				label: farmerLabel(plot, mood, tl),
				looks: {
					...base,
					tool: pose === "working" ? TOOLS[index % TOOLS.length] : undefined,
				},
				name: plot.name,
				pose,
				position: [farmer[0], 0, farmer[1]],
			});
		}
		return list;
	}, [diorama, looks, tl]);
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
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<Fences runs={fences} />
			<PathStones night={night} size={0.5} stones={stones} />
			<LampPosts lamps={lamps} night={night} />
			<Barn night={night} rect={diorama.barn} />
			<Silo at={diorama.silo} />
			<HayBales at={[diorama.barn.minX + 0.2, diorama.barn.maxZ + 0.55]} />
			<Pond
				at={[diorama.pond.x, 0, diorama.pond.z]}
				night={night}
				radius={diorama.pond.radius}
			/>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={FARM_3D.bedFrame}
				items={beds.planks}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={beds.ridges} receiveShadow>
				<sphereGeometry args={[0.5, 16, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.mounds} receiveShadow>
				<sphereGeometry args={[1, 14, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.stems}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={CROP_INK} items={parts.trunks}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={CROP_INK}
				items={parts.leaves}
				receiveShadow
			>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={CROP_INK} items={parts.balls}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial rim={0.25} />
			</InstancedParts>
			<InstancedParts items={parts.droplets}>
				<sphereGeometry args={[1, 12, 8]} />
				<ToonMaterial rim={0.4} />
			</InstancedParts>
			<CropHits crops={crops} onOpen={onOpenCrop} />
			<Villagers
				iconOnly={actScene?.handlers.iconOnly ?? false}
				// The kids who help are not plots: a pick on one opens nothing.
				onSelect={(id) => {
					if (!id.includes(":helper:")) {
						onOpenPlot(id);
					}
				}}
				paths={actScene?.paths}
				reducedMotion={reducedMotion}
				selectedId={selectedPlotId}
				villagers={actScene?.villagers ?? villagers}
			/>
			{actScene ? <FarmActProps actScene={actScene} diorama={diorama} /> : null}
			{diorama.beds
				.filter(({ plot }) => !plot.agent)
				.map(({ plot, sign }) => (
					<IsoMarker
						at={[sign[0], 0.35, sign[1]]}
						focusId={plot.id}
						key={plot.id}
						label={plotLabel(plot, tl)}
						onSelect={() => onOpenPlot(plot.id)}
						pressed={selectedPlotId === plot.id}
					>
						{plot.name}
					</IsoMarker>
				))}
			{diorama.fields
				.filter(({ fence }) => fence)
				.map(({ field, sign }) => (
					<IsoLabel at={[sign[0], 0.75, sign[1]]} key={field.id}>
						{field.name}
					</IsoLabel>
				))}
			<IsoMarker
				at={[
					(diorama.barn.minX + diorama.barn.maxX) / 2,
					2.6,
					(diorama.barn.minZ + diorama.barn.maxZ) / 2,
				]}
				focusId="barn"
				label="Barn: every crop by status"
				onSelect={onOpenBarn}
			>
				Barn
			</IsoMarker>
		</group>
	);
}

/** The act props at every agent's bed and at the porch. */
function FarmActProps({
	actScene,
	diorama,
}: {
	actScene: FarmActScene;
	diorama: FarmDiorama;
}) {
	const beds = useMemo(() => bedsByAgent(diorama), [diorama]);
	const benches = porchSpots(diorama).benches;
	return (
		<group>
			{[...beds].map(([agentId, placed]) => {
				const act = actScene.acts.get(agentId);
				const bench = actScene.benches.get(agentId);
				return act ? (
					<FarmBedActs
						act={act}
						bench={
							bench
								? (benches[Number(bench.slice("bench-".length))] ?? null)
								: null
						}
						handlers={actScene.handlers}
						key={agentId}
						placed={placed}
					/>
				) : null;
			})}
			<FarmPorchActs
				diorama={diorama}
				handlers={actScene.handlers}
				offStage={actScene.offStage}
				onStage={actScene.onStage}
				owners={actScene.owners}
				slots={actScene.slots}
			/>
		</group>
	);
}

/** One invisible hit box per crop: clicking a plant opens its conversation. */
function CropHits({
	crops,
	onOpen,
}: {
	crops: readonly { crop: FarmCrop; x: number; z: number }[];
	onOpen: (threadId: string) => void;
}) {
	if (crops.length === 0) {
		return null;
	}
	return (
		<group>
			{crops.map(({ crop, x, z }) => (
				<mesh
					key={crop.thread.id}
					onClick={(event) => {
						event.stopPropagation();
						onOpen(crop.thread.id);
					}}
					position={[x, 0.3, z]}
				>
					<boxGeometry args={[0.7, 0.6, 0.7]} />
					<meshBasicMaterial visible={false} />
				</mesh>
			))}
		</group>
	);
}

/** A crop's accessible name, for lists outside the diorama. */
export function cropStatusLabel(
	crop: FarmCrop,
	tl: LiteralMessage = tr
): string {
	return tl("{stage}, {status}", {
		stage: stageName(crop.stage),
		status: threadStatusLabel(crop.status, tl),
	});
}
