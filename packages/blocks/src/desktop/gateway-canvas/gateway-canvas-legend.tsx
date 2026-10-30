"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import { Lock } from "lucide-react";
import { EDGE_STROKE, OUTCOME_COLOR } from "./edges.tsx";
import { META } from "./gateway-canvas-constants.ts";
import {
	type CanvasEdgeKind,
	MAX_PULSES_PER_SECOND,
	OUTCOME_LABELS,
	type PulseOutcome,
} from "./model.ts";
import { HealthDot } from "./nodes.tsx";

function LegendLine({ kind }: { kind: CanvasEdgeKind }) {
	return (
		<svg aria-hidden="true" height="12" viewBox="0 0 24 12" width="24">
			<line style={EDGE_STROKE[kind]} x1="2" x2="22" y1="6" y2="6" />
		</svg>
	);
}

function LegendDot({ outcome }: { outcome: PulseOutcome }) {
	return (
		<span
			aria-hidden="true"
			className="size-2 rounded-full"
			style={{ background: OUTCOME_COLOR[outcome] }}
		/>
	);
}

const LEGEND_OUTCOMES: PulseOutcome[] = [
	"allow",
	"redacted",
	"block",
	"cache_hit",
	"degraded",
	"error",
];

export function CanvasLegend({ motion }: { motion: boolean }) {
	const tl = useLiteralMessages();
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						className={cn(
							"h-7 px-2 text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
							META
						)}
						size="xs"
						type="button"
						variant="ghost"
					/>
				}
			>
				Legend
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-64 gap-0 rounded-lg border-border bg-background p-3 shadow-none"
				side="bottom"
				sideOffset={6}
			>
				<ul aria-label="Legend" className={cn("flex flex-col gap-2", META)}>
					{LEGEND_OUTCOMES.map((outcome) => (
						<li className="flex h-4 items-center gap-2" key={outcome}>
							<span className="flex w-6 justify-center">
								<LegendDot outcome={outcome} />
							</span>
							{OUTCOME_LABELS[outcome]}
						</li>
					))}
					<li className="flex h-4 items-center gap-2">
						<LegendLine kind="traffic" />
						Request path
					</li>
					<li className="flex h-4 items-center gap-2">
						<LegendLine kind="control" />
						Configuration and health
					</li>
					<li className="flex h-4 items-center gap-2">
						<span className="flex w-6 justify-center">
							<Lock aria-hidden="true" className="size-3" />
						</span>
						Fixed by Ryu or the pipeline
					</li>
					<li className="flex h-4 items-center gap-2">
						<span className="flex w-6 justify-center">
							<HealthDot health="degraded" />
						</span>
						Degraded or down
					</li>
				</ul>
				<p className={cn("mt-3 text-muted-foreground", META)}>
					{motion
						? tl(
								"A blocked request stops at the layer that refused it. At most {MAX_PULSES_PER_SECOND} requests a second are drawn; counts include every request.",
								{ MAX_PULSES_PER_SECOND }
							)
						: "Motion is reduced, so requests are counted but not animated."}
				</p>
			</PopoverContent>
		</Popover>
	);
}
