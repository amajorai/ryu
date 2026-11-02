/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { translate as tr } from "@ryu/i18n/lite";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useRef } from "react";
import type { Group } from "three";
import {
	type ActSeat,
	countedFolds,
	FELT_Y,
	FLOOR_Y,
	onFelt,
	seatFelt,
	seatLayout,
	seatSpot,
	slotLift,
	youLayout,
	youPoints,
} from "./card-table-acts.tsx";
import { CARD_ACT_ART, CARD_ROOM_3D } from "./card-table-palette.ts";
import { POT, type RoomSeat } from "./card-table-room.ts";
import { GAME_PLATE } from "./game-hud.tsx";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actorTarget,
	type OffStage,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The Card Table act layer's set pieces in the room: the travelling ask
 * cards, the notice stands and the dealer button at your seat, and each
 * seat's station with its folded cards and sitting-out button. The places
 * they use are worked out in `card-table-acts.tsx`.
 */

/**
 * The limit in the card room's words: the player is sitting out, "Sitting
 * out, back 15:10" ("Likely sitting out, back 15:10" for an inferred
 * limit: the kit adds "Likely " before the lowercase words).
 */
export const sittingOut: LimitText = (act, clearsAt) => {
	if (limitIsLikely(act)) {
		return clearsAt
			? tr("sitting out, back {time}", { time: clearsAt })
			: tr("sitting out");
	}
	return clearsAt
		? tr("Sitting out, back {time}", { time: clearsAt })
		: tr("Sitting out");
};

/** The progress chips: bet (done), a ghost outline up to the total, a guess. */
const CHIP_PIPS = {
	done: CARD_ACT_ART.pipGold,
	estimate: CARD_ACT_ART.pipEstimate,
	todo: CARD_ACT_ART.pipGhost,
} as const;

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
