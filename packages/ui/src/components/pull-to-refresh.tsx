import { RefreshCw } from "lucide-react";
import type {
	CSSProperties,
	ReactNode,
	PointerEvent as ReactPointerEvent,
	Ref,
	UIEvent,
} from "react";
import { useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import drawingStyles from "./pull-to-refresh.drawing.module.css";

interface PullSurfaceStyle extends CSSProperties {
	"--pull-to-refresh-1-touch-action"?: CSSProperties["touchAction"];
}
interface PullIndicatorStyle extends CSSProperties {
	"--pull-to-refresh-2-opacity"?: CSSProperties["opacity"];
	"--pull-to-refresh-2-transform"?: CSSProperties["transform"];
}
interface PullContentStyle extends CSSProperties {
	"--pull-to-refresh-3-transform"?: CSSProperties["transform"];
	"--pull-to-refresh-3-transition"?: CSSProperties["transition"];
}

const THRESHOLD = 72;
const MAX_PULL = 112;
const INTERACTIVE_TARGETS = [
	"a[href]",
	"area[href]",
	"button",
	"input",
	"select",
	"textarea",
	"summary",
	"[contenteditable]:not([contenteditable='false'])",
	"[role='button']",
	"[role='checkbox']",
	"[role='link']",
	"[role='menuitem']",
	"[role='menuitemcheckbox']",
	"[role='menuitemradio']",
	"[role='option']",
	"[role='radio']",
	"[role='switch']",
	"[role='tab']",
	"[tabindex]:not([tabindex='-1'])",
	"[data-pull-to-refresh-ignore]",
].join(",");

function isInteractiveTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element && target.closest(INTERACTIVE_TARGETS) !== null
	);
}

/** A small, dependency-free pull gesture for scrollable data surfaces. */
export function PullToRefresh({
	children,
	onRefresh,
	className,
	ariaLabel = "Pull to refresh",
	refreshLabel = "Refresh list",
	edgeFade = false,
	onScroll,
	scrollRef,
}: {
	children: ReactNode;
	onRefresh: () => void | Promise<void>;
	className?: string;
	ariaLabel?: string;
	/**
	 * Name of the built-in refresh button. The pull gesture has no keyboard or
	 * single-pointer equivalent, so a real button (revealed on keyboard focus)
	 * runs the same refresh (WCAG 2.1.1 / 2.5.7).
	 */
	refreshLabel?: string;
	/**
	 * Fade the top/bottom edges while content is scrolled past them. The
	 * `scroll-fade` mask is driven by this element's own scroll timeline, so it
	 * must sit on the scroller itself, never on a wrapper.
	 */
	edgeFade?: boolean;
	onScroll?: (event: UIEvent<HTMLDivElement>) => void;
	scrollRef?: Ref<HTMLDivElement>;
}) {
	const [pull, setPull] = useState(0);
	const [refreshing, setRefreshing] = useState(false);
	const start = useRef<number | null>(null);
	const active = useRef(false);

	const runRefresh = async () => {
		setRefreshing(true);
		try {
			await onRefresh();
		} finally {
			setRefreshing(false);
		}
	};

	const finish = async () => {
		const shouldRefresh = pull >= THRESHOLD;
		setPull(0);
		active.current = false;
		if (!shouldRefresh) {
			return;
		}
		await runRefresh();
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (
			event.currentTarget.scrollTop !== 0 ||
			refreshing ||
			isInteractiveTarget(event.target)
		) {
			return;
		}
		start.current = event.clientY;
		active.current = true;
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!active.current || start.current === null) {
			return;
		}
		const distance = event.clientY - start.current;
		if (distance <= 0) {
			return;
		}
		event.preventDefault();
		setPull(Math.min(MAX_PULL, distance * 0.48));
	};

	const pullSurfaceStyle: PullSurfaceStyle = {
		"--pull-to-refresh-1-touch-action": pull > 0 ? "none" : "pan-y",
	};
	const pullIndicatorStyle: PullIndicatorStyle = {
		"--pull-to-refresh-2-opacity": pull > 4 || refreshing ? 1 : 0,
		"--pull-to-refresh-2-transform": `translateY(${pull - 28}px)`,
	};
	const pullContentStyle: PullContentStyle = {
		"--pull-to-refresh-3-transform": `translateY(${pull}px)`,
		"--pull-to-refresh-3-transition": active.current
			? "none"
			: "transform 220ms cubic-bezier(.22,1,.36,1)",
	};
	return (
		<div
			aria-label={ariaLabel}
			className={cn(
				cn("relative overflow-y-auto", edgeFade && "scroll-fade", className),
				drawingStyles.pullSurface
			)}
			onPointerCancel={() => {
				active.current = false;
				setPull(0);
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={() => {
				void finish();
			}}
			onScroll={onScroll}
			ref={scrollRef}
			style={pullSurfaceStyle}
		>
			<div className="pointer-events-none sticky top-0 z-20 flex h-0 justify-center overflow-visible">
				<button
					className="type-compact sr-only rounded-full bg-background px-2 py-1 text-foreground shadow-sm focus-visible:not-sr-only focus-visible:pointer-events-auto focus-visible:mt-1"
					disabled={refreshing}
					onClick={() => {
						void runRefresh();
					}}
					type="button"
				>
					{refreshLabel}
				</button>
				<div
					className={cn(
						"type-compact flex items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-muted-foreground shadow-sm transition-opacity",
						drawingStyles.pullIndicator
					)}
					style={pullIndicatorStyle}
				>
					<RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
					{refreshing
						? "Refreshing…"
						: pull >= THRESHOLD
							? "Release to refresh"
							: "Pull to refresh"}
				</div>
			</div>
			<div className={drawingStyles.pullContent} style={pullContentStyle}>
				{children}
			</div>
		</div>
	);
}
