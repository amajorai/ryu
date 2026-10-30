import { useLiteralMessages } from "@ryu/i18n/react";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { ChevronRight, Landmark } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type Ref,
	useContext,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { GAME_PLATE } from "./game-hud.tsx";
import { compactAge } from "./interface-renderer.ts";
import { TownActMode } from "./town-desk-act-mode.ts";
import { DistrictList } from "./town-desk-district-list.tsx";
import { Minimap } from "./town-desk-minimap.tsx";
import { useNow } from "./town-hooks.ts";
import {
	eventWhen,
	spokenAge,
	type Town,
	type TownPetition,
} from "./town-model.ts";
import type { TownDataView, TownPalette } from "./town-palette.ts";

export { TownActMode } from "./town-desk-act-mode.ts";
export { DistrictList } from "./town-desk-district-list.tsx";
export {
	districtSwatch,
	Minimap,
	minimapPoint,
} from "./town-desk-minimap.tsx";

/**
 * City Hall's desk: the petitions (conversations waiting on you, failed
 * runs first) with "Hear petition" opening each, and the district map
 * below it: a minimap turned to match the camera, and the districts as a
 * list that moves the camera.
 */

export function petitionLabel(
	petition: TownPetition,
	now: number,
	actMode = false
): string {
	const from = petition.agent ? `from ${petition.agent.name}` : "unassigned";
	const state =
		petition.status === "attention" ? "Run failed" : "Reply waiting";
	const base = `Hear petition: ${petition.thread.title}. ${state}, ${from}, ${petition.districtName}`;
	return actMode
		? base
		: `${base}, ${spokenAge(petition.thread.updatedAt, now)}`;
}

/** When the longest-waiting petition was filed, if any. */
export function oldestUpdate(petitions: TownPetition[]): string | null {
	let oldest: string | null = null;
	let oldestAt = Number.POSITIVE_INFINITY;
	for (const petition of petitions) {
		const at = Date.parse(petition.thread.updatedAt);
		if (!Number.isNaN(at) && at < oldestAt) {
			oldestAt = at;
			oldest = petition.thread.updatedAt;
		}
	}
	return oldest;
}

export function PetitionList({
	activeThreadId,
	headingRef,
	loading,
	onHear,
	petitions,
}: {
	activeThreadId: string | null;
	headingRef?: Ref<HTMLHeadingElement>;
	loading: boolean;
	onHear: (threadId: string) => void;
	petitions: TownPetition[];
}) {
	const tl = useLiteralMessages();
	const now = useNow();
	const actMode = useContext(TownActMode);
	const oldest = loading || actMode ? null : oldestUpdate(petitions);
	return (
		<section
			aria-labelledby="town-petitions-heading"
			className="flex min-h-0 flex-col"
		>
			<div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
				<h2
					className="gk-display rounded-md text-(--gk-ink) text-[18px] leading-6 outline-none focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid"
					id="town-petitions-heading"
					ref={headingRef}
					tabIndex={-1}
				>
					Petitions
				</h2>
				{loading ? null : (
					<span className="text-(--gk-ink-muted) text-[13px] tabular-nums">
						{petitions.length}
					</span>
				)}
				{oldest ? (
					<span className="ms-auto text-(--gk-ink-muted) text-[13px] tabular-nums">
						{tl("oldest {age}", { age: compactAge(oldest, now) })}
					</span>
				) : null}
			</div>
			{loading ? (
				<div className="flex flex-col gap-3 px-4 py-2">
					{[0, 1, 2, 3].map((row) => (
						<div
							className="flex flex-col gap-1.5"
							key={`row-${row.toString()}`}
						>
							<Skeleton className="h-4 w-4/5" />
							<Skeleton className="h-3 w-1/2" />
						</div>
					))}
				</div>
			) : null}
			{!loading && petitions.length === 0 ? (
				<p className="px-4 pt-1 pb-4 text-(--gk-ink-muted) text-sm leading-5">
					Nothing is waiting on you. Replies and failed runs land here.
				</p>
			) : null}
			{!loading && petitions.length > 0 ? (
				<ul className="flex flex-col px-2 pb-2">
					{petitions.map((petition) => {
						const active = petition.thread.id === activeThreadId;
						return (
							<li key={petition.thread.id}>
								<button
									aria-current={active ? "true" : undefined}
									aria-label={petitionLabel(petition, now, actMode)}
									className={cn(
										"group flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-(--gk-plate-sunk) focus-visible:ring-(--gk-focus) focus-visible:ring-3 focus-visible:ring-inset",
										active && "bg-(--gk-plate-sunk)"
									)}
									onClick={() => onHear(petition.thread.id)}
									type="button"
								>
									<span className="flex items-center gap-2">
										<BoardStatusDot status={petition.status} />
										<span className="min-w-0 flex-1 truncate font-semibold text-(--gk-ink) text-[15px]">
											{petition.thread.title}
										</span>
										{/* One fixed slot: Hear takes the age's place, so the title never reflows. */}
										<span className="relative flex h-5 w-11 shrink-0 items-center justify-end text-[13px]">
											<span className="text-(--gk-ink-muted) tabular-nums group-hover:invisible group-focus-visible:invisible">
												{actMode
													? null
													: compactAge(petition.thread.updatedAt, now)}
											</span>
											<span
												aria-hidden="true"
												className="invisible absolute inset-y-0 right-0 inline-flex items-center gap-0.5 font-medium text-(--gk-ink) group-hover:visible group-focus-visible:visible"
											>
												Hear
												<ChevronRight className="size-3.5" />
											</span>
										</span>
									</span>
									<span className="flex min-w-0 items-center gap-1 ps-4 text-(--gk-ink-muted) text-[13px]">
										{petition.status === "attention" ? (
											<span className="shrink-0 font-medium text-(--gk-bad)">
												Run failed ·
											</span>
										) : null}
										<span className="truncate">
											{petition.agent?.name ?? "Unassigned"} ·{" "}
											{petition.districtName}
										</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
		</section>
	);
}

/**
 * The next scheduled runs, under the petitions like a city builder's
 * advisor queue. A run with an agent opens that agent's card.
 */
export function UpcomingRuns({
	events,
	onAgent,
	town,
}: {
	events: InterfaceEvent[];
	onAgent: (agentId: string) => void;
	town: Town;
}) {
	const tl = useLiteralMessages();
	const now = useNow();
	if (events.length === 0) {
		return null;
	}
	return (
		<section
			aria-labelledby="town-upcoming-heading"
			className="flex flex-col border-(--gk-plate-sunk) border-t pt-3"
		>
			<h2
				className="gk-display px-4 pb-1 text-(--gk-ink) text-[18px] leading-6"
				id="town-upcoming-heading"
			>
				Upcoming
			</h2>
			<ul className="flex flex-col px-2 pb-2">
				{events.map((event) => {
					const agent = event.agentId
						? town.buildings.find(
								(building) => building.agent.id === event.agentId
							)?.agent
						: undefined;
					const content = (
						<>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-(--gk-ink) text-sm">
									{event.title}
								</span>
								<span className="truncate text-(--gk-ink-muted) text-[13px]">
									{[agent?.name ?? "Any agent", event.label]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</span>
							<span className="w-12 shrink-0 text-right text-(--gk-ink-muted) text-[13px] tabular-nums">
								{eventWhen(event, now)}
							</span>
						</>
					);
					const row =
						"flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left";
					return (
						<li key={event.id}>
							{agent ? (
								<button
									aria-label={tl(
										"{title}, {agent}, {label}, {when}. Open {agent}'s card",
										{
											agent: agent.name,
											label: `${event.label}`,
											title: event.title,
											when: eventWhen(event, now),
										}
									)}
									className={cn(
										row,
										"outline-none transition-colors hover:bg-(--gk-plate-sunk) focus-visible:ring-(--gk-focus) focus-visible:ring-3 focus-visible:ring-inset"
									)}
									onClick={() => onAgent(agent.id)}
									type="button"
								>
									{content}
								</button>
							) : (
								<div className={row}>{content}</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * The docked desk: petitions fill the column and scroll; the map and the
 * districts are pinned to its foot, so the column always ends cleanly.
 */
export function TownDesk({
	actQueue,
	activeThreadId,
	className,
	dataView,
	header,
	headingRef,
	loading,
	onAgent,
	onDistrict,
	onHall,
	onHear,
	palette,
	selectedId,
	style,
	town,
	upcoming,
}: {
	/**
	 * With acts, what needs you (the kit's ask queue, blocking asks first)
	 * replaces the petitions, and `needYou` counts them.
	 */
	actQueue?: { count: number; list: ReactNode };
	activeThreadId: string | null;
	className?: string;
	dataView: TownDataView;
	/** A close button when the desk floats over the map. */
	header?: ReactNode;
	headingRef: Ref<HTMLHeadingElement>;
	loading: boolean;
	onAgent: (agentId: string) => void;
	onDistrict: (districtId: string) => void;
	onHall: () => void;
	onHear: (threadId: string) => void;
	palette: TownPalette;
	selectedId: string | null;
	style?: CSSProperties;
	town: Town;
	upcoming: InterfaceEvent[];
}) {
	return (
		<aside
			aria-label="City Hall"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex min-h-0 flex-col overflow-hidden",
				className
			)}
			style={style}
		>
			<div className="flex shrink-0 items-center gap-2.5 border-(--gk-plate-sunk) border-b-2 py-2.5 ps-3 pe-2.5">
				<span
					aria-hidden="true"
					className="grid size-9 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)"
				>
					<Landmark className="size-5" strokeWidth={2.25} />
				</span>
				<p className="gk-display flex-1 text-[20px] leading-7">City Hall</p>
				{header}
			</div>
			<TownDeskBody
				activeThreadId={activeThreadId}
				actQueue={actQueue}
				dataView={dataView}
				headingRef={headingRef}
				loading={loading}
				onAgent={onAgent}
				onDistrict={onDistrict}
				onHall={onHall}
				onHear={onHear}
				palette={palette}
				selectedId={selectedId}
				town={town}
				upcoming={upcoming}
			/>
		</aside>
	);
}

export type TownDeskBodyProps = Omit<
	Parameters<typeof TownDesk>[0],
	"className" | "header" | "style"
>;

/**
 * City Hall's contents (petitions, upcoming runs, the map and districts),
 * for the floating desk or the kit's GameSheet.
 */
export function TownDeskBody({
	actQueue,
	activeThreadId,
	dataView,
	headingRef,
	loading,
	onAgent,
	onDistrict,
	onHall,
	onHear,
	palette,
	selectedId,
	town,
	upcoming,
}: TownDeskBodyProps) {
	const [highlightId, setHighlightId] = useState<string | null>(null);
	return (
		<>
			<ScrollArea className="min-h-0 flex-1">
				{actQueue ? (
					<section
						aria-labelledby="town-petitions-heading"
						className="flex min-h-0 flex-col"
					>
						<div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
							<h2
								className="gk-display rounded-md text-(--gk-ink) text-[18px] leading-6 outline-none focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid"
								id="town-petitions-heading"
								ref={headingRef}
								tabIndex={-1}
							>
								Queue
							</h2>
							<span className="text-(--gk-ink-muted) text-[13px] tabular-nums">
								{actQueue.count}
							</span>
						</div>
						<div className="px-2 pb-2">{actQueue.list}</div>
					</section>
				) : (
					<PetitionList
						activeThreadId={activeThreadId}
						headingRef={headingRef}
						loading={loading}
						onHear={onHear}
						petitions={town.petitions}
					/>
				)}
				{loading ? null : (
					<UpcomingRuns events={upcoming} onAgent={onAgent} town={town} />
				)}
			</ScrollArea>
			<section
				aria-labelledby="town-map-heading"
				className="flex shrink-0 flex-col gap-2 border-(--gk-plate-sunk) border-t px-2 pt-3 pb-2"
			>
				<h2
					className="gk-display px-2 text-(--gk-ink) text-[18px] leading-6"
					id="town-map-heading"
				>
					Map
				</h2>
				{loading ? (
					<Skeleton className="mx-auto aspect-[2/1.24] w-56" />
				) : (
					<>
						<div className="relative mx-auto aspect-[2/1.24] w-56">
							<Minimap
								dataView={dataView}
								highlightId={highlightId}
								onDistrict={onDistrict}
								onHall={onHall}
								onHighlight={setHighlightId}
								palette={palette}
								selectedId={selectedId}
								town={town}
							/>
						</div>
						<DistrictList
							dataView={dataView}
							highlightId={highlightId}
							onDistrict={onDistrict}
							onHighlight={setHighlightId}
							palette={palette}
							town={town}
						/>
					</>
				)}
			</section>
		</>
	);
}
