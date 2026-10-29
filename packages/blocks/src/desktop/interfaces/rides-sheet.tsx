import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import {
	type DriverOption,
	type RideTrip,
	SHEET_TABS,
	type SheetTab,
	type TripDay,
} from "./rides-model.ts";
import {
	DriverOptionBody,
	SHEET_ROW,
	SheetEmpty,
	SheetSkeleton,
	TripRow,
} from "./rides-parts.tsx";

export interface SheetLists {
	arrived: RideTrip[];
	history: TripDay[];
	now: RideTrip[];
}

const EMPTY: Record<SheetTab, { body: string; title: string }> = {
	arrived: {
		body: "When a driver replies, the trip ends here and it is your turn.",
		title: "Nothing has arrived",
	},
	now: {
		body: "Book a trip with Where to? to see it here.",
		title: "No trips under way",
	},
	trips: {
		body: "Finished trips are kept here by day.",
		title: "No past trips",
	},
};

function count(lists: SheetLists, tab: SheetTab): number {
	if (tab === "trips") {
		return lists.history.reduce((total, day) => total + day.trips.length, 0);
	}
	return lists[tab].length;
}

/**
 * Now / Arrived / Trips: the sheet's lists under the booking box. Tabs
 * follow the WAI-ARIA tabs pattern (arrow keys move between them); rows
 * preview on focus and open on Enter.
 */
export function RidesSheetTabs({
	drivers,
	lists,
	loading,
	now,
	onFocusTrip,
	onOpenTrip,
	onPickDriver,
	onTabChange,
	pickedDriverId,
	reduceMotion,
	selectedTripId,
	tab,
}: {
	drivers: DriverOption[];
	lists: SheetLists;
	loading: boolean;
	now: number;
	onFocusTrip: (tripId: string) => void;
	onOpenTrip: (tripId: string) => void;
	onPickDriver: (agentId: string) => void;
	onTabChange: (tab: SheetTab) => void;
	pickedDriverId: string | undefined;
	reduceMotion: boolean;
	selectedTripId: string | null;
	tab: SheetTab;
}) {
	const baseId = useId();
	const tabRefs = useRef(new Map<SheetTab, HTMLButtonElement>());

	const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const index = SHEET_TABS.findIndex((item) => item.id === tab);
		let next = -1;
		if (event.key === "ArrowRight") {
			next = (index + 1) % SHEET_TABS.length;
		} else if (event.key === "ArrowLeft") {
			next = (index - 1 + SHEET_TABS.length) % SHEET_TABS.length;
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = SHEET_TABS.length - 1;
		}
		const target = SHEET_TABS[next];
		if (target) {
			event.preventDefault();
			onTabChange(target.id);
			tabRefs.current.get(target.id)?.focus();
		}
	};

	const rowProps = {
		now,
		onFocusTrip,
		onOpen: onOpenTrip,
	};

	let body: ReactNode;
	if (loading) {
		body = <SheetSkeleton />;
	} else if (tab === "now" && count(lists, tab) === 0 && drivers.length > 0) {
		// Nothing under way: the drivers nearby take the empty list's place,
		// like the ride options a rider app opens on.
		body = (
			<DriverList
				drivers={drivers}
				headingId={`${baseId}-drivers`}
				onPick={onPickDriver}
				pickedDriverId={pickedDriverId}
			/>
		);
	} else if (count(lists, tab) === 0) {
		body = <SheetEmpty title={EMPTY[tab].title}>{EMPTY[tab].body}</SheetEmpty>;
	} else if (tab === "trips") {
		body = (
			<div className="flex flex-col">
				{lists.history.map((day) => (
					<section aria-labelledby={`${baseId}-${day.key}`} key={day.key}>
						<SheetHeading id={`${baseId}-${day.key}`} sticky>
							{day.label}
						</SheetHeading>
						<ul className="flex flex-col">
							{day.trips.map((trip) => (
								<TripRow
									{...rowProps}
									key={trip.id}
									selected={trip.id === selectedTripId}
									trip={trip}
									variant="history"
								/>
							))}
						</ul>
					</section>
				))}
			</div>
		);
	} else {
		const rows = (trips: RideTrip[]) => (
			<ul className="flex flex-col">
				{trips.map((trip) => (
					<TripRow
						{...rowProps}
						key={trip.id}
						selected={trip.id === selectedTripId}
						trip={trip}
						variant="live"
					/>
				))}
			</ul>
		);
		const live = lists[tab].filter((trip) => trip.stage !== "cancelled");
		const attention = lists[tab].filter((trip) => trip.stage === "cancelled");
		body = (
			<>
				{live.length > 0 ? rows(live) : null}
				{attention.length > 0 ? (
					<section aria-labelledby={`${baseId}-attention`}>
						<SheetHeading id={`${baseId}-attention`}>
							Needs attention
						</SheetHeading>
						{rows(attention)}
					</section>
				) : null}
			</>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				aria-label="Trips"
				className="flex shrink-0 gap-6 border-border border-b px-4"
				role="tablist"
			>
				{SHEET_TABS.map((item) => {
					const active = item.id === tab;
					const total = loading ? null : count(lists, item.id);
					return (
						<button
							aria-controls={`${baseId}-panel`}
							aria-selected={active}
							className={cn(
								"relative flex h-11 items-center gap-1.5 font-medium text-sm outline-none transition-colors after:absolute after:inset-x-[-6px] after:inset-y-2 after:rounded-sm focus-visible:text-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
								active
									? "text-foreground"
									: "text-muted-foreground hover:text-foreground"
							)}
							id={`${baseId}-${item.id}`}
							key={item.id}
							onClick={() => onTabChange(item.id)}
							onKeyDown={onTabKeyDown}
							ref={(node) => {
								if (node) {
									tabRefs.current.set(item.id, node);
								} else {
									tabRefs.current.delete(item.id);
								}
							}}
							role="tab"
							tabIndex={active ? 0 : -1}
							type="button"
						>
							{item.label}
							{total ? (
								<span className="text-[13px] text-muted-foreground tabular-nums">
									{total}
								</span>
							) : null}
							{active ? (
								<motion.span
									aria-hidden="true"
									className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground"
									layoutId={`${baseId}-indicator`}
									transition={{ duration: reduceMotion ? 0 : 0.2 }}
								/>
							) : null}
						</button>
					);
				})}
			</div>
			<div
				aria-labelledby={`${baseId}-${tab}`}
				className="min-h-0 flex-1 overflow-y-auto pb-2"
				id={`${baseId}-panel`}
				role="tabpanel"
			>
				{body}
			</div>
		</div>
	);
}

/** A small section label inside the sheet's lists. */
function SheetHeading({
	children,
	id,
	sticky = false,
}: {
	children: ReactNode;
	id: string;
	sticky?: boolean;
}) {
	return (
		<h3
			className={cn(
				"bg-(--gk-plate) px-4 pt-4 pb-1.5 font-medium text-[13px] text-muted-foreground",
				sticky && "sticky top-0 z-10"
			)}
			id={id}
		>
			{children}
		</h3>
	);
}

/**
 * Drivers nearby, shown in Now while no trip is under way: each with when
 * they are free. Choosing one picks them for the next booking and moves
 * focus to "Where to?".
 */
function DriverList({
	drivers,
	headingId,
	onPick,
	pickedDriverId,
}: {
	drivers: DriverOption[];
	headingId: string;
	onPick: (agentId: string) => void;
	pickedDriverId: string | undefined;
}) {
	const tl = useLiteralMessages();
	return (
		<section aria-labelledby={headingId}>
			<SheetHeading id={headingId}>Drivers nearby</SheetHeading>
			<ul className="flex flex-col">
				{drivers.map((option) => {
					const picked = option.agent.id === pickedDriverId;
					return (
						<li key={option.agent.id}>
							<button
								aria-label={
									option.available
										? tl("Choose {driverName}, available now", {
												driverName: option.agent.name,
											})
										: tl(
												"Choose {driverName}, free in about {waitMinutes} min",
												{
													driverName: option.agent.name,
													waitMinutes: String(option.waitMinutes),
												}
											)
								}
								aria-pressed={picked}
								className={cn(SHEET_ROW, picked && "bg-muted hover:bg-muted")}
								onClick={() => onPick(option.agent.id)}
								type="button"
							>
								<DriverOptionBody option={option} />
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
