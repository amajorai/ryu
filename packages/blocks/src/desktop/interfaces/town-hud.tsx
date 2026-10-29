import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	Building2,
	Coins,
	Construction,
	FastForward,
	Landmark,
	Maximize,
	Minus,
	Pause,
	Play,
	Plus,
	Smile,
	Users,
} from "lucide-react";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameCounter,
	GameCounters,
	GamePlate,
	GameTitlePlate,
	type GameTone,
} from "./game-hud.tsx";
import { useNow } from "./town-hooks.ts";
import type { TownStats } from "./town-model.ts";
import {
	rampGradient,
	type TownDataView,
	type TownPalette,
} from "./town-palette.ts";

/**
 * The mayor's HUD on the shared game kit (game-shell.tsx): the town's name,
 * date and speed on a title plate, its vital signs (population, happiness,
 * what is under construction, funds) as counters, the simulation speed and
 * the data views as chunky segmented plates, and the zoom buttons. All of
 * it floats over the full-bleed map.
 */

export const SPEEDS = [
	{ icon: Pause, label: "Pause", value: 0 },
	{ icon: Play, label: "Normal speed", value: 1 },
	{ icon: FastForward, label: "Fast", value: 3 },
] as const;

/** What the speed control reads as beside it: the clock's rate. */
export function speedLabel(speed: number): string {
	return speed === 0 ? "Paused" : `${speed}×`;
}

/** One segment of a chunky segmented plate. */
const SEGMENT =
	"grid h-9 min-w-9 place-items-center rounded-xl px-2 font-semibold text-(--gk-ink-muted) transition-colors hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink) aria-pressed:bg-(--gk-accent) aria-pressed:text-(--gk-accent-ink) aria-pressed:shadow-[inset_0_-3px_0_var(--gk-accent-edge)]";

function happinessTone(value: number): GameTone {
	if (value >= 70) {
		return "good";
	}
	if (value >= 40) {
		return "warn";
	}
	return "bad";
}

const METER_TONE: Record<GameTone, string> = {
	accent: "bg-(--gk-accent)",
	bad: "bg-(--gk-bad)",
	gold: "bg-(--gk-gold)",
	good: "bg-(--gk-good)",
	info: "bg-(--gk-info)",
	warn: "bg-(--gk-warn)",
};

function HappinessMeter({
	compact,
	value,
}: {
	compact: boolean;
	value: number;
}) {
	return (
		<span className="inline-flex items-center gap-2">
			{value}%
			<span
				aria-label="Happiness"
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={value}
				className={cn(
					"relative h-2.5 w-14 overflow-hidden rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)",
					compact && "sr-only"
				)}
				role="meter"
			>
				<span
					className={cn(
						"absolute inset-y-0 left-0",
						METER_TONE[happinessTone(value)]
					)}
					style={{ width: `${value}%` }}
				/>
			</span>
		</span>
	);
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
	weekday: "short",
};
const TIME_FORMAT: Intl.DateTimeFormatOptions = {
	hour: "numeric",
	minute: "2-digit",
};

/**
 * The town's date and clock, with the simulation's rate beside it the way
 * a city builder shows its speed next to the calendar.
 */
function TownDate({ speed }: { speed: number }) {
	const now = useNow();
	const date = new Date(now);
	return (
		<span className="tabular-nums">
			<time dateTime={date.toISOString()}>
				{date.toLocaleDateString(undefined, DATE_FORMAT)}
				<span aria-hidden="true"> · </span>
				{date.toLocaleTimeString(undefined, TIME_FORMAT)}
			</time>
			<span aria-hidden="true"> · </span>
			<output aria-live="polite">
				<span className="sr-only">Simulation speed </span>
				{speedLabel(speed)}
			</output>
		</span>
	);
}

/** Top left: the town's name, date, clock and speed. */
export function TownTitle({
	actStatus,
	compact,
	speed,
}: {
	/** The act layer's summary line, when the host sends asks. */
	actStatus?: string;
	compact: boolean;
	speed: number;
}) {
	if (compact && actStatus !== undefined) {
		// A phone's title plate truncates its status line: the act summary
		// gets a plate of its own under it, where it wraps whole.
		return (
			<div className="flex min-w-0 flex-col items-start gap-2">
				<GameTitlePlate
					compact
					icon={<Building2 strokeWidth={2.25} />}
					title="Town"
				/>
				<GamePlate className="px-3 py-1.5 font-semibold text-(--gk-ink-muted) text-[13px] leading-5">
					{actStatus}
				</GamePlate>
			</div>
		);
	}
	return (
		<GameTitlePlate
			compact={compact}
			icon={<Building2 strokeWidth={2.25} />}
			keepStatus={actStatus !== undefined}
			status={actStatus ?? <TownDate speed={speed} />}
			title="Town"
		/>
	);
}

/** The town's vital signs as HUD counters. */
export function TownStatsPlate({
	compact,
	funds,
	stats,
}: {
	compact: boolean;
	funds: string | null;
	stats: TownStats;
}) {
	return (
		<GameCounters label="Town statistics">
			<GameCounter
				compact={compact}
				icon={<Users strokeWidth={2.5} />}
				label="Population"
				tone="info"
				value={stats.population}
			/>
			<GameCounter
				compact={compact}
				icon={<Smile strokeWidth={2.5} />}
				label="Happiness"
				tone={happinessTone(stats.happiness)}
				value={<HappinessMeter compact={compact} value={stats.happiness} />}
			/>
			<GameCounter
				compact={compact}
				icon={<Construction strokeWidth={2.5} />}
				label="Under construction"
				tone="warn"
				value={stats.working}
			/>
			{funds ? (
				<GameCounter
					compact={compact}
					icon={<Coins strokeWidth={2.5} />}
					label="Funds"
					tone="gold"
					value={funds}
				/>
			) : null}
		</GameCounters>
	);
}

/** Pause, normal and fast, as one chunky segmented plate. */
export function SpeedControl({
	onSpeed,
	speed,
}: {
	onSpeed: (speed: number) => void;
	speed: number;
}) {
	return (
		<fieldset
			aria-label="Simulation speed"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex items-center gap-1 p-1"
			)}
		>
			{SPEEDS.map((option) => (
				<button
					aria-label={option.label}
					aria-pressed={speed === option.value}
					className={cn(SEGMENT, GAME_FOCUS)}
					key={option.value}
					onClick={() => onSpeed(option.value)}
					title={option.label}
					type="button"
				>
					<option.icon
						aria-hidden="true"
						className="size-4"
						strokeWidth={2.75}
					/>
				</button>
			))}
		</fieldset>
	);
}

/** Folds the City Hall desk open on stages too narrow to dock it. */
export function CityHallButton({
	actMode = false,
	onClick,
	open,
	petitions,
}: {
	/** With acts the count is what needs you (blocking asks). */
	actMode?: boolean;
	onClick: () => void;
	open: boolean;
	petitions: number;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			aria-expanded={open}
			aria-label={
				actMode
					? tl("City Hall, {petitions} need you", { petitions })
					: tl(
							"City Hall, {petitions, plural, one {# petition} other {# petitions}}",
							{ petitions }
						)
			}
			className={cn(
				GAME_PLATE,
				"gk-display pointer-events-auto flex h-12 shrink-0 items-center gap-2 ps-2 pe-3 text-[16px] hover:bg-(--gk-plate-sunk)",
				GAME_FOCUS
			)}
			onClick={onClick}
			type="button"
		>
			<span className="grid size-8 place-items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
				<Landmark aria-hidden="true" className="size-4" strokeWidth={2.5} />
			</span>
			<span className="max-sm:sr-only">City Hall</span>
			{petitions > 0 ? (
				<span className="grid h-6 min-w-6 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-accent) px-1.5 text-(--gk-accent-ink) text-[13px] tabular-nums">
					{petitions}
				</span>
			) : null}
		</button>
	);
}

const VIEW_LABELS: Record<TownDataView, string> = {
	activity: "Activity",
	needs: "Needs you",
	none: "Districts",
};

const VIEW_SCALE: Record<Exclude<TownDataView, "none">, [string, string]> = {
	activity: ["Idle", "Busy now"],
	needs: ["Settled", "Waiting on you"],
};

/** With acts the "Needs you" view counts asks and stopped runs. */
const ACT_VIEW_HINTS: Record<TownDataView, string> = {
	activity: "Running and recently active conversations",
	needs: "Agents asking you or stopped",
	none: "Each district in its own ground colour",
};

/** What each data view measures, on its button and over its legend. */
export const VIEW_HINTS: Record<TownDataView, string> = {
	activity: "Running and recently active conversations",
	needs: "Replies and failed runs waiting on you",
	none: "Each district in its own ground colour",
};

/** Data views: tint the districts by activity or by what waits on you. */
export function DataViewControl({
	actMode = false,
	onChange,
	palette,
	value,
}: {
	/** With acts the views speak of acts (asks, stopped runs). */
	actMode?: boolean;
	onChange: (view: TownDataView) => void;
	palette: TownPalette;
	value: TownDataView;
}) {
	return (
		<div className="pointer-events-auto flex flex-col items-start gap-2">
			<fieldset
				aria-label="Data view"
				className={cn(GAME_PLATE, "flex items-center gap-1 p-1")}
			>
				{(["none", "activity", "needs"] as const).map((view) => (
					<button
						aria-description={(actMode ? ACT_VIEW_HINTS : VIEW_HINTS)[view]}
						aria-pressed={value === view}
						className={cn(SEGMENT, "px-3 text-[14px]", GAME_FOCUS)}
						key={view}
						onClick={() => onChange(view)}
						title={(actMode ? ACT_VIEW_HINTS : VIEW_HINTS)[view]}
						type="button"
					>
						{VIEW_LABELS[view]}
					</button>
				))}
			</fieldset>
			{value === "none" ? null : (
				<div
					className={cn(
						GAME_PLATE,
						"flex flex-col gap-1.5 px-3 py-2.5 font-semibold text-[13px]"
					)}
				>
					<p>{(actMode ? ACT_VIEW_HINTS : VIEW_HINTS)[value]}</p>
					<div className="flex items-center gap-2 text-(--gk-ink-muted)">
						<span>{VIEW_SCALE[value][0]}</span>
						<span
							aria-hidden="true"
							className="h-2.5 w-24 rounded-full border-(--gk-edge) border-2"
							style={{ backgroundImage: rampGradient(palette.ramps[value]) }}
						/>
						<span>{VIEW_SCALE[value][1]}</span>
					</div>
				</div>
			)}
		</div>
	);
}

const ZOOM_BUTTON =
	"grid size-10 place-items-center rounded-xl text-(--gk-ink) transition-colors hover:bg-(--gk-plate-sunk)";

/** Zoom in, zoom out and fit, stacked like a map's controls. */
export function ZoomControls({
	onFit,
	onZoom,
}: {
	onFit: () => void;
	onZoom: (factor: number) => void;
}) {
	return (
		<fieldset
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex flex-col items-center gap-0.5 p-1"
			)}
		>
			<legend className="sr-only">Camera</legend>
			<button
				aria-label="Zoom in"
				className={cn(ZOOM_BUTTON, GAME_FOCUS)}
				onClick={() => onZoom(1.3)}
				title="Zoom in"
				type="button"
			>
				<Plus aria-hidden="true" className="size-5" strokeWidth={2.75} />
			</button>
			<button
				aria-label="Zoom out"
				className={cn(ZOOM_BUTTON, GAME_FOCUS)}
				onClick={() => onZoom(1 / 1.3)}
				title="Zoom out"
				type="button"
			>
				<Minus aria-hidden="true" className="size-5" strokeWidth={2.75} />
			</button>
			<button
				aria-label="Fit the town to the view"
				className={cn(ZOOM_BUTTON, GAME_FOCUS)}
				onClick={onFit}
				title="Fit the town to the view"
				type="button"
			>
				<Maximize aria-hidden="true" className="size-4" strokeWidth={2.75} />
			</button>
		</fieldset>
	);
}
