import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	BellRing,
	CookingPot,
	Flame,
	HandPlatter,
	Utensils,
} from "lucide-react";
import type { ReactNode } from "react";
import { GameCounter, GameCounters } from "./game-hud.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import type { HudDensity } from "./kitchen-hud-layout.ts";
import type { KitchenService } from "./kitchen-model.ts";

/**
 * Bottom left: today's tally, like the reference's score counter. The
 * cooking count carries the note that its rings are estimates.
 */
export function ServiceScore({
	actTotals,
	density,
	service,
}: {
	/** The act layer's counts, when the host sends asks. */
	actTotals?: ActTotals;
	density: HudDensity;
	service: KitchenService;
}) {
	const tl = useLiteralMessages();
	const { totals } = service;
	if (actTotals) {
		return (
			<ActServiceScore
				compact={density === "narrow"}
				servedToday={totals.servedToday}
				totals={actTotals}
			/>
		);
	}
	const compact = density === "narrow";
	const cookingChefs = service.stations.filter(
		(station) => station.working
	).length;
	const note = tl(
		"{count, plural, one {# chef} other {# chefs}} cooking. Rings estimate each run against that chef's usual run time.",
		{ count: cookingChefs }
	);
	const cookingLabel: ReactNode =
		cookingChefs > 0 && !compact ? (
			<Tooltip>
				<TooltipTrigger
					aria-label={tl("Cooking. {note}", { note })}
					className="cursor-help rounded-sm uppercase underline decoration-(--gk-ink-soft) decoration-dotted underline-offset-4 outline-none focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid"
					type="button"
				>
					Cooking
				</TooltipTrigger>
				<TooltipContent side="top">{note}</TooltipContent>
			</Tooltip>
		) : (
			"Cooking"
		);
	return (
		<GameCounters label="Service totals">
			<GameCounter
				compact={compact}
				icon={<HandPlatter strokeWidth={2.5} />}
				label={compact ? "Served" : "Served today"}
				tone="gold"
				value={totals.servedToday}
			/>
			<GameCounter
				compact={compact}
				icon={<Utensils strokeWidth={2.5} />}
				label="Ready"
				tone="good"
				value={totals.ready}
			/>
			<GameCounter
				compact={compact}
				icon={<CookingPot strokeWidth={2.5} />}
				label={cookingLabel}
				tone="warn"
				value={totals.cooking}
			/>
			{totals.burnt > 0 ? (
				<GameCounter
					compact={compact}
					icon={<Flame strokeWidth={2.5} />}
					label="Burnt"
					tone="bad"
					value={totals.burnt}
				/>
			) : null}
		</GameCounters>
	);
}

/** Today's tally with the act layer's counts (asks, cooking, burnt). */
function ActServiceScore({
	compact,
	servedToday,
	totals,
}: {
	compact: boolean;
	servedToday: number;
	totals: ActTotals;
}) {
	return (
		<GameCounters label="Service totals">
			<GameCounter
				compact={compact}
				icon={<HandPlatter strokeWidth={2.5} />}
				label={compact ? "Served" : "Served today"}
				tone="gold"
				value={servedToday}
			/>
			<GameCounter
				compact={compact}
				icon={<BellRing strokeWidth={2.5} />}
				label="Need you"
				tone="gold"
				value={totals.needYou}
			/>
			<GameCounter
				compact={compact}
				icon={<CookingPot strokeWidth={2.5} />}
				label="Cooking"
				tone="warn"
				value={totals.working}
			/>
			{totals.failed > 0 ? (
				<GameCounter
					compact={compact}
					icon={<Flame strokeWidth={2.5} />}
					label="Burnt"
					tone="bad"
					value={totals.failed}
				/>
			) : null}
		</GameCounters>
	);
}
