"use client";

// One usage ring: the mark of a source inside one arc per limit window. The
// outer arc is the longest window and the inner arc the shortest; a pool of
// several accounts draws one arc, the mean of what its accounts have left.
// Hover or keyboard focus opens a card with the accounts, Escape closes it,
// and a click opens the Usage page.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import type { UsageBarMode } from "@/src/hooks/useUsageBarPrefs.ts";
import type {
	RailTrack,
	UsageRailSource,
} from "@/src/lib/usage-rail/usage-rail-sources.ts";
import { UsageRailCard } from "./usage-rail-card.tsx";
import { RailLogoMark } from "./usage-rail-logo.tsx";
import { moreRingLabel, ringLabel, shownPercent } from "./usage-rail-text.ts";
import { usageToneClasses } from "./usage-rail-tone.ts";

/** Two arcs in a 32 unit box, their centre lines 4.5 units apart. */
const RING_BOX = 32;
const RING_STROKE = 2.5;
const RING_GAP = 4.5;
const RING_CENTER = RING_BOX / 2;
const OUTER_RADIUS = (RING_BOX - RING_STROKE) / 2;
/** A ring draws two windows at most. The card lists every one. */
const MAX_TRACKS = 2;
/** The card waits a moment, so a pointer that only crosses the strip opens none. */
const CARD_OPEN_DELAY_MS = 250;
const CARD_CLOSE_DELAY_MS = 75;

/** Where the card opens: beside the narrow rail, above the sidebar row. */
export type UsageRingSide = "inline-end" | "top";

const BUTTON_SIZE = {
	footer: "size-8",
	rail: "size-10",
	row: "size-9",
} as const;
export type UsageRingSize = keyof typeof BUTTON_SIZE;

function RingArcs({
	mode,
	tracks,
}: {
	mode: UsageBarMode;
	tracks: readonly RailTrack[];
}) {
	return (
		<svg
			aria-hidden="true"
			className="absolute inset-0.5 -rotate-90"
			fill="none"
			viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
		>
			{tracks.slice(0, MAX_TRACKS).map((track, index) => {
				const radius = OUTER_RADIUS - index * RING_GAP;
				const shown = shownPercent(track.usedPercent, mode);
				return (
					<g key={track.label ?? "mean"}>
						<circle
							className="stroke-current opacity-15"
							cx={RING_CENTER}
							cy={RING_CENTER}
							r={radius}
							strokeWidth={RING_STROKE}
						/>
						{shown > 0 ? (
							<circle
								className={usageToneClasses(track.usedPercent).arc}
								cx={RING_CENTER}
								cy={RING_CENTER}
								data-testid="usage-ring-arc"
								pathLength={100}
								r={radius}
								strokeDasharray={`${shown} 100`}
								strokeLinecap="round"
								strokeWidth={RING_STROKE}
							/>
						) : null}
					</g>
				);
			})}
		</svg>
	);
}

/** The button and its card. The name on the button says all the card shows first. */
function RingButton({
	card,
	children,
	label,
	onOpen,
	side,
	size,
	testId,
}: {
	card: ReactNode;
	children: ReactNode;
	label: string;
	onOpen: () => void;
	side: UsageRingSide;
	size: UsageRingSize;
	testId: string;
}) {
	return (
		<HoverCard>
			<HoverCardTrigger
				closeDelay={CARD_CLOSE_DELAY_MS}
				delay={CARD_OPEN_DELAY_MS}
				render={
					<button
						aria-label={label}
						className={cn(
							"relative flex shrink-0 items-center justify-center rounded-full text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none",
							BUTTON_SIZE[size]
						)}
						data-testid={testId}
						onClick={onOpen}
						type="button"
					/>
				}
			>
				{children}
			</HoverCardTrigger>
			<HoverCardContent
				align={side === "top" ? "center" : "end"}
				className="w-72 motion-reduce:animate-none motion-reduce:transition-none"
				side={side}
				sideOffset={8}
				spacing="rail"
			>
				{card}
			</HoverCardContent>
		</HoverCard>
	);
}

export function UsageRing({
	mode,
	onOpen,
	side,
	size,
	source,
}: {
	mode: UsageBarMode;
	onOpen: () => void;
	side: UsageRingSide;
	size: UsageRingSize;
	source: UsageRailSource;
}) {
	const tl = useLiteralMessages();
	return (
		<RingButton
			card={<UsageRailCard mode={mode} sources={[source]} />}
			label={ringLabel(source, mode, tl)}
			onOpen={onOpen}
			side={side}
			size={size}
			testId="usage-ring"
		>
			<RingArcs mode={mode} tracks={source.tracks} />
			<RailLogoMark logo={source.logo} size={14} />
		</RingButton>
	);
}

/**
 * The rings that did not fit, as one ring with their number. Its card lists
 * every one of them. With one place only it stands for all the sources.
 */
export function MoreUsageRing({
	holdsAll,
	mode,
	onOpen,
	side,
	size,
	sources,
}: {
	holdsAll: boolean;
	mode: UsageBarMode;
	onOpen: () => void;
	side: UsageRingSide;
	size: UsageRingSize;
	sources: readonly UsageRailSource[];
}) {
	const tl = useLiteralMessages();
	return (
		<RingButton
			card={<UsageRailCard mode={mode} sources={sources} />}
			label={moreRingLabel(sources.length, holdsAll, tl)}
			onOpen={onOpen}
			side={side}
			size={size}
			testId="usage-ring-more"
		>
			<svg
				aria-hidden="true"
				className="absolute inset-0.5"
				fill="none"
				viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
			>
				<circle
					className="stroke-current opacity-15"
					cx={RING_CENTER}
					cy={RING_CENTER}
					r={OUTER_RADIUS}
					strokeWidth={RING_STROKE}
				/>
			</svg>
			<span
				aria-hidden="true"
				className="font-semibold text-xs tabular-nums"
				data-ryu-i18n="off"
			>
				{`+${sources.length}`}
			</span>
		</RingButton>
	);
}
