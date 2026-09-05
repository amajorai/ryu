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
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type CSSProperties,
	type ReactElement,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

export type TrayTone = "default" | "danger" | "success" | "primary";

export interface TrayTriggerRenderProps {
	"aria-controls": string;
	"aria-expanded": boolean;
	"aria-haspopup": true;
	"aria-label": string;
	onClick: () => void;
	ref: RefObject<HTMLButtonElement | null>;
}

/** The 28px footer icon button both trays hang off. */
export const trayTriggerClass =
	"relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/** Row radius, concentric with the panel (20px panel − 6px padding). */
const ROW_RADIUS = "rounded-[14px]";

/** The morph's open width — the fixed tray width both trays were laid out at. */
const TRAY_MORPH_OPEN_W = "23rem";
/**
 * The morph's open height is measured, not declared, so this is only the value
 * shown until the always-mounted panel is measured. The CreateMenu comment that
 * says the open box "has to be declared, not measured" is about feeding the
 * animated size back into the thing being animated (a loop); here the panel's
 * height depends only on its own content — never on the container — so measuring
 * it and writing the container's height is one-way and settles.
 */
const TRAY_MORPH_INITIAL_H = 240;
/**
 * How far the 40px box hangs past the 28px trigger slot on each pinned edge —
 * the `-bottom-1.5 -left-1.5` the box carried while it was an absolutely
 * positioned child of the slot, now applied to the portaled box's fixed
 * coordinates so it lands in exactly the same place.
 */
const MORPH_SLOT_OFFSET = 6;

/**
 * The count bubble for trays without a dedicated animated trigger. It stays
 * mounted so the transitions.dev notification-badge (03) can pop it in/out
 * rather than hard-mounting.
 */
export function TrayBadge({
	count,
	label,
	tone = "primary",
}: {
	count: number;
	/** Announced to screen readers; the number alone says nothing. */
	label: string;
	tone?: "primary" | "danger";
}) {
	const open = count > 0;
	return (
		<span
			aria-hidden={!open}
			aria-label={open ? `${count} ${label}` : undefined}
			className="t-badge -top-0.5 -right-0.5"
			data-open={open}
		>
			<span
				className={cn(
					"t-badge-dot flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-medium text-[10px] tabular-nums ring-2 ring-sidebar",
					tone === "danger"
						? "bg-destructive text-white"
						: "bg-primary text-primary-foreground"
				)}
			>
				{count > 9 ? "9+" : count}
			</span>
		</span>
	);
}

/**
 * The sidebar-footer tray morph (Inbox, Downloads): a 28px icon button that
 * grows into the tray box (`.t-morph` / `.t-morph-menu`) instead of spawning a
 * popover beside itself, like the "+" CreateMenu in the same footer. The panel
 * is always mounted (inert when closed) so its height can be measured while
 * hidden; the box grows to the measured height, so a short list hugs its rows
 * and a long one caps at the scroller's max.
 *
 * The box is PORTALED out and positioned `fixed` over the trigger's slot,
 * because the tray is 23rem — wider than the sidebar it lives in — and two of
 * the sidebar's hosts clip it flat at that width: Layout's hover-peek panel
 * (`overflow-hidden` + a transform) and, once a background is customized,
 * `html[data-ryu-bg-active] [data-slot="sidebar-inner"]` (`overflow: clip`).
 * `position: fixed` alone is not enough — the hover-peek panel also carries a
 * transform, which makes it the containing block for fixed descendants, so the
 * box has to leave the subtree entirely. (The docked sidebar clips nothing,
 * which is why this only ever looked broken on some setups.)
 *
 * The BUTTON stays in the sidebar DOM (it keeps its tab order, its tooltip, and
 * NavUser's context-menu wrapper for "Hide downloads"); only the box travels.
 * It fades out on open the way `.t-morph-plus` used to, so the panel — which
 * now sits over it rather than around it — hands off cleanly.
 */
export function TrayMorph({
	badge,
	children,
	icon,
	label,
	onOpenChange,
	open,
	renderTrigger,
}: {
	badge?: ReactNode;
	/** The tray panel body — TrayHeader, TrayScroll/TrayEmpty, TrayFooter. */
	children: ReactNode;
	icon: IconSvgElement;
	label: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	renderTrigger?: (props: TrayTriggerRenderProps) => ReactElement;
}) {
	const panelId = useId();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const [openH, setOpenH] = useState(TRAY_MORPH_INITIAL_H);
	const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
		null
	);
	const [portalTarget, setPortalTarget] = useState<Element | null>(null);

	// Close on outside pointerdown or Escape — the morph has no backdrop, and
	// there is no Base UI popover here that would own this for us. The box is
	// portaled, so "inside" is the trigger slot OR the box; testing the slot
	// alone would read every click on a row as an outside click.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			const inside =
				rootRef.current?.contains(target) || boxRef.current?.contains(target);
			if (!inside) {
				onOpenChange(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onOpenChange(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onOpenChange, open]);

	// Measure the panel one-way: the box's open height tracks the panel's
	// content height, which nothing animates, so the observer settles. Keyed on
	// `portalTarget` because the panel does not exist until the portal has one —
	// on an empty dep list this runs against a null ref on the first commit and
	// never again, which silently pins every tray to the fallback height and
	// guillotines any list taller than it.
	useEffect(() => {
		const el = panelRef.current;
		if (!el || typeof ResizeObserver === "undefined") {
			return;
		}
		const measure = () => setOpenH(el.offsetHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [portalTarget]);

	// Track where the portaled box sits: bottom-left pinned to the trigger's
	// slot, offset by the 6px the box used to hang past it (`-bottom-1.5
	// -left-1.5`). Measured on mount, on every open, and on window resize —
	// enough for a control that only moves when the window or the sidebar's own
	// layout changes, and cheaper than tracking it every frame. Layout effect, so
	// the corrected anchor lands in the same commit as the open: the hover-peek
	// sidebar mounts this while translated off-screen, so the anchor measured at
	// mount is stale by the time the panel has slid in, and a passive effect would
	// paint the first frames of the morph off the window's left edge.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) {
			return;
		}
		const measure = () => {
			const r = el.getBoundingClientRect();
			setAnchor({
				bottom: window.innerHeight - r.bottom - MORPH_SLOT_OFFSET,
				left: r.left - MORPH_SLOT_OFFSET,
			});
		};
		measure();
		// On a phone the sidebar is a modal Sheet, which does NOT clip (nothing in
		// that chain sets overflow) but does mark the rest of the body
		// `aria-hidden` while it is open. Portaling to the body there would leave
		// the tray visible and clickable but invisible to a screen reader, so the
		// Sheet's own popup is the portal target when there is one.
		setPortalTarget(el.closest('[data-slot="sheet-content"]') ?? document.body);
		window.addEventListener("resize", measure);
		// Capture: the sidebar's own scroller, not the window, is what moves the
		// footer on the surfaces where the footer scrolls.
		window.addEventListener("scroll", measure, true);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [open]);

	// Keep the popover's focus behaviour: the panel takes focus when it opens,
	// and returns it to the trigger when it closes.
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current) {
			panelRef.current?.focus();
		} else if (!open && wasOpen.current) {
			triggerRef.current?.focus();
		}
		wasOpen.current = open;
	}, [open]);

	const morphVars = {
		"--morph-open-w": TRAY_MORPH_OPEN_W,
		"--morph-open-h": `${openH}px`,
	} as CSSProperties;
	const triggerProps: TrayTriggerRenderProps = {
		"aria-controls": panelId,
		"aria-expanded": open,
		"aria-haspopup": true,
		"aria-label": label,
		onClick: () => onOpenChange(!open),
		ref: triggerRef,
	};

	return (
		<div className="relative size-7 shrink-0" ref={rootRef}>
			{/* The trigger stays here; the box below is portaled over it. It fades
			    and lifts on open (what `.t-morph-plus` did while it still wrapped the
			    button) so the icon hands off to the panel instead of showing through
			    the panel's translucent corner. */}
			<div
				className="transition-[opacity,transform] duration-200 ease-out data-[open=true]:pointer-events-none data-[open=true]:-translate-y-1 data-[open=true]:opacity-0"
				data-open={open}
			>
				<Tooltip>
					<TooltipTrigger
						render={
							renderTrigger ? (
								renderTrigger(triggerProps)
							) : (
								<button
									{...triggerProps}
									className={cn(
										trayTriggerClass,
										open && "bg-muted text-foreground"
									)}
									type="button"
								>
									<HugeiconsIcon icon={icon} size={15} />
									{badge}
								</button>
							)
						}
					/>
					<TooltipContent>{label}</TooltipContent>
				</Tooltip>
			</div>
			{portalTarget &&
				createPortal(
					// Bottom-left pinned at the trigger's slot, so the box grows UP and to
					// the RIGHT — over the content pane, not off the window's left edge —
					// and the rows sit still while it grows past them. `pointer-events` is
					// off while closed: the 40px closed box covers the trigger it no longer
					// contains, and would otherwise swallow the click that opens it.
					<div
						className={cn(
							"fixed z-[60]",
							open ? "pointer-events-auto" : "pointer-events-none"
						)}
						// Marks "a panel the sidebar owns is open, outside the sidebar's own
						// DOM". Layout's hover-peek sidebar reads it so moving the pointer
						// onto this tray — which now counts as leaving the peek panel —
						// doesn't slide the sidebar away underneath it.
						data-sidebar-overlay={open ? "open" : undefined}
						ref={boxRef}
						style={{
							bottom: anchor?.bottom ?? 0,
							// Parked off-screen for the frame before the first measurement,
							// so an unpositioned box never flashes in the corner.
							left: anchor?.left ?? -9999,
						}}
					>
						{/* The lift rides the container, not the panel: `.t-morph` clips its
					    children, so a shadow on the panel inside would never be painted. */}
						<div
							className="t-morph data-[open=true]:shadow-lg"
							data-open={open}
							style={morphVars}
						>
							{/* Pinned to the container's bottom-left at its open width. The
						    height is content-sized and always mounted so the closed tray is
						    measurable. */}
							<div
								className="t-morph-menu absolute bottom-0 left-0 flex flex-col rounded-[20px] border border-border/50 bg-popover/70 p-0 backdrop-blur-2xl backdrop-saturate-150"
								id={panelId}
								inert={!open}
								ref={panelRef}
								style={{ width: "var(--morph-open-w)" }}
								tabIndex={-1}
							>
								{children}
							</div>
						</div>
					</div>,
					portalTarget
				)}
		</div>
	);
}

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
		<div className="flex items-start gap-2 px-2.5 pt-1.5 pb-2">
			<div className="flex min-w-0 flex-col gap-0.5">
				<div className="flex items-center gap-1.5">
					<span className="font-medium text-[13px] tracking-tight">
						{title}
					</span>
					{count !== undefined && count > 0 && (
						<span className="text-[11px] text-muted-foreground/80 tabular-nums">
							{count}
						</span>
					)}
				</div>
				{status && (
					<span className="truncate text-[11px] text-muted-foreground tabular-nums leading-4">
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
				"rounded-lg px-1.5 py-1 font-medium text-[11px] transition-colors disabled:opacity-50",
				tone === "primary"
					? "text-primary hover:bg-primary/10"
					: "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/** Full-bleed hairline that ignores the panel's inset padding. */
export function TrayDivider({ className }: { className?: string }) {
	return <div className={cn("my-1 h-px bg-border/50", className)} />;
}

/**
 * Full-bleed activity line under the header. `percent === null` sweeps the
 * marquee band (same treatment the Progress primitive uses for unknown sizes).
 */
export function TrayProgressLine({ percent }: { percent: number | null }) {
	return (
		<div className="relative mt-0.5 mb-1 h-0.5 overflow-hidden bg-border/50">
			{percent === null ? (
				<span className="t-progress-marquee" />
			) : (
				<div
					className="h-full bg-primary/70 transition-[width] duration-500 ease-out"
					style={{ width: `${percent}%` }}
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
		<div className="flex h-7 items-center gap-1.5 px-2.5 pt-1">
			<span className="font-medium text-[11px] text-muted-foreground">
				{children}
			</span>
			{count !== undefined && count > 0 && (
				<span className="text-[11px] text-muted-foreground/60 tabular-nums">
					{count}
				</span>
			)}
			{trailing && (
				<div className="-mr-1 ml-auto flex items-center">{trailing}</div>
			)}
		</div>
	);
}

/** The small glyph tile that leads every row. */
export function TrayRowIcon({
	className,
	icon,
	tone = "default",
}: {
	className?: string;
	icon: IconSvgElement;
	tone?: TrayTone;
}) {
	return (
		<span
			className={cn(
				"mt-px flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-muted text-muted-foreground",
				tone === "danger" && "text-destructive",
				tone === "success" && "text-success",
				tone === "primary" && "text-primary",
				className
			)}
		>
			<HugeiconsIcon icon={icon} size={14} />
		</span>
	);
}

/**
 * A labelled affirmative action — the one control per row that must be read.
 * Filled default button (or success fill); outline chips used to wash out next
 * to icon ghosts and read as secondary.
 */
export function TrayAction({
	busy,
	label,
	onClick,
	tone = "primary",
}: {
	busy?: boolean;
	label: string;
	onClick: () => void;
	tone?: "primary" | "success";
}) {
	return (
		<button
			className={cn(
				"flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 font-medium text-[11px] transition-colors disabled:opacity-60",
				tone === "success"
					? "bg-success text-white hover:bg-success/80"
					: "bg-primary text-primary-foreground hover:bg-primary/80"
			)}
			disabled={busy}
			onClick={onClick}
			type="button"
		>
			{busy && <Spinner className="size-3" />}
			{label}
		</button>
	);
}

/** A 24px ghost control. Icon-only, tooltipped, sized for a dense row. */
export function TrayIconAction({
	icon,
	label,
	onClick,
	tone = "default",
}: {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						aria-label={label}
						className={cn(
							"flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
							tone === "danger" &&
								"hover:bg-destructive/10 hover:text-destructive"
						)}
						onClick={onClick}
						type="button"
					>
						<HugeiconsIcon icon={icon} size={13} />
					</button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/** Dot-separated meta segments, pre-truncated to one line. */
export function trayMeta(
	...parts: (string | null | undefined | false)[]
): string {
	return parts.filter(Boolean).join(" · ");
}

/**
 * The one row every tray list is built from.
 *
 * `onOpen` is wired as a full-bleed underlay button rather than by wrapping the
 * text: the whole row is then a single click target, and the action controls sit
 * above it instead of being nested inside another button (which is invalid, and
 * left the old rows with a hover highlight wider than their hit area).
 */
export function TrayRow({
	actions,
	busy,
	icon,
	iconNode,
	meta,
	metaTone = "default",
	onOpen,
	openLabel,
	progress,
	title,
	tone = "default",
	trailing,
}: {
	actions?: ReactNode;
	/** Swaps the whole action slot for a spinner, keeping the row's width. */
	busy?: boolean;
	icon?: IconSvgElement;
	/** A custom lead tile (an `<AppIcon/>`, a brand mark) that replaces the glyph.
	 *  When set, `tone` is ignored for the tile — the custom node owns its plate. */
	iconNode?: ReactNode;
	meta?: ReactNode;
	metaTone?: "default" | "danger";
	onOpen?: () => void;
	openLabel?: string;
	/** `undefined` draws no bar; `null` draws an indeterminate one. */
	progress?: number | null;
	title: ReactNode;
	tone?: TrayTone;
	/** Right-aligned stamp on the title line (kept out of the meta line). */
	trailing?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"group/row relative flex items-start gap-2.5 px-2 py-2 transition-colors",
				ROW_RADIUS,
				onOpen && "hover:bg-muted/50"
			)}
		>
			{onOpen && (
				<button
					aria-label={openLabel}
					className={cn("absolute inset-0", ROW_RADIUS)}
					onClick={onOpen}
					type="button"
				/>
			)}
			{iconNode ?? (icon && <TrayRowIcon icon={icon} tone={tone} />)}
			{/* Text ignores the pointer only when there's an underlay button to fall
			    through to; otherwise it would swallow its own `title` tooltip. */}
			<div
				className={cn(
					"relative flex min-w-0 flex-1 flex-col",
					onOpen && "pointer-events-none"
				)}
			>
				<div className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate font-medium text-[13px] leading-5">
						{title}
					</span>
					{trailing && (
						<span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
							{trailing}
						</span>
					)}
				</div>
				{meta && (
					<span
						className={cn(
							"mt-0.5 truncate text-[11px] tabular-nums leading-4",
							metaTone === "danger"
								? "text-destructive/90"
								: "text-muted-foreground"
						)}
					>
						{meta}
					</span>
				)}
				{progress !== undefined && (
					// Under the meta line, not between it and the title: sitting directly
					// beneath the title the bar read as an underline rather than as
					// progress. The track is explicit so a barely-started download still
					// shows how far it has to go.
					<div className="relative mt-2 h-[3px] overflow-hidden rounded-full bg-foreground/10">
						{progress === null ? (
							<span className="t-progress-marquee" />
						) : (
							<div
								className="h-full rounded-full bg-primary/80 transition-[width] duration-500 ease-out"
								style={{ width: `${progress}%` }}
							/>
						)}
					</div>
				)}
			</div>
			<div className="relative flex shrink-0 items-center gap-1">
				{busy ? (
					<span className="flex size-6 items-center justify-center">
						<Spinner className="size-3.5 text-muted-foreground" />
					</span>
				) : (
					actions
				)}
			</div>
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
		if (!el || typeof ResizeObserver === "undefined") {
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

	const content = (
		<div
			className={cn(
				"flex max-h-[20rem] flex-col overscroll-contain [scrollbar-width:thin]",
				className
			)}
			onScroll={measure}
			ref={ref}
			style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
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
		<div className="flex flex-col items-center gap-2 px-8 py-7 text-center">
			<span className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
				<HugeiconsIcon icon={icon} size={17} />
			</span>
			<span className="font-medium text-[13px]">{title}</span>
			<p className="text-balance text-[11px] text-muted-foreground leading-relaxed">
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
				"flex w-full items-center gap-1.5 px-2.5 py-2 font-medium text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
				ROW_RADIUS
			)}
			onClick={onClick}
			type="button"
		>
			<span>{label}</span>
			<HugeiconsIcon
				className="ml-auto opacity-70"
				icon={ArrowUpRight01Icon}
				size={13}
			/>
		</button>
	);
}
