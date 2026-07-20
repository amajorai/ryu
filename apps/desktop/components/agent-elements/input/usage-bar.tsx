"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";
import { useAgentUsage } from "@/src/hooks/useAgentUsage.ts";
import {
	type UsageBarMode,
	type UsageBarStyle,
	useUsageBarPrefs,
} from "@/src/hooks/useUsageBarPrefs.ts";
import type { UsageWindow } from "@/src/lib/api/usage.ts";

/**
 * Compact subscription usage meters for the active chat agent (à la CodexBar /
 * openusage). When a subscription ACP agent is active (Claude Code, Codex), Core
 * reads that CLI's own local OAuth token and returns its rolling rate-limit
 * windows — the 5h "session" window and the weekly window — which render here as
 * tiny labeled bars beside the other composer controls.
 *
 * Renders nothing unless there are real usage windows to show — no data, a
 * local model / Gemini / Pi, or an unavailable state (signed out, token
 * expired, rate limited) all just hide the meter, keeping the toolbar clean
 * instead of nagging.
 */
export const UsageBar = memo(function UsageBar({
	agentId,
	className,
	visible,
	compact,
}: {
	agentId: string | null;
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
	// Show real usage windows only. Anything else — hidden by the user, no data,
	// unavailable (signed out / expired / rate limited), or zero windows —
	// renders nothing, so the surface stays clean instead of nagging.
	if (!(usage && isVisible && usage.available) || usage.windows.length === 0) {
		return null;
	}
	if (compact) {
		return (
			<div className={cn("flex items-center", className)}>
				<CompactUsageMeter
					barStyle={prefs.showBar ? prefs.barStyle : "bar"}
					mode={prefs.mode}
					plan={usage.plan}
					windows={usage.windows}
				/>
			</div>
		);
	}
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			{usage.windows.map((usageWindow) => (
				<UsageMeter
					barStyle={prefs.barStyle}
					key={usageWindow.label}
					mode={prefs.mode}
					plan={usage.plan}
					showBar={prefs.showBar}
					showPercent={prefs.showPercent}
					window={usageWindow}
				/>
			))}
		</div>
	);
});

/** Threshold colors for the filled portion: calm → amber → red as it fills. */
function fillClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "bg-red-500";
	}
	if (usedPercent >= 70) {
		return "bg-amber-500";
	}
	return "bg-emerald-500";
}

/** Same threshold hue as the fill, dimmed to /20 for the unfilled track — barely
 *  tinted so it reads against the muted composer without the fill's brightness
 *  bleeding into the empty space. */
function trackClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "bg-red-500/20";
	}
	if (usedPercent >= 70) {
		return "bg-amber-500/20";
	}
	return "bg-emerald-500/20";
}

/** Ring equivalent of `fillClass`: the same calm → amber → red danger hue, but as
 *  an SVG stroke color for the circular meter. */
function fillStrokeClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "stroke-red-500";
	}
	if (usedPercent >= 70) {
		return "stroke-amber-500";
	}
	return "stroke-emerald-500";
}

/** Ring equivalent of `trackClass`: the dimmed unfilled track as an SVG stroke. */
function trackStrokeClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "stroke-red-500/20";
	}
	if (usedPercent >= 70) {
		return "stroke-amber-500/20";
	}
	return "stroke-emerald-500/20";
}

// Geometry for the circular meter, shared by every ring so the dasharray math is
// computed once. r = 6 in a 16×16 viewBox leaves room for the stroke width.
const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A tiny circular progress ring — the "ring" counterpart of the linear bar. `used`
 * drives the danger color (high usage → red); `shown` drives the swept arc, so it
 * matches whichever number (used / remaining) the meter displays. Starts at 12
 * o'clock and sweeps clockwise via the -90° rotation.
 */
function UsageRing({ used, shown }: { used: number; shown: number }) {
	const offset =
		RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, shown)) / 100);
	return (
		<svg
			aria-hidden="true"
			className="size-3.5 -rotate-90"
			fill="none"
			viewBox="0 0 16 16"
		>
			<circle
				className={trackStrokeClass(used)}
				cx="8"
				cy="8"
				r={RING_RADIUS}
				strokeWidth="2.5"
			/>
			<circle
				className={fillStrokeClass(used)}
				cx="8"
				cy="8"
				r={RING_RADIUS}
				strokeDasharray={RING_CIRCUMFERENCE}
				strokeDashoffset={offset}
				strokeLinecap="round"
				strokeWidth="2.5"
			/>
		</svg>
	);
}

/** Short axis label: "Session" → "5h", "Weekly" → "7d", "Sonnet weekly" → "Sonnet". */
function shortLabel(label: string): string {
	if (label === "Session") {
		return "5h";
	}
	if (label === "Weekly") {
		return "7d";
	}
	if (label === "Sonnet weekly") {
		return "Sonnet";
	}
	return label;
}

/** "resets in ~3h" / "resets in ~12m" / "" when unknown or already past. */
function formatReset(resetsAt: string | null): string {
	if (!resetsAt) {
		return "";
	}
	const resetMs = Date.parse(resetsAt);
	if (Number.isNaN(resetMs)) {
		return "";
	}
	const diffMinutes = Math.round((resetMs - Date.now()) / 60_000);
	if (diffMinutes <= 0) {
		return "resets soon";
	}
	if (diffMinutes < 60) {
		return `resets in ~${diffMinutes}m`;
	}
	const hours = Math.round(diffMinutes / 60);
	if (hours < 48) {
		return `resets in ~${hours}h`;
	}
	return `resets in ~${Math.round(hours / 24)}d`;
}

/**
 * All of an agent's usage windows collapsed into one short segmented pill — one
 * equal-width segment per window (5h, 7d), each filled and colored by its own
 * danger level, with no inline labels. Every number lives in a single shared
 * tooltip. This is the tight-space variant (the sidebar row) where the composer's
 * full labeled meters would be too wide.
 */
function CompactUsageMeter({
	windows,
	plan,
	mode,
	barStyle,
}: {
	windows: UsageWindow[];
	plan: string | null;
	mode: UsageBarMode;
	barStyle: UsageBarStyle;
}) {
	const noun = mode === "remaining" ? "left" : "used";
	const isRing = barStyle === "ring";
	// Screen-reader summary: "Usage — 5h: 88% left, 7d: 61% left".
	const label = windows
		.map((w) => {
			const used = Math.max(0, Math.min(100, w.usedPercent));
			const shown = mode === "remaining" ? 100 - used : used;
			return `${shortLabel(w.label)}: ${Math.round(shown)}% ${noun}`;
		})
		.join(", ");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`Usage — ${label}`}
						className={cn(
							"flex items-center",
							isRing ? "gap-0.5" : "h-1.5 w-10 gap-px"
						)}
						role="img"
					/>
				}
			>
				{windows.map((usageWindow) => {
					const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
					const shown = mode === "remaining" ? 100 - used : used;
					if (isRing) {
						return (
							<UsageRing key={usageWindow.label} shown={shown} used={used} />
						);
					}
					return (
						<span
							className={cn(
								"h-full flex-1 overflow-hidden rounded-full",
								trackClass(used)
							)}
							key={usageWindow.label}
						>
							<span
								className={cn("block h-full rounded-full", fillClass(used))}
								style={{ width: `${shown}%` }}
							/>
						</span>
					);
				})}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{windows.map((usageWindow) => {
						const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
						const shown = mode === "remaining" ? 100 - used : used;
						const reset = formatReset(usageWindow.resetsAt);
						return (
							<span className="font-medium" key={usageWindow.label}>
								{usageWindow.label}: {Math.round(shown)}% {noun}
								{reset ? (
									<span className="ml-1 font-normal text-muted-foreground">
										· {reset}
									</span>
								) : null}
							</span>
						);
					})}
					{plan ? (
						<span className="text-muted-foreground">Plan: {plan}</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function UsageMeter({
	window: usageWindow,
	plan,
	mode,
	showBar,
	barStyle,
	showPercent,
}: {
	window: UsageWindow;
	plan: string | null;
	mode: UsageBarMode;
	showBar: boolean;
	barStyle: UsageBarStyle;
	showPercent: boolean;
}) {
	const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
	// What the user chose to read off the meter: percent used, or percent left.
	const shown = mode === "remaining" ? 100 - used : used;
	const noun = mode === "remaining" ? "left" : "used";
	// Color always reflects danger (high usage → red), regardless of which
	// number is displayed; the bar fill matches the displayed number.
	const reset = formatReset(usageWindow.resetsAt);
	const linearBar = (
		<span
			className={cn("h-1 w-8 overflow-hidden rounded-full", trackClass(used))}
		>
			<span
				className={cn("block h-full rounded-full", fillClass(used))}
				style={{ width: `${shown}%` }}
			/>
		</span>
	);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${usageWindow.label}: ${Math.round(shown)}% ${noun}`}
						className="flex items-center gap-1 text-muted-foreground/70"
					/>
				}
			>
				<span className="text-[10px] tabular-nums">
					{shortLabel(usageWindow.label)}
				</span>
				{showBar &&
					(barStyle === "ring" ? (
						<UsageRing shown={shown} used={used} />
					) : (
						linearBar
					))}
				{showPercent ? (
					<span className="text-[10px] tabular-nums">{Math.round(shown)}%</span>
				) : null}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<span className="font-medium">
						{usageWindow.label}: {Math.round(shown)}% {noun}
					</span>
					{reset ? (
						<span className="text-muted-foreground">{reset}</span>
					) : null}
					{plan ? (
						<span className="text-muted-foreground">Plan: {plan}</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
