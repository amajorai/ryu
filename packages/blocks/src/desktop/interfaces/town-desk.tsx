import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { ChevronRight, Landmark } from "lucide-react";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	type Ref,
	useContext,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { GAME_PLATE } from "./game-hud.tsx";
import { compactAge } from "./interface-renderer.ts";
import { useNow } from "./town-hooks.ts";
import {
	eventWhen,
	plural,
	ROAD,
	roadLines,
	SIDEWALK,
	spokenAge,
	type Town,
	type TownPetition,
} from "./town-model.ts";
import {
	districtColor,
	mixHex,
	type TownDataView,
	type TownPalette,
} from "./town-palette.ts";

/**
 * City Hall's desk: the petitions (conversations waiting on you, failed
 * runs first) with "Hear petition" opening each, and the district map
 * below it: a minimap turned to match the camera, and the districts as a
 * list that moves the camera.
 */

/**
 * Whether the act layer is on: the petitions then carry no last-update
 * ages (the act layer's own cards and timers say how long things waited).
 */
export const TownActMode = createContext(false);

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
						oldest {compactAge(oldest, now)}
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
 * The swatch a district shows in the legend: its ground tint by day; at
 * night the tint is lifted toward the facades so it reads on a dark card.
 */
export function districtSwatch(
	palette: TownPalette,
	dataView: TownDataView,
	district: { activity: number; needs: number; tint: number }
): string {
	const ground = districtColor(palette, dataView, district);
	return palette.mode === "dark" && dataView === "none"
		? mixHex(ground, palette.column, 0.35)
		: ground;
}

/** The minimap's squash: the 45° turn flattened like the isometric view. */
const MAP_SQUASH = 0.62;

/**
 * Where a point of the town lands on the minimap, as fractions of its box:
 * the same turn and squash as the SVG, so HTML labels sit on the blocks.
 */
export function minimapPoint(
	x: number,
	z: number,
	view: number
): { left: number; top: number } {
	const turnedX = (x - z) * Math.SQRT1_2;
	const turnedY = (x + z) * Math.SQRT1_2 * MAP_SQUASH;
	return {
		left: (turnedX + view) / (view * 2),
		top: (turnedY + view * MAP_SQUASH) / (view * 2 * MAP_SQUASH),
	};
}

function mapView(town: Town): { half: number; view: number } {
	const half = town.grid.reach + ROAD / 2 + 0.6;
	return { half, view: half * Math.SQRT2 };
}

/**
 * The minimap: the town from above, turned 45° so it reads the same way as
 * the isometric camera. Roads are drawn, buildings are dots and status
 * shows as theme colour; the block under the pointer (or the district row
 * in focus) is outlined and named.
 */
export function Minimap({
	dataView,
	highlightId,
	onDistrict,
	onHall,
	onHighlight,
	palette,
	selectedId,
	town,
}: {
	dataView: TownDataView;
	highlightId: string | null;
	onDistrict: (districtId: string) => void;
	onHall: () => void;
	onHighlight: (id: string | null) => void;
	palette: TownPalette;
	selectedId: string | null;
	town: Town;
}) {
	const { inner, reach } = town.grid;
	const block = inner + SIDEWALK * 2;
	const { half, view } = mapView(town);
	const lines = roadLines(town.grid);
	const span = reach + ROAD / 2;
	const highlighted =
		highlightId === "hall"
			? { name: "City Hall", x: 0, z: 0 }
			: town.districts.find((item) => item.id === highlightId);
	const label = highlighted
		? minimapPoint(highlighted.x, highlighted.z, view)
		: null;
	return (
		<>
			<svg
				aria-hidden="true"
				className="absolute inset-0 size-full"
				focusable="false"
				onPointerLeave={() => onHighlight(null)}
				viewBox={`${-view} ${-view * MAP_SQUASH} ${view * 2} ${view * 2 * MAP_SQUASH}`}
			>
				<g transform={`scale(1 ${MAP_SQUASH}) rotate(45)`}>
					<rect
						className="fill-muted"
						height={half * 2}
						rx={0.8}
						width={half * 2}
						x={-half}
						y={-half}
					/>
					{lines.map((line) => (
						<g className="stroke-muted-foreground/30" key={`road-${line}`}>
							<line
								strokeWidth={ROAD * 0.7}
								x1={-span}
								x2={span}
								y1={line}
								y2={line}
							/>
							<line
								strokeWidth={ROAD * 0.7}
								x1={line}
								x2={line}
								y1={-span}
								y2={span}
							/>
						</g>
					))}
					{town.parks.map((park) => (
						<rect
							fill={palette.grassDark}
							height={block}
							key={park.id}
							rx={0.4}
							width={block}
							x={park.x - block / 2}
							y={park.z - block / 2}
						/>
					))}
					<rect
						className={cn(
							"cursor-pointer fill-card",
							highlightId === "hall" ? "stroke-foreground" : "stroke-border"
						)}
						height={block}
						onClick={onHall}
						onPointerEnter={() => onHighlight("hall")}
						rx={0.4}
						strokeWidth={highlightId === "hall" ? 0.3 : 0.12}
						width={block}
						x={-block / 2}
						y={-block / 2}
					/>
					<rect
						className="pointer-events-none fill-muted-foreground/60"
						height={2.2}
						width={3.4}
						x={-1.7}
						y={-1.6}
					/>
					{town.districts.map((district) => (
						<rect
							className={cn(
								"cursor-pointer",
								highlightId === district.id && "stroke-foreground"
							)}
							fill={districtColor(palette, dataView, district)}
							height={block}
							key={district.id}
							onClick={() => onDistrict(district.id)}
							onPointerEnter={() => onHighlight(district.id)}
							rx={0.4}
							strokeWidth={highlightId === district.id ? 0.3 : 0}
							width={block}
							x={district.x - block / 2}
							y={district.z - block / 2}
						/>
					))}
					<g className="pointer-events-none">
						{[
							...town.districts.flatMap((district) => district.fillers),
							...town.parks.flatMap((park) => park.homes),
						].map((filler) => (
							<rect
								className="fill-foreground/25"
								height={1}
								key={filler.id}
								rx={0.15}
								width={1}
								x={filler.lot.x - 0.5}
								y={filler.lot.z - 0.5}
							/>
						))}
						{town.buildings.map((building) => {
							let tone = "fill-foreground/60";
							if (building.alert) {
								tone = "fill-destructive";
							} else if (building.replied) {
								tone = "fill-primary";
							} else if (building.working) {
								tone = "fill-success";
							}
							const selected = building.agent.id === selectedId;
							return (
								<rect
									className={cn(tone, selected && "stroke-foreground")}
									height={1.3}
									key={building.agent.id}
									rx={0.2}
									strokeWidth={selected ? 0.3 : 0}
									width={1.3}
									x={building.lot.x - 0.65}
									y={building.lot.z - 0.65}
								/>
							);
						})}
					</g>
				</g>
			</svg>
			{highlighted && label ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute flex h-5 -translate-x-1/2 -translate-y-1/2 items-center whitespace-nowrap rounded bg-background px-1.5 font-medium text-(--gk-ink) text-[13px] shadow-xs ring-1 ring-border"
					style={{ left: `${label.left * 100}%`, top: `${label.top * 100}%` }}
				>
					{highlighted.name}
				</span>
			) : null}
		</>
	);
}

const DISTRICT_COLUMNS = "grid grid-cols-[1fr_3.5rem_3rem] items-center gap-2";

/** The districts as a list: the accessible twin of the minimap. */
export function DistrictList({
	dataView,
	highlightId,
	onDistrict,
	onHighlight,
	palette,
	town,
}: {
	dataView: TownDataView;
	highlightId: string | null;
	onDistrict: (districtId: string) => void;
	onHighlight: (id: string | null) => void;
	palette: TownPalette;
	town: Town;
}) {
	const actMode = useContext(TownActMode);
	return (
		<div className="flex flex-col">
			<div
				aria-hidden="true"
				className={cn(
					DISTRICT_COLUMNS,
					"h-6 px-2 text-(--gk-ink-muted) text-[13px]"
				)}
			>
				<span>District</span>
				<span className="text-right">Waiting</span>
				<span className="text-right">Total</span>
			</div>
			<ul
				aria-label="Districts"
				className="flex flex-col"
				onPointerLeave={() => onHighlight(null)}
			>
				{town.districts.map((district) => (
					<li key={district.id}>
						<button
							aria-label={
								actMode
									? `${district.name}: ${plural(district.buildings.length, "building")}, ${district.petitions} waiting on you, ${plural(district.threads.length, "conversation")} in all. Show on the map`
									: `${district.name}: ${plural(district.buildings.length, "building")}, ${plural(district.threads.length, "conversation")}, ${plural(district.petitions, "petition")}. Show on the map`
							}
							className={cn(
								DISTRICT_COLUMNS,
								"h-8 w-full rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-(--gk-plate-sunk) focus-visible:ring-(--gk-focus) focus-visible:ring-3 focus-visible:ring-inset",
								highlightId === district.id && "bg-(--gk-plate-sunk)"
							)}
							onBlur={() => onHighlight(null)}
							onClick={() => onDistrict(district.id)}
							onFocus={() => onHighlight(district.id)}
							onPointerEnter={() => onHighlight(district.id)}
							type="button"
						>
							<span className="flex min-w-0 items-center gap-2">
								<span
									aria-hidden="true"
									className="size-2.5 shrink-0 rounded-sm ring-1 ring-foreground/25"
									style={{
										backgroundColor: districtSwatch(
											palette,
											dataView,
											district
										),
									}}
								/>
								<span className="truncate text-(--gk-ink)">
									{district.name}
								</span>
							</span>
							<span
								className={cn(
									"text-right text-[13px] tabular-nums",
									district.petitions > 0
										? "font-medium text-(--gk-ink)"
										: "text-(--gk-ink-muted)"
								)}
							>
								{district.petitions}
							</span>
							<span className="text-right text-(--gk-ink-muted) text-[13px] tabular-nums">
								{district.threads.length}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
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
									aria-label={`${event.title}, ${agent.name}, ${event.label}, ${eventWhen(event, now)}. Open ${agent.name}'s card`}
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
