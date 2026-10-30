// apps/desktop/src/components/shell/TrayPopover.tsx
//
// Shared chrome for the sidebar-footer tray panels (Inbox, Downloads). Both hang
// a TrayMorph off a 28px icon button: a circle that morphs open into the tray
// box (`.t-morph` / `.t-morph-menu` in globals.css) over the button rather than
// spawning a popover beside it — the same motion the sidebar "+" CreateMenu
// uses. Unlike CreateMenu the box is portaled out of the sidebar (see
// TrayMorph): the tray is wider than the sidebar, and two of the sidebar's
// hosts clip it flat at the sidebar's width. The two trays share one set of
// headers, rows, empty states, and the "open the full page" footer here.
//
// Design rules the two trays obey, so they read as one component:
//   * One row grid, always: 28px glyph · title + one meta line · action slot.
//     Rows are inset cards (radius concentric with the panel: 20px panel − 6px
//     padding = 14px row), never full-bleed `divide-y` slabs.
//   * One meta line, dot-separated and truncated. Timestamps, sizes, speeds and
//     risk tags all live there — nothing gets its own stacked line, so every row
//     is the same height and the list scans as a column.
//   * Actions are labelled pills: the affirmative one is a filled default (or
//     success) chip, the rest are icon ghosts in a fixed-width slot (so hover
//     never reflows the row). Nothing that decides something is hover-only.
//   * Tone is carried by the glyph and the meta text, never by tinted row
//     backgrounds — a list of red-washed tiles reads as an error state.

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { PullToRefresh } from "@ryu/ui/components/pull-to-refresh.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import layoutStyles from "./TrayPopover.module.css";
import type { LayoutCssVariables } from "./tray/tray-morph.tsx";
import { ROW_RADIUS } from "./tray/tray-rows.tsx";

export type {
	TrayPlacement,
	TrayTriggerRenderProps,
} from "./tray/tray-morph.tsx";
export { TrayMorph, trayTriggerClass } from "./tray/tray-morph.tsx";
export type { TrayTone } from "./tray/tray-rows.tsx";
export {
	TrayAction,
	TrayBadge,
	TrayIconAction,
	TrayRow,
	TrayRowIcon,
	trayMeta,
} from "./tray/tray-rows.tsx";

/**
 * Panel header: title + count on the left, quiet text actions on the right, and
 * an optional status line underneath (the downloads aggregate lives there, so
 * the tray answers "how long?" without spending a whole strip on it).
 */
export function TrayHeader({
	actions,
	count,
	status,
	title,
}: {
	actions?: ReactNode;
	count?: number;
	status?: ReactNode;
	title: string;
}) {
	return (
		<div className="flex items-start gap-2 px-2 pt-1.5 pb-2">
			<div className="flex min-w-0 flex-col gap-0.5">
				<div className="flex items-center gap-1.5">
					<span className="text-(length:--text-detail) font-medium">
						{title}
					</span>
					{count !== undefined && count > 0 && (
						<span className="text-muted-foreground/70 text-xs tabular-nums">
							{count}
						</span>
					)}
				</div>
				{status && (
					<span className="truncate text-muted-foreground text-xs tabular-nums">
						{status}
					</span>
				)}
			</div>
			{actions && (
				<div className="-mr-1 ml-auto flex shrink-0 items-center gap-0.5">
					{actions}
				</div>
			)}
		</div>
	);
}

/** Quiet text button for the header/section action slots. */
export function TrayTextButton({
	children,
	disabled,
	onClick,
	tone = "default",
}: {
	children: ReactNode;
	disabled?: boolean;
	onClick: () => void;
	tone?: "default" | "primary";
}) {
	return (
		<button
			className={cn(
				"rounded-lg px-1.5 py-1 font-medium text-xs transition-colors disabled:opacity-50",
				tone === "primary"
					? "text-primary hover:bg-primary/10"
					: "text-muted-foreground hover:bg-muted hover:text-foreground"
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/** How long the tray Refresh reads "Refreshing…" at minimum. */
const TRAY_MIN_REFRESH_MS = 600;

/**
 * Visible Refresh for a tray header. The pull gesture in `TrayScroll` has no
 * keyboard or single-pointer equivalent on its own (WCAG 2.1.1 / 2.5.7), so
 * every panel that offers pull-to-refresh also shows this control. It reads
 * "Refreshing…" and stays disabled while the refresh is in flight.
 */
export function TrayRefreshButton({ onRefresh }: { onRefresh: () => unknown }) {
	const [refreshing, setRefreshing] = useState(false);
	return (
		<TrayTextButton
			disabled={refreshing}
			onClick={() => {
				setRefreshing(true);
				// A floor on the feedback (as on the Downloads page), never a delay
				// on the data: an instant refetch still reads as an action.
				const floor = new Promise((resolve) => {
					setTimeout(resolve, TRAY_MIN_REFRESH_MS);
				});
				Promise.all([Promise.resolve().then(onRefresh), floor])
					.catch(() => undefined)
					.finally(() => setRefreshing(false));
			}}
		>
			{refreshing ? "Refreshing…" : "Refresh"}
		</TrayTextButton>
	);
}

/** Full-bleed hairline that ignores the panel's inset padding. */
export function TrayDivider({ className }: { className?: string }) {
	return <div className={cn("my-1 h-px bg-border", className)} />;
}

/**
 * Full-bleed activity line under the header. `percent === null` sweeps the
 * marquee band (same treatment the Progress primitive uses for unknown sizes).
 */
export function TrayProgressLine({ percent }: { percent: number | null }) {
	const cssVariables2: LayoutCssVariables = {
		"--desktop-inline4-width": `${percent}%`,
	};
	return (
		<div className="relative mt-0.5 mb-1 h-0.5 overflow-hidden bg-border">
			{percent === null ? (
				<span className="t-progress-marquee" />
			) : (
				<div
					className={cn(
						cn(
							"h-full bg-primary/70 duration-500 ease-out",
							layoutStyles.authored3
						),
						layoutStyles.inline4
					)}
					style={cssVariables2}
				/>
			)}
		</div>
	);
}

/**
 * Group heading inside the scroller. Sentence case at 11px rather than 10px
 * caps: at tray size the tracked uppercase read as noise between the rows.
 */
export function TraySectionLabel({
	children,
	count,
	trailing,
}: {
	children: ReactNode;
	count?: number;
	trailing?: ReactNode;
}) {
	return (
		<div className="flex h-7 items-center gap-1.5 px-2 pt-1">
			<span className="text-muted-foreground text-xs">{children}</span>
			{count !== undefined && count > 0 && (
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					{count}
				</span>
			)}
			{trailing && (
				<div className="-mr-1 ml-auto flex items-center">{trailing}</div>
			)}
		</div>
	);
}

/**
 * Scrolling body. The fade is a mask driven by actual scroll position, so a
 * short list is never clipped and the last row of a long one doesn't sit under
 * a permanent grey smear (a gradient painted over glass, as before, dirtied the
 * panel rather than suggesting depth).
 */
export function TrayScroll({
	children,
	className,
	onRefresh,
}: {
	children: ReactNode;
	className?: string;
	onRefresh?: () => void | Promise<void>;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [fade, setFade] = useState({ bottom: false, top: false });

	const measure = useCallback(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		const overflow = el.scrollHeight - el.clientHeight;
		setFade({
			bottom: overflow > 1 && el.scrollTop < overflow - 1,
			top: el.scrollTop > 1,
		});
	}, []);

	useEffect(() => {
		measure();
		const el = ref.current;
		if (!(el && "ResizeObserver" in globalThis)) {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		for (const child of Array.from(el.children)) {
			observer.observe(child);
		}
		return () => observer.disconnect();
	}, [measure]);

	let mask: string | undefined;
	if (fade.top && fade.bottom) {
		mask =
			"linear-gradient(to bottom, transparent 0, black 1.25rem, black calc(100% - 1.25rem), transparent 100%)";
	} else if (fade.bottom) {
		mask =
			"linear-gradient(to bottom, black calc(100% - 1.25rem), transparent 100%)";
	} else if (fade.top) {
		mask = "linear-gradient(to bottom, transparent 0, black 1.25rem)";
	}

	const cssVariables4: LayoutCssVariables = {
		"--desktop-inline6-mask-Image": mask,
		"--desktop-inline6--Webkit-Mask-Image": mask,
	};
	const content = (
		<div
			className={cn(
				cn(
					"flex max-h-[20rem] flex-col overscroll-contain [scrollbar-width:thin]",
					className
				),
				layoutStyles.inline6
			)}
			onScroll={measure}
			ref={ref}
			style={mask ? cssVariables4 : undefined}
		>
			{children}
		</div>
	);

	return onRefresh ? (
		<PullToRefresh
			ariaLabel="Refresh tray"
			className={cn("max-h-[20rem] [scrollbar-width:thin]", className)}
			onRefresh={onRefresh}
			onScroll={measure}
			scrollRef={ref}
		>
			{content}
		</PullToRefresh>
	) : (
		content
	);
}

/** Centred nothing-here state, sized for a popover rather than a page. */
export function TrayEmpty({
	description,
	icon,
	title,
}: {
	description: string;
	icon: IconSvgElement;
	title: string;
}) {
	return (
		<div className="flex flex-col items-center gap-2 px-8 py-12 text-center">
			<HugeiconsIcon
				className="size-5 text-muted-foreground"
				icon={icon}
				size={20}
			/>
			<span className="font-medium text-sm">{title}</span>
			<p className="text-(length:--text-detail) text-pretty text-muted-foreground leading-(--text-detail--line-height)">
				{description}
			</p>
		</div>
	);
}

/** The "open the full page" action pinned under every tray. */
export function TrayFooter({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"flex h-8 w-full items-center gap-2 px-2 text-muted-foreground text-xs transition-colors duration-150 hover:bg-muted hover:text-foreground hover:duration-0",
				ROW_RADIUS
			)}
			onClick={onClick}
			type="button"
		>
			<span>{label}</span>
			<HugeiconsIcon
				className="ml-auto size-3.5"
				icon={ArrowUpRight01Icon}
				size={14}
			/>
		</button>
	);
}
