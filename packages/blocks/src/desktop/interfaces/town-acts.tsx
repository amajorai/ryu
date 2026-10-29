import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	blockerAriaLabel,
	type ClockOptions,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceBlocker,
	type InterfaceSnapshot,
	threadClaims,
} from "@ryuhq/protocol/interfaces";
import {
	CalendarX,
	Clock,
	Mail,
	Package,
	Pause,
	ScrollText,
	StickyNote,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	LIMIT_TONE,
	type LimitText,
	limitWords,
	oldBlockersOf,
	unreadAsksOf,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actHasBlocker,
	YOU_SLOTS,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { alarmTone, LimitCue } from "./game3d-alarm.tsx";
import type { LifeBubble, LifePaths } from "./game3d-life.ts";
import { LifeBubbleTag } from "./game3d-life.tsx";
import {
	ProgressPips3D,
	progressText,
	queuePlateText,
	WaitTimer3D,
} from "./game3d-meters.tsx";
import {
	ActPlateButton,
	type ActTargetKind,
	NextSign,
	openerLabel,
	overflowLabel,
} from "./game3d-signs.tsx";
import type { Vec3 } from "./town-art.tsx";
import { HALL_TOP, PAD_Y } from "./town-buildings.tsx";
import {
	LOT,
	needsLevel,
	SIDEWALK,
	type Town,
	type TownBuilding,
} from "./town-model.ts";

/**
 * The town's act layer (spec §5 town row). Each agent's building button
 * stays its one target, named by its act sentence. The act props are
 * anchored overlay buttons in the town's DOM layer (the `data-anchor`
 * pattern): alarms, unread answers and suggestions at each building, and
 * at City Hall's steps the queue (petition letters for unowned or parked
 * asks, a plate over each villager who walked there to ask), the delivery
 * crate at the inbox and the "+N more" tally. The townsfolk walk to the
 * steps to ask and to the inbox to deliver (`actLife`).
 */

/** A delivery crate is the town's deliverable. */
export const TOWN_SKIN: ActSkin = { deliverable: { shape: "box" } };

/** Where City Hall's steps, queue, inbox and tally are, in world units. */
const STEPS_Z = 2.3;
/**
 * The petition queue runs down the plaza from the steps toward you, so on
 * screen each plate sits lower (a row and more apart) and a little right
 * of the one before; a bubble flips to whichever side is clear.
 */
const SLOT_GAP = 0.75;
const SLOT_STEP = 0.75;
export const HALL_SPOTS = {
	slots: YOU_SLOTS.map(
		(_, index) =>
			[0.2 + index * SLOT_GAP, 0.19, STEPS_Z + 0.3 + index * SLOT_STEP] as Vec3
	),
	tally: [0, 1.2, STEPS_Z + 0.7] as Vec3,
	tray: [4.4, 0.19, 4.6] as Vec3,
	you: [0, 0.19, STEPS_Z + 0.75] as Vec3,
};

/** A building's door, where its villager stands (world units). */
export function doorOf(building: TownBuilding): Vec3 {
	return [building.lot.x + LOT * 0.4, 0.19, building.lot.z + LOT * 0.4];
}

/**
 * The townsfolk's waypoints (world units): each door, its block's corner
 * nearest City Hall, then the plaza in front of the steps, the queue
 * slots along the steps and the inbox.
 */
export function townPaths(town: Town): LifePaths {
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	const ring = town.grid.inner / 2 + SIDEWALK / 2;
	points.you = HALL_SPOTS.you;
	points["you-tray"] = HALL_SPOTS.tray;
	for (const [index, slot] of HALL_SPOTS.slots.entries()) {
		points[`you-${index + 1}`] = slot;
	}
	links.push(
		["you", "you-1"],
		["you-1", "you-2"],
		["you-2", "you-3"],
		["you-3", "you-4"],
		["you", "you-tray"]
	);
	for (const district of town.districts) {
		const corner = `corner-${district.id}`;
		points[corner] = [
			district.x - Math.sign(district.x || 1) * ring,
			0.19,
			district.z - Math.sign(district.z || 1) * ring,
		];
		links.push([corner, "you"]);
		for (const building of district.buildings) {
			const door = `door-${building.agent.id}`;
			points[door] = doorOf(building);
			links.push([door, corner]);
		}
	}
	return { links, points };
}

/**
 * The town as the act layer draws it: each agent's building art follows
 * its act, never the threads' statuses. A crane only while its agent
 * works; a beacon only for a counted blocker, toned by kind (an old,
 * uncounted failure lights nothing); no reply bubble (the act's own
 * bubble carries an answer).
 */
export function actTown(
	town: Town,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Town {
	const remade = new Map<TownBuilding, TownBuilding>();
	for (const building of town.buildings) {
		const act = acts.get(building.agent.id);
		if (!act) {
			remade.set(building, building);
			continue;
		}
		const alarm = beaconTone(act);
		remade.set(building, {
			...building,
			alarm,
			calendar: act.blockers.some(
				(blocker) => alarmTone(blocker) === "calendar"
			),
			alert: alarm !== undefined,
			replied: false,
			working: act.act === "working",
		});
	}
	const swap = (building: TownBuilding) => remade.get(building) ?? building;
	// The desk's "Waiting" column and the "Needs you" view: who here asks you
	// or has stopped (a limited agent waits on its limit, not on you).
	const waiting = town.districts.map(
		(district) =>
			district.buildings.filter((building) => {
				const act = acts.get(building.agent.id);
				return act
					? act.act === "asking" || act.act === "blocked"
					: building.counts.attention + building.counts["your-turn"] > 0;
			}).length
	);
	const most = Math.max(0, ...waiting);
	return {
		...town,
		buildings: town.buildings.map(swap),
		districts: town.districts.map((district, index) => ({
			...district,
			buildings: district.buildings.map(swap),
			needs: needsLevel(waiting[index] ?? 0, most),
			petitions: waiting[index] ?? 0,
		})),
	};
}

/** Beacon tones, most severe first (amber is a limit: no beacon). */
const BEACON_ORDER = ["red", "calendar", "grey"] as const;

/**
 * The beacon over an agent's building: the most severe of its counted
 * blockers, whatever their order (a limit first and a failure after still
 * lights red); none for a limit alone.
 */
export function beaconTone(
	act: InterfaceAgentAct
): (typeof BEACON_ORDER)[number] | undefined {
	const tones = new Set(act.blockers.map((blocker) => alarmTone(blocker)));
	return BEACON_ORDER.find((tone) => tones.has(tone));
}

/**
 * What `actTown` reads from the acts, as a key: the building art is rebuilt
 * only when this changes, not on every clock tick.
 */
export function actTownKey(
	acts: ReadonlyMap<string, InterfaceAgentAct>
): string {
	return [...acts.values()]
		.map(
			(act) =>
				`${act.agentId}:${act.act}:${act.blockers.map((blocker) => alarmTone(blocker)).join(",")}`
		)
		.sort()
		.join("|");
}

/** One act prop in the town's DOM layer, at a world point. */
export type TownActEntry =
	| {
			agentName: string;
			anchor: string;
			at: Vec3;
			blocker: InterfaceBlocker;
			kind: "alarm" | "old";
			/** The failed thread (matched by value and claim), for its card. */
			threadId: string | null;
	  }
	| {
			agentName: string | null;
			anchor: string;
			asks: InterfaceAsk[];
			at: Vec3;
			/** The tray's files-changed sticker, when the budget keeps it. */
			count?: number | null;
			kind: "notice" | "suggestion" | "tray" | "unread";
	  }
	| {
			agentName: string;
			anchor: string;
			ask: InterfaceAsk;
			at: Vec3;
			/** The asking villager's bubble, when the budget keeps it. */
			bubble: LifeBubble | null;
			kind: "slot";
	  }
	| { anchor: string; at: Vec3; count: number; kind: "tally" }
	/** The clock tower's hourglass: an obstacle labels keep off (no text). */
	| { anchor: string; at: Vec3; kind: "clock" }
	| {
			anchor: string;
			at: Vec3;
			kind: "text";
			/** The budget kind it is drawn as (`data-budgeted-overlay`). */
			overlay: "elapsed" | "limit" | "text";
			text: string;
	  };

/**
 * Every act prop and where it stands: per building (one alarm per counted
 * blocker, dim older ones, unread answers, suggestions) and at City Hall
 * (the queue in `slots` order, the inbox's crates, the tally).
 */
export function townActEntries({
	acts,
	bubbles = new Map(),
	clock,
	nowMs = 0,
	overflow,
	owners,
	shown,
	slots,
	snapshot,
	town,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** The asking villagers' bubbles the budget kept, by agent id. */
	bubbles?: ReadonlyMap<string, LifeBubble>;
	clock?: ClockOptions;
	/** For the limit's clock label ("Closed till 15:10"). */
	nowMs?: number;
	overflow: number;
	owners: ReadonlyMap<string, string>;
	/** The status text the overlay budget chose (`actOverlays` ids). */
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	snapshot: InterfaceSnapshot;
	town: Town;
}): TownActEntry[] {
	const entries: TownActEntry[] = [];
	const claims = threadClaims(snapshot);
	for (const building of town.buildings) {
		const act = acts.get(building.agent.id);
		if (!act) {
			continue;
		}
		const { x, z } = building.lot;
		const id = building.agent.id;
		const marks = [
			...act.blockers.map((blocker) => ({ blocker, old: false })),
			...oldBlockersOf(act, snapshot, claims).map((blocker) => ({
				blocker,
				old: true,
			})),
		];
		for (const [index, mark] of marks.entries()) {
			entries.push({
				agentName: act.agentName,
				anchor: `act:alarm:${id}:${index}`,
				// Inside its own lot on its screen-right side (clear of the folk
				// at the front door below), climbing up the screen.
				at: [x + LOT * 0.18, 1.2 + index * 1.0, z - LOT * 0.42],
				blocker: mark.blocker,
				kind: mark.old ? "old" : "alarm",
				threadId: mark.old
					? null
					: (snapshot.threads.find((thread) =>
							actHasBlocker(
								{ agentId: act.agentId, blockers: [mark.blocker] },
								thread,
								claims
							)
						)?.id ?? null),
			});
		}
		const texts: {
			id: string;
			overlay: "elapsed" | "limit" | "text";
			text: string | null;
		}[] = [
			{
				id: `limit:${id}`,
				overlay: "limit",
				text: limitWords(act, { clock, limitText: townLimitText, nowMs }),
			},
			{
				id: `progress:${id}`,
				overlay: "text",
				text: progressText(act.progress),
			},
			{ id: `next:${id}`, overlay: "text", text: act.next },
			{ id: `elapsed:${id}`, overlay: "elapsed", text: act.elapsed },
			{
				id: `cue:${id}`,
				overlay: "text",
				text: act.stalled
					? "stalled?"
					: act.longerThanUsual
						? `Longer than usual${act.elapsed ? ` · ${act.elapsed}` : ""}`
						: null,
			},
		];
		for (const [index, item] of texts.entries()) {
			if (item.text && shown.has(item.id)) {
				entries.push({
					anchor: `act:text:${item.id}`,
					// Low by the lot's front-left (the limit at its door, as a sign).
					at:
						item.overlay === "limit"
							? [doorOf(building)[0], 0.75, doorOf(building)[2]]
							: [x - LOT * 0.3, 0.5 + index * 0.42, z + LOT * 0.25],
					kind: "text",
					overlay: item.overlay,
					text: item.text,
				});
			}
		}
		// Unread answers wait only at an idle or working station (§4.1).
		const unread =
			act.act === "idle" || act.act === "working"
				? unreadAsksOf(act, snapshot, claims)
				: [];
		if (unread.length > 0) {
			entries.push({
				agentName: act.agentName,
				anchor: `act:unread:${id}`,
				asks: unread,
				at: [x - LOT * 0.25, 0.45, z + LOT * 0.25],
				kind: "unread",
			});
		}
		if (act.suggestions.length > 0) {
			entries.push({
				agentName: act.agentName,
				anchor: `act:suggestion:${id}`,
				asks: act.suggestions,
				at: [x + LOT * 0.25, 0.45, z - LOT * 0.25],
				kind: "suggestion",
			});
		}
	}
	for (const [index, slot] of slots.entries()) {
		const at = HALL_SPOTS.slots[index] ?? HALL_SPOTS.you;
		if (slot.carrier === "notice") {
			entries.push({
				agentName: owners.get(slot.ask.id) ?? null,
				anchor: `act:notice:${slot.ask.id}`,
				asks: [slot.ask],
				at: [at[0], 0.75, at[2]],
				kind: "notice",
			});
		} else {
			entries.push({
				agentName: acts.get(slot.agentId ?? "")?.agentName ?? "",
				anchor: `act:slot:${slot.ask.id}`,
				ask: slot.ask,
				bubble: bubbles.get(slot.agentId ?? "") ?? null,
				at: [at[0], 1.25, at[2]],
				kind: "slot",
			});
		}
	}
	const delivering = [...acts.values()].filter(
		(act) => act.act === "delivering" && act.ask
	);
	for (const [index, act] of delivering.entries()) {
		entries.push({
			agentName: act.agentName,
			anchor: `act:tray:${act.agentId}`,
			asks: [act.ask as InterfaceAsk],
			count: shown.has(`count:${act.agentId}`)
				? (snapshot.threads.find((thread) => thread.id === act.threadId)
						?.outcome?.filesChanged ?? null)
				: null,
			at: [
				HALL_SPOTS.tray[0] + index * 0.6,
				0.5,
				HALL_SPOTS.tray[2] + index * 0.3,
			],
			kind: "tray",
		});
	}
	if (overflow > 0) {
		entries.push({
			anchor: "act:tally",
			at: HALL_SPOTS.tally,
			count: overflow,
			kind: "tally",
		});
	}
	// The clock tower's hourglass (a 3D prop): labels and bubbles keep off it.
	if (oldestBlockingAsk(snapshot.asks)) {
		entries.push({ anchor: "act:clock", at: CLOCK_TOWER, kind: "clock" });
	}
	return entries;
}

/** The anchor points of the act props, for the scene to place. */
export function townActAnchors(
	entries: readonly TownActEntry[]
): Map<string, Vec3> {
	return new Map(entries.map((entry) => [entry.anchor, entry.at]));
}

/** What the act props need to answer and open cards. */
export interface TownActHandlers {
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	privacy: "full" | "redacted";
	snapshot: InterfaceSnapshot;
}

/** A point label in the town's DOM layer: hung above its anchor point. */
function Anchored({
	anchor,
	children,
	fixed = false,
	interactive,
	rank,
}: {
	anchor: string;
	children: ReactNode;
	/** Held in place: an obstacle the other labels settle round. */
	fixed?: boolean;
	/** False for plain plates (queue plates, status words): no pointer target. */
	interactive: boolean;
	rank: number;
}) {
	return (
		<span
			className={cn(
				"invisible absolute -translate-x-1/2 -translate-y-full",
				interactive ? "pointer-events-auto" : "pointer-events-none"
			)}
			data-anchor={anchor}
			data-fixed={fixed ? "true" : undefined}
			data-hang="above"
			data-rank={rank}
		>
			{children}
		</span>
	);
}

/** Settling rank: queue plates, then targets, then signs, then words. */
function entryRank(entry: TownActEntry): number {
	// An alarm settles first: it stays in its own column over its lot, and
	// the queue's plates slide or stack round it (never over a Tab stop).
	if (entry.kind === "alarm") {
		return 8;
	}
	if (entry.kind === "slot" || entry.kind === "notice") {
		return 7;
	}
	if (entry.kind === "old") {
		return 4;
	}
	if (entry.kind === "text") {
		return entry.overlay === "limit" ||
			entry.anchor.startsWith("act:text:next:")
			? 5
			: 4;
	}
	return 6;
}

/** Alarm plates in the game kit's tokens (no literal colours here). */
const ALARM_CLASS: Record<ReturnType<typeof alarmTone>, string> = {
	amber: LIMIT_TONE,
	calendar: "bg-(--gk-bad) text-(--gk-plate)",
	grey: "bg-(--gk-plate-sunk) text-(--gk-ink)",
	red: "bg-(--gk-bad) text-(--gk-plate)",
};

/** An alarm's icon by tone: a failure, a schedule that failed, a pause. */
const ALARM_ICON: Record<ReturnType<typeof alarmTone>, ReactNode> = {
	amber: <Clock aria-hidden="true" />,
	calendar: <CalendarX aria-hidden="true" />,
	grey: <Pause aria-hidden="true" />,
	red: <span aria-hidden="true">!</span>,
};

const OPENER_ICON: Record<
	"notice" | "suggestion" | "tray" | "unread",
	ReactNode
> = {
	notice: <Mail aria-hidden="true" />,
	suggestion: <StickyNote aria-hidden="true" />,
	tray: <Package aria-hidden="true" />,
	unread: <Mail aria-hidden="true" />,
};

/**
 * The act props as anchored buttons (and the villagers' queue plates as
 * plain plates) in the town's DOM layer, after the building buttons in
 * Tab order. Act props settle before name tags, so they are never the
 * ones hidden in a crowd.
 */
export function TownActProps({
	entries,
	handlers,
}: {
	entries: readonly TownActEntry[];
	handlers: TownActHandlers;
}) {
	const { clock, iconOnly, nowMs, privacy } = handlers;
	return (
		<ul aria-label="What needs you" className="contents">
			{entries.map((entry) => {
				let body: ReactNode = null;
				if (entry.kind === "clock") {
					return (
						<li className="contents" key={entry.anchor}>
							<Anchored
								anchor={entry.anchor}
								fixed
								interactive={false}
								rank={entryRank(entry)}
							>
								<span aria-hidden="true" className="block h-12 w-9" />
							</Anchored>
						</li>
					);
				}
				if (entry.kind === "alarm") {
					const tone = alarmTone(entry.blocker);
					const threadId = entry.threadId;
					body = (
						<ActPlateButton
							className={ALARM_CLASS[tone]}
							focusable
							icon={ALARM_ICON[tone]}
							iconOnly={iconOnly}
							kind="alarm"
							label={blockerAriaLabel(
								entry.blocker,
								entry.agentName,
								nowMs,
								privacy,
								clock
							)}
							onActivate={() => {
								if (threadId) {
									handlers.onBlocker(threadId, entry.agentName);
								}
							}}
						>
							{entry.blocker.source === "estimate"
								? `Likely ${entry.blocker.title}`
								: entry.blocker.title}
						</ActPlateButton>
					);
				} else if (entry.kind === "old") {
					body = (
						<span
							aria-hidden="true"
							className="block size-3 rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk) opacity-70"
						/>
					);
				} else if (entry.kind === "slot") {
					const timer = {
						approx: entry.ask.sinceApprox,
						since: entry.ask.since,
						until: entry.ask.expiresAt ?? null,
						untilApprox: entry.ask.expiresApprox,
					};
					// A pointer target only (tabIndex -1): the building is its
					// keyboard target; a tap here answers too.
					const askId = entry.ask.id;
					body = (
						<button
							aria-hidden="true"
							className="gk-display relative flex h-7 items-center whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2 text-(--gk-ink) text-[12px] shadow-[0_2px_0_var(--gk-edge)]"
							data-you-spot="slot"
							onClick={() => handlers.onAsk(askId)}
							tabIndex={-1}
							type="button"
						>
							{entry.bubble ? <LifeBubbleTag bubble={entry.bubble} /> : null}
							{queuePlateText(entry.agentName, timer, nowMs)}
						</button>
					);
				} else if (entry.kind === "text") {
					body = (
						<span
							aria-hidden="true"
							className={cn(
								"gk-display flex h-6 items-center whitespace-nowrap rounded-lg border-(--gk-edge) border-2 px-2 text-[12px]",
								entry.overlay === "limit"
									? LIMIT_TONE
									: "bg-(--gk-plate) text-(--gk-ink)"
							)}
							data-budgeted-overlay={entry.overlay}
						>
							{entry.text}
						</span>
					);
				} else if (entry.kind === "tally") {
					body = (
						<ActPlateButton
							budgeted="tally"
							focusable
							kind="tally"
							label={overflowLabel(entry.count)}
							onActivate={handlers.onQueue}
							tally="you"
							youSpot="tally"
						>
							{`+${entry.count} more`}
						</ActPlateButton>
					);
				} else if ("asks" in entry) {
					const first = entry.asks[0];
					if (!first) {
						return null;
					}
					const question =
						entry.kind === "suggestion" && first.kind === "question";
					const timer = {
						approx: first.sinceApprox,
						since: first.since,
						until: first.expiresAt ?? null,
						untilApprox: first.expiresApprox,
					};
					let text: ReactNode = String(entry.asks.length);
					if (entry.kind === "notice") {
						text = queuePlateText(entry.agentName ?? "Inbox", timer, nowMs);
					} else if (entry.kind === "tray") {
						text = entry.count ? (
							<span data-budgeted-overlay="count">{String(entry.count)}</span>
						) : null;
					}
					body = (
						<ActPlateButton
							focusable
							icon={
								question ? (
									<ScrollText aria-hidden="true" />
								) : (
									OPENER_ICON[entry.kind]
								)
							}
							iconOnly={entry.kind === "notice" ? false : iconOnly}
							kind={entry.kind satisfies ActTargetKind}
							label={
								entry.kind === "notice" || entry.kind === "tray"
									? askAriaLabel(first, entry.agentName, nowMs, privacy)
									: openerLabel(entry.asks, entry.agentName, nowMs, privacy)
							}
							onActivate={() => handlers.onAsk(first.id)}
							youSpot={
								entry.kind === "notice"
									? "slot"
									: entry.kind === "tray"
										? "tray"
										: undefined
							}
						>
							{text}
						</ActPlateButton>
					);
				}
				return (
					<li className="contents" key={entry.anchor}>
						<Anchored
							anchor={entry.anchor}
							interactive={!(entry.kind === "text" || entry.kind === "old")}
							// Targets and queue plates are exempt (rank 6+, never hidden);
							// status words and dim marks give way when crowded, the next
							// step and the limit last.
							rank={entryRank(entry)}
						>
							{body}
						</Anchored>
					</li>
				);
			})}
		</ul>
	);
}

/** The town's words for a limit, on the door sign: "Closed till 15:10". */
export const townLimitText: LimitText = (_act, at) =>
	at ? `Closed till ${at}` : "Closed";

/** The oldest blocking ask's wait, for the clock tower (null with none). */
export function oldestBlockingAsk(
	asks: readonly InterfaceAsk[] | undefined
): InterfaceAsk | null {
	let oldest: InterfaceAsk | null = null;
	for (const ask of asks ?? []) {
		if (!(ask.blocking && ask.since)) {
			continue;
		}
		if (!oldest?.since || Date.parse(ask.since) < Date.parse(oldest.since)) {
			oldest = ask;
		}
	}
	return oldest;
}

/** Above the clock tower's spire, clear of its eave: the oldest wait. */
const CLOCK_TOWER: Vec3 = [0, HALL_TOP + 0.35, -1.35];

/** The kit's meshes are villager-sized: the town draws them at its folk scale. */
const PROP_SCALE = 0.72;

const unscaled = ([x, y, z]: Vec3): Vec3 => [
	x / PROP_SCALE,
	y / PROP_SCALE,
	z / PROP_SCALE,
];

/**
 * The act layer's meshes in the town's own canvas (spec §5 town row); the
 * DOM buttons in the overlay stay their targets. Per building: scaffold
 * pips for the plan's steps, a billboard for the next step, a "Closed"
 * sign on a limited agent's door. At City Hall: a petition letter on a
 * post for each notice in the queue, the clock tower's hourglass showing
 * the oldest blocking wait, and a delivery crate per answer at the inbox.
 */
export function TownActMeshes({
	acts,
	clock,
	nowMs,
	palette,
	reduced,
	slots,
	snapshot,
	town,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	palette: { craneDark: string; crane: string; lotPad: string };
	reduced: boolean;
	slots: readonly YouSpotSlot[];
	snapshot: Pick<InterfaceSnapshot, "asks">;
	town: Town;
}) {
	const oldest = oldestBlockingAsk(snapshot.asks);
	const delivering = [...acts.values()].filter(
		(act) => act.act === "delivering" && act.ask
	);
	return (
		<group scale={PROP_SCALE}>
			{town.buildings.map((building) => {
				const act = acts.get(building.agent.id);
				if (!act) {
					return null;
				}
				const { x, z } = building.lot;
				return (
					<group key={building.agent.id}>
						<ProgressPips3D
							at={unscaled([x - LOT * 0.42, PAD_Y + 0.05, z + LOT * 0.46])}
							progress={act.progress}
							reducedMotion={reduced}
							showText={false}
							skin={{
								done: palette.crane,
								estimate: palette.crane,
								todo: palette.lotPad,
							}}
						/>
						<NextSign
							at={unscaled([x - LOT * 0.42, PAD_Y, z - LOT * 0.1])}
							showText={false}
							text={act.next}
						/>
						{act.act === "limited" ? (
							<LimitCue
								at={unscaled(doorOf(building))}
								showText={false}
								text={limitWords(act, {
									clock,
									limitText: townLimitText,
									nowMs,
								})}
							/>
						) : null}
					</group>
				);
			})}
			{slots.map((slot, index) => {
				if (slot.carrier !== "notice") {
					return null;
				}
				const at = HALL_SPOTS.slots[index] ?? HALL_SPOTS.you;
				return (
					<group key={slot.ask.id} position={unscaled(at)}>
						<mesh castShadow position={[0, 0.35, 0]}>
							<cylinderGeometry args={[0.04, 0.05, 0.7, 8]} />
							<meshStandardMaterial color={palette.craneDark} />
						</mesh>
						<mesh castShadow position={[0, 0.72, 0.03]}>
							<boxGeometry args={[0.32, 0.22, 0.03]} />
							<meshStandardMaterial color={palette.lotPad} />
						</mesh>
					</group>
				);
			})}
			{oldest ? (
				<WaitTimer3D
					at={unscaled(CLOCK_TOWER)}
					nowMs={nowMs}
					reducedMotion={reduced}
					timer={{
						approx: oldest.sinceApprox,
						since: oldest.since,
						until: oldest.expiresAt ?? null,
						untilApprox: oldest.expiresApprox,
					}}
				/>
			) : null}
			{delivering.map((act, index) => (
				<mesh
					castShadow
					key={act.agentId}
					position={unscaled([
						HALL_SPOTS.tray[0] + index * 0.6,
						PAD_Y + 0.14,
						HALL_SPOTS.tray[2] + index * 0.3,
					])}
				>
					<boxGeometry args={[0.38, 0.28, 0.38]} />
					<meshStandardMaterial color={palette.crane} />
				</mesh>
			))}
		</group>
	);
}
