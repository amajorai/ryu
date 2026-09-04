"use client";

// packages/ui/src/components/edge-scroller.tsx
//
// Shared horizontal overflow measurement and edge-fade primitives. TabsList
// consumes the hook directly; EdgeScroller and EdgeScrollChevrons cover strips
// that still own their scrolling box. Keeping the measurement here prevents
// each surface from growing another subtly different implementation.
//
// Two bugs it exists to make unrepeatable:
//
//  1. `overflow-x-auto` ALONE also shows a vertical scrollbar. CSS resolves an
//     `overflow-y: visible` next to a non-visible `overflow-x` to `auto`, so a
//     one-line strip that never overflows vertically still reserved (and, on a
//     fractional layout height, PAINTED) a vertical bar. Every scroller here is
//     `overflow-y-hidden` explicitly.
//  2. `scrollbar-none` is not a utility in this codebase — only `scrollbar-hide`
//     is, and it is defined in `apps/desktop/src/index.css`, i.e. in ONE app's
//     stylesheet. A shared package cannot rely on it: the class silently no-ops
//     wherever that stylesheet is absent (the web store, the e2e harness). The
//     hiding is arbitrary-property CSS on the element itself, so it cannot rot.
//
// The affordance is a chevron per overflowing edge, revealed on hover: no border,
// no plate, no chrome at rest — just the glyph, over the same edge fade the strip
// already dissolved into. A visible scrollbar under a row of pills is the thing
// being replaced, not decorated.

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cn } from "../lib/utils.ts";

/** How much of each overflowing edge dissolves into the background. */
const EDGE_FADE = "2rem";
/** Fraction of the visible width one chevron press travels. */
const PAGE_FRACTION = 0.8;

/** Hides the native scrollbar in every engine, without depending on a utility
 *  class that may not exist in the consuming app's stylesheet. */
export const HORIZONTAL_SCROLLBAR_HIDDEN =
	"[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export interface HorizontalOverflowEdges {
	end: boolean;
	start: boolean;
}

export interface HorizontalOverflowState {
	dataEdges: "both" | "end" | "none" | "start";
	edges: HorizontalOverflowEdges;
	measure: () => void;
	style: CSSProperties | undefined;
}

/**
 * Which edges of a horizontal scroller currently have more content, remeasured on
 * scroll and on any resize of the box OR its content row.
 *
 * Measured in JS rather than with a scroll-driven CSS animation because this
 * component is consumed by more than one app (desktop shell, web marketplace, e2e
 * harness) and each builds its own stylesheet — a `@utility` defined in one is
 * dead everywhere else.
 */
export function useHorizontalOverflowState(
	ref: RefObject<HTMLElement | null>,
	enabled = true
): HorizontalOverflowState {
	const [edges, setEdges] = useState<HorizontalOverflowEdges>({
		end: false,
		start: false,
	});

	const measure = useCallback(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		const max = Math.max(0, el.scrollWidth - el.clientWidth);
		// 1px slack: fractional layout widths otherwise leave a permanent
		// sub-pixel "there is more" on a strip that fits exactly.
		const nextEdges = {
			end: max - el.scrollLeft > 1,
			start: el.scrollLeft > 1,
		};
		setEdges((current) =>
			current.end === nextEdges.end && current.start === nextEdges.start
				? current
				: nextEdges
		);
	}, [ref]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!(enabled && el)) {
			setEdges((current) =>
				current.end || current.start ? { end: false, start: false } : current
			);
			return;
		}

		measure();
		el.addEventListener("scroll", measure, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		// The container gives the AVAILABLE width; its content row gives the
		// CONTENT width. A strip that grows (an app registers a section, a tab
		// opens) resizes only the second, so both have to be watched.
		const observeContent = () => {
			observer?.disconnect();
			observer?.observe(el);
			for (const child of Array.from(el.children)) {
				observer?.observe(child);
			}
		};
		observeContent();
		const mutationObserver =
			typeof MutationObserver === "undefined"
				? null
				: new MutationObserver(() => {
						observeContent();
						measure();
					});
		mutationObserver?.observe(el, { childList: true });
		return () => {
			el.removeEventListener("scroll", measure);
			observer?.disconnect();
			mutationObserver?.disconnect();
		};
	}, [enabled, measure, ref]);

	return {
		dataEdges: edgeStateName(edges.start, edges.end),
		edges,
		measure,
		style: fadeStyle(edges.start, edges.end),
	};
}

function fadeStyle(start: boolean, end: boolean): CSSProperties | undefined {
	if (!(start || end)) {
		return;
	}
	const gradient = `linear-gradient(to right, ${
		start ? `transparent 0, #000 ${EDGE_FADE}` : "#000 0"
	}, ${end ? `#000 calc(100% - ${EDGE_FADE}), transparent 100%` : "#000 100%"})`;
	return { maskImage: gradient, WebkitMaskImage: gradient };
}

function edgeStateName(start: boolean, end: boolean) {
	if (start && end) {
		return "both";
	}
	if (end) {
		return "end";
	}
	if (start) {
		return "start";
	}
	return "none";
}

/** One edge chevron. Bare glyph — no border, no background plate. */
function EdgeChevron({
	side,
	onPress,
}: {
	onPress: () => void;
	side: "end" | "start";
}) {
	const localizedLabel = useLocalizedString(
		side === "start" ? "Scroll left" : "Scroll right"
	);
	return (
		<button
			aria-label={localizedLabel}
			className={cn(
				"pointer-events-auto absolute inset-y-0 z-10 flex w-6 items-center justify-center",
				"text-muted-foreground opacity-0 transition-opacity duration-150",
				"hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none",
				"group-hover/edge-scroller:opacity-100",
				side === "start" ? "left-0" : "right-0"
			)}
			// A pointerdown-driven scroll would fight the roving tab-index focus the
			// pill lists ship; a plain click leaves keyboard nav alone.
			onClick={onPress}
			tabIndex={-1}
			type="button"
		>
			<HugeiconsIcon
				className="size-4"
				icon={side === "start" ? ArrowLeft01Icon : ArrowRight01Icon}
			/>
		</button>
	);
}

/**
 * A horizontally scrolling strip with no scrollbars and hover-revealed edge
 * chevrons.
 *
 * `children` is laid out as the scroller's single content row, so callers pass
 * the row itself (a `TabsList`, a tab strip's items) and keep owning its spacing.
 */
export function EdgeScroller({
	children,
	className,
	contentClassName,
	"data-slot": dataSlot,
}: {
	children: ReactNode;
	className?: string;
	contentClassName?: string;
	"data-slot"?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const { dataEdges, edges, measure, style } = useHorizontalOverflowState(ref);

	const page = (direction: -1 | 1) => {
		const el = ref.current;
		if (!el) {
			return;
		}
		el.scrollBy({
			behavior: "smooth",
			left: direction * Math.max(120, el.clientWidth * PAGE_FRACTION),
		});
	};

	// A strip whose content shrinks back under the box width must drop its mask;
	// ResizeObserver covers layout, this covers a children-count change that keeps
	// the same measured size (a tab replaced, not added).
	useEffect(measure, [measure]);

	return (
		<div
			className={cn(
				"group/edge-scroller relative min-w-0",
				// The chevrons are the only pointer targets this wrapper adds; the
				// wrapper itself must stay transparent to clicks aimed at the strip.
				className
			)}
		>
			<div
				className={cn(
					"min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain",
					HORIZONTAL_SCROLLBAR_HIDDEN,
					contentClassName
				)}
				data-edges={dataEdges}
				data-slot={dataSlot ?? "edge-scroller"}
				ref={ref}
				style={style}
			>
				{children}
			</div>
			{edges.start ? (
				<EdgeChevron onPress={() => page(-1)} side="start" />
			) : null}
			{edges.end ? <EdgeChevron onPress={() => page(1)} side="end" /> : null}
		</div>
	);
}

/**
 * The chevrons WITHOUT the scroller — for a strip that already owns its own
 * scroll box and cannot give it up.
 *
 * The window tab bar is the case: its scroller carries a `pb-8` overflow trick
 * (the scrollbar renders in a padding band that an outer `h-8` box clips away),
 * a `data-tauri-drag-region={false}` opt-out, and a ref the strip scrolls
 * programmatically to reveal a newly-activated tab. Wrapping it in
 * {@link EdgeScroller} would mean re-homing all three. Mount this inside a
 * `relative` ancestor of that scroller instead and pass its ref.
 *
 * Deliberately renders no fade: a strip with its own scroll box also has its own
 * clipping rules, and a mask applied from outside it would cut the wrong element.
 */
export function EdgeScrollChevrons({
	scrollRef,
	className,
}: {
	className?: string;
	scrollRef: RefObject<HTMLElement | null>;
}) {
	// Same measurement as EdgeScroller's, over a ref this component does not own.
	const { edges } = useHorizontalOverflowState(scrollRef);

	const page = (direction: -1 | 1) => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		el.scrollBy({
			behavior: "smooth",
			left: direction * Math.max(120, el.clientWidth * PAGE_FRACTION),
		});
	};

	if (!(edges.start || edges.end)) {
		return null;
	}
	return (
		// `inset-y-0` on a zero-width, pointer-transparent layer: the chevrons
		// position against the SCROLLER's box, and this layer must not swallow
		// clicks meant for the tabs behind it.
		<span
			aria-hidden={false}
			className={cn(
				"pointer-events-none absolute inset-0 z-10 group-hover/edge-scroller:[&>button]:opacity-100",
				className
			)}
			data-slot="edge-scroll-chevrons"
		>
			{edges.start ? (
				<EdgeChevron onPress={() => page(-1)} side="start" />
			) : null}
			{edges.end ? <EdgeChevron onPress={() => page(1)} side="end" /> : null}
		</span>
	);
}

export default EdgeScroller;
