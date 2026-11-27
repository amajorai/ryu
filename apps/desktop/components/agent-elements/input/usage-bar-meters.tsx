"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { UsageBarMode } from "@/src/hooks/useUsageBarPrefs.ts";
import type { UsageMeter, UsageWindow } from "@/src/lib/api/usage.ts";
import {
	expiryClass,
	formatCountdown,
	formatExpiryDate,
} from "@/src/lib/expiry.ts";
import {
	formatMeter,
	formatReset,
	paceDotClass,
	paceStatus,
	shortLabel,
	UsageRing,
	windowKey,
} from "./usage-bar-helpers.tsx";

/** "5h: 88% left" or "5h: 61% used", one whole sentence per mode. */
function usageLine(
	tl: ReturnType<typeof useLiteralMessages>,
	mode: UsageBarMode,
	label: string,
	shown: number
): string {
	const values = { label, percent: Math.round(shown) };
	return mode === "remaining"
		? tl("{label}: {percent}% left", values)
		: tl("{label}: {percent}% used", values);
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

/** One window's line inside a shared tooltip: "Weekly: 61% used · Resets in 3 days". */
export function WindowTooltipRow({
	window: usageWindow,
	mode,
}: {
	window: UsageWindow;
	mode: UsageBarMode;
}) {
	const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
	const shown = mode === "remaining" ? 100 - used : used;
	const tl = useLiteralMessages();
	const reset = formatReset(usageWindow.resetsAt, tl);
	const pace = paceStatus(usageWindow, tl);
	return (
		<span className="font-medium">
			{usageLine(tl, mode, usageWindow.label, shown)}
			{reset ? (
				<span className="ms-1 font-normal text-muted-foreground">
					· {reset}
				</span>
			) : null}
			{pace ? (
				<span className="ms-1 font-normal text-muted-foreground">· {pace}</span>
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
	const reset = formatReset(meter.resetsAt, tl);
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
 * One limit window as its short label and a small ring. The number, the reset
 * time, the pace and the plan live in the tooltip.
 */
export function UsageWindowMeter({
	window: usageWindow,
	plan,
	mode,
}: {
	window: UsageWindow;
	plan: string | null;
	mode: UsageBarMode;
}) {
	const tl = useLiteralMessages();
	const used = Math.max(0, Math.min(100, usageWindow.usedPercent));
	// What the user chose to read off the meter: percent used, or percent left.
	const shown = mode === "remaining" ? 100 - used : used;
	// Color always reflects danger (high usage is red), whichever number is
	// displayed; the arc matches the displayed number.
	const reset = formatReset(usageWindow.resetsAt, tl);
	const pace = paceStatus(usageWindow, tl);
	const paceClass = paceDotClass(usageWindow);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={usageLine(tl, mode, usageWindow.label, shown)}
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
				<UsageRing shown={shown} used={used} />
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<span className="font-medium">
						{usageLine(tl, mode, usageWindow.label, shown)}
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
