/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useRef } from "react";
import type { Group } from "three";
import { CARD_ACT_ART, CARD_ROOM_3D } from "./card-table-palette.ts";

import { POT, type RoomSeat, TABLE } from "./card-table-room.ts";
import { GAME_PLATE } from "./game-hud.tsx";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actOverlays,
	actorTarget,
	type BudgetItem,
	type OffStage,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerPose,
	VillagerSpec,
} from "./game3d-villager.tsx";

/**
 * The Card Table's act layer (spec §5, card-table row). The players stay in
 * their chairs; what travels is the **card**: an asking agent slides a face
 * up card across the felt to your seat at the near edge (via
 * `actorTarget`), where it waits in the queue beside the dealer's timer
 * chip. Clicking the card (or the seat's plate) opens the ask card; there
 * are no Approve or Reject chips on the felt. Each seat is a kit
 * `ActStation` on the felt in front of the chair: its progress as a stack
 * of chips with a ghost outline up to the total, every counted failure as
 * a folded (face down) card under its alarm whatever the act, a limited
 * player's "sitting out" button, its marks and its status words. A
 * delivered answer's pot is pushed to your seat, and the dealer button by
 * the pot names the next scheduled deal.
 */

/** Screen right and away from the viewer, on the floor (as card-table-room). */
const ACROSS: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
const AWAY: [number, number] = [-Math.SQRT1_2, -Math.SQRT1_2];
/** On the felt, just above it. */
const FELT_Y = TABLE.height + 0.04;

function onFelt(across: number, away: number, y = FELT_Y): Vec3 {
	return [
		ACROSS[0] * across + AWAY[0] * away,
		y,
		ACROSS[1] * across + AWAY[1] * away,
	];
}

/** Across the floor between queue places (world units). */
const QUEUE_GAP = 1.35;
/**
 * A phone's queue places (across, toward the viewer): a staggered row of
 * three, and the fourth in front of them, clear of the near right seat.
 */
const NARROW_PLACES: readonly [number, number][] = [
	[-2.6, -3.4],
	[-0.9, -2.3],
	[0.9, -3.4],
	[-0.9, -4.55],
];

/**
 * Your seat at the near edge: "you" at the near rail, the queue "you-1"
 * .."you-4" across the floor just in front of the table (a wide stage's
 * plates alternate low and high, `slotLift`; a phone's places stagger on
 * the floor), and "you-tray" at the near right, where a delivered pot is
 * pushed. Cards arriving here stay at the table's height: held up at your
 * seat.
 */
export function youPoints(narrow = false): Record<string, Vec3> {
	const place = (index: number) => {
		const spot = NARROW_PLACES[index];
		return narrow && spot
			? onFelt(spot[0], spot[1])
			: onFelt((index - 1.5) * QUEUE_GAP, -3.45);
	};
	return {
		you: onFelt(0, -2.4),
		"you-1": place(0),
		"you-2": place(1),
		"you-3": place(2),
		"you-4": place(3),
		"you-tray": onFelt(2.85, -2.3),
	};
}

/** A seat's place on the felt: its chips (where its card starts). */
export function seatSpot(seat: RoomSeat): Vec3 {
	return [seat.chips[0], FELT_Y, seat.chips[1]];
}

export function cardPaths(
	seats: readonly RoomSeat[],
	narrow: boolean
): LifePaths {
	const points: Record<string, Vec3> = { ...youPoints(narrow) };
	const links: [string, string][] = [];
	for (const seat of seats) {
		points[`seat-${seat.slot}`] = seatSpot(seat);
		links.push([`seat-${seat.slot}`, "you"]);
	}
	return { links, points };
}

/** A seated player's pose for its act (players stay in their chairs). */
export function seatPose(act: InterfaceAgentAct): VillagerPose {
	switch (act.act) {
		case "asking":
			return "needs-you";
		case "blocked":
			return "failed";
		case "working":
			return act.stalled ? "idle" : "working";
		case "waiting":
			return "waiting";
		default:
			return "idle";
	}
}

/** The helpers standing by a seated player's chair. */
export function seatHelpers(
	act: InterfaceAgentAct,
	looks: MemberLooks,
	seat: RoomSeat
): VillagerSpec[] {
	return apprenticeSpecs({
		agentId: act.agentId,
		helpers: act.helpers,
		looks,
		station: [seat.at[0], 0, seat.at[1]],
	});
}

/**
 * The status overlays the card room can show: the kit's list less the
 * bubbles, as the seated players never speak (an ask's words ride its queue
 * plate and the ask card, the work words the seat's status line), so no
 * budget goes to a bubble nobody draws.
 */
export function cardOverlays(
	onStage: readonly InterfaceAgentAct[],
	slots: { overflow: number; slots: readonly YouSpotSlot[] },
	offStage: Pick<OffStage, "count">,
	reduced: boolean
): BudgetItem[] {
	const focus = onStage.find((act) => act.act === "working")?.agentId ?? null;
	return actOverlays(onStage, slots, offStage, focus, { reduced }).filter(
		(item) => item.kind !== "ask-bubble" && item.kind !== "work-bubble"
	);
}

/**
 * The limit in the card room's words: the player is sitting out, "Sitting
 * out, back 15:10" ("Likely sitting out, back 15:10" for an inferred
 * limit: the kit adds "Likely ").
 */
export const sittingOut: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `sitting out, back ${clearsAt}` : "sitting out";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** The progress chips: bet (done), a ghost outline up to the total, a guess. */
const CHIP_PIPS = {
	done: CARD_ACT_ART.pipGold,
	estimate: CARD_ACT_ART.pipEstimate,
	todo: CARD_ACT_ART.pipGhost,
} as const;

/** Toward the viewer on the floor: down the screen. */
const TOWARD: [number, number] = [-AWAY[0], -AWAY[1]];

/** A seat's screen-outer side on the floor (screen right for the right-hand seats). */
function outerSide(seat: RoomSeat): { right: boolean; side: [number, number] } {
	const right = seat.at[0] * ACROSS[0] + seat.at[1] * ACROSS[1] >= 0;
	return {
		right,
		side: right ? [ACROSS[0], ACROSS[1]] : [-ACROSS[0], -ACROSS[1]],
	};
}

/** A floor point by a seat's chair: `out` to its outer side, `down` toward the viewer. */
function byTheChair(seat: RoomSeat, out: number, down: number): Vec3 {
	const { side } = outerSide(seat);
	return [
		seat.at[0] + side[0] * out + TOWARD[0] * down,
		FLOOR_Y,
		seat.at[1] + side[1] * out + TOWARD[1] * down,
	];
}

/** From the chair out to the first fold, and fold to fold (world units). */
const FOLD_FIRST = 0.7;
const FOLD_GAP = 0.34;
/** How far toward the viewer the folds lie from the chair. */
const FOLD_DOWN = 0.3;

/** A seat's counted failures: a folded card each (an interrupted run or a limit folds none). */
export function countedFolds(act: InterfaceAgentAct): number {
	return act.blockers.filter(
		(blocker) =>
			blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
	).length;
}

/**
 * The card room's own pieces by a seat, on the floor at the outer side of
 * the chair (never on the felt toward the pot, whose plate the far seats
 * flank): a folded card for each counted failure, thrown down beside the
 * chair, the sitting-out button there for a limited player, and the spot
 * just past the folds where the failures' reasons (the alarms) stand.
 */
export function seatFelt(
	seat: RoomSeat,
	folds = 0
): {
	fold: (index: number) => Vec3;
	puck: Vec3;
	reason: Vec3;
} {
	return {
		fold: (index) => byTheChair(seat, FOLD_FIRST + index * FOLD_GAP, FOLD_DOWN),
		puck: byTheChair(seat, FOLD_FIRST, FOLD_DOWN),
		reason: byTheChair(
			seat,
			FOLD_FIRST + Math.max(0, folds - 0.5) * FOLD_GAP + 0.3,
			FOLD_DOWN - 0.25
		),
	};
}

/**
 * Where a seat's pieces sit, as offsets from its chips (the station). The
 * felt in the middle is the pot's, so a seat's words keep to its own side
 * of the table: the alarms stand on the felt just past their folded cards,
 * on the outer side of the chair (the reason by the fold), their plates
 * hanging further out, off the seat's own figure; the status board hangs
 * on the screen-outer side of the chair, below the name plate over the
 * head; the pips and the marks lie on the felt by the chips. The alarm
 * stack keeps the kit's stacking (one plate row per alarm) on every stage.
 * On a narrow stage the outer side is off the frame and the queue fills
 * the felt's near edge: the board goes down past the queue, toward the
 * viewer.
 */
export function seatLayout(
	seat: RoomSeat,
	narrow = false,
	folds = 0
): Partial<StationLayout> {
	const chips = seatSpot(seat);
	// Toward the screen's outer side for this seat.
	const { right, side } = outerSide(seat);
	/** A point by the chair (`out` to the outer side, `down` toward the viewer). */
	const byChair = (out: number, down: number, y: number): Vec3 => [
		seat.at[0] + side[0] * out + TOWARD[0] * down - chips[0],
		y - chips[1],
		seat.at[1] + side[1] * out + TOWARD[1] * down - chips[2],
	];
	// The far seats sit either side of the pot's plate: their words go up
	// beside their name plates instead, over the back of the room.
	const boardAt = (): Vec3 => {
		if (narrow) {
			return byChair(0.75, 1.95, 0.4);
		}
		return seat.slot < 2
			? byChair(1.25, -0.9, 1.45)
			: byChair(1.55, 0.45, 0.75);
	};
	const reason = seatFelt(seat, folds).reason;
	return {
		// Hung outward from the reasons by the folds, off the chair.
		alarmSide: right ? "right" : "left",
		alarms: [reason[0] - chips[0], reason[1] - chips[1], reason[2] - chips[2]],
		// On a phone the queue fills the felt's near edge: the board goes down
		// past it, toward the viewer, on the seat's own side.
		board: boardAt(),
		cue: [0, 0.02, 0],
		figure: byChair(0, 0, 0),
		limit: byChair(0.75, -0.45, 0),
		next: byChair(-0.55, -0.55, 0),
		pips: [0, 0.05, 0],
		suggestion: narrow ? byChair(0.4, 1.3, 0) : byChair(0.95, 1.45, 0),
		unread: narrow ? byChair(0.4, 0.8, 0) : byChair(0.95, 0.8, 0),
	};
}

/** A playing card lying flat on the felt, `yaw` turned. */
function FlatCard({
	at,
	color,
	yaw,
}: {
	at: Vec3;
	color: string;
	yaw: number;
}) {
	return (
		<ToonMesh
			castShadow
			color={color}
			ink={0.012}
			position={[at[0], at[1] + 0.01, at[2]]}
			rotation={[0, yaw, 0]}
			scale={[0.3, 0.012, 0.42]}
		>
			<boxGeometry />
		</ToonMesh>
	);
}

/** A white puck on the felt: the dealer button, or the sitting-out button. */
function TablePuck({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={CARD_ACT_ART.buttonRim}
				ink={0.01}
				position={[0, 0.02, 0]}
				scale={[0.2, 0.04, 0.2]}
			>
				<cylinderGeometry args={[1, 1, 1, 20]} />
			</ToonMesh>
			<ToonMesh
				color={CARD_ACT_ART.buttonFace}
				position={[0, 0.045, 0]}
				scale={[0.17, 0.012, 0.17]}
			>
				<cylinderGeometry args={[1, 1, 1, 20]} />
			</ToonMesh>
		</group>
	);
}

/** How fast a card slides (world units a second). */
const SLIDE_SPEED = 2.4;

/**
 * An asking agent's card: face up, it slides from the seat's chips to its
 * place in your queue (straight there under reduced motion). Its plate
 * reads "Ada · 14m" (the dealer's timer chip beside it counts the wait).
 * A click on it opens the ask card from the agent's seat plate, the
 * agent's one keyboard target, so focus comes back there; the plate itself
 * stays out of the Tab order.
 */
function TravellingCard({
	act,
	from,
	lift,
	nowMs,
	onOpen,
	reduced,
	to,
}: {
	act: InterfaceAgentAct;
	from: Vec3;
	/** How much higher its plate rides at its queue place (`slotLift`). */
	lift: number;
	nowMs: number;
	onOpen: (askId: string, opener?: HTMLElement) => void;
	reduced: boolean;
	to: Vec3;
}) {
	const group = useRef<Group>(null);
	const start = useRef<Vec3>(reduced ? to : from);
	useFrame((_, delta) => {
		const node = group.current;
		if (!node) {
			return;
		}
		if (reduced) {
			node.position.set(to[0], to[1], to[2]);
			return;
		}
		const dx = to[0] - node.position.x;
		const dz = to[2] - node.position.z;
		const left = Math.hypot(dx, dz);
		const step = Math.min(left, SLIDE_SPEED * delta);
		if (left > 1e-3) {
			node.position.x += (dx / left) * step;
			node.position.z += (dz / left) * step;
		}
	});
	const ask = act.ask;
	if (!ask) {
		return null;
	}
	const destructive = ask.choices?.some((choice) => choice.destructive);
	return (
		<group position={start.current} ref={group}>
			<ToonMesh
				castShadow
				color={CARD_ROOM_3D.cardFace}
				ink={0.012}
				position={[0, 0.01, 0]}
				rotation={[0, Math.PI / 4, 0]}
				scale={[0.34, 0.012, 0.48]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={destructive ? CARD_ACT_ART.pipRed : CARD_ACT_ART.pipGold}
				position={[0, 0.02, 0]}
				rotation={[0, Math.PI / 4, 0]}
				scale={[0.12, 0.01, 0.12]}
			>
				<cylinderGeometry args={[1, 1, 1, 12]} />
			</ToonMesh>
			<group position={[0, 0.55 + lift, 0]}>
				<Html center zIndexRange={[35, 0]}>
					<button
						aria-hidden="true"
						className={cn(
							GAME_PLATE,
							"gk-display flex h-7 cursor-pointer select-none items-center whitespace-nowrap rounded-full px-2 text-[12px] leading-none"
						)}
						data-iso-plate=""
						data-you-spot="slot"
						onClick={(event) => {
							event.stopPropagation();
							// The seat plate is the agent's keyboard target.
							const seat = event.currentTarget.ownerDocument.querySelector(
								`[data-seat="${CSS.escape(act.agentId)}"][data-act-agent]`
							);
							onOpen(ask.id, seat instanceof HTMLElement ? seat : undefined);
						}}
						tabIndex={-1}
						type="button"
					>
						{queuePlateText(
							act.agentName,
							{
								approx: ask.sinceApprox,
								since: ask.since,
								until: ask.expiresAt ?? null,
								untilApprox: ask.expiresApprox,
							},
							nowMs
						)}
					</button>
				</Html>
			</group>
		</group>
	);
}

/** One seated agent and where its chair is. */
export interface ActSeat {
	act: InterfaceAgentAct;
	seat: RoomSeat;
}

/** Where the you-spot pieces sit at your seat. */
export function youLayout(narrow: boolean): YouSpotLayout {
	const points = youPoints(narrow);
	const at = (slot: YouSlot): Vec3 => {
		const [x, y, z] = points[slot] ?? [0, 0, 0];
		return [x, y + slotLift(slot, narrow, "notice"), z];
	};
	const last = at("you-4");
	const tray = points["you-tray"] ?? [0, 0, 0];
	return {
		// The off-stage tally is a HUD button beside the queue button.
		offStage: last,
		slots: {
			"you-1": at("you-1"),
			"you-2": at("you-2"),
			"you-3": at("you-3"),
			"you-4": at("you-4"),
		},
		tally: [
			last[0] + ACROSS[0] * 1.2,
			last[1] + 0.5,
			last[2] + ACROSS[1] * 1.2,
		],
		timer: [ACROSS[0] * 0.42, 0.04, ACROSS[1] * 0.42 + 0.2],
		tray: [tray[0], tray[1], tray[2]],
		trayMax: 2,
		trayRowStep: [AWAY[0] * 0.6, 0, AWAY[1] * 0.6],
		trayStep: [ACROSS[0] * 0.55, 0, ACROSS[1] * 0.55],
	};
}

/**
 * How much higher a queue place's plate rides (world units) for what
 * carries it there. On a wide stage the places stand in one row, closer
 * than a plate is wide, so the plates alternate low and high (a card's
 * plate low, or held up high; a notice pinned low on a short chip stack, or
 * high on a tall one; a notice's plate rides `NOTICE_ABOVE_CARD` above a
 * card's at the same place) and clear each other without the stage nudging
 * them. A phone's places are staggered on the felt instead.
 */
export function slotLift(
	slot: YouSlot | null,
	narrow: boolean,
	carrier: "notice" | "villager" = "villager"
): number {
	if (narrow) {
		return 0;
	}
	const high = slot === "you-2" || slot === "you-4";
	if (carrier === "notice") {
		return high ? HIGH_PLATE - NOTICE_ABOVE_CARD : -NOTICE_ABOVE_CARD;
	}
	return high ? HIGH_PLATE : 0;
}

/** How far a notice's plate rides above a card's plate at one place. */
const NOTICE_ABOVE_CARD = 0.55;
/** How much higher a high place's plate rides than a low one's. */
const HIGH_PLATE = 1.1;
/** The floor's top, where a notice's chip stack stands. */
const FLOOR_Y = 0.08;

/** The chip stack a notice is pinned on, from the floor up to `top`. */
function NoticeStand({ at, top }: { at: Vec3; top: number }) {
	const height = Math.max(0.05, top - FLOOR_Y);
	return (
		<ToonMesh
			castShadow
			color={CARD_ACT_ART.potChip}
			ink={0.015}
			position={[at[0], FLOOR_Y + height / 2, at[2]]}
			scale={[0.16, height, 0.16]}
		>
			<cylinderGeometry args={[1, 1, 1, 14]} />
		</ToonMesh>
	);
}

/** Where the dealer button lies: on the felt by the pot, toward your seat. */
const DEALER_AT = onFelt(0.9, -0.75);

export interface CardActPropsInput {
	clock?: ClockOptions;
	/** True when a deal is scheduled: the dealer button lies by the pot. */
	dealer: boolean;
	iconOnly: boolean;
	narrow: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	paths: LifePaths;
	reduced: boolean;
	seated: readonly ActSeat[];
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
}

/**
 * Everything the act layer adds to the room: the travelling cards and the
 * queue at your seat, the pushed pot, the "+N more" tally, the dealer
 * button, and each seat's station.
 */
export function CardActProps({
	clock,
	dealer,
	iconOnly,
	narrow,
	nowMs,
	offStage,
	onAsk,
	onBlocker,
	onQueue,
	onStage,
	owners,
	paths,
	reduced,
	seated,
	shown,
	slots,
	snapshot,
}: CardActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	const slotFor = (agentId: string): YouSlot | null =>
		slots.slots.find(
			(slot) => slot.agentId === agentId && slot.carrier === "villager"
		)?.point ?? null;
	// The off-stage tally is drawn in the HUD, never at a fixed world point.
	const sceneShown = new Set([...shown].filter((id) => id !== "tally:off"));
	return (
		<group>
			<YouSpots
				iconOnly={iconOnly}
				item={{ color: CARD_ACT_ART.potChip, shape: "box" }}
				layout={youLayout(narrow)}
				nowMs={nowMs}
				offStage={offStage}
				onAsk={onAsk}
				onOpenQueue={onQueue}
				onStage={onStage}
				owners={owners}
				privacy={privacy}
				reduced={reduced}
				shown={sceneShown}
				slots={slots}
				snapshot={snapshot}
				timerSkin={{ color: CARD_ACT_ART.timer }}
			/>
			{seated
				.filter((entry) => entry.act.act === "asking" && entry.act.ask)
				.map(({ act, seat }) => {
					const spots: ActSpots = {
						paths,
						slot: slotFor(act.agentId),
						station: `seat-${seat.slot}`,
					};
					const target = actorTarget(act, spots, reduced).position;
					return (
						<TravellingCard
							act={act}
							from={seatSpot(seat)}
							key={`${act.agentId}:${act.ask?.id}:${spots.slot}`}
							lift={slotLift(spots.slot ?? null, narrow)}
							nowMs={nowMs}
							onOpen={onAsk}
							reduced={reduced}
							to={target}
						/>
					);
				})}
			{slots.slots.map((slot) => {
				const at = youPoints(narrow)[slot.point];
				return slot.carrier === "notice" && at ? (
					<NoticeStand
						at={at}
						key={`stand:${slot.ask.id}`}
						top={at[1] + slotLift(slot.point, narrow, "notice")}
					/>
				) : null;
			})}
			{dealer ? (
				<TablePuck
					at={[POT[0] + DEALER_AT[0], FELT_Y, POT[2] + DEALER_AT[2]]}
				/>
			) : null}
			{seated.map(({ act, seat }) => (
				<SeatStation
					act={act}
					clock={clock}
					iconOnly={iconOnly}
					key={act.agentId}
					narrow={narrow}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					reduced={reduced}
					seat={seat}
					shown={shown}
					snapshot={snapshot}
				/>
			))}
		</group>
	);
}

/**
 * One seat's station (kit `ActStation`) and the card room's own set pieces
 * under it: a folded card for each counted failure, lying under its alarm,
 * and the sitting-out button by a limited player's clock.
 */
function SeatStation({
	act,
	clock,
	iconOnly,
	narrow,
	nowMs,
	onAsk,
	onBlocker,
	reduced,
	seat,
	shown,
	snapshot,
}: {
	act: InterfaceAgentAct;
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	narrow: boolean;
	reduced: boolean;
	seat: RoomSeat;
	shown: ReadonlySet<string>;
	snapshot: InterfaceSnapshot;
}) {
	const at = seatSpot(seat);
	const folds = countedFolds(act);
	const layout = seatLayout(seat, narrow, folds);
	const felt = seatFelt(seat, folds);
	return (
		<group>
			{Array.from({ length: folds }, (_, index) => (
				<FlatCard
					at={felt.fold(index)}
					color={CARD_ACT_ART.foldBack}
					// biome-ignore lint/suspicious/noArrayIndexKey: one fold per counted failure, in order
					key={index}
					yaw={seat.facing + 0.25 * (index % 2 === 0 ? 1 : -1)}
				/>
			))}
			{act.act === "limited" ? <TablePuck at={felt.puck} /> : null}
			<ActStation
				act={act}
				at={at}
				clock={clock}
				iconOnly={iconOnly}
				layout={layout}
				limitText={sittingOut}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				pipSkin={CHIP_PIPS}
				privacy={snapshot.privacy ?? "full"}
				reduced={reduced}
				shown={shown}
				snapshot={snapshot}
			/>
		</group>
	);
}
