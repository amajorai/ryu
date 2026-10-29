import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import {
	FoldHorizontal,
	Minus,
	Plus,
	Scan,
	SquarePen,
	UnfoldHorizontal,
	Waypoints,
} from "lucide-react";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { type MindmapStats, plural } from "./mindmap-model.ts";
import { MINDMAP_TOOLTIP_KBD } from "./mindmap-panel.tsx";

/** The map's title bar: what it holds, and a way to start a thread. */
export function MindmapHeader({
	onStart,
	stats,
}: {
	onStart: () => void;
	stats: MindmapStats;
}) {
	const tl = useLiteralMessages();
	return (
		<header className="flex h-14 shrink-0 items-center gap-4 border-border border-b pr-3 pl-4">
			<div className="flex min-w-0 flex-1 items-baseline gap-3">
				<h2 className="shrink-0 font-semibold text-base text-foreground leading-6">
					Mind map
				</h2>
				<p className="@max-[519px]:hidden truncate text-[13px] text-muted-foreground tabular-nums leading-5">
					{plural(stats.agents, "agent")} · {plural(stats.threads, "thread")}
					{stats.needYou > 0 ? (
						<>
							{" · "}
							<span className="font-medium text-foreground">
								{tl("{needYou} need you", { needYou: stats.needYou })}
							</span>
						</>
					) : null}
					{stats.working > 0
						? tl(" · {working} working", { working: stats.working })
						: null}
				</p>
			</div>
			<Button onClick={onStart} size="sm" type="button" variant="outline">
				<SquarePen aria-hidden="true" data-icon="inline-start" />
				New thread
			</Button>
		</header>
	);
}

const LEGEND = ["attention", "your-turn", "working"] as const;

/** The three marks a leaf can carry, so the dots never need a guess. */
export function MindmapLegend() {
	return (
		<ul
			aria-label="Thread marks"
			className="pointer-events-none absolute bottom-4 left-4 z-10 flex @max-[719px]:hidden items-center gap-4 text-[13px] text-muted-foreground leading-5"
		>
			{LEGEND.map((status) => (
				<li className="flex items-center gap-1.5" key={status}>
					<BoardStatusDot status={status} />
					{THREAD_STATUS_LABELS[status]}
				</li>
			))}
		</ul>
	);
}

function ControlButton({
	children,
	label,
	onClick,
	shortcut,
}: {
	children: ReactNode;
	label: string;
	onClick: () => void;
	shortcut: string[];
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost-muted"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="top">
				{label}
				<KbdGroup>
					{shortcut.map((key) => (
						<Kbd className={MINDMAP_TOOLTIP_KBD} key={key}>
							{key}
						</Kbd>
					))}
				</KbdGroup>
			</TooltipContent>
		</Tooltip>
	);
}

/** Zoom, fit, and fold-all, docked bottom right like a canvas tool. */
export function MindmapControls({
	allFolded,
	modKey,
	onFit,
	onResetZoom,
	onToggleAll,
	onZoomIn,
	onZoomOut,
	zoom,
}: {
	allFolded: boolean;
	modKey: string;
	onFit: () => void;
	onResetZoom: () => void;
	onToggleAll: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			aria-label="Map view"
			className="absolute right-4 bottom-4 z-10 flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5 shadow-xs"
			role="toolbar"
		>
			<ControlButton
				label={allFolded ? "Expand all" : "Collapse all"}
				onClick={onToggleAll}
				shortcut={["Alt", "."]}
			>
				{allFolded ? (
					<UnfoldHorizontal aria-hidden="true" />
				) : (
					<FoldHorizontal aria-hidden="true" />
				)}
			</ControlButton>
			<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
			<ControlButton
				label="Zoom out"
				onClick={onZoomOut}
				shortcut={[modKey, "−"]}
			>
				<Minus aria-hidden="true" />
			</ControlButton>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-label={tl("Zoom {zoomPercent}%, reset to 100%", {
								zoomPercent: String(Math.round(zoom * 100)),
							})}
							className="w-12 px-0 font-medium text-xs tabular-nums"
							onClick={onResetZoom}
							size="sm"
							type="button"
							variant="ghost-muted"
						/>
					}
				>
					{`${Math.round(zoom * 100)}%`}
				</TooltipTrigger>
				<TooltipContent side="top">
					Reset to 100%
					<KbdGroup>
						<Kbd className={MINDMAP_TOOLTIP_KBD}>{modKey}</Kbd>
						<Kbd className={MINDMAP_TOOLTIP_KBD}>0</Kbd>
					</KbdGroup>
				</TooltipContent>
			</Tooltip>
			<ControlButton
				label="Zoom in"
				onClick={onZoomIn}
				shortcut={[modKey, "+"]}
			>
				<Plus aria-hidden="true" />
			</ControlButton>
			<ControlButton
				label="Fit to screen"
				onClick={onFit}
				shortcut={["Shift", "1"]}
			>
				<Scan aria-hidden="true" />
			</ControlButton>
		</div>
	);
}

/** A neutral sketch of a map while the first snapshot loads. */
export function MindmapLoading() {
	const rows = [
		{ side: "left", top: "30%", width: "w-28" },
		{ side: "left", top: "62%", width: "w-20" },
		{ side: "right", top: "24%", width: "w-24" },
		{ side: "right", top: "50%", width: "w-32" },
		{ side: "right", top: "74%", width: "w-20" },
	] as const;
	return (
		<div
			aria-busy="true"
			aria-label="Loading the mind map"
			className="relative size-full overflow-hidden bg-background"
			data-testid="interface-mindmap"
			role="status"
		>
			<div aria-hidden="true" className="absolute inset-0">
				<Skeleton className="absolute top-1/2 left-1/2 h-11 w-20 -translate-x-1/2 -translate-y-1/2 rounded-xl" />
				{rows.map((row) => (
					<Skeleton
						className={cn(
							"absolute h-4 rounded-sm",
							row.width,
							row.side === "left" ? "right-[62%]" : "left-[62%]"
						)}
						key={`${row.side}-${row.top}`}
						style={{ top: row.top }}
					/>
				))}
			</div>
			<span className="sr-only">Loading the mind map…</span>
		</div>
	);
}

/** No agents and no threads: say what the map will show and offer a start. */
export function MindmapEmpty({ onStart }: { onStart: () => void }) {
	return (
		<Empty className="m-auto max-w-sm">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Waypoints aria-hidden="true" />
				</EmptyMedia>
				<EmptyTitle>Nothing on the map yet</EmptyTitle>
				<EmptyDescription>
					Your projects, teams, and agents branch out from you here, with each
					thread as a leaf.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onStart} type="button">
					<SquarePen aria-hidden="true" data-icon="inline-start" />
					New thread
				</Button>
			</EmptyContent>
		</Empty>
	);
}
