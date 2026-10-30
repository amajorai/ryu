import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type {
	UsageMeter,
	UsageValue,
	UsageWindow,
} from "@/src/lib/api/usage.ts";

/**
 * How many of each row kind the non-compact bar shows inline before the rest move
 * into the "+N" overflow chip. Two windows is the canonical Session/Weekly pair
 * every vendor reports (Core emits them first); one meter covers the single row
 * that is usually worth watching — a credit balance, or banked resets that are
 * about to expire.
 */
export const INLINE_WINDOW_LIMIT = 2;
export const INLINE_METER_LIMIT = 1;

/**
 * How many segments the compact pill draws. Purely visual — its tooltip lists
 * every window and meter regardless of this cap.
 */
export const COMPACT_SEGMENT_LIMIT = 3;

/** Threshold colors for the filled portion: calm → amber → red as it fills. */
export function fillClass(usedPercent: number): string {
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
export function trackClass(usedPercent: number): string {
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
export function UsageRing({ used, shown }: { used: number; shown: number }) {
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
export function windowKey(usageWindow: UsageWindow): string {
	return `${usageWindow.label}:${usageWindow.windowSeconds ?? "?"}`;
}

export function shortLabel(usageWindow: UsageWindow): string {
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
export function formatReset(resetsAt: string | null): string {
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
export function paceStatus(usageWindow: UsageWindow): string | null {
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

export function paceDotClass(usageWindow: UsageWindow): string {
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
export function formatMeter(meter: UsageMeter): string {
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
