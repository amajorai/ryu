import type {
	ClockOptions,
	InterfaceEvent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { cloneElement, useMemo } from "react";
import { CardRoom, type CardRoomActors } from "./card-table-diorama.tsx";
import {
	ISLAND_RIM,
	PHONE_ROOM_FIT,
	potChipSize,
	seatMenuPlacement,
} from "./card-table-interface-layout.ts";
import { FlatTable } from "./card-table-interface-parts.tsx";
import type { SeatInfo, StageSize, TableGeometry } from "./card-table-model.ts";
import { TablePot } from "./card-table-pot.tsx";
import { ROOM_BOUNDS, ROOM_TOP } from "./card-table-room.ts";
import {
	EmptySeat,
	type SeatAct,
	type SeatActions,
	TableSeat,
} from "./card-table-seat.tsx";
import { islandFor } from "./game3d-ground.tsx";
import { IsoStage, type IsoView } from "./game3d-stage.tsx";
import type { IsoInsets } from "./game3d-stage-framing.ts";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import { clockLabel } from "./interface-act-time.ts";

/**
 * The Card Table's room: the 3D card room (or, without WebGL, the flat
 * table) with the pot on the felt and a plate on every chair. Split out of
 * `card-table-interface.tsx`.
 */

interface CardTableRoomProps {
	actions: SeatActions;
	actors: CardRoomActors | undefined;
	actsOn: boolean;
	clock: ClockOptions | undefined;
	cloth: { cardBack: string; felt: string; feltLine: string };
	geometry: TableGeometry;
	insets: IsoInsets;
	isEmpty: boolean;
	isoView: IsoView;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	next: InterfaceEvent | undefined;
	night: boolean;
	now: number;
	nowMs: number;
	onDeal: () => void;
	onOpen: (threadId: string) => void;
	reduceMotion: boolean;
	running: InterfaceThread[];
	seatAct: (agentId: string, scene: boolean) => SeatAct | undefined;
	seated: SeatInfo[];
	snapshot: InterfaceSnapshot;
	stage: StageSize;
}

export function CardTableRoom({
	actions,
	actsOn,
	actors,
	clock,
	cloth,
	geometry,
	insets,
	isEmpty,
	isoView,
	looks,
	next,
	night,
	now,
	nowMs,
	onDeal,
	onOpen,
	reduceMotion,
	running,
	seatAct,
	seated,
	snapshot,
	stage,
}: CardTableRoomProps) {
	const shape = useMemo(
		() =>
			islandFor(
				ROOM_BOUNDS.maxX - ROOM_BOUNDS.minX,
				ROOM_BOUNDS.maxZ - ROOM_BOUNDS.minZ,
				ISLAND_RIM
			),
		[]
	);
	const pot = isEmpty ? null : (
		<TablePot
			activeThreadId={actions.activeThreadId}
			actNext={
				actsOn
					? next
						? clockLabel(next.start, nowMs, clock)
						: null
					: undefined
			}
			compact={geometry.compact}
			next={next}
			now={now}
			onOpen={onOpen}
			pileSize={potChipSize(geometry)}
			running={running}
			snapshot={snapshot}
			word={actsOn ? "working" : undefined}
		/>
	);
	// With acts the room's felt holds the chips; its plate is the pot's
	// count and the dealer button only, clear of the queue at your seat.
	const roomPot = pot && actsOn ? cloneElement(pot, { pile: false }) : pot;
	const chairPlate = (slot: number, compact: boolean, nameplate = false) => {
		const seat = seated[slot];
		const point = geometry.seats[slot];
		const placement = point
			? seatMenuPlacement(slot, point, stage)
			: ({ align: "center", side: "bottom" } as const);
		if (seat) {
			return (
				<TableSeat
					act={seatAct(seat.agent.id, nameplate)}
					actions={actions}
					align={placement.align}
					compact={compact}
					nameplate={nameplate}
					seat={seat}
					side={placement.side}
				/>
			);
		}
		return (
			<EmptySeat
				align={placement.align}
				compact={compact}
				onDeal={onDeal}
				side={placement.side}
			/>
		);
	};
	return (
		<div className="absolute inset-x-0 -top-[64px] @min-[672px]/game:-top-[76px] bottom-0">
			<IsoStage
				bounds={{ ...ROOM_BOUNDS, top: ROOM_TOP }}
				fallback={
					<FlatTable
						actsOn={actsOn}
						chairPlate={chairPlate}
						geometry={geometry}
						pot={pot}
						seated={seated}
					/>
				}
				fitPlates={geometry.compact ? PHONE_ROOM_FIT : undefined}
				insets={insets}
				label="Card room: your agents seated round the felt table with their chips, and the pot in the middle. Tab moves between the seats and the pot; drag to pan, plus and minus to zoom."
				motes={false}
				night={night}
				reducedMotion={reduceMotion}
				view={isoView}
			>
				{({ quality, theme }) => (
					<CardRoom
						actors={actors}
						cloth={cloth}
						looks={looks}
						night={night}
						potPlate={roomPot}
						quality={quality}
						reducedMotion={reduceMotion}
						running={running.length}
						seated={seated}
						seatPlate={(slot) => chairPlate(slot, true, true)}
						shape={shape}
						theme={theme}
					/>
				)}
			</IsoStage>
		</div>
	);
}
