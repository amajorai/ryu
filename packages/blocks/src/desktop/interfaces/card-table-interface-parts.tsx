import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { SEAT_SLOTS } from "./card-table-interface-layout.ts";
import {
	type CardTableLook,
	CardTableLookContext,
} from "./card-table-look.tsx";
import {
	emptyPanelRect,
	handPose,
	type SeatInfo,
	type StageSize,
	stackChips,
	type TableGeometry,
} from "./card-table-model.ts";
import { ChipStack, HoleCards } from "./card-table-pieces.tsx";
import { type CardVerdicts, CardVerdictsContext } from "./card-table-rows.tsx";

/**
 * The Card Table renderer's plain pieces: its providers, the loading
 * skeletons, the empty-table panel and the flat (no-WebGL) table. Split out
 * of `card-table-interface.tsx`.
 */

const SKELETON_CARDS = ["deal-1", "deal-2", "deal-3", "deal-4", "deal-5"];

/** The table's contexts: its look (felt, deck) and the acts' card verdicts. */
export function CardTableProviders({
	children,
	look,
	verdicts,
}: {
	children: ReactNode;
	look: CardTableLook;
	verdicts: CardVerdicts | null;
}) {
	return (
		<CardTableLookContext.Provider value={look}>
			<CardVerdictsContext.Provider value={verdicts}>
				{children}
			</CardVerdictsContext.Provider>
		</CardTableLookContext.Provider>
	);
}

function SeatSkeleton({ compact }: { compact: boolean }) {
	if (compact) {
		return (
			<div className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-card/90 px-2 py-2 shadow-sm">
				<Skeleton className="size-8" radius="pill" />
				<Skeleton className="h-2 w-10" radius="pill" />
			</div>
		);
	}
	return (
		<div className="flex w-[200px] items-center gap-2.5 rounded-2xl border border-border bg-card/90 py-2 ps-2 pe-3 shadow-sm">
			<Skeleton className="size-10 shrink-0" radius="pill" />
			<div className="flex flex-1 flex-col gap-1.5">
				<Skeleton className="h-2.5 w-16" radius="pill" />
				<Skeleton className="h-2 w-12" radius="pill" />
			</div>
		</div>
	);
}

export function HandSkeleton({
	geometry,
	stage,
}: {
	geometry: TableGeometry;
	stage: StageSize;
}) {
	return (
		<div aria-hidden="true" className="absolute inset-0 z-20">
			{SKELETON_CARDS.map((key, index) => {
				const pose = handPose({
					count: SKELETON_CARDS.length,
					geometry,
					index,
					lifted: null,
					stage,
				});
				return (
					<Skeleton
						className="absolute top-0 left-0 rounded-xl border border-border bg-card"
						key={key}
						radius="panel"
						style={{
							height: geometry.card.height,
							transform: `translate(${pose.x}px, ${pose.y}px) rotate(${pose.rotate}deg)`,
							transformOrigin: "50% 135%",
							width: geometry.card.width,
						}}
					/>
				);
			})}
		</div>
	);
}

/** While loading: the felt's outline with a placeholder pot, and the seats. */
export function LoadingTable({ geometry }: { geometry: TableGeometry }) {
	return (
		<>
			<div
				className="absolute rounded-[50%] bg-(--gk-plate-sunk)/50"
				style={{
					height: geometry.felt.height,
					left: geometry.felt.x,
					top: geometry.felt.y,
					width: geometry.felt.width,
				}}
			>
				<Skeleton
					className="absolute top-1/2 left-1/2 h-8 w-32 -translate-x-1/2 -translate-y-1/2 bg-background/60"
					radius="pill"
				/>
			</div>
			<ul aria-label="Seats" className="absolute inset-0">
				{SEAT_SLOTS.map((slot) => {
					const point = geometry.seats[slot];
					return point ? (
						<li
							className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
							key={`slot-${slot}`}
							style={{ left: point.x, top: point.y }}
						>
							<SeatSkeleton compact={geometry.compact} />
						</li>
					) : null;
				})}
			</ul>
		</>
	);
}

/** Nobody seated and no threads: what the table is and how to start. */
export function EmptyTablePanel({
	geometry,
	onDeal,
}: {
	geometry: TableGeometry;
	onDeal: () => void;
}) {
	return (
		<div className="absolute inset-0 z-20 flex items-center justify-center p-4">
			<div
				className="flex flex-col items-center gap-2 rounded-2xl bg-background/85 px-5 py-4 text-center shadow-[0_12px_30px_-18px] shadow-foreground/50 backdrop-blur-md"
				data-testid="card-table-empty-panel"
				style={{ width: emptyPanelRect(geometry).width }}
			>
				<p className="font-semibold text-foreground text-sm">
					Nobody is at the table yet
				</p>
				<p className="text-muted-foreground text-xs">
					Deal a thread to bring an agent in. Their runs land in the pot, and
					replies come back to you as cards.
				</p>
				<Button className="mt-1" onClick={onDeal} size="sm" type="button">
					<Plus aria-hidden="true" data-icon="inline-start" />
					Deal a thread
				</Button>
			</div>
		</div>
	);
}

function SeatChips({
	compact,
	point,
	seat,
	slot,
}: {
	compact: boolean;
	point: { x: number; y: number };
	seat: SeatInfo;
	slot: number;
}) {
	const count = seat.threads.length;
	if (count === 0) {
		return null;
	}
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute z-[5] flex -translate-x-1/2 -translate-y-1/2 items-end gap-2 group-data-settled/stage:transition-[left,top] group-data-settled/stage:duration-300 group-data-settled/stage:ease-out motion-reduce:transition-none"
			data-chips={seat.agent.id}
			style={{ left: point.x, top: point.y }}
		>
			{seat.agentTurn > 0 ? <HoleCards width={compact ? 22 : 30} /> : null}
			<ChipStack
				chips={stackChips(count)}
				colorIndex={slot}
				size={compact ? 22 : 32}
			/>
		</div>
	);
}

/**
 * Without WebGL (and in tests) the table is laid flat: an oval of felt, the
 * pot in its middle, chips before each seat and the seats round it.
 */
export function FlatTable({
	actsOn,
	chairPlate,
	geometry,
	pot,
	seated,
}: {
	actsOn: boolean;
	chairPlate: (slot: number, compact: boolean) => ReactNode;
	geometry: TableGeometry;
	pot: ReactNode;
	seated: readonly SeatInfo[];
}) {
	const felt = {
		height: geometry.felt.height,
		left: geometry.felt.x,
		top: geometry.felt.y,
		width: geometry.felt.width,
	};
	return (
		<>
			<div
				aria-hidden="true"
				className="absolute rounded-[50%] border-(--gk-edge)/30 border-[10px] bg-(--gk-plate-sunk)"
				data-testid="card-table-felt"
				style={felt}
			/>
			<div className="absolute flex items-center justify-center" style={felt}>
				{pot}
			</div>
			{/* With acts a seat's progress and marks say it; no chip per thread. */}
			{(actsOn ? [] : seated).map((seat, slot) => {
				const point = geometry.chips[slot];
				return point ? (
					<SeatChips
						compact={geometry.compact}
						key={seat.agent.id}
						point={point}
						seat={seat}
						slot={slot}
					/>
				) : null;
			})}
			<ul aria-label="Seats" className="pointer-events-none absolute inset-0">
				{SEAT_SLOTS.map((slot) => {
					const point = geometry.seats[slot];
					if (!point) {
						return null;
					}
					const seat = seated[slot];
					return (
						<li
							className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2 group-data-settled/stage:transition-[left,top] group-data-settled/stage:duration-300 group-data-settled/stage:ease-out motion-reduce:transition-none"
							data-slot-index={slot}
							key={seat ? seat.agent.id : `slot-${slot}`}
							style={{ left: point.x, top: point.y }}
						>
							{chairPlate(slot, geometry.compact)}
						</li>
					);
				})}
			</ul>
		</>
	);
}
