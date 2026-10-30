/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	type LimitText,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	actBubble,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { bubbleWords, LifeBubbleTag } from "./game3d-life.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { IsoMarker } from "./game3d-stage.tsx";
import { ORIGIN, offset } from "./rides-acts-kerb.ts";
import {
	byNose,
	Hazards,
	Honk,
	RedLight,
	RoofSign,
} from "./rides-acts-props.tsx";
import type { RidesActTrip } from "./rides-acts-trips.ts";
import { RIDES_ACT_3D } from "./rides-palette.ts";

export {
	onRoad,
	ridesCarTarget,
	ridesYouSpot,
} from "./rides-acts-kerb.ts";
export {
	actRouteShare,
	type RidesActTrip,
	type RidesTripTone,
	ridesActTrips,
} from "./rides-acts-trips.ts";

/**
 * The rides act layer. Cars are the actors (`actorTarget`, not villagers):
 * an asking driver pulls up at the pickup kerb in front of you (the queue,
 * with a taxi-meter timer; notices for parked and unowned asks pin to posts
 * there), a delivering one drops its parcel at the kerb, and every other
 * car keeps to its own spot on the map (its route, its pin, or home). Each
 * car is an `ActStation` (hazard alarms, limit light, unread mark,
 * suggestion note, progress and its station board) with a roof sign for
 * the step it is on, and its name plate is its per-agent target. Words only
 * come from the act (`agentActs` on an already-redacted snapshot).
 */

/** What the rides scene needs to act out the snapshot. */
export interface RidesActView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/** Narrow stages: act props and plates collapse to glyphs. */
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	/** Owner names of asks, for notice plates ("Ada asks: …"). */
	owners: ReadonlyMap<string, string>;
	privacy: "full" | "redacted";
	/** The overlay budget's chosen ids (actOverlays). */
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	/** Each trip's act word and stage (pins and labels say it). */
	trips?: ReadonlyMap<string, RidesActTrip>;
}

/** The rides' produce: a parcel. */
const PARCEL = { shape: "bag" as const };

/**
 * A car's name plate as its per-agent target: named by the act sentence,
 * plus "Answer their ask." (an asking driver's plate is its queue plate,
 * "Ada · 14m") or the map's own action.
 */
export function RidesCarPlate({
	act,
	at,
	label,
	onSelect,
	pressed,
	reduced = false,
	view,
}: {
	act: InterfaceAgentAct;
	at: Vec3;
	/** The map's own action for other acts ("Show the trip."). */
	label: string;
	onSelect: () => void;
	pressed: boolean;
	reduced?: boolean;
	view: RidesActView;
}) {
	const tl = useLiteralMessages();
	const ask = act.act === "asking" ? act.ask : null;
	const queued = ask !== null && slotOf(view.slots.slots, act.agentId) !== null;
	// The driver's words ride its plate: the ask, the step (dashed when
	// only partly known), the answer it brings. A phone has no room for the
	// step; under reduced motion the parcel's count says the answer.
	const bubbleId = bubbleOverlayId(act);
	const bubble =
		bubbleId &&
		view.shown.has(bubbleId) &&
		!(view.iconOnly && act.act === "working") &&
		!(reduced && act.act === "delivering")
			? actBubble(act)
			: null;
	// A working car's step is its roof sign, on top of its plate, not a
	// bubble hanging off it onto its neighbours.
	const roofSign = act.act === "working" && bubble ? bubbleWords(bubble) : null;
	return (
		<IsoMarker
			actAgent={act.agentId}
			activate={ask ? () => view.onAsk(ask.id) : undefined}
			at={at}
			className={
				roofSign
					? "relative h-auto flex-col gap-0.5 rounded-xl px-2 py-1 text-[12px]"
					: "relative h-6 px-2 text-[12px]"
			}
			iconOnly={queued ? false : view.iconOnly}
			label={
				ask
					? tl("{ariaLabel} Answer their ask.", { ariaLabel: act.ariaLabel })
					: `${act.ariaLabel} ${label}`
			}
			onSelect={onSelect}
			pressed={pressed}
			youSpot={queued ? "slot" : undefined}
		>
			{bubble && !roofSign ? <LifeBubbleTag bubble={bubble} /> : null}
			{roofSign ? (
				<span
					aria-hidden="true"
					className="max-w-36 truncate rounded-sm bg-(--gk-warn) px-1 font-semibold text-(--gk-edge) text-[11px] leading-4"
					data-budgeted-overlay="work-bubble"
					data-roof-sign=""
				>
					{roofSign}
				</span>
			) : null}
			{ask
				? queuePlateText(
						act.agentName,
						{
							approx: ask.sinceApprox,
							since: ask.since,
							until: ask.expiresAt ?? null,
							untilApprox: ask.expiresApprox,
						},
						view.nowMs
					)
				: act.agentName}
		</IsoMarker>
	);
}

/**
 * Where a car's pieces sit round it (cars are about 1.2 long): the openers
 * (alarms, unread mark) at its right, the next sign and limit light at its
 * left, the station board up and to the right, clear of its name plate and
 * the cars round it.
 */
export const RIDES_STATION_LAYOUT: Partial<StationLayout> = {
	alarms: offset(ORIGIN, 1.6, 0.4),
	board: offset(ORIGIN, 1, -0.7, 0.1),
	cue: [0, 0.02, 0],
	limit: offset(ORIGIN, -0.7, 0.6),
	next: offset(ORIGIN, -0.8, -0.4),
	pips: offset(ORIGIN, 0, 0.75, 0.05),
	suggestion: offset(ORIGIN, -0.7, -0.9),
	unread: offset(ORIGIN, 0.7, -0.6),
};

/** Route pips: legs driven in the meter's yellow, legs ahead in road grey. */
export const RIDES_PIPS = {
	done: RIDES_ACT_3D.pipDone,
	estimate: RIDES_ACT_3D.pipEstimate,
	todo: RIDES_ACT_3D.pipTodo,
};

/** "Red light till 15:10": the rides' words for a usage limit (the kit adds "Likely"). */
export const ridesLimitText: LimitText = (_act, at) =>
	at ? `Red light till ${at}` : "Red light";

/** On a phone the city is small: the board stands well behind the car, up the screen, clear of its neighbours. */
const RIDES_STATION_LAYOUT_NARROW: Partial<StationLayout> = {
	...RIDES_STATION_LAYOUT,
	board: offset(ORIGIN, 0.3, -2, 0.1),
};

/**
 * On a phone a limited car's words ("Red light till 15:10") stand further
 * across than a working car's board, so the two never meet in the small
 * city.
 */
const RIDES_STATION_LAYOUT_NARROW_LIMIT: Partial<StationLayout> = {
	...RIDES_STATION_LAYOUT_NARROW,
	board: offset(ORIGIN, 1.3, -2, 0.1),
};

/** A station's layout: a phone's own (a limit's words apart), or the wide one. */
function ridesStationLayout(
	iconOnly: boolean,
	limited: boolean
): Partial<StationLayout> {
	if (!iconOnly) {
		return RIDES_STATION_LAYOUT;
	}
	return limited
		? RIDES_STATION_LAYOUT_NARROW_LIMIT
		: RIDES_STATION_LAYOUT_NARROW;
}

/** Where a car's station board (its words, a limit's included) stands. */
export function ridesBoardOffset(iconOnly: boolean, limited = false): Vec3 {
	return ridesStationLayout(iconOnly, limited).board ?? ORIGIN;
}

/**
 * The kerb (the kit's `YouSpots`: notices, taxi meters beside queued cars,
 * the tallies, parcels left for you) and every car's station, with a roof
 * sign for the step a working car is on.
 */
export function RidesActProps({
	cars,
	onStage,
	reduced,
	view,
	yaws,
	youLayout,
}: {
	/** Where each on-stage agent's car is now (its act's target). */
	cars: ReadonlyMap<string, Vec3>;
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	view: RidesActView;
	/** Each car's heading (its nose along +z), to set the red light by its front. */
	yaws?: ReadonlyMap<string, number>;
	youLayout: YouSpotLayout;
}) {
	return (
		<group>
			<YouSpots
				iconOnly={view.iconOnly}
				item={PARCEL}
				layout={youLayout}
				nowMs={view.nowMs}
				offStage={view.offStage}
				onAsk={view.onAsk}
				onOpenQueue={view.onQueue}
				onStage={onStage}
				owners={view.owners}
				privacy={view.privacy}
				reduced={reduced}
				shown={view.shown}
				slots={view.slots}
				snapshot={view.snapshot}
				timerSkin={{ color: RIDES_ACT_3D.meter }}
			/>
			{onStage.map((act) => {
				const at = cars.get(act.agentId);
				if (!at) {
					return null;
				}
				return (
					<group key={act.agentId}>
						{act.act === "blocked" &&
						act.blockers[0] &&
						act.blockers[0].kind !== "interrupted" ? (
							<Hazards at={at} reduced={reduced} />
						) : null}
						{act.act === "limited" ? (
							<RedLight at={byNose(at, yaws?.get(act.agentId) ?? 0)} />
						) : null}
						{act.act === "asking" ? (
							<Honk
								at={byNose(at, yaws?.get(act.agentId) ?? 0)}
								reduced={reduced}
								yaw={yaws?.get(act.agentId) ?? 0}
							/>
						) : null}
						{act.act === "working" ? (
							<RoofSign at={at} yaw={yaws?.get(act.agentId) ?? 0} />
						) : null}
						<ActStation
							act={act}
							at={at}
							clock={view.clock}
							iconOnly={view.iconOnly}
							layout={ridesStationLayout(view.iconOnly, act.act === "limited")}
							limitText={ridesLimitText}
							nowMs={view.nowMs}
							onAsk={view.onAsk}
							onBlocker={view.onBlocker}
							pipSkin={RIDES_PIPS}
							privacy={view.privacy}
							reduced={reduced}
							shown={view.shown}
							snapshot={view.snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
