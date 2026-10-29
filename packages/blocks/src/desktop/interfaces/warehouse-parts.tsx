import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type LucideIcon,
	Package,
	PackageOpen,
	TriangleAlert,
	Truck,
} from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import {
	type FloorStats,
	type OrderStage,
	type OrderTab,
	stageLabel,
} from "./warehouse-model.ts";
import { PAPER_SHEET } from "./warehouse-palette.ts";

/**
 * True under the act layer: stage names follow the acts ("Stopped" for a
 * counted stopped run) and no age is read from `updatedAt` (spec 5.2).
 */
export const WarehouseActsContext = createContext(false);

const PILL_TONE: Record<OrderStage, string> = {
	exception: "bg-destructive/12 text-status-destructive",
	// In progress, two hues so the pipeline reads at a glance: Picking is
	// work in the aisles (info), Packing is nearly out the door (success).
	packing: "bg-success/14 text-status-success",
	// Sitting out a limit: still unfulfilled, waiting on the clock.
	parked: "bg-warning/10 text-foreground/80 ring-1 ring-border ring-inset",
	picking: "bg-info/12 text-status-info",
	// Waiting on you: a soft fill with the glyph carrying the colour, so the
	// rows that need you stand out without turning the table amber.
	ready: "bg-warning/14 text-foreground [&>svg]:text-status-warning",
	// Not started yet: an outline, where Shipped (done) is a solid fill.
	received: "text-foreground/75 ring-1 ring-border ring-inset",
	shipped: "bg-muted text-foreground/70",
	// An older failure that no longer counts: muted, not an alarm.
	stale: "text-muted-foreground ring-1 ring-border ring-inset",
};

/**
 * How far along an order is, as a ring that fills by stage (the way order
 * tools mark partial fulfillment). Exceptions get a struck ring instead.
 */
export function StageGlyph({
	className,
	stage,
}: {
	className?: string;
	stage: OrderStage;
}) {
	const fill: Record<OrderStage, number> = {
		exception: 0,
		packing: 0.75,
		parked: 0.5,
		picking: 0.5,
		ready: 0.9,
		received: 0.25,
		shipped: 1,
		stale: 0,
	};
	const r = 4;
	const circumference = 2 * Math.PI * r;
	return (
		<svg
			aria-hidden="true"
			className={cn("size-3 shrink-0", className)}
			fill="none"
			viewBox="0 0 12 12"
		>
			<circle
				cx={6}
				cy={6}
				r={5}
				stroke="currentColor"
				strokeDasharray={stage === "received" ? "1.6 1.6" : undefined}
				strokeWidth={1.25}
			/>
			{stage === "exception" ? (
				<path
					d="M3.5 3.5l5 5"
					stroke="currentColor"
					strokeLinecap="round"
					strokeWidth={1.5}
				/>
			) : (
				<circle
					cx={6}
					cy={6}
					r={r / 2}
					stroke="currentColor"
					strokeDasharray={`${(circumference / 2) * fill[stage]} ${circumference}`}
					strokeWidth={r}
					transform="rotate(-90 6 6)"
				/>
			)}
		</svg>
	);
}

/**
 * The order's fulfillment stage, as a compact status pill, or (`stamp`) as
 * an inked rubber stamp on the order sheet.
 */
export function StagePill({
	className,
	stage,
	stamp = false,
}: {
	className?: string;
	stage: OrderStage;
	stamp?: boolean;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full ps-1.5 pe-2 font-medium text-xs",
				PILL_TONE[stage],
				stamp &&
					"-rotate-2 gap-0.5 rounded-[3px] border-2 border-current bg-transparent ps-1 pe-1 font-bold text-[9px] uppercase tracking-wide ring-0",
				className
			)}
			data-stage={stage}
		>
			<StageGlyph stage={stage} />
			{stageLabel(stage, useContext(WarehouseActsContext))}
		</span>
	);
}

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters =
		words.length > 1
			? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
			: name.trim().slice(0, 1);
	return letters.toUpperCase();
}

/**
 * A fulfiller's picture, else their initials on a quiet disc: at row size a
 * name's letters hold their shape where generative art turns to noise.
 */
export function FulfillerAvatar({
	agent,
	className,
}: {
	agent: InterfaceAgent;
	className?: string;
}) {
	return (
		<Avatar aria-hidden="true" className={cn("size-5", className)}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback className="font-medium text-[10px] text-foreground/80">
				{initials(agent.name)}
			</AvatarFallback>
		</Avatar>
	);
}

/** An agent as a fulfiller: face and name, or "Unassigned". */
export function Fulfiller({
	agent,
	className,
	size = 20,
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
	/** Avatar size in px. */
	size?: 16 | 20;
}) {
	const avatar = size === 16 ? "size-4" : "size-5";
	if (!agent) {
		return (
			<span
				className={cn(
					"inline-flex min-w-0 items-center gap-2 text-muted-foreground text-sm",
					className
				)}
			>
				<span
					aria-hidden="true"
					className={cn(
						avatar,
						"shrink-0 rounded-full border border-muted-foreground/50 border-dashed"
					)}
				/>
				<span className="truncate">Unassigned</span>
			</span>
		);
	}
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-2 text-foreground text-sm",
				className
			)}
		>
			<FulfillerAvatar agent={agent} className={avatar} />
			<span className="truncate">{agent.name}</span>
		</span>
	);
}

const STAT_CELLS: readonly {
	hint?: string;
	icon: LucideIcon;
	key: keyof FloorStats;
	label: string;
	/** The tab listing exactly these orders; absent when no tab does. */
	tab?: OrderTab;
}[] = [
	{
		hint: "Orders with activity since midnight",
		icon: Package,
		key: "today",
		label: "Updated today",
	},
	{
		icon: PackageOpen,
		key: "unfulfilled",
		label: "Unfulfilled",
		tab: "unfulfilled",
	},
	{ icon: Truck, key: "ready", label: "Ready to ship", tab: "ready" },
	{
		icon: TriangleAlert,
		key: "exceptions",
		label: "Exceptions",
		tab: "exceptions",
	},
];

/** Each stat's icon tile: the kit's tones, red only when exceptions exist. */
const STAT_TONE: Record<keyof FloorStats, (alert: boolean) => string> = {
	exceptions: (alert) =>
		alert
			? "bg-(--gk-bad) text-white"
			: "bg-(--gk-plate-sunk) text-(--gk-ink-muted)",
	ready: () => "bg-(--gk-good) text-white",
	today: () => "bg-(--gk-accent) text-(--gk-accent-ink)",
	total: () => "bg-(--gk-accent) text-(--gk-accent-ink)",
	unfulfilled: () => "bg-(--gk-info) text-white",
};

/**
 * The floor's numbers for the shift. A figure that a tab lists exactly is a
 * shortcut to that tab; the rest are read-only.
 */
export function StatsStrip({
	activeTab,
	compact,
	loading,
	onPick,
	stats,
}: {
	activeTab: OrderTab;
	compact: boolean;
	loading: boolean;
	onPick: (tab: OrderTab) => void;
	stats: FloorStats;
}) {
	const acts = useContext(WarehouseActsContext);
	const tl = useLiteralMessages();
	return (
		<ul
			aria-label="Floor stats"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex items-stretch divide-x-2 divide-(--gk-plate-sunk) overflow-hidden"
			)}
		>
			{STAT_CELLS.map((cell) => {
				// With acts no figure comes from `updatedAt`: "Updated today"
				// becomes every order on the clipboard.
				const actsToday = acts && cell.key === "today";
				const value = actsToday ? stats.total : stats[cell.key];
				let label = cell.label;
				if (acts && cell.key === "exceptions") {
					label = "Stopped";
				} else if (actsToday) {
					label = "Orders";
				}
				const hint = actsToday ? "Every order on the clipboard" : cell.hint;
				const alert = cell.key === "exceptions" && value > 0;
				// A grid so the label comes first in the DOM (screen readers read
				// it before the figure) while the figure shows on top beside the
				// icon tile.
				const cellClass = cn(
					"grid h-full grid-cols-[auto_auto] content-center items-center justify-start text-start",
					compact ? "gap-x-1.5 px-2 py-1.5" : "gap-x-2.5 py-2 ps-2.5 pe-4"
				);
				const figureClass = cn(
					"col-start-2 row-start-1",
					compact && "row-span-2"
				);
				const body = (
					<>
						<span
							className={cn(
								"col-start-2 row-start-2 whitespace-nowrap font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide",
								compact && "sr-only"
							)}
						>
							{label}
						</span>
						<span
							aria-hidden="true"
							className={cn(
								"col-start-1 row-span-2 row-start-1 grid shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2",
								compact ? "size-7 [&_svg]:size-4" : "size-10 [&_svg]:size-5",
								STAT_TONE[cell.key](alert)
							)}
						>
							<cell.icon strokeWidth={2.5} />
						</span>
						{loading ? (
							<Skeleton className={cn("h-6 w-8", figureClass)} radius="dense" />
						) : (
							<span
								className={cn(
									"gk-display whitespace-nowrap tabular-nums",
									compact ? "text-[18px] leading-6" : "text-[26px] leading-7",
									figureClass
								)}
							>
								{value}
							</span>
						)}
						{hint ? <span className="sr-only">{hint}</span> : null}
					</>
				);
				const { tab } = cell;
				return (
					<li className="min-w-0" key={cell.key}>
						{tab ? (
							<button
								aria-pressed={activeTab === tab}
								className={cn(
									cellClass,
									"transition-colors hover:bg-(--gk-plate-sunk) disabled:pointer-events-none aria-pressed:bg-(--gk-plate-sunk)",
									GAME_FOCUS
								)}
								disabled={loading}
								onClick={() => onPick(tab)}
								title={tl("Show {label}", { label: label.toLowerCase() })}
								type="button"
							>
								{body}
							</button>
						) : (
							<div className={cellClass} title={hint}>
								{body}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The orders' clipboard: a board in the game kit's frame with a metal clip at
 * the top, holding the theme's paper (the orders list, an order, or the
 * conversation) so the list reads as part of the floor, not office chrome.
 */
export function Clipboard({
	children,
	label,
	view,
}: {
	children: ReactNode;
	label: string;
	view: string;
}) {
	return (
		<aside
			aria-label={label}
			className="relative flex size-full min-h-0 flex-col rounded-[22px] border-(--gk-edge) border-2 bg-(--wh-box) pt-5 shadow-(--gk-lip)"
			data-view={view}
		>
			<span
				aria-hidden="true"
				className="absolute -top-3 left-1/2 flex h-8 w-32 -translate-x-1/2 items-center justify-center rounded-lg border-(--gk-edge) border-2 bg-(--wh-cab) shadow-[0_2px_0_var(--gk-edge)]"
			>
				<span className="h-2 w-12 rounded-full border-(--gk-edge) border-2 bg-(--wh-cab-r)" />
			</span>
			<div
				className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border-(--gk-edge) border-2 bg-background text-foreground"
				style={view === "thread" ? undefined : PAPER_SHEET}
			>
				{children}
			</div>
		</aside>
	);
}
