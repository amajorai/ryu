"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, memo } from "react";
import { useAgentUsage } from "@/src/hooks/useAgentUsage.ts";
import { useProviderCredits } from "@/src/hooks/useProviderCredits.ts";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import {
	type UsageBarMode,
	type UsageBarStyle,
	useUsageBarPrefs,
} from "@/src/hooks/useUsageBarPrefs.ts";
import {
	type SubscriptionAccount,
	type UsageMeter,
	type UsageValue,
	type UsageWindow,
	usageSnapshotFromReading,
} from "@/src/lib/api/usage.ts";
import {
	expiryClass,
	formatCountdown,
	formatExpiryDate,
} from "@/src/lib/expiry.ts";
import styles from "./usage-bar.module.css";

interface UsageFillStyle extends CSSProperties {
	"--usage-fill": string;
}

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

/**
 * How many of each row kind the non-compact bar shows inline before the rest move
 * into the "+N" overflow chip. Two windows is the canonical Session/Weekly pair
 * every vendor reports (Core emits them first); one meter covers the single row
 * that is usually worth watching — a credit balance, or banked resets that are
 * about to expire.
 */
const INLINE_WINDOW_LIMIT = 2;
const INLINE_METER_LIMIT = 1;

/**
 * How many segments the compact pill draws. Purely visual — its tooltip lists
 * every window and meter regardless of this cap.
 */
const COMPACT_SEGMENT_LIMIT = 3;

/** Threshold colors for the filled portion: calm → amber → red as it fills. */
function fillClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "bg-destructive";
	}
	if (usedPercent >= 70) {
		return "bg-warning";
	}
	return "bg-success";
}

/** Same threshold hue as the fill, dimmed to /20 for the unfilled track — barely
 *  tinted so it reads against the muted composer without the fill's brightness
 *  bleeding into the empty space. */
function trackClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "bg-destructive/20";
	}
	if (usedPercent >= 70) {
		return "bg-warning/20";
	}
	return "bg-success/20";
}

/** Ring equivalent of `fillClass`: the same calm → amber → red danger hue, but as
 *  an SVG stroke color for the circular meter. */
function fillStrokeClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "stroke-destructive";
	}
	if (usedPercent >= 70) {
		return "stroke-warning";
	}
	return "stroke-success";
}

/** Ring equivalent of `trackClass`: the dimmed unfilled track as an SVG stroke. */
function trackStrokeClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "stroke-destructive/20";
	}
	if (usedPercent >= 70) {
		return "stroke-warning/20";
	}
	return "stroke-success/20";
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

const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

/**
 * Short axis label. The two rolling windows every vendor reports collapse to
 * their duration ("5h" / "7d") when the vendor told us how long the window is —
 * so a per-model or vendor-specific window ("Sonnet", "Spark", "Web searches")
 * keeps its own name instead of needing a case here. Labels are data now: Core
 * reads Claude's per-model weekly limits straight out of the API's `limits`
 * array, so this can't be a closed set.
 */
/**
 * React key for a window. Labels alone aren't guaranteed unique — a vendor can
 * report two windows of different lengths whose canonical names collide, and Core
 * names them from the data — so the length participates in the key.
 */
function windowKey(usageWindow: UsageWindow): string {
	return `${usageWindow.label}:${usageWindow.windowSeconds ?? "?"}`;
}

function shortLabel(usageWindow: UsageWindow): string {
	const { label, windowSeconds } = usageWindow;
	if (label !== "Session" && label !== "Weekly") {
		return label;
	}
	if (windowSeconds === null || windowSeconds <= 0) {
		return label === "Session" ? "5h" : "7d";
	}
	const hours = Math.round(windowSeconds / SECONDS_PER_HOUR);
	if (hours < HOURS_PER_DAY) {
		return `${hours}h`;
	}
	return `${Math.round(hours / HOURS_PER_DAY)}d`;
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
 * Compare actual consumption with an even burn over the window. A 7-day window
 * that has elapsed one day expects roughly 14%; consuming 50% is therefore 36
 * points in deficit. Unknown dates deliberately produce no pace claim.
 */
function paceStatus(usageWindow: UsageWindow): string | null {
	if (
		!(usageWindow.resetsAt && usageWindow.windowSeconds) ||
		usageWindow.windowSeconds <= 0
	) {
		return null;
	}
	const reset = Date.parse(usageWindow.resetsAt);
	if (Number.isNaN(reset)) {
		return null;
	}
	const expected = Math.max(
		0,
		Math.min(
			100,
			100 * (1 - (reset - Date.now()) / (usageWindow.windowSeconds * 1000))
		)
	);
	const difference = usageWindow.usedPercent - expected;
	if (Math.abs(difference) < 1) {
		return "on pace";
	}
	return difference > 0
		? `${Math.round(difference)}% in deficit`
		: `${Math.round(-difference)}% in reserve`;
}

function paceDotClass(usageWindow: UsageWindow): string {
	const status = paceStatus(usageWindow);
	if (status?.includes("deficit")) {
		return "bg-destructive";
	}
	if (status?.includes("reserve")) {
		return "bg-success";
	}
	return "bg-muted-foreground/40";
}

function formatDollars(value: number): string {
	return formatCurrency(value, "USD", {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
	});
}

/** "$32.84" / "821 credits" / "42%" — one figure, formatted for its kind. */
function formatValue(value: UsageValue): string {
	if (value.kind === "dollars") {
		return formatDollars(value.number);
	}
	if (value.kind === "percent") {
		return `${Math.round(value.number)}%`;
	}
	const count = formatCount(value.number) ?? "—";
	return value.unit ? `${count} ${value.unit}` : count;
}

/**
 * The chip text for a whole row. A pair of same-kind figures is a
 * value-against-cap ("$2.50/$25.00", "120/3000"); anything else shows its
 * leading figure with its unit ("2 available", "$32.84").
 */
function formatMeter(meter: UsageMeter): string {
	const [first, second] = meter.values;
	if (!first) {
		return "";
	}
	if (second && second.kind === first.kind) {
		const cap =
			second.kind === "dollars"
				? formatDollars(second.number)
				: (formatCount(second.number) ?? "—");
		const used =
			first.kind === "dollars"
				? formatDollars(first.number)
				: (formatCount(first.number) ?? "—");
		return `${used}/${cap}`;
	}
	return formatValue(first);
}

/**
 * A meter's per-credit expiry timeline: every item soonest-first with its exact
 * moment, its countdown, and an urgency dot. Shared by the chip's own tooltip and
 * the overflow tooltip so the timeline is defined once.
 */
function ExpiryTimeline({ expiresAt }: { expiresAt: string[] }) {
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
						{index + 1}. expires {formatExpiryDate(expiry)}
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
function WindowTooltipRow({
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
function MeterTooltipRow({ meter }: { meter: UsageMeter }) {
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
function MeterChip({
	meter,
	plan,
}: {
	meter: UsageMeter;
	plan: string | null;
}) {
	const text = formatMeter(meter);
	if (!text) {
		return null;
	}
	const soonest = meter.expiresAt.at(0) ?? null;
	const reset = formatReset(meter.resetsAt);
	const isMoney = meter.values[0]?.kind === "dollars";
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
				<span
					className={cn("type-compact tabular-nums", isMoney && "font-mono")}
				>
					{text}
				</span>
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
						<span className="text-muted-foreground">Plan: {plan}</span>
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
function OverflowChip({
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
	const count = windows.length + meters.length;
	if (count === 0) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${count} more usage meters`}
						className="type-compact shrink-0 text-muted-foreground/70 tabular-nums"
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
						<span className="text-muted-foreground">Plan: {plan}</span>
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
function CompactUsageMeter({
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
						aria-label={`Usage — ${label}`}
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
						<span className="text-muted-foreground">Plan: {plan}</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function UsageWindowMeter({
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
				<span className="type-compact tabular-nums">
					{shortLabel(usageWindow)}
				</span>
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
					<span className="type-compact tabular-nums">
						{Math.round(shown)}%
					</span>
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
						<span className="text-muted-foreground">Plan: {plan}</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The agent picker's per-row usage indicator: the tightest possible read of an
 * agent's subscription headroom, for the row you are about to pick.
 *
 * Shows the single most-consumed window as `NN%` (the one that will bite first),
 * coloured by the same calm → amber → red danger scale as the composer bar, with
 * the full breakdown — every window, every non-percent row, the plan — in its
 * tooltip. Deliberately not the full `UsageBar`: a picker row already carries a
 * logo, a name and a checkmark, and a meter per window would not fit.
 *
 * Renders nothing whenever there is nothing real to show, so a row for an agent
 * with no subscription window (or one that is signed out) looks exactly as it did
 * before this existed.
 *
 * Cost note: one of these mounts per installed subscription-agent row, so opening
 * the picker can touch several vendor endpoints. They share `useAgentUsage`'s
 * query key and its 5-minute `staleTime` with the composer bar, and TanStack's
 * `refetchOnWindowFocus` is stale-gated (`shouldFetchOn` → `isStale`), so a focus
 * cannot fan out a burst — a given agent is polled at most once per 5 minutes no
 * matter how many badges are mounted.
 */
export const AgentUsageBadge = memo(function AgentUsageBadge({
	agentId,
	className,
}: {
	agentId: string;
	className?: string;
}) {
	const usage = useAgentUsage(agentId);
	if (!usage?.available) {
		return null;
	}
	// The ACCOUNT-WIDE window closest to its cap. Model-scoped windows are excluded
	// deliberately: they have their own badges on their own model rows, and folding
	// them in here would read as "this agent is nearly out" when only one model's
	// weekly limit is exhausted — sending the user to a different agent when
	// switching model was free.
	const worst = worstWindow(
		usage.windows.filter((usageWindow) => usageWindow.model === null)
	);
	if (!(worst || usage.meters.length > 0)) {
		return null;
	}
	const used = worst ? Math.max(0, Math.min(100, worst.usedPercent)) : 0;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={
							worst
								? `${worst.label}: ${Math.round(used)}% used`
								: "Subscription usage"
						}
						className={cn(
							"type-compact shrink-0 tabular-nums",
							worst ? usageTextClass(used) : "text-muted-foreground/70",
							className
						)}
					/>
				}
			>
				{worst ? `${Math.round(used)}%` : formatMeter(usage.meters[0])}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{usage.windows.map((usageWindow) => (
						<WindowTooltipRow
							key={windowKey(usageWindow)}
							mode="used"
							window={usageWindow}
						/>
					))}
					{usage.meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					{usage.plan ? (
						<span className="text-muted-foreground">Plan: {usage.plan}</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * The worst account-wide window of one saved account's reading, as the picker's
 * one-number read. `null` when there is no live account-wide window.
 */
function accountWorstWindow(account: SubscriptionAccount): UsageWindow | null {
	if (!account.usage?.available) {
		return null;
	}
	return worstWindow(
		usageSnapshotFromReading(account.usage).windows.filter(
			(usageWindow) => usageWindow.model === null
		)
	);
}

/** Why an account has no number, in the words the tooltip uses. */
function accountStateText(account: SubscriptionAccount): string {
	switch (account.state) {
		case "needs_reauth":
			return "needs a new sign-in";
		case "pool_disabled":
			return "off in account routing";
		case "unsupported":
			return "no usage reported";
		case "pending":
			return "checking…";
		default:
			return account.usage?.available === false
				? "usage unavailable"
				: "no reading yet";
	}
}

/** One account's line in a provider tooltip: "Work (active): 61% used". */
function AccountTooltipRow({ account }: { account: SubscriptionAccount }) {
	const worst = accountWorstWindow(account);
	const name = account.label ?? "Saved account";
	return (
		<span className="font-medium">
			{name}
			{account.active ? (
				<span className="font-normal text-muted-foreground"> (active)</span>
			) : null}
			:{" "}
			{worst ? (
				<span className="tabular-nums">
					{Math.round(Math.max(0, Math.min(100, worst.usedPercent)))}% used
					<span className="ml-1 font-normal text-muted-foreground">
						· {worst.label}
					</span>
				</span>
			) : (
				<span className="font-normal text-muted-foreground">
					{accountStateText(account)}
				</span>
			)}
		</span>
	);
}

/**
 * The picker badge for a Ryu subscription provider logged in through the
 * managed Pi: the ACTIVE account's tightest account-wide window as `NN%`, with a
 * tooltip listing every saved account. Shares the ACP badge's colour scale.
 *
 * Reads Core's subscriptions snapshot for this provider, so every account's
 * number comes from one request and the same cached readings the usage page and
 * account-routing settings show. Renders nothing when Core reports no
 * per-account usage for the provider.
 */
export const ProviderUsageBadge = memo(function ProviderUsageBadge({
	className,
	providerId,
}: {
	className?: string;
	providerId: string;
}) {
	const { data } = useSubscriptions({ providerId, usage: "refresh" });
	const provider = data?.providers.find(
		(entry) => entry.providerId === providerId
	);
	if (!(provider?.capabilities.accountUsage && provider.accounts.length > 0)) {
		return null;
	}
	const activeAccount =
		provider.accounts.find((account) => account.active) ?? null;
	const worst = activeAccount ? accountWorstWindow(activeAccount) : null;
	const used = worst ? Math.max(0, Math.min(100, worst.usedPercent)) : 0;
	const label = activeAccount?.label ?? provider.label;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={
							worst
								? `${label}: ${worst.label} ${Math.round(used)}% used`
								: `${provider.label} account usage`
						}
						className={cn(
							"type-compact shrink-0 tabular-nums",
							worst ? usageTextClass(used) : "text-muted-foreground/70",
							className
						)}
					/>
				}
			>
				{worst ? `${Math.round(used)}%` : "—"}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{provider.accounts.map((account) => (
						<AccountTooltipRow account={account} key={account.accountId} />
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * One saved account's usage as the same `NN%` badge, for a per-account list.
 * Purely presentational: it renders the reading Core put in the subscriptions
 * snapshot and never asks for one itself, so an account Core will not read (a
 * login that needs a new sign-in, one switched off in routing) stays unread.
 */
export const AccountUsageBadge = memo(function AccountUsageBadge({
	account,
	className,
}: {
	account: SubscriptionAccount;
	className?: string;
}) {
	const worst = accountWorstWindow(account);
	const snapshot =
		account.usage?.available === true
			? usageSnapshotFromReading(account.usage)
			: null;
	const name = account.label ?? "Saved account";
	if (!(worst && snapshot)) {
		return (
			<span
				className={cn(
					"type-compact shrink-0 text-muted-foreground/70",
					className
				)}
			>
				{accountStateText(account)}
			</span>
		);
	}
	const used = Math.max(0, Math.min(100, worst.usedPercent));
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${name}: ${worst.label} ${Math.round(used)}% used`}
						className={cn(
							"type-compact shrink-0 tabular-nums",
							usageTextClass(used),
							className
						)}
					/>
				}
			>
				{Math.round(used)}%
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{snapshot.windows.map((usageWindow) => (
						<WindowTooltipRow
							key={windowKey(usageWindow)}
							mode="used"
							window={usageWindow}
						/>
					))}
					{snapshot.meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					{snapshot.plan ? (
						<span className="text-muted-foreground">Plan: {snapshot.plan}</span>
					) : null}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * The window closest to its cap — the one that stops the next turn, which is the
 * only thing a one-number badge can usefully say. `null` for an empty list.
 */
function worstWindow(windows: UsageWindow[]): UsageWindow | null {
	return windows.reduce<UsageWindow | null>(
		(peak, candidate) =>
			peak === null || candidate.usedPercent > peak.usedPercent
				? candidate
				: peak,
		null
	);
}

/** Text-colour counterpart of `fillClass`, for the picker badge's bare number. */
function usageTextClass(usedPercent: number): string {
	if (usedPercent >= 90) {
		return "text-status-destructive";
	}
	if (usedPercent >= 70) {
		return "text-status-warning";
	}
	return "text-muted-foreground/70";
}

/**
 * Normalize a model name for matching: lowercase, strip everything that isn't a
 * letter or digit. `"GPT-5.3-Codex-Spark"` and `"gpt_5_3_codex_spark"` collapse
 * to the same token, so punctuation drift between the vendor's limit name and
 * the model id in the picker can't break the match.
 */
function normalizeModel(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

/**
 * The per-model quota badge for a model row inside an agent's submenu: Claude's
 * weekly Sonnet / Opus limits, Codex's Spark pair.
 *
 * Matched on `UsageWindow.model` — which Core reports explicitly — rather than on
 * the window's label. Inferring "a label that isn't Session or Weekly names a
 * model" would need a closed set of non-model labels, and Copilot's `Chat` /
 * `Completions` and Z.ai's `Daily` are exactly what such a set misses; hanging an
 * account-wide quota off a model row because they shared a word is worse than
 * showing nothing.
 *
 * Renders nothing when this model has no window of its own, which is the common
 * case — most models draw on the account-wide pool the row's agent badge shows.
 */
export const ModelUsageBadge = memo(function ModelUsageBadge({
	agentId,
	modelId,
	modelName,
}: {
	agentId: string;
	modelId: string;
	modelName?: string;
}) {
	const usage = useAgentUsage(agentId);
	if (!usage?.available) {
		return null;
	}
	const haystack = normalizeModel(`${modelId} ${modelName ?? ""}`);
	// A model can have MORE than one window of its own — Codex meters Spark on both
	// a 5h and a weekly limit — so take the one closest to its cap, exactly as the
	// agent badge does. Taking the first would hide a Spark weekly at 95% behind a
	// session at 3%.
	const scoped = worstWindow(
		usage.windows.filter((usageWindow) => {
			if (!usageWindow.model) {
				return false;
			}
			const needle = normalizeModel(usageWindow.model);
			return needle.length > 0 && haystack.includes(needle);
		})
	);
	if (!scoped) {
		return null;
	}
	const used = Math.max(0, Math.min(100, scoped.usedPercent));
	const reset = formatReset(scoped.resetsAt);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${scoped.label}: ${Math.round(used)}% used`}
						className={cn(
							"type-compact shrink-0 tabular-nums",
							usageTextClass(used)
						)}
					/>
				}
			>
				{Math.round(used)}%
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<WindowTooltipRow mode="used" window={scoped} />
					{reset ? null : (
						<span className="text-muted-foreground">
							This model has its own limit.
						</span>
					)}
				</div>
			</TooltipContent>
		</Tooltip>
	);
});

/**
 * A BYOK provider's remaining prepaid API credit, on its picker row: "$37.75".
 *
 * Only three providers expose a balance to the inference key you already hold
 * (OpenRouter, DeepSeek, Moonshot) — `useProviderCredits` gates the query on
 * that, so the ~13 that don't cost nothing. Anything unavailable renders
 * nothing: a row that suddenly shows an error chip is worse than one that shows
 * no chip, and `$0.00` for "we couldn't ask" would be a lie about their money.
 */
export const ProviderCreditsBadge = memo(function ProviderCreditsBadge({
	providerId,
	label,
}: {
	providerId: string;
	label: string;
}) {
	const credits = useProviderCredits(providerId);
	const meters = credits?.available ? credits.meters : [];
	const balance = meters.at(0);
	if (!balance) {
		return null;
	}
	// The leading figure only. Core emits granted/voucher money as its OWN meter
	// precisely so it can't be rendered as a "$9.87/$1.23" ratio; the chip shows
	// the balance and the tooltip lists the rest.
	const text = formatMeter(balance);
	if (!text) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${label}: ${text} of API credit left`}
						className="type-compact shrink-0 font-mono text-muted-foreground/70 tabular-nums"
					/>
				}
			>
				{text}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					{meters.map((meter) => (
						<MeterTooltipRow key={meter.label} meter={meter} />
					))}
					<span className="text-muted-foreground">
						Prepaid credit on your {label} key.
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
});
