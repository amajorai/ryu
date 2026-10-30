import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import {
	type CSSProperties,
	type ReactElement,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import layoutStyles from "../TrayPopover.module.css";

export interface TrayMorphStyle extends CSSProperties {
	"--morph-open-h": string;
	"--morph-open-w": string;
}

export type TrayPlacement = "menubar" | "sidebar";

export type TrayAnchor =
	| { bottom: number; left: number; placement: "sidebar" }
	| { placement: "menubar"; right: number; top: number };

export interface TrayTriggerRenderProps {
	"aria-controls": string;
	"aria-expanded": boolean;
	"aria-haspopup": "dialog";
	"aria-label": string;
	onClick: () => void;
	ref: RefObject<HTMLButtonElement | null>;
}

/** The 28px footer icon button both trays hang off. */
export const trayTriggerClass =
	"relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/**
 * The morph's open height is measured, not declared, so this is only the value
 * shown until the always-mounted panel is measured. The CreateMenu comment that
 * says the open box "has to be declared, not measured" is about feeding the
 * animated size back into the thing being animated (a loop); here the panel's
 * height depends only on its own content — never on the container — so measuring
 * it and writing the container's height is one-way and settles.
 */
export const TRAY_MORPH_INITIAL_H = 240;

export const TRAY_MORPH_MAX_WIDTH = 368;

export const TRAY_VIEWPORT_GUTTER = 8;

/**
 * How far the 40px box hangs past the 28px trigger slot on each pinned edge —
 * the `-bottom-1.5 -left-1.5` the box carried while it was an absolutely
 * positioned child of the slot, now applied to the portaled box's fixed
 * coordinates so it lands in exactly the same place.
 */
export const MORPH_SLOT_OFFSET = 6;

/**
 * The Inbox and Downloads tray morph: a 28px icon button that grows into the
 * tray box (`.t-morph` / `.t-morph-menu`). Sidebar trays grow up and right from
 * the footer; menu-bar trays grow down and left from the top-right controls.
 * The panel stays mounted (inert while closed) so its height can be measured;
 * the box grows to that height, so a short list hugs its rows and a long one
 * caps at the scroller's max.
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
 * The BUTTON stays in the host surface DOM so it keeps its tab order and
 * tooltip; only the box travels.
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
	placement = "sidebar",
	renderTrigger,
}: {
	badge?: ReactNode;
	/** The tray panel body — TrayHeader, TrayScroll/TrayEmpty, TrayFooter. */
	children: ReactNode;
	icon: IconSvgElement;
	label: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	placement?: TrayPlacement;
	renderTrigger?: (props: TrayTriggerRenderProps) => ReactElement;
}) {
	const panelId = useId();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const [openH, setOpenH] = useState(TRAY_MORPH_INITIAL_H);
	const [anchor, setAnchor] = useState<TrayAnchor | null>(null);
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
			const target = e.target;
			if (!(target instanceof Node)) {
				return;
			}
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
		if (!(el && "ResizeObserver" in globalThis)) {
			return;
		}
		const measure = () => setOpenH(el.offsetHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [portalTarget]);

	// Track the portaled box from the trigger: sidebar trays pin bottom-left and
	// menu-bar trays pin top-right, both with the 6px slot offset. Measure on mount,
	// on every open, and on window resize. Layout effect, so
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
			if (placement === "menubar") {
				const menubar = el.closest('[data-tray-anchor="menubar"]');
				const menubarBottom =
					menubar?.getBoundingClientRect().bottom ?? r.bottom;
				const panelWidth = Math.min(
					TRAY_MORPH_MAX_WIDTH,
					window.innerWidth - 16
				);
				const maximumRight =
					window.innerWidth - panelWidth - TRAY_VIEWPORT_GUTTER;
				const triggerRight = window.innerWidth - r.right - MORPH_SLOT_OFFSET;
				setAnchor({
					placement,
					right: Math.min(
						Math.max(TRAY_VIEWPORT_GUTTER, triggerRight),
						Math.max(TRAY_VIEWPORT_GUTTER, maximumRight)
					),
					top: menubarBottom + MORPH_SLOT_OFFSET,
				});
				return;
			}
			setAnchor({
				bottom: window.innerHeight - r.bottom - MORPH_SLOT_OFFSET,
				left: r.left - MORPH_SLOT_OFFSET,
				placement,
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
	}, [open, placement]);

	const morphVars =
		/* SAFETY: ReactDOM forwards these exact custom properties with style.setProperty; the complete TrayMorphStyle producer checks all standard CSS fields and app slots, which React CSSProperties omits. */ {
			"--morph-open-w": "min(23rem, calc(100vw - 1rem))",
			"--morph-open-h": `${openH}px`,
		} satisfies TrayMorphStyle as CSSProperties;
	const triggerClassName =
		placement === "menubar"
			? "relative flex size-[24px] shrink-0 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white"
			: trayTriggerClass;
	const triggerProps: TrayTriggerRenderProps = {
		"aria-controls": panelId,
		"aria-expanded": open,
		"aria-haspopup": "dialog",
		"aria-label": label,
		onClick: () => onOpenChange(!open),
		ref: triggerRef,
	};

	const cssVariables1: LayoutCssVariables = {
		"--desktop-inline3-transform-Origin":
			placement === "menubar" ? "top right" : "top left",
	};
	const anchorVariables: CSSProperties & {
		"--tray-right"?: string;
		"--tray-top"?: string;
		"--tray-bottom"?: string;
		"--tray-left"?: string;
	} = {
		"--tray-right":
			anchor?.placement === "menubar" ? `${anchor.right}px` : undefined,
		"--tray-top":
			anchor?.placement === "menubar" ? `${anchor.top}px` : undefined,
		"--tray-bottom":
			anchor?.placement === "menubar" ? undefined : `${anchor?.bottom ?? 0}px`,
		"--tray-left":
			anchor?.placement === "menubar"
				? undefined
				: `${anchor?.left ?? -9999}px`,
	};
	return (
		<div
			className={cn(
				"relative shrink-0",
				placement === "menubar" ? "size-[24px]" : "size-7"
			)}
			ref={rootRef}
		>
			{/* The trigger stays here; the box below is portaled over it. It fades
			    and lifts on open (what `.t-morph-plus` did while it still wrapped the
			    button) so the icon hands off to the panel instead of showing through
			    the panel's translucent corner. */}
			<div
				className={cn(
					"duration-200 ease-out data-[open=true]:pointer-events-none data-[open=true]:-translate-y-1 data-[open=true]:opacity-0",
					layoutStyles.authored1
				)}
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
										triggerClassName,
										open &&
											(placement === "menubar"
												? "bg-white/10 text-white"
												: "bg-muted text-foreground")
									)}
									type="button"
								>
									<HugeiconsIcon icon={icon} size={16} />
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
					// Sidebar trays grow up and right; menu-bar trays grow down and left.
					// `pointer-events` is
					// off while closed: the 40px closed box covers the trigger it no longer
					// contains, and would otherwise swallow the click that opens it.
					<div
						className={cn(
							"fixed z-[60]",
							layoutStyles.anchor,
							open ? "pointer-events-auto" : "pointer-events-none"
						)}
						data-placement={anchor?.placement ?? "sidebar"}
						// Marks "a panel the sidebar owns is open, outside the sidebar's own
						// DOM". Layout's hover-peek sidebar reads it so moving the pointer
						// onto this tray — which now counts as leaving the peek panel —
						// doesn't slide the sidebar away underneath it.
						data-sidebar-overlay={open ? "open" : undefined}
						ref={boxRef}
						style={anchorVariables}
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
								aria-label={label}
								aria-modal={false}
								className={cn(
									cn(
										cn(
											"t-morph-menu absolute flex flex-col border border-border bg-popover p-0",
											layoutStyles.authored2
										),
										placement === "menubar"
											? "top-0 right-0"
											: "bottom-0 left-0"
									),
									layoutStyles.inline3
								)}
								id={panelId}
								inert={!open}
								ref={panelRef}
								role="dialog"
								style={cssVariables1}
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

export interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-right"?: string | number;
	"--desktop-inline1-top"?: string | number;
	"--desktop-inline3-transform-Origin"?: string | number;
	"--desktop-inline4-width"?: string | number;
	"--desktop-inline5-width"?: string | number;
	"--desktop-inline6--Webkit-Mask-Image"?: string | number;
	"--desktop-inline6-mask-Image"?: string | number;
}
