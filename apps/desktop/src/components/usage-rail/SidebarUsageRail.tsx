"use client";

// The usage rings of the full sidebar: one row directly above the account
// footer, or, when the sidebar is too short to give that row its height, one
// ring beside the account button whose card lists every source.

import { useLiteralMessages } from "@ryu/i18n/react";
import { type RefObject, useRef } from "react";
import { fitUsageRings } from "@/src/lib/usage-rail/usage-rail-fit.ts";
import {
	type UsageRail,
	useRowRingPlaces,
	useSidebarUsagePlacement,
	useUsageRail,
} from "./usage-rail-layout.ts";
import { MoreUsageRing, UsageRing } from "./usage-ring.tsx";

export interface SidebarUsageRail extends UsageRail {
	/** "none" with no source to show, or with the rings turned off. */
	placement: "footer" | "none" | "row";
}

/** The rings of the full sidebar and where they go, measured from `listRef`. */
export function useSidebarUsageRail(
	listRef: RefObject<HTMLElement | null>
): SidebarUsageRail {
	const rail = useUsageRail();
	const hasRings = rail.sources.length > 0;
	const placement = useSidebarUsagePlacement(listRef, hasRings);
	return { ...rail, placement: hasRings ? placement : "none" };
}

/** The row above the account footer. As many rings as its width holds. */
export function SidebarUsageRow({ rail }: { rail: SidebarUsageRail }) {
	const tl = useLiteralMessages();
	const rowRef = useRef<HTMLUListElement | null>(null);
	const shown = rail.placement === "row";
	const places = useRowRingPlaces(rowRef, shown);
	if (!shown) {
		return null;
	}
	const layout = fitUsageRings(rail.sources, places);
	return (
		<ul
			aria-label={tl("Usage")}
			className="flex h-11 shrink-0 items-center gap-1 px-2"
			data-testid="sidebar-usage-row"
			ref={rowRef}
		>
			{layout.shown.map((source) => (
				<li className="flex" key={source.id}>
					<UsageRing
						mode={rail.mode}
						onOpen={rail.openUsage}
						side="top"
						size="row"
						source={source}
					/>
				</li>
			))}
			{layout.more.length > 0 ? (
				<li className="flex">
					<MoreUsageRing
						holdsAll={layout.shown.length === 0}
						mode={rail.mode}
						onOpen={rail.openUsage}
						side="top"
						size="row"
						sources={layout.more}
					/>
				</li>
			) : null}
		</ul>
	);
}

/**
 * The one ring beside the account button of a short sidebar. A single source
 * keeps its own ring: the "+N" ring never stands for one ring alone.
 */
export function SidebarUsageFooterRing({ rail }: { rail: SidebarUsageRail }) {
	if (rail.placement !== "footer") {
		return null;
	}
	const layout = fitUsageRings(rail.sources, 1);
	const [only] = layout.shown;
	return only ? (
		<UsageRing
			mode={rail.mode}
			onOpen={rail.openUsage}
			side="top"
			size="footer"
			source={only}
		/>
	) : (
		<MoreUsageRing
			holdsAll
			mode={rail.mode}
			onOpen={rail.openUsage}
			side="top"
			size="footer"
			sources={layout.more}
		/>
	);
}
