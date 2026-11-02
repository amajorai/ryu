"use client";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { HorizontalOverflowEdges } from "@ryu/ui/components/edge-scroller.tsx";
import type { ReactElement } from "react";

const TAB_SCROLL_PAGE_FRACTION = 0.8;

interface TabsOverflowNavigationProps {
	children: ReactElement;
	edges: HorizontalOverflowEdges;
	listId: string;
	onScrollPage: (direction: -1 | 1) => void;
}

/**
 * Scroll affordances for an overflowing tab strip. The controls are physical on
 * purpose: `edges` reports hidden content measured from the physical left (see
 * `useHorizontalOverflowState`, which normalizes RTL `scrollLeft`), each button
 * sits on the edge it reveals with an arrow pointing outward, and
 * `onScrollPage(-1)` scrolls toward the physical left in either direction. The
 * labels therefore name the physical side the button scrolls toward.
 */
function TabsOverflowNavigation({
	children,
	edges,
	listId,
	onScrollPage,
}: TabsOverflowNavigationProps) {
	const hasOverflow = edges.start || edges.end;
	const controlsLabel = useLocalizedString("Tab scrolling controls");
	const scrollLeftLabel = useLocalizedString("Scroll tabs left");
	const scrollRightLabel = useLocalizedString("Scroll tabs right");

	return (
		<div
			className="group/tabs-overflow relative isolate min-w-0"
			data-slot="tabs-list-overflow"
		>
			{children}
			{hasOverflow ? (
				<>
					{edges.start ? (
						<span
							aria-hidden="true"
							className="corner-l-squircle pointer-events-none absolute inset-y-0 left-0 z-10 w-10 rounded-l-[inherit] backdrop-blur-[2px] [mask-image:linear-gradient(to_right,black,transparent)]"
						/>
					) : null}
					{edges.end ? (
						<span
							aria-hidden="true"
							className="corner-r-squircle pointer-events-none absolute inset-y-0 right-0 z-10 w-10 rounded-r-[inherit] backdrop-blur-[2px] [mask-image:linear-gradient(to_left,black,transparent)]"
						/>
					) : null}
					<div
						aria-label={controlsLabel}
						className="pointer-events-none absolute inset-0 z-20"
						data-slot="tabs-overflow-controls"
						role="group"
					>
						<Button
							aria-controls={listId}
							aria-label={scrollLeftLabel}
							className="pointer-events-auto absolute inset-y-0 left-0 z-20 h-full w-9 rounded-r-none rounded-l-full border-0 bg-transparent p-0 text-foreground shadow-none hover:bg-transparent focus-visible:bg-transparent disabled:pointer-events-none disabled:opacity-0"
							disabled={!edges.start}
							onClick={() => onScrollPage(-1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon
								aria-hidden
								icon={ArrowLeft01Icon}
								strokeWidth={2}
							/>
						</Button>
						<Button
							aria-controls={listId}
							aria-label={scrollRightLabel}
							className="pointer-events-auto absolute inset-y-0 right-0 z-20 h-full w-9 rounded-r-full rounded-l-none border-0 bg-transparent p-0 text-foreground shadow-none hover:bg-transparent focus-visible:bg-transparent disabled:pointer-events-none disabled:opacity-0"
							disabled={!edges.end}
							onClick={() => onScrollPage(1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon
								aria-hidden
								icon={ArrowRight01Icon}
								strokeWidth={2}
							/>
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}

export { TAB_SCROLL_PAGE_FRACTION, TabsOverflowNavigation };
