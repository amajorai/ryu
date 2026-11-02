import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
	CardTableHand,
	EmptyHand,
	HandLabel,
	type HandLabelPlacement,
} from "./card-table-hand.tsx";
import type { CardTableActs } from "./card-table-interface-acts.tsx";
import {
	HUD_TOP,
	LEGEND_INSET,
	LEGEND_MIN_WIDTH,
} from "./card-table-interface-layout.ts";
import {
	EmptyTablePanel,
	HandSkeleton,
	LoadingTable,
} from "./card-table-interface-parts.tsx";
import { TableLegend } from "./card-table-legend.tsx";
import type {
	CardPose,
	HandLayout,
	SeatInfo,
	StageSize,
	TableGeometry,
} from "./card-table-model.ts";
import { RAIL_LEATHER, TABLE_SHADOW } from "./card-table-palette.ts";
import { CardTableRail } from "./card-table-rail.tsx";
import { CardTableSpread } from "./card-table-spread.tsx";
import type { SpreadActions } from "./card-table-spread-deck-parts.tsx";
import { IsoZoomControls, type useIsoView } from "./game3d-stage.tsx";

/**
 * The Card Table's play areas below the HUD: the Cards layout's spread on
 * its leather rail, and the Table layout's stage (the hand, its label and
 * legend, the empty and loading tables, the room, its zoom and the rail
 * panel). Split out of `card-table-interface.tsx`.
 */

/** The Cards layout: the spread laid on felt inside the table's rail. */
export function CardTableSpreadFrame({
	actHudBottom,
	actions,
	isEmpty,
	loading,
	panelOpen,
	spreadActs,
}: {
	actHudBottom: number;
	actions: SpreadActions;
	isEmpty: boolean;
	loading: boolean;
	panelOpen: boolean;
	spreadActs: CardTableActs["spreadActs"];
}) {
	return (
		<div
			className={cn(
				"absolute inset-x-0 bottom-0 @max-[671px]/game:mx-1.5 mx-3 @max-[671px]/game:mb-1.5 mb-3 flex flex-col rounded-[32px] @max-[671px]/game:p-1.5 p-2.5 shadow-(--ct-rail-shadow)",
				HUD_TOP
			)}
			style={
				{
					background: RAIL_LEATHER,
					"--ct-rail-shadow": TABLE_SHADOW,
					...(actHudBottom > 0 ? { top: actHudBottom + 8 } : {}),
				} as CSSProperties
			}
		>
			<CardTableSpread
				actions={actions}
				acts={spreadActs}
				isEmpty={isEmpty}
				key="spread"
				loading={loading}
				panelOpen={panelOpen}
			/>
		</div>
	);
}

/** What the hand deals: the fan, its tuck, its label and the cursor. */
export interface StageHand {
	activeThreadId: string | null;
	cardRefs: RefObject<Map<string, HTMLButtonElement>>;
	cursorId: string | null;
	dealt: InterfaceSnapshot["threads"];
	fan: HandLayout;
	held: number;
	heldThreads: InterfaceSnapshot["threads"];
	label: HandLabelPlacement;
	onCursor: (threadId: string) => void;
	onPlay: (threadId: string, pose: CardPose) => void;
	onTuck: ((open: boolean) => void) | undefined;
	tucked: number;
}

interface CardTableStageProps {
	actions: SpreadActions;
	actsOn: boolean;
	/** Seats and the felt animate their moves (settled, not tracking). */
	animate: boolean;
	announcement: string;
	geometry: TableGeometry;
	hand: StageHand;
	isEmpty: boolean;
	isoView: ReturnType<typeof useIsoView>;
	loading: boolean;
	now: number;
	onDeal: () => void;
	rail: SeatInfo[];
	railActs: CardTableActs["railActs"];
	railLayout: { collapsed: boolean; maxHeight: number };
	railTop: number | undefined;
	/** The room (or its flat fallback), drawn once loaded. */
	room: ReactNode;
	snapshot: InterfaceSnapshot;
	stage: StageSize;
	stageRef: RefObject<HTMLDivElement | null>;
	unseated: Parameters<typeof CardTableRail>[0]["unseated"];
}

/** The Table layout's stage. */
export function CardTableStage({
	actions,
	actsOn,
	animate,
	announcement,
	geometry,
	hand,
	isEmpty,
	isoView,
	loading,
	now,
	onDeal,
	rail,
	railActs,
	railLayout,
	railTop,
	room,
	snapshot,
	stage,
	stageRef,
	unseated,
}: CardTableStageProps) {
	const { dealt, label } = hand;
	return (
		<div
			aria-busy={loading}
			className={cn(
				// The room's canvas runs up under the HUD, so this does not clip.
				"group/stage absolute inset-x-0 bottom-0",
				HUD_TOP
			)}
			data-compact={geometry.compact ? "" : undefined}
			data-settled={animate ? "" : undefined}
			ref={stageRef}
		>
			{/* The hand comes first in reading and tab order: it is what you
			    act on. It is positioned, so this does not move it. */}
			{loading ? <HandSkeleton geometry={geometry} stage={stage} /> : null}
			{!loading && dealt.length > 0 ? (
				<>
					<CardTableHand
						activeThreadId={hand.activeThreadId}
						cardRefs={hand.cardRefs}
						cards={dealt}
						cursorId={hand.cursorId}
						geometry={geometry}
						held={hand.held}
						layout={hand.fan}
						now={now}
						onCursor={hand.onCursor}
						onPlay={hand.onPlay}
						onTuck={hand.onTuck}
						snapshot={snapshot}
						stage={stage}
						tucked={hand.tucked}
					/>
					<HandLabel
						actions={actions}
						acts={actsOn}
						count={dealt.length}
						heldThreads={hand.heldThreads}
						placement={label}
						tucked={hand.tucked}
					/>
					{/* Mirrors the hand's label, inside the HUD's 16px inset. */}
					{label.kind === "beside" &&
					stage.width - label.right - LEGEND_INSET >= LEGEND_MIN_WIDTH ? (
						<TableLegend
							acts={actsOn}
							left={label.right}
							maxWidth={stage.width - label.right - LEGEND_INSET}
							top={label.top}
						/>
					) : null}
				</>
			) : null}
			{!loading && dealt.length === 0 ? (
				<EmptyHand geometry={geometry} stage={stage} />
			) : null}

			{isEmpty ? <EmptyTablePanel geometry={geometry} onDeal={onDeal} /> : null}
			{loading ? <LoadingTable geometry={geometry} /> : room}

			{loading || isEmpty || geometry.compact ? null : (
				<div className="absolute end-3 top-3 z-30">
					<IsoZoomControls view={isoView} />
				</div>
			)}
			{loading || railLayout.collapsed ? null : (
				<CardTableRail
					actions={actions}
					acts={railActs}
					collapsed={false}
					maxHeight={railLayout.maxHeight}
					seats={rail}
					top={railTop}
					unseated={unseated}
				/>
			)}
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
		</div>
	);
}
