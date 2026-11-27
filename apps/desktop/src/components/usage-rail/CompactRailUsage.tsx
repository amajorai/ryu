"use client";

// The usage rings of the narrow rail: a vertical stack after the agents, as
// many rings as the rail's free height holds and five at most. The rings that
// do not fit go behind one "+N" ring.

import { useLiteralMessages } from "@ryu/i18n/react";
import type { RefObject } from "react";
import { RailDivider } from "@/src/components/layout/compact-rail-agents.tsx";
import { fitUsageRings } from "@/src/lib/usage-rail/usage-rail-fit.ts";
import { useRailRingPlaces, useUsageRail } from "./usage-rail-layout.ts";
import { MoreUsageRing, UsageRing } from "./usage-ring.tsx";

export function CompactRailUsage({
	rosterRef,
}: {
	/** The scrolling list of agents, whose height the rings share. */
	rosterRef: RefObject<HTMLElement | null>;
}) {
	const tl = useLiteralMessages();
	const rail = useUsageRail();
	const places = useRailRingPlaces(rosterRef, rail.sources.length);
	if (rail.sources.length === 0) {
		return null;
	}
	const layout = fitUsageRings(rail.sources, places);
	return (
		<>
			<RailDivider />
			<ul
				aria-label={tl("Usage")}
				className="flex shrink-0 flex-col items-center gap-1 py-1"
				data-testid="compact-rail-usage"
			>
				{layout.shown.map((source) => (
					<li className="flex" key={source.id}>
						<UsageRing
							mode={rail.mode}
							onOpen={rail.openUsage}
							side="inline-end"
							size="rail"
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
							side="inline-end"
							size="rail"
							sources={layout.more}
						/>
					</li>
				) : null}
			</ul>
		</>
	);
}
