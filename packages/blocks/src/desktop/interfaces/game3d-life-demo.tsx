import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Sparkles } from "lucide-react";
import { useMemo, useRef } from "react";
import { GameTitlePlate } from "./game-hud.tsx";
import { GameHudSlot, GameShell } from "./game-shell.tsx";
import {
	ActStation,
	useStageWidth,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actLife,
	actOverlays,
	actSummaryLine,
	actTotals,
	bubbleOverlayId,
	overlayBudget,
	slotOf,
	stageAgents,
	toolForActivity,
	YOU_SLOTS,
	youSpotSlots,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { IslandGrass, IsoIsland, islandFor } from "./game3d-ground.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { Crates, PathStones, TreeGrove } from "./game3d-props.tsx";
import {
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
	useReducedMotion,
} from "./game3d-stage.tsx";
import {
	useVillagerLooks,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/**
 * The act layer's reference scene, for the story harness (`?demo=life`)
 * and the games that adopt it: one island, a station per agent, and the
 * you-spot queue at the front, all driven by `agentActs` on a snapshot
 * (the useful-state fixture in the harness). It wires every kit piece the
 * way a game should: `actLife` scripts on the villagers, `youSpotSlots`
 * for the queue (villagers and notice posts), `stageAgents`, the meters,
 * alarms, signs, apprentices and tray, the overlay budget, and the DOM
 * queue, HUD summary, Queue and need-you buttons, blind-spot caption,
 * announcer and cards. Without a snapshot it uses an empty island.
 */

const COLUMNS = 5;
const STATION_GAP_X = 2.6;
const STATION_GAP_Z = 3;
const STATIONS_TOP = -3.2;

/** The you-spot: the queue points and the tray, at the front left. */
const YOU_POINTS: Record<string, Vec3> = {
	you: [-6.4, 0, 4.4],
	"you-1": [-7.4, 0, 5.6],
	"you-2": [-5.8, 0, 5.6],
	"you-3": [-4.2, 0, 5.6],
	"you-4": [-2.6, 0, 5.6],
	"you-tray": [-6.4, 0, 3.2],
};

function stationAt(index: number): Vec3 {
	const column = index % COLUMNS;
	const row = Math.floor(index / COLUMNS);
	return [
		(column - (COLUMNS - 1) / 2) * STATION_GAP_X,
		0,
		STATIONS_TOP + row * STATION_GAP_Z,
	];
}

/** Waypoints: a lane in front of each station row, joined to the you-spot. */
function demoPaths(stations: readonly Vec3[]): LifePaths {
	const points: Record<string, Vec3> = { ...YOU_POINTS };
	const links: [string, string][] = [
		["you", "you-1"],
		["you-1", "you-2"],
		["you-2", "you-3"],
		["you-3", "you-4"],
		["you", "you-tray"],
	];
	const rows = Math.max(1, Math.ceil(stations.length / COLUMNS));
	for (let row = 0; row < rows; row++) {
		const z = STATIONS_TOP + row * STATION_GAP_Z + 1.2;
		const west = `lane-${row}-w`;
		const east = `lane-${row}-e`;
		points[west] = [-7.2, 0, z];
		points[east] = [6.6, 0, z];
		links.push([west, east], [west, "you"]);
		if (row > 0) {
			links.push([`lane-${row - 1}-w`, west]);
		}
	}
	for (const [index, station] of stations.entries()) {
		const row = Math.floor(index / COLUMNS);
		const id = `station-${index}`;
		points[id] = station;
		const lane = `lane-${row}-stop-${index}`;
		points[lane] = [station[0], 0, station[2] + 1.2];
		links.push([id, lane], [lane, `lane-${row}-w`], [lane, `lane-${row}-e`]);
	}
	return { links, points };
}

const SKIN = { deliverable: { shape: "box" as const } };

const point = (name: string): Vec3 => YOU_POINTS[name] ?? [0, 0, 0];
const YOU_LAYOUT: YouSpotLayout = {
	offStage: [6.4, 0.6, 5.4],
	slots: {
		"you-1": point("you-1"),
		"you-2": point("you-2"),
		"you-3": point("you-3"),
		"you-4": point("you-4"),
	},
	tally: [point("you-4")[0] + 1.4, 0.6, point("you-4")[2]],
	tray: point("you-tray"),
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	asks: [],
	groups: [],
	threads: [],
	version: INTERFACE_PROTOCOL_VERSION,
};

const NO_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

/** The demo scene for `snapshot`, answering through `port`. */
export function LifeDemo({
	capacity = Number.POSITIVE_INFINITY,
	port = NO_PORT,
	snapshot = EMPTY,
}: {
	port?: InterfacePort;
	snapshot?: InterfaceSnapshot;
	/** Stations on the island (a seat-capped game's cap); the rest are off stage. */
	capacity?: number;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const reduced = useReducedMotion();
	const night = useGameNight(rootRef);
	const view = useIsoView();
	const width = useStageWidth(rootRef);
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, capacity),
		[acts, capacity]
	);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const totals = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const stations = useMemo(
		() => onStage.map((_, index) => stationAt(index)),
		[onStage]
	);
	const paths = useMemo(() => demoPaths(stations), [stations]);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(
		actOverlays(
			onStage,
			slots,
			offStage,
			onStage.find((act) => act.act === "working")?.agentId ?? null,
			{ reduced }
		)
	);
	const shownKey = [...shown].sort().join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shownIds = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const ids = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(ids, night);
	const villagers = useMemo<VillagerSpec[]>(() => {
		const cast: VillagerSpec[] = [];
		for (const [index, act] of onStage.entries()) {
			const look = looks.get(act.agentId);
			const station = stations[index];
			if (!(look && station)) {
				continue;
			}
			const spots: ActSpots = {
				paths,
				slot: slotOf(slots.slots, act.agentId),
				station: `station-${index}`,
				stationFacing: LIFE_FACE_CAMERA,
			};
			const asking = act.act === "asking" && act.ask;
			const askId = act.ask?.id;
			const bubbleId = bubbleOverlayId(act);
			cast.push({
				activate: asking && askId ? () => cards.openAsk(askId) : undefined,
				actAgent: act.agentId,
				bubble: bubbleId ? shownIds.has(bubbleId) : true,
				id: act.agentId,
				label: asking ? `${act.ariaLabel} Answer their ask.` : act.ariaLabel,
				// Queue plates keep their words ("Ada · 14m") on narrow stages.
				iconOnly: asking && spots.slot ? false : undefined,
				life: actLife(act, spots, SKIN, { reduced }),
				youSpot: asking && spots.slot ? "slot" : undefined,
				looks: {
					...look,
					tool: act.act === "working" ? toolForActivity(act.carry) : undefined,
				},
				name:
					asking && act.ask
						? queuePlateText(
								act.agentName,
								{
									approx: act.ask.sinceApprox,
									since: act.ask.since,
									until: act.ask.expiresAt ?? null,
									untilApprox: act.ask.expiresApprox,
								},
								nowMs
							)
						: act.agentName,
				pose: "idle",
				position: station,
			});
			cast.push(
				...apprenticeSpecs({
					agentId: act.agentId,
					helpers: act.helpers,
					looks: look,
					station,
				})
			);
		}
		return cast;
	}, [
		cards.openAsk,
		looks,
		nowMs,
		onStage,
		paths,
		reduced,
		shownIds,
		slots.slots,
		stations,
	]);
	const shape = useMemo(() => islandFor(18, 13, 1), []);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const agentList = (
		<ActAgentList
			acts={acts}
			clock={clock}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			onOpenThread={port.openThread}
			snapshot={snapshot}
		/>
	);
	return (
		<GameShell
			accent="leaf"
			hud={
				<>
					<GameHudSlot at="top-left" className="flex-col items-start">
						<GameTitlePlate
							compact={budget.narrow}
							icon={<Sparkles />}
							keepStatus
							status={actsView.enabled ? actSummaryLine(totals) : undefined}
							title="Behaviour demo"
						/>
						<BlindSpotCaption snapshot={snapshot} />
					</GameHudSlot>
					<GameHudSlot at={budget.narrow ? "bottom-left" : "top-right"}>
						<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
						<QueueButton
							acts={acts}
							clock={clock}
							narrow={budget.narrow}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							openRef={queueOpener}
							snapshot={snapshot}
							totals={totals}
							unowned={unowned}
						/>
					</GameHudSlot>
					<GameHudSlot at="bottom-right">
						<IsoZoomControls view={view} />
					</GameHudSlot>
				</>
			}
			label="Behaviour demo"
			rootRef={rootRef}
			testId="life-demo"
		>
			<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
				Behaviour demo
			</h1>
			<AskQueueList
				acts={acts}
				clock={clock}
				fallbackFocus={headingRef}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				snapshot={snapshot}
				unowned={unowned}
			/>
			<IsoStage
				bounds={{ maxX: 8.5, maxZ: 7, minX: -8.5, minZ: -5, top: 2.6 }}
				fallback={<div className="p-4">{agentList}</div>}
				fill={1.05}
				label="Behaviour demo: a station per agent and the queue of asks at the front."
				night={night}
				reducedMotion={reduced}
				view={view}
			>
				{({ quality, theme }) => (
					<>
						<IsoIsland shape={shape} theme={theme} />
						<IslandGrass
							quality={quality}
							reducedMotion={reduced}
							shape={shape}
							theme={theme}
						/>
						<TreeGrove
							theme={theme}
							trees={[
								{ at: [-8.6, 0, -4], kind: "fruit", scale: 1, seed: 2 },
								{ at: [8.4, 0, 4.6], kind: "blossom", scale: 0.9, seed: 5 },
							]}
						/>
						<PathStones night={night} stones={Object.values(YOU_POINTS)} />
						<Crates
							crates={stations.map((at) => ({
								at: [at[0] + 0.7, 0, at[2] - 0.5] as Vec3,
								scale: 0.8,
							}))}
						/>
						<Villagers
							iconOnly={budget.iconOnly}
							onSelect={(agentId) => {
								const threadId = acts.get(agentId)?.threadId;
								if (threadId) {
									port.openThread(threadId);
								}
							}}
							paths={paths}
							reducedMotion={reduced}
							villagers={villagers}
						/>
						<YouSpots
							iconOnly={budget.iconOnly}
							item={SKIN.deliverable}
							layout={YOU_LAYOUT}
							nowMs={nowMs}
							offStage={offStage}
							onAsk={(askId) => cards.openAsk(askId)}
							onOpenQueue={() => openQueue(queueOpener)}
							onStage={onStage}
							owners={owners}
							privacy={privacy}
							reduced={reduced}
							shown={shown}
							slots={slots}
							snapshot={snapshot}
						/>
						{onStage.map((act, index) => {
							const station = stations[index];
							return station ? (
								<ActStation
									act={act}
									at={station}
									clock={clock}
									iconOnly={budget.iconOnly}
									key={act.agentId}
									nowMs={nowMs}
									onAsk={(askId) => cards.openAsk(askId)}
									onBlocker={(threadId, agentName) =>
										cards.openBlocker(threadId, agentName)
									}
									privacy={privacy}
									reduced={reduced}
									shown={shown}
									snapshot={snapshot}
								/>
							) : null;
						})}
					</>
				)}
			</IsoStage>
			<ActAnnouncer sentence={sentence} />
			{cards.element}
		</GameShell>
	);
}

/** Where the you-spot slots are, for checks that they never overlap. */
export const LIFE_DEMO_SLOTS = YOU_SLOTS.map((slot) => YOU_POINTS[slot]);
