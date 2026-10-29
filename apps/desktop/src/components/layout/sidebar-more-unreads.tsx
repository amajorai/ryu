import { ArrowDown02Icon, ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { type RefObject, useEffect, useState } from "react";

/**
 * Marks a sidebar row whose conversation is unread. The "More unreads" pills
 * read it straight from the DOM, so any row kind (chat, agent thread, …) opts
 * in by spreading `sidebarUnreadRowAttributes` — no list plumbing needed, and
 * rows hidden by a collapsed section or the overflow popover simply don't count.
 */
export const SIDEBAR_UNREAD_ROW_ATTRIBUTE = "data-sidebar-unread";

const UNREAD_ROW_SELECTOR = `[${SIDEBAR_UNREAD_ROW_ATTRIBUTE}="true"]`;

/** Leaves room for the pill itself when a jumped-to row lands at an edge. */
const JUMP_EDGE_OFFSET_PX = 44;

export function sidebarUnreadRowAttributes(unread: boolean) {
	return { [SIDEBAR_UNREAD_ROW_ATTRIBUTE]: unread ? "true" : undefined };
}

interface VerticalSpan {
	bottom: number;
	top: number;
}

export interface OffscreenUnreads {
	/** Distance from the viewport top to the nearest unread row above it. */
	nearestAbove: number | null;
	/** Distance from the viewport bottom to the nearest unread row below it. */
	nearestBelow: number | null;
}

/**
 * Classify unread rows against the scroll viewport. A row counts as offscreen
 * once its vertical center has left the viewport — a row half under the scroll
 * fade still reads as "seen", one mostly clipped does not.
 */
export function findOffscreenUnreads(
	viewport: VerticalSpan,
	rows: readonly VerticalSpan[]
): OffscreenUnreads {
	let nearestAbove: number | null = null;
	let nearestBelow: number | null = null;
	for (const row of rows) {
		const center = (row.top + row.bottom) / 2;
		if (center < viewport.top) {
			const distance = viewport.top - row.top;
			nearestAbove =
				nearestAbove === null ? distance : Math.min(nearestAbove, distance);
		} else if (center > viewport.bottom) {
			const distance = row.bottom - viewport.bottom;
			nearestBelow =
				nearestBelow === null ? distance : Math.min(nearestBelow, distance);
		}
	}
	return { nearestAbove, nearestBelow };
}

function measure(root: HTMLElement): OffscreenUnreads {
	const rows = Array.from(
		root.querySelectorAll<HTMLElement>(UNREAD_ROW_SELECTOR),
		(row) => row.getBoundingClientRect()
	);
	return findOffscreenUnreads(root.getBoundingClientRect(), rows);
}

function scrollBehavior(): ScrollBehavior {
	const reduce =
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	return reduce ? "auto" : "smooth";
}

const NONE: OffscreenUnreads = { nearestAbove: null, nearestBelow: null };

function sameState(a: OffscreenUnreads, b: OffscreenUnreads): boolean {
	return (
		(a.nearestAbove === null) === (b.nearestAbove === null) &&
		(a.nearestBelow === null) === (b.nearestBelow === null)
	);
}

/**
 * Floating "More unreads" pills over the sidebar's scrolling list: one at the
 * top when an unread row is scrolled out above, one at the bottom when one is
 * below. Clicking scrolls the nearest such row into view.
 *
 * `containerRef` is a positioned wrapper around the sidebar's
 * `SidebarContent`; the pills overlay it rather than living inside the
 * scroller, so they never take part in its layout or scroll anchoring.
 */
export function SidebarMoreUnreads({
	containerRef,
}: {
	containerRef: RefObject<HTMLElement | null>;
}): React.ReactNode {
	const [state, setState] = useState<OffscreenUnreads>(NONE);
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);

	useEffect(() => {
		setScrollRoot(
			containerRef.current?.querySelector<HTMLElement>(
				'[data-slot="sidebar-content"]'
			) ?? null
		);
	}, [containerRef]);

	useEffect(() => {
		if (!scrollRoot) {
			return;
		}
		let frame = 0;
		const update = () => {
			frame = 0;
			const next = measure(scrollRoot);
			// Distances move on every scroll tick; re-render only when a pill
			// appears or disappears.
			setState((prev) => (sameState(prev, next) ? prev : next));
		};
		const schedule = () => {
			if (frame === 0) {
				frame = requestAnimationFrame(update);
			}
		};
		update();
		scrollRoot.addEventListener("scroll", schedule, { passive: true });
		const resizeObserver =
			typeof ResizeObserver === "function"
				? new ResizeObserver(schedule)
				: null;
		resizeObserver?.observe(scrollRoot);
		// Rows mount/unmount as sections expand, chats arrive, and unread flags
		// flip; any of those can move an unread row across the viewport edge.
		const mutationObserver = new MutationObserver(schedule);
		mutationObserver.observe(scrollRoot, {
			attributeFilter: [SIDEBAR_UNREAD_ROW_ATTRIBUTE, "data-state", "hidden"],
			attributes: true,
			childList: true,
			subtree: true,
		});
		return () => {
			if (frame !== 0) {
				cancelAnimationFrame(frame);
			}
			scrollRoot.removeEventListener("scroll", schedule);
			resizeObserver?.disconnect();
			mutationObserver.disconnect();
		};
	}, [scrollRoot]);

	if (!scrollRoot) {
		return null;
	}

	const jump = (direction: "up" | "down") => {
		const { nearestAbove, nearestBelow } = measure(scrollRoot);
		const distance = direction === "up" ? nearestAbove : nearestBelow;
		if (distance === null) {
			return;
		}
		const delta = distance + JUMP_EDGE_OFFSET_PX;
		scrollRoot.scrollBy({
			behavior: scrollBehavior(),
			top: direction === "up" ? -delta : delta,
		});
	};

	return (
		<>
			{state.nearestAbove === null ? null : (
				<MoreUnreadsPill direction="up" onClick={() => jump("up")} />
			)}
			{state.nearestBelow === null ? null : (
				<MoreUnreadsPill direction="down" onClick={() => jump("down")} />
			)}
		</>
	);
}

function MoreUnreadsPill({
	direction,
	onClick,
}: {
	direction: "up" | "down";
	onClick: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Button
			aria-label={
				direction === "up"
					? tl("Scroll to more unread chats above")
					: tl("Scroll to more unread chats below")
			}
			className={`absolute left-1/2 z-20 -translate-x-1/2 shadow-md group-data-[collapsible=icon]:hidden ${direction === "up" ? "top-2" : "bottom-2"}`}
			data-testid={`sidebar-more-unreads-${direction}`}
			onClick={onClick}
			radius="pill"
			size="xs"
			type="button"
		>
			<HugeiconsIcon
				data-icon="inline-start"
				icon={direction === "up" ? ArrowUp02Icon : ArrowDown02Icon}
				strokeWidth={2}
			/>
			More unreads
		</Button>
	);
}
