/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	STATION_LAYOUT,
	type StationLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actLife,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";
import {
	Cauldron,
	LITTLE_TREE,
	LittleTree,
	PostBox,
	SleighMailbox,
	StoppedCover,
	seasonNext,
} from "./seasonal-acts-props.tsx";
import {
	SEASON_ACT_WORDS,
	type SeasonStation,
	seasonLimit,
} from "./seasonal-acts-stations.ts";
import {
	ground,
	SEASON_TOOLS,
	seasonHelperDress,
	seasonSkin,
	seasonTimerSkin,
	seasonYouLayout,
	YOU_PLANS,
} from "./seasonal-acts-you.ts";
import type { Season } from "./seasonal-model.ts";
import { SEASON_ACT_ART } from "./seasonal-palette.ts";
import type { WorldDoor } from "./seasonal-world.ts";

export { seasonNext, TomorrowDoor } from "./seasonal-acts-props.tsx";
export {
	boardAgents,
	doorActs,
	doorStand,
	SEASON_ACT_WORDS,
	type SeasonActWords,
	type SeasonStation,
	seasonLimit,
	seasonStations,
} from "./seasonal-acts-stations.ts";
export {
	SEASON_TOOLS,
	seasonActPaths,
	seasonHelperDress,
	seasonTimerSkin,
	seasonYouLayout,
	youPoints,
} from "./seasonal-acts-you.ts";

/**
 * The Seasonal board's act layer (spec §5, seasonal row). Each agent's
 * villager stands at the door of its focus thread (the advent house's
 * door or window, its pumpkin in the patch, its lantern on the street),
 * never just its first door. Garlands are its progress pips; an ask is a
 * letter carried to the you-spot (the sleigh mailbox under a little
 * tree on the square, the cauldron at the patch's gate, the post box at the street's
 * end), where a candle melts with the wait; a stopped run frosts its door
 * shut with an icicle tag (a cobweb over the pumpkin, a lantern gone
 * dark); a limit reads "Snowed in, back 15:10" in the season's words; an
 * answer is a wrapped gift set down at the you-spot, tagged with its
 * headline; helpers are dressed as elves (or the season's helpers), and
 * a scheduled next run is tomorrow's door. Opened doors come from the
 * thread's unread count, never from this browser's storage.
 */

/** The garlands as progress pips: hung, still to hang, a guess. */
function garlandPips(season: Season) {
	const art = SEASON_ACT_ART[season];
	return { done: art.pipDone, estimate: art.pipEstimate, todo: art.pipTodo };
}

/**
 * One station's layout, `front` units out in front of the villager's feet
 * for its board of words. The icicle tags (alarms) stand beside the
 * figure on its right with their plates hanging further right, never over
 * it; the marks (unread, suggestion) low on its left and in front, out of
 * the lane up and to the right where a neighbour's bubble hangs;
 * tomorrow's door (the next sign) and the limit behind it on the left; the
 * garland pips at its right hand, low.
 */
function stationLayout(
	front: number,
	alarms = STATION_LAYOUT.alarms
): StationLayout {
	return {
		// Screen-right of the figure, the plates hanging further right (the
		// kit's side), one plate row above the last.
		alarmStep: STATION_LAYOUT.alarmStep,
		alarms,
		board: [0, 0.15, front],
		cue: [0, 0.02, 0],
		limit: [-0.45, 0, -0.35],
		next: [-0.5, 0, -0.1],
		pips: [0.4, 0.05, 0.25],
		suggestion: [0.3, 0, front + 0.15],
		unread: [-0.6, 0, 0.3],
	};
}

/** Each season's station layout (the patch and street are roomier). */
const SEASON_LAYOUT: Record<Season, StationLayout> = {
	advent: stationLayout(0.6),
	// The patch's villagers stand in the free cells of its checkerboard, a
	// number on either side of the name: the icicle tags stand on the
	// figure's right (their plates hang right), the board of words low on
	// its left.
	halloween: {
		...stationLayout(0.7),
		board: [-1.1, 0.15, 0.4],
	},
	// On the street the front wire's numbers hang at the figure's left:
	// the unread mark stands low on its right instead.
	// The front wire's villagers stand down and to the right of each other:
	// the alarms stand on the figure's left (their plates hang left).
	"lunar-new-year": {
		...stationLayout(0.5, [-0.75, 0, 0.75]),
		unread: [0.6, 0, 0.5],
	},
};

/**
 * The patch's layout for a villager whose right-hand neighbour pumpkin is
 * busy (its number stands where the tags would hang): the tags stand on
 * the figure's left (under its own pumpkin's number) and the board on its
 * right.
 */
const PATCH_FLIPPED: StationLayout = {
	// Low on the left, its plate under its pumpkin's number.
	...stationLayout(0.7, [-0.8, 0, 1.5]),
	board: [1.1, 0.15, -0.4],
};

/**
 * On a phone (icon-only plates) a station's board of words stands further
 * out in front of the figure, where the stage's steeper, turned portrait
 * look leaves room clear of the neighbours' names and bubbles.
 */
const NARROW_BOARD: Record<Season, StationLayout["board"] | undefined> = {
	advent: [1.0, 0.15, 1.0],
	halloween: [2, 0.15, 0.3],
	"lunar-new-year": [1.4, 0.15, 1.4],
};

/** A station's layout: its season's, or the patch's flipped one. */
function layoutOf(
	season: Season,
	station: SeasonStation,
	iconOnly: boolean
): StationLayout {
	const layout = station.flipped ? PATCH_FLIPPED : SEASON_LAYOUT[season];
	const board = iconOnly ? NARROW_BOARD[season] : undefined;
	return board ? { ...layout, board } : layout;
}

/** The villagers as act villagers (plus their elves). */
export function actVillagers({
	acts,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
	season,
	shown,
	slots,
	stations,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	season: Season;
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	stations: readonly SeasonStation[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	const skin = seasonSkin(season);
	for (const station of stations) {
		const act = acts.get(station.agentId);
		const look = looks.get(station.agentId);
		if (!(act && look)) {
			continue;
		}
		const spots: ActSpots = {
			paths,
			slot: slotOf(slots, act.agentId),
			station: station.id,
			stationFacing: LIFE_FACE_CAMERA,
		};
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		cast.push({
			actAgent: act.agentId,
			activate: asking ? () => onAsk(asking.id) : undefined,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			iconOnly: asking && spots.slot ? false : undefined,
			id: act.agentId,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} ${SEASON_ACT_WORDS[season].open}`,
			life: actLife(act, spots, skin, { reduced }),
			looks: {
				...look,
				tool:
					act.act === "working"
						? toolForActivity(act.carry, SEASON_TOOLS)
						: undefined,
			},
			name: asking
				? queuePlateText(
						act.agentName,
						{
							approx: asking.sinceApprox,
							since: asking.since,
							until: asking.expiresAt ?? null,
							untilApprox: asking.expiresApprox,
						},
						nowMs
					)
				: act.agentName,
			pose: "idle",
			position: station.at,
			youSpot: asking && spots.slot ? "slot" : undefined,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				dress: seasonHelperDress(season),
				helpers: act.helpers,
				looks: look,
				station: station.at,
			})
		);
	}
	return cast;
}

export interface SeasonActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	reduced: boolean;
	season: Season;
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	stations: readonly SeasonStation[];
	/** The stopped runs' doors, to frost shut. */
	stopped: readonly WorldDoor[];
}

/** The act props: the you-spot, each station's cues, the stopped doors. */
export function SeasonActProps({
	acts,
	clock,
	iconOnly,
	nowMs,
	offStage,
	onAsk,
	onBlocker,
	onQueue,
	onStage,
	owners,
	reduced,
	season,
	shown,
	slots,
	snapshot,
	stations,
	stopped,
}: SeasonActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	const plan = YOU_PLANS[season];
	const post = ground(plan.post);
	const limitText = seasonLimit(season);
	let mailbox = (
		<>
			<LittleTree at={LITTLE_TREE} />
			<SleighMailbox at={post} />
		</>
	);
	if (season === "halloween") {
		mailbox = <Cauldron at={post} />;
	} else if (season === "lunar-new-year") {
		mailbox = <PostBox at={post} />;
	}
	return (
		<group>
			{mailbox}
			{stopped.map((place) => (
				<StoppedCover key={place.number} place={place} season={season} />
			))}
			<YouSpots
				iconOnly={iconOnly}
				item={seasonSkin(season).deliverable}
				layout={seasonYouLayout(season)}
				nowMs={nowMs}
				offStage={offStage}
				onAsk={onAsk}
				onOpenQueue={onQueue}
				onStage={onStage}
				owners={owners}
				privacy={privacy}
				reduced={reduced}
				shown={shown}
				slots={slots}
				snapshot={snapshot}
				timerSkin={seasonTimerSkin(season)}
				trayTag="headline"
			/>
			{stations.map((station) => {
				const act = acts.get(station.agentId);
				if (!act) {
					return null;
				}
				return (
					<ActStation
						act={act}
						at={station.at}
						clock={clock}
						iconOnly={iconOnly}
						key={station.id}
						layout={layoutOf(season, station, iconOnly)}
						limitText={limitText}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						pipSkin={garlandPips(season)}
						privacy={privacy}
						reduced={reduced}
						renderNext={seasonNext(season)}
						shown={shown}
						snapshot={snapshot}
					/>
				);
			})}
		</group>
	);
}
