/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import { useMemo } from "react";
import { slotOf, toolForActivity } from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts } from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	LampPosts,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	coffeeOf,
	type DeskActivity,
	deskActivity,
	doorLayout,
	doorSpots,
	officePaths,
	WORKER_TOOLS,
	WorkerDeskActs,
	WorkersDoorActs,
	workerLife,
} from "./workers-acts.tsx";
import { Desks } from "./workers-diorama-desks.tsx";
import {
	InboxTray,
	OfficeDoor,
	oldestBlockingWaitMs,
} from "./workers-diorama-door.tsx";
import { cornerPlants, garden } from "./workers-diorama-garden.ts";
import {
	chairOf,
	deskPoint,
	facingOf,
	INBOX_TOP,
	SEAT,
	SEAT_X,
	SLAB,
	workerPose,
} from "./workers-diorama-geometry.ts";
import { deskLayout } from "./workers-diorama-layout.ts";
import {
	WorkerMarkers,
	type WorkersActScene,
} from "./workers-diorama-markers.tsx";
import { CoffeeCorner, LeftWall, Room } from "./workers-diorama-room.tsx";
import { CHAIR_OUT, type OfficePlan } from "./workers-model.ts";
import type { WorkersArt } from "./workers-palette.ts";
import { deskLabel } from "./workers-status.tsx";

export { oldestBlockingWaitMs } from "./workers-diorama-door.tsx";
export { workerPose } from "./workers-diorama-geometry.ts";
export { deskLayout } from "./workers-diorama-layout.ts";
export {
	actScreenLabel,
	actScreenWords,
	screenLabel,
	WorkerMarkers,
	type WorkersActScene,
} from "./workers-diorama-markers.tsx";

/**
 * Workers as an isometric diorama on the game kit (game3d-stage.tsx): a
 * cut-away open-plan office on the island, its back and left walls lined
 * with big windows, a whiteboard and a bookshelf, on a plank floor with a
 * rug. Every agent is a villager at its own desk, on an office chair before
 * a monitor whose screen glows in its conversation's colour (working,
 * waiting on you, a failed run, or a dim screensaver when idle), with the
 * conversation's title on a small screen plate. Working villagers face
 * their screen; one with a reply for you, or a failed run, turns round to
 * the room. Potted plants, desk lamps (lit at night) and a coffee corner
 * fill the office; lawn, trees and lamps sit outside.
 */

export const OFFICE_RIM = 2.6;

const NO_RESTS: ReadonlyMap<string, Vec3 | null> = new Map();

export interface WorkersDioramaProps {
	actScene?: WorkersActScene | null;
	art: WorkersArt;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpenScreen: (workerId: string) => void;
	onOpenWorker: (workerId: string) => void;
	plan: OfficePlan;
	quality: RenderQuality;
	reducedMotion: boolean;
	selectedId: string | null;
	shape: IslandShape;
	theme: Scene3dTheme;
}

/** The office diorama: island, garden, the cut-away room, desks, workers. */
export function WorkersDioramaScene({
	actScene = null,
	art,
	looks,
	night,
	onOpenScreen,
	onOpenWorker,
	plan,
	quality,
	reducedMotion,
	selectedId,
	shape,
	theme,
}: WorkersDioramaProps) {
	const tl = useLiteralMessages();
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(x) < plan.halfWidth + 0.35 &&
			Math.abs(z) < plan.halfDepth + 0.35,
		[plan]
	);
	const green = useMemo(() => garden(shape, plan), [plan, shape]);
	const plants = useMemo(() => cornerPlants(plan), [plan]);
	// Stable items: InstancedParts rebuilds its ink hull whenever they change.
	const pots = useMemo(
		() =>
			plants.pots.map((at) => ({
				position: [at[0], at[1] + 0.2, at[2]] as Vec3,
				scale: [0.2, 0.4, 0.2] as Vec3,
			})),
		[plants]
	);
	const outside = useMemo(
		() => ({
			benches: [
				{ at: [plan.halfWidth * 0.3, 0, plan.halfDepth + 0.9] as Vec3, yaw: 0 },
			],
			lamps: [
				[plan.halfWidth + 0.55, 0, plan.halfDepth + 0.45],
				[-plan.halfWidth - 0.55, 0, plan.halfDepth + 0.45],
			] as Vec3[],
		}),
		[plan]
	);
	const villagers = useMemo<VillagerSpec[]>(
		() =>
			plan.desks.flatMap(({ worker, x, z }) => {
				const base = looks.get(worker.id);
				if (!base) {
					return [];
				}
				return [
					{
						facing: facingOf(worker.state),
						id: worker.id,
						label: tl("{label}. Open their desk", { label: deskLabel(worker) }),
						looks: base,
						name: worker.name,
						pose: workerPose(worker.state),
						position: deskPoint(x, z, [SEAT_X, SLAB + SEAT, CHAIR_OUT]),
					},
				];
			}),
		[looks, plan.desks, tl]
	);
	const actCast = useMemo(() => {
		if (!actScene) {
			return null;
		}
		const chairs = new Map(
			plan.desks.map((desk) => [desk.worker.id, chairOf(desk)])
		);
		const paths = officePaths(plan, chairs, SLAB);
		const coffee = coffeeOf(plan, actScene.acts);
		const specs: VillagerSpec[] = [];
		const activity = new Map<string, DeskActivity>();
		for (const desk of plan.desks) {
			const act = actScene.acts.get(desk.worker.id);
			const base = looks.get(desk.worker.id);
			const chair = chairs.get(desk.worker.id);
			if (!(act && base && chair)) {
				continue;
			}
			activity.set(desk.worker.id, deskActivity(act));
			const facing = facingOf(desk.worker.state);
			specs.push({
				facing,
				id: desk.worker.id,
				label: act.ariaLabel,
				life: workerLife(act, {
					coffee: coffee.get(desk.worker.id) ?? null,
					facing,
					paths,
					reduced: reducedMotion,
					slot: slotOf(actScene.slots.slots, act.agentId),
				}),
				looks: {
					...base,
					tool:
						act.act === "working" && !act.stalled
							? toolForActivity(act.carry, WORKER_TOOLS)
							: undefined,
				},
				name: desk.worker.name,
				pose: "idle",
				position: chair,
			});
			specs.push(
				...apprenticeSpecs({
					agentId: act.agentId,
					helpers: act.helpers,
					looks: base,
					station: deskPoint(desk.x, desk.z, [SEAT_X, SLAB, CHAIR_OUT + 0.4]),
				})
			);
		}
		const rests = new Map(
			[...coffee].map(([id, point]) => [id, paths.points[point] ?? null])
		);
		return { activity, paths, rests, specs };
	}, [actScene, looks, plan, reducedMotion]);
	const door = doorSpots(plan, SLAB);
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
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={[...green.bushes, ...plants.bushes]} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<Benches benches={outside.benches} />
			<LampPosts lamps={outside.lamps} night={night} />
			<Room art={art} night={night} plan={plan} />
			<LeftWall art={art} plan={plan} />
			<InstancedParts castShadow ink={PROP_INK} inkColor={art.pot} items={pots}>
				<cylinderGeometry args={[1, 0.75, 1, 14]} />
				<ToonMaterial color={art.pot} />
			</InstancedParts>
			<CoffeeCorner art={art} at={plan.coffee} />
			<Desks
				activity={actCast?.activity ?? null}
				art={art}
				desks={plan.desks}
				night={night}
				theme={theme}
			/>
			{actScene ? (
				<>
					<OfficeDoor
						art={art}
						at={door.you}
						waitMs={oldestBlockingWaitMs(
							actScene.handlers.snapshot,
							actScene.handlers.nowMs
						)}
					/>
					<InboxTray art={art} at={door.tray} />
					{plan.desks.map((desk) => {
						const act = actScene.acts.get(desk.worker.id);
						return act ? (
							<WorkerDeskActs
								act={act}
								at={[desk.x, 0, desk.z]}
								handlers={actScene.handlers}
								key={desk.worker.id}
								layout={deskLayout(
									desk,
									actCast?.rests.get(desk.worker.id) ?? null,
									plan.coffee,
									actScene.handlers.iconOnly
								)}
							/>
						) : null;
					})}
					<WorkersDoorActs
						handlers={actScene.handlers}
						layout={doorLayout(plan, SLAB, SLAB + INBOX_TOP)}
						offStage={actScene.offStage}
						onStage={actScene.onStage}
						owners={actScene.owners}
						slots={actScene.slots}
					/>
				</>
			) : null}
			<WorkerMarkers
				actScene={actScene}
				onOpenScreen={onOpenScreen}
				onOpenWorker={onOpenWorker}
				plan={plan}
				rests={actCast?.rests ?? NO_RESTS}
				selectedId={selectedId}
			/>
			<Villagers
				onSelect={onOpenWorker}
				paths={actCast?.paths}
				plates={false}
				reducedMotion={reducedMotion}
				selectedId={selectedId}
				villagers={actCast?.specs ?? villagers}
			/>
		</group>
	);
}
