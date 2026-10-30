"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import type {
	UsageBarMode,
	UsageBarStyle,
} from "@/src/hooks/useUsageBarPrefs.ts";
import type { UsageMeter, UsageWindow } from "@/src/lib/api/usage.ts";
import {
	expiryClass,
	formatCountdown,
	formatExpiryDate,
} from "@/src/lib/expiry.ts";
import styles from "./usage-bar.module.css";
import {
	COMPACT_SEGMENT_LIMIT,
	fillClass,
	formatMeter,
	formatReset,
	paceDotClass,
	paceStatus,
	shortLabel,
	trackClass,
	UsageRing,
	windowKey,
} from "./usage-bar-helpers.tsx";

interface UsageFillStyle extends CSSProperties {
	"--usage-fill": string;
}

/**
 * A meter's per-credit expiry timeline: every item soonest-first with its exact
 * moment, its countdown, and an urgency dot. Shared by the chip's own tooltip and
 * the overflow tooltip so the timeline is defined once.
 */
function ExpiryTimeline({ expiresAt }: { expiresAt: string[] }) {
	const tl = useLiteralMessages();
	return (
		<>
			{expiresAt.map((expiry, index) => (
				<span
					className="flex items-center gap-1.5 text-muted-foreground"
					key={expiry}
				>
					<span
						aria-hidden="true"
						className={cn("size-1.5 rounded-full", expiryClass(expiry))}
					/>
					<span className="tabular-nums">
						{tl("{index}. expires {date}", {
							index: String(index + 1),
							date: formatExpiryDate(expiry),
						})}
					</span>
					<span className="tabular-nums opacity-70">
						{formatCountdown(expiry)}
					</span>
				</span>
			))}
		</>
	);
}

/** One window's line inside a shared tooltip: "Weekly: 61% used · resets in ~3d". */
export function WindowTooltipRow({
	window: usageWindow,
	mode,
}: {
	window: UsageWindow;
	mode: UsageBarMode;
}) {
	const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
	const shown = mode === "remaining" ? 100 - used : used;
	const reset = formatReset(usageWindow.resetsAt);
	const pace = paceStatus(usageWindow);
	return (
		<span className="font-medium">
			{usageWindow.label}: {Math.round(shown)}%{" "}
			{mode === "remaining" ? "left" : "used"}
			{reset ? (
				<span className="ml-1 font-normal text-muted-foreground">
					· {reset}
				</span>
			) : null}
			{pace ? (
				<span className="ml-1 font-normal text-muted-foreground">· {pace}</span>
			) : null}
		</span>
	);
}

/** One meter's line inside a shared tooltip, with its expiry timeline. */
export function MeterTooltipRow({ meter }: { meter: UsageMeter }) {
	const text = formatMeter(meter);
	if (!text) {
		return null;
	}
	return (
		<>
			<span className="font-medium">
				{meter.label}: {text}
			</span>
			<ExpiryTimeline expiresAt={meter.expiresAt} />
		</>
	);
}

/**
 * One non-percent usage row as a tiny text chip: a credit balance, the count of
 * banked rate-limit resets, extra-usage spend. These have no denominator, so a
 * bar would have to invent one — the number itself is the honest rendering.
 *
 * When the row carries per-item expiries (Codex's banked resets, where every
 * credit expires on its own date), the tooltip lists them soonest-first as a
 * timeline with a countdown and an urgency dot, and the chip itself wears the
 * soonest expiry's hue.
 */
export function MeterChip({
	meter,
	plan,
}: {
	meter: UsageMeter;
	plan: string | null;
}) {
	const tl = useLiteralMessages();
	const text = formatMeter(meter);
	if (!text) {
		return null;
	}
	const soonest = meter.expiresAt.at(0) ?? null;
	const reset = formatReset(meter.resetsAt);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${meter.label}: ${text}`}
						className="flex shrink-0 items-center gap-1 text-muted-foreground/70"
					/>
				}
			>
				{soonest ? (
					<span
						aria-hidden="true"
						className={cn("size-1.5 rounded-full", expiryClass(soonest))}
					/>
				) : null}
				<span className="text-xs tabular-nums">{text}</span>
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<span className="font-medium">
						{meter.label}: {text}
					</span>
					<ExpiryTimeline expiresAt={meter.expiresAt} />
					{reset ? (
						<span className="text-muted-foreground">{reset}</span>
					) : null}
					{plan ? (
						<span className="text-muted-foreground">
							{tl("Plan: {plan}", { plan })}
						</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The rows that didn't fit inline, behind a single "+N" chip whose tooltip lists
 * them in full.
 *
 * Both reference apps do the same thing for the same reason: CodexBar tucks Spark
 * / Spark Weekly under a "show more" caret and openusage puts a provider's
 * secondary metrics in an "On Demand" group. A Codex account with the Spark limit
 * reports four windows plus two non-percent rows, and six inline meters would
 * crowd the composer's control cluster off its line.
 */
export function OverflowChip({
	windows,
	meters,
	mode,
	plan,
}: {
	windows: UsageWindow[];
	meters: UsageMeter[];
	mode: UsageBarMode;
	plan: string | null;
}) {
	const tl = useLiteralMessages();
	const count = windows.length + meters.length;
	if (count === 0) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("{count} more usage meters", {
							count: String(count),
						})}
						className="shrink-0 text-muted-foreground/70 text-xs tabular-nums"
					/>
				}
			>
				+{count}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{windows.map((usageWindow) => (
						<WindowTooltipRow
							key={windowKey(usageWindow)}
							mode={mode}
							window={usageWindow}
						/>
					))}
					{meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					{plan ? (
						<span className="text-muted-foreground">
							{tl("Plan: {plan}", { plan })}
						</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * All of an agent's usage windows collapsed into one short segmented pill — one
 * equal-width segment per window (5h, 7d), each filled and colored by its own
 * danger level, with no inline labels. Every number lives in a single shared
 * tooltip. This is the tight-space variant (the sidebar row) where the composer's
 * full labeled meters would be too wide.
 */
export function CompactUsageMeter({
	windows,
	meters,
	plan,
	mode,
	barStyle,
}: {
	windows: UsageWindow[];
	/** The non-percent rows, folded into this pill's shared tooltip. */
	meters: UsageMeter[];
	plan: string | null;
	mode: UsageBarMode;
	barStyle: UsageBarStyle;
}) {
	const tl = useLiteralMessages();
	const noun = mode === "remaining" ? "left" : "used";
	const isRing = barStyle === "ring";
	// Screen-reader summary: "Usage — 5h: 88% left, 7d: 61% left".
	const label = windows
		.map((w) => {
			const used = Math.max(0, Math.min(100, w.usedPercent));
			const shown = mode === "remaining" ? 100 - used : used;
			return `${shortLabel(w)}: ${Math.round(shown)}% ${noun}`;
		})
		.join(", ");
	// The pill is decorative — every number lives in the tooltip below, which
	// always lists all of them. So cap the drawn segments: a fixed-width bar split
	// six ways is unreadable, and in ring mode six 14px rings are wider than the
	// sidebar row the compact variant exists to fit.
	const segments = windows.slice(0, COMPACT_SEGMENT_LIMIT);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("Usage — {label}", { label })}
						className={cn(
							"flex shrink-0 items-center",
							isRing ? "gap-0.5" : "h-1.5 w-10 gap-px"
						)}
						role="img"
					/>
				}
			>
				{segments.map((usageWindow) => {
					const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
					const shown = mode === "remaining" ? 100 - used : used;
					const fillStyle: UsageFillStyle = { "--usage-fill": `${shown}%` };
					if (isRing) {
						return (
							<UsageRing
								key={windowKey(usageWindow)}
								shown={shown}
								used={used}
							/>
						);
					}
					return (
						<span
							className={cn(
								"h-full flex-1 overflow-hidden rounded-full",
								trackClass(used)
							)}
							key={windowKey(usageWindow)}
						>
							<span
								className={cn(
									styles.linearFill,
									"block h-full rounded-full",
									fillClass(used)
								)}
								style={fillStyle}
							/>
						</span>
					);
				})}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{windows.map((usageWindow) => (
						<WindowTooltipRow
							key={windowKey(usageWindow)}
							mode={mode}
							window={usageWindow}
						/>
					))}
					{meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					{plan ? (
						<span className="text-muted-foreground">
							{tl("Plan: {plan}", { plan })}
						</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

export function UsageWindowMeter({
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
	const tl = useLiteralMessages();
	const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
	// What the user chose to read off the meter: percent used, or percent left.
	const shown = mode === "remaining" ? 100 - used : used;
	const fillStyle: UsageFillStyle = { "--usage-fill": `${shown}%` };
	const noun = mode === "remaining" ? "left" : "used";
	// Color always reflects danger (high usage → red), regardless of which
	// number is displayed; the bar fill matches the displayed number.
	const reset = formatReset(usageWindow.resetsAt);
	const pace = paceStatus(usageWindow);
	const paceClass = paceDotClass(usageWindow);
	const linearBar = (
		<span
			className={cn("h-1 w-8 overflow-hidden rounded-full", trackClass(used))}
		>
			<span
				className={cn(
					styles.linearFill,
					"block h-full rounded-full",
					fillClass(used)
				)}
				style={fillStyle}
			/>
		</span>
	);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${usageWindow.label}: ${Math.round(shown)}% ${noun}`}
						className="flex shrink-0 items-center gap-1 text-muted-foreground/70"
					/>
				}
			>
				<span className="text-xs tabular-nums">{shortLabel(usageWindow)}</span>
				{pace ? (
					<span
						aria-hidden="true"
						className={cn("size-1 rounded-full", paceClass)}
					/>
				) : null}
				{showBar &&
					(barStyle === "ring" ? (
						<UsageRing shown={shown} used={used} />
					) : (
						linearBar
					))}
				{showPercent ? (
					<span className="text-xs tabular-nums">{Math.round(shown)}%</span>
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
					{pace ? <span className="text-muted-foreground">{pace}</span> : null}
					{plan ? (
						<span className="text-muted-foreground">
							{tl("Plan: {plan}", { plan })}
						</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
