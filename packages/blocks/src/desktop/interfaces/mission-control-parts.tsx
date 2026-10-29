import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import type {
	MissionAgentState,
	MissionKpi,
	MissionTone,
} from "./mission-control-model.ts";

/** Solid fills per tone. Marks only: text keeps text tokens. */
export const TONE_FILL: Record<MissionTone, string> = {
	advisory: "bg-primary",
	attention: "bg-destructive",
	live: "bg-success",
	neutral: "bg-muted-foreground",
};

/** Text tones for the few labels that carry state (always beside a mark). */
export const TONE_TEXT: Record<MissionTone, string> = {
	advisory: "text-foreground",
	attention: "text-status-destructive",
	live: "text-status-success",
	neutral: "text-muted-foreground",
};

export const STATE_TONE: Record<MissionAgentState, MissionTone> = {
	alert: "attention",
	idle: "neutral",
	waiting: "neutral",
	working: "live",
	"your-turn": "advisory",
};

export const STATUS_TONE: Record<ThreadStatus, MissionTone> = {
	attention: "attention",
	quiet: "neutral",
	waiting: "neutral",
	working: "live",
	"your-turn": "advisory",
};

export type LampState = "failure" | "success" | MissionAgentState;

/** The KPI strip's stat labels: the one place the wall uses small caps. */
export const LABEL_TEXT =
	"font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]";

/** Sub-headers and quiet strip labels: sentence case, one step down. */
export const SUBTLE_LABEL = "font-medium text-muted-foreground text-xs";

const LAMP_FILL: Record<LampState, string> = {
	alert: "bg-destructive",
	failure: "bg-destructive",
	idle: "bg-muted-foreground/30",
	success: "bg-success",
	waiting: "border-[1.5px] border-muted-foreground",
	working: "bg-success",
	// A ring around a dot: reads apart from the solid "working" lamp by shape,
	// even in themes whose primary is green.
	"your-turn": "border border-primary bg-primary bg-clip-content p-px",
};

/** The ringed your-turn lamp is a step larger so its centre dot stays legible. */
function lampSize(state: LampState, size: "md" | "sm"): string {
	if (state === "your-turn") {
		return size === "md" ? "size-2.5" : "size-2";
	}
	return size === "md" ? "size-2" : "size-1.5";
}

/**
 * A console indicator lamp: a flat dot in its tone. Idle lamps are dim,
 * queued ones hollow and your-turn ones a ringed dot, so state never rests on
 * hue alone. `pulse` breathes
 * slowly (only when motion is allowed); the wall uses it once, on the live
 * indicator.
 */
export function Lamp({
	className,
	pulse = false,
	size = "md",
	state,
}: {
	className?: string;
	pulse?: boolean;
	size?: "md" | "sm";
	state: LampState;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex shrink-0 rounded-full",
				lampSize(state, size),
				LAMP_FILL[state],
				pulse && "motion-safe:animate-pulse",
				className
			)}
		/>
	);
}

/** A Grafana-style panel: one flat surface, a title strip over its body. */
export function MissionPanel({
	actions,
	children,
	className,
	meta,
	title,
	titleId,
}: {
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	meta?: ReactNode;
	title: string;
	titleId: string;
}) {
	return (
		<section
			aria-labelledby={titleId}
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground",
				className
			)}
		>
			<header className="flex h-9 shrink-0 items-center gap-3 border-border border-b px-3">
				<h2
					className="truncate font-medium text-[13px] text-foreground leading-5"
					id={titleId}
				>
					{title}
				</h2>
				{meta ? (
					<span className="ml-auto flex min-w-0 items-center gap-3 truncate text-[11px] text-muted-foreground tabular-nums">
						{meta}
					</span>
				) : null}
				{actions ? (
					<span className={cn("flex shrink-0 gap-1", !meta && "ml-auto")}>
						{actions}
					</span>
				) : null}
			</header>
			<div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
		</section>
	);
}

const SPARK_STROKE: Record<MissionTone, string> = {
	advisory: "text-primary",
	attention: "text-destructive",
	live: "text-success",
	neutral: "text-muted-foreground",
};

/** Plot units: the viewBox is stretched to the tile, the stroke is not. */
const SPARK_W = 100;
const SPARK_H = 24;

/**
 * A single-line area sparkline across the tile, Grafana stat-panel style:
 * the 24 hourly values as one line over a light fill of the same tone, on a
 * hairline baseline so a quiet day still reads as a chart.
 */
export function Sparkline({
	label,
	tone,
	values,
}: {
	label: string;
	tone: MissionTone;
	values: readonly number[];
}) {
	const max = Math.max(1, ...values);
	const step = values.length > 1 ? SPARK_W / (values.length - 1) : SPARK_W;
	const points = values.map((value, index) => {
		const x = index * step;
		// Keep a 1-unit inset so the stroke never clips at the top or bottom.
		const y = SPARK_H - 1 - (value / max) * (SPARK_H - 2);
		return `${x.toFixed(2)},${y.toFixed(2)}`;
	});
	const line = `M${points.join("L")}`;
	const area = `${line}L${SPARK_W},${SPARK_H}L0,${SPARK_H}Z`;
	return (
		<svg
			aria-label={label}
			className={cn("block h-6 w-full overflow-visible", SPARK_STROKE[tone])}
			preserveAspectRatio="none"
			role="img"
			viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
		>
			<line
				className="stroke-border"
				strokeWidth={1}
				vectorEffect="non-scaling-stroke"
				x1={0}
				x2={SPARK_W}
				y1={SPARK_H - 0.5}
				y2={SPARK_H - 0.5}
			/>
			<path className="fill-current opacity-[0.12]" d={area} />
			<path
				className="fill-none stroke-current"
				d={line}
				strokeLinejoin="round"
				strokeWidth={1.5}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

function trendSummary(kpi: MissionKpi, tl: LiteralMessage): string {
	const peak = Math.max(0, ...kpi.trend);
	const current = kpi.trend.at(-1) ?? 0;
	return tl(
		"{label} trend ({trendNote}), {trendLabel} per hour over the last 24 hours: peak {peak}, this hour {current}",
		{
			current: String(current),
			label: kpi.label,
			peak: String(peak),
			trendLabel: kpi.trendLabel,
			trendNote: kpi.trendNote,
		}
	);
}

/**
 * One stat cell: label, figure with its caption, and a 24-hour sparkline.
 * Cells sit flush in one strip, split by hairlines; only the figure takes the
 * threshold color. The sparkline shows on wide walls only.
 */
export function KpiTile({ kpi }: { kpi: MissionKpi }) {
	const tl = useLiteralMessages();
	const alarmed = kpi.tone === "attention";
	return (
		<div className="flex min-w-0 flex-col gap-2 bg-card p-3" data-kpi={kpi.id}>
			<dt className={cn("truncate", LABEL_TEXT)}>{kpi.label}</dt>
			<dd className="flex min-w-0 items-baseline gap-2">
				<span
					className={cn(
						"font-semibold @min-[1100px]/wall:text-[32px] text-[28px] tabular-nums leading-none tracking-tight",
						alarmed ? "text-status-destructive" : "text-foreground"
					)}
				>
					{kpi.value}
				</span>
				<span className="truncate text-muted-foreground text-xs">
					{kpi.caption}
				</span>
			</dd>
			<dd className="@min-[1100px]/wall:block hidden">
				<Sparkline
					label={trendSummary(kpi, tl)}
					tone={kpi.tone}
					values={kpi.trend}
				/>
			</dd>
		</div>
	);
}
