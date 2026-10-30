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
	CompactUsageMeter,
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
 * Compact subscription usage meters for the active chat agent (à la CodexBar /
 * openusage). When a subscription ACP agent is active (Claude Code, Codex,
 * Copilot, Grok, GLM), Core reads that CLI's own local credential and returns
 * its rolling rate-limit windows — the 5h "session" window, the weekly window,
 * per-model weekly limits — which render here as tiny labeled bars beside the
 * other composer controls.
 *
 * Alongside them come the figures that aren't percentages: a credit balance,
 * Codex's banked rate-limit resets (a count whose credits each expire on their
 * own date), extra-usage spend. Those render as tiny text chips, since a bar
 * needs a denominator they don't have.
 *
 * Renders nothing unless there is real usage to show — no data, a local model /
 * Gemini / Pi, or an unavailable state (signed out, token expired, rate limited)
 * all just hide the meter, keeping the toolbar clean instead of nagging.
 */
export const UsageBar = memo(function UsageBar({
	agentId,
	className,
	visible,
	compact,
	adaptive = false,
}: {
	agentId: string | null;
	/** Render both densities so the composer can switch at its container width. */
	adaptive?: boolean;
	className?: string;
	/**
	 * Override the "show the meter" gate. Defaults to the shared `visible` pref
	 * (the composer's toggle); the sidebar passes its own independent pref so the
	 * two surfaces can be turned on/off separately while still sharing the look
	 * (bar/percent/mode) prefs.
	 */
	visible?: boolean;
	/**
	 * Collapse every window into a single segmented pill (one segment per window,
	 * no inline labels — all the numbers move into one shared tooltip). Used in
	 * the tight sidebar row where two labeled meters would be too wide; the
	 * roomy composer leaves this off and shows the full labeled meters.
	 */
	compact?: boolean;
}) {
	const usage = useAgentUsage(agentId);
	const prefs = useUsageBarPrefs();
	const isVisible = visible ?? prefs.visible;
	// Show real usage only. Anything else — hidden by the user, no data,
	// unavailable (signed out / expired / rate limited), or nothing to show at
	// all — renders nothing, so the surface stays clean instead of nagging.
	if (!(usage && isVisible && usage.available)) {
		return null;
	}
	// Nothing to draw: neither a percent window nor a non-percent row.
	if (usage.windows.length === 0 && usage.meters.length === 0) {
		return null;
	}
	const compactContent = (
		<div className="flex items-center gap-1">
			{usage.windows.length > 0 ? (
				<CompactUsageMeter
					barStyle={prefs.showBar ? prefs.barStyle : "bar"}
					meters={usage.meters}
					mode={prefs.mode}
					plan={usage.plan}
					windows={usage.windows}
				/>
			) : null}
			{/* With no percent windows to hang the shared tooltip on, the
			    non-percent rows still need their own chips. */}
			{usage.windows.length === 0
				? usage.meters.map((meter) => (
						<MeterChip key={meter.label} meter={meter} plan={usage.plan} />
					))
				: null}
		</div>
	);
	// Bound the inline row. Core can report six rows for one agent (Codex with the
	// Spark limit: four windows plus banked resets and credits), and the composer's
	// control cluster shares its line with the settings menu, the capability badges
	// and the send button. The rest go behind one "+N" chip, mirroring the caret
	// both reference apps hide their secondary metrics behind.
	const inlineWindows = usage.windows.slice(0, INLINE_WINDOW_LIMIT);
	const inlineMeters = usage.meters.slice(0, INLINE_METER_LIMIT);
	const fullContent = (
		<div className="flex items-center gap-1.5">
			{inlineWindows.map((usageWindow) => (
				<UsageWindowMeter
					barStyle={prefs.barStyle}
					key={windowKey(usageWindow)}
					mode={prefs.mode}
					plan={usage.plan}
					showBar={prefs.showBar}
					showPercent={prefs.showPercent}
					window={usageWindow}
				/>
			))}
			{inlineMeters.map((meter) => (
				<MeterChip key={meter.label} meter={meter} plan={usage.plan} />
			))}
			<OverflowChip
				meters={usage.meters.slice(INLINE_METER_LIMIT)}
				mode={prefs.mode}
				plan={usage.plan}
				windows={usage.windows.slice(INLINE_WINDOW_LIMIT)}
			/>
		</div>
	);

	if (adaptive) {
		return (
			<div className={cn("composer-usage-adaptive", className)}>
				<div className="composer-usage-wide">{fullContent}</div>
				<div className="composer-usage-compact">{compactContent}</div>
			</div>
		);
	}
	return compact ? (
		<div className={cn("flex items-center gap-1", className)}>
			{compactContent}
		</div>
	) : (
		<div className={cn("flex items-center gap-1.5", className)}>
			{fullContent}
		</div>
	);
});
