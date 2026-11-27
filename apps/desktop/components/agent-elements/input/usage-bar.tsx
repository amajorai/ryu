"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { memo } from "react";
import { useAgentUsage } from "@/src/hooks/useAgentUsage.ts";
import { useUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import {
	INLINE_METER_LIMIT,
	INLINE_WINDOW_LIMIT,
	windowKey,
} from "./usage-bar-helpers.tsx";
import {
	MeterChip,
	OverflowChip,
	UsageWindowMeter,
} from "./usage-bar-meters.tsx";

export {
	AccountUsageBadge,
	AgentUsageBadge,
	ModelUsageBadge,
	ProviderCreditsBadge,
	ProviderUsageBadge,
} from "./usage-badges.tsx";

/**
 * The subscription usage meters of one sign-in, on a row of the picker's
 * provider list: choosing a provider is where an account level number helps.
 * Core returns the rolling rate-limit windows of that sign-in (the 5h "session"
 * window, the weekly window, per-model weekly limits), which render here as
 * small labeled rings.
 *
 * Alongside them come the figures that aren't percentages: a credit balance,
 * Codex's banked rate-limit resets (a count whose credits each expire on their
 * own date), extra-usage spend. Those render as tiny text chips, since a ring
 * needs a denominator they don't have.
 *
 * The sidebar rows, the composer and the picker's bot rows show no meter: a bot
 * draws from an account pool, so "this bot has X left" says nothing true. The
 * rings at the side of the window (`components/usage-rail`) show the pools.
 *
 * Renders nothing unless there is real usage to show. No data, a local model,
 * or an unavailable state (signed out, token expired, rate limited) all hide
 * the meter, so the row stays clean instead of nagging.
 */
export const UsageBar = memo(function UsageBar({
	agentId,
	className,
}: {
	agentId: string | null;
	className?: string;
}) {
	const usage = useAgentUsage(agentId);
	// Whether the numbers read as what is used or as what is left.
	const { mode } = useUsageBarPrefs();
	if (!usage?.available) {
		return null;
	}
	// Nothing to draw: neither a percent window nor a non-percent row.
	if (usage.windows.length === 0 && usage.meters.length === 0) {
		return null;
	}
	// Bound the inline row. Core can report six rows for one sign-in (Codex with
	// the Spark limit: four windows plus banked resets and credits). The rest go
	// behind one "+N" chip whose tooltip lists them.
	const inlineWindows = usage.windows.slice(0, INLINE_WINDOW_LIMIT);
	const inlineMeters = usage.meters.slice(0, INLINE_METER_LIMIT);
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			{inlineWindows.map((usageWindow) => (
				<UsageWindowMeter
					key={windowKey(usageWindow)}
					mode={mode}
					plan={usage.plan}
					window={usageWindow}
				/>
			))}
			{inlineMeters.map((meter) => (
				<MeterChip key={meter.label} meter={meter} plan={usage.plan} />
			))}
			<OverflowChip
				meters={usage.meters.slice(INLINE_METER_LIMIT)}
				mode={mode}
				plan={usage.plan}
				windows={usage.windows.slice(INLINE_WINDOW_LIMIT)}
			/>
		</div>
	);
});
