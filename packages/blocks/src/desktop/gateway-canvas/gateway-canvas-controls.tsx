"use client";

import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { Panel, useReactFlow } from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	type CanvasView,
	FIT_VIEW_OPTIONS,
	META,
	NARROW_WIDTH,
	OVERLAY,
} from "./gateway-canvas-constants.ts";
import type { CanvasLiveStore } from "./live-store.ts";
import { type CanvasFeedState, formatCount } from "./model.ts";

const FEED_LABEL: Record<CanvasFeedState["status"], string> = {
	aggregated: "Per-minute totals",
	connecting: "Connecting",
	denied: "No access to live traffic",
	live: "Live",
	off: "No live feed",
	unavailable: "Feed unavailable",
};

export function FeedStatus({
	feed,
	store,
}: {
	feed: CanvasFeedState;
	store: CanvasLiveStore;
}) {
	const totals = useSyncExternalStore(
		store.subscribe,
		store.totals,
		store.totals
	);
	const live = feed.status === "live";
	const parts = [feed.message ?? FEED_LABEL[feed.status]];
	if (live || totals.requests > 0) {
		if (live) {
			parts.push(
				`${totals.perSecond.toFixed(totals.perSecond < 10 ? 1 : 0)}/s`
			);
		}
		parts.push(`${formatCount(totals.requests)} requests`);
		parts.push(`${formatCount(totals.blocked)} blocked`);
	}
	return (
		<p
			aria-live="off"
			className={cn(
				"flex min-w-0 items-center gap-1.5 truncate px-2 tabular-nums",
				META
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					live ? "bg-success" : "bg-muted-foreground/50"
				)}
			/>
			<span className="truncate">{parts.join(" · ")}</span>
		</p>
	);
}

export function ViewSwitch({
	onChange,
	view,
}: {
	onChange: (view: CanvasView) => void;
	view: CanvasView;
}) {
	return (
		<fieldset aria-label="View" className="flex items-center gap-0.5">
			{(["map", "table"] as const).map((option) => (
				<Button
					aria-pressed={view === option}
					className={cn(
						"h-7 px-2 text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
						META
					)}
					key={option}
					onClick={() => onChange(option)}
					size="xs"
					type="button"
					variant="ghost"
				>
					{option === "map" ? "Map" : "Table"}
				</Button>
			))}
		</fieldset>
	);
}

export function ZoomControls({ duration }: { duration: number }) {
	const flow = useReactFlow();
	return (
		<Panel position="bottom-left">
			<fieldset aria-label="Zoom" className={OVERLAY}>
				<Button
					aria-label="Zoom out"
					className="size-7 text-muted-foreground"
					onClick={() => flow.zoomOut({ duration })}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Minus aria-hidden="true" className="size-4" />
				</Button>
				<Button
					aria-label="Zoom in"
					className="size-7 text-muted-foreground"
					onClick={() => flow.zoomIn({ duration })}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Plus aria-hidden="true" className="size-4" />
				</Button>
				<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
				<Button
					aria-label="Fit map to view"
					className="size-7 text-muted-foreground"
					onClick={() => flow.fitView({ ...FIT_VIEW_OPTIONS, duration })}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Maximize aria-hidden="true" className="size-4" />
				</Button>
			</fieldset>
		</Panel>
	);
}

/** Tracks whether the canvas is narrower than {@link NARROW_WIDTH}. */
export function useNarrow(
	ref: React.RefObject<HTMLElement | null>
): boolean | null {
	const [narrow, setNarrow] = useState<boolean | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () =>
			setNarrow(element.getBoundingClientRect().width < NARROW_WIDTH);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return narrow;
}
