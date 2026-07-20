import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { cn } from "@ryu/ui/lib/utils";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_WARN_PCT,
	ContextRing,
	type ContextUsage,
} from "../context-usage.tsx";

function BreakdownRow({
	label,
	value,
	muted,
}: {
	label: string;
	value: string;
	muted?: boolean;
}) {
	return (
		<div className="flex items-center justify-between gap-6">
			<span className="text-muted-foreground">{label}</span>
			<span
				className={cn(
					"font-mono tabular-nums",
					muted && "text-muted-foreground"
				)}
			>
				{value}
			</span>
		</div>
	);
}

/**
 * Persistent context-window meter for the composer toolbar. Shows how full the
 * model's context window is BEFORE the user sends — a donut ring that shifts
 * muted → amber → red as the conversation grows, with the used percentage
 * beside it. Hovering reveals the token breakdown (input / cached / output /
 * reasoning / total) and the window utilization, mirroring assistant-ui's
 * ContextDisplay.
 *
 * Renders nothing until the window size is known AND a turn has reported usage
 * (usage is live-only), so a fresh/reloaded chat shows no meter rather than a
 * misleading empty ring.
 */
export function ContextMeter({
	usage,
	className,
}: {
	usage: ContextUsage;
	className?: string;
}) {
	const { used, total } = usage;
	if (!(total > 0) || used <= 0) {
		return null;
	}

	const pct = (used / total) * 100;
	const remaining = Math.max(0, total - used);
	const near = pct >= CONTEXT_WARN_PCT;
	const over = pct >= CONTEXT_CRITICAL_PCT;

	const rows: Array<{ label: string; value: string }> = [];
	if (typeof usage.promptTokens === "number") {
		rows.push({
			label: "Input",
			value: usage.promptTokens.toLocaleString(),
		});
	}
	if (typeof usage.cachedTokens === "number") {
		rows.push({
			label: "Cached",
			value: usage.cachedTokens.toLocaleString(),
		});
	}
	if (typeof usage.completionTokens === "number") {
		rows.push({
			label: "Output",
			value: usage.completionTokens.toLocaleString(),
		});
	}
	if (typeof usage.reasoningTokens === "number") {
		rows.push({
			label: "Reasoning",
			value: usage.reasoningTokens.toLocaleString(),
		});
	}

	return (
		<HoverCard closeDelay={80} openDelay={120}>
			<HoverCardTrigger
				aria-label={`Context ${Math.round(pct)}% used`}
				className={cn(
					"flex h-7 w-fit shrink-0 cursor-default select-none items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground tabular-nums",
					near && "text-amber-500",
					over && "text-destructive",
					className
				)}
			>
				<ContextRing pct={pct} />
				<span>{Math.round(pct)}%</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-56 text-xs">
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-6 font-medium">
						<span>Context window</span>
						<span className="font-mono tabular-nums">{Math.round(pct)}%</span>
					</div>
					<div className="my-0.5 h-px bg-border" />
					{rows.map((row) => (
						<BreakdownRow key={row.label} label={row.label} value={row.value} />
					))}
					<BreakdownRow
						label="Used"
						value={`${used.toLocaleString()} / ${total.toLocaleString()}`}
					/>
					<BreakdownRow
						label="Remaining"
						muted
						value={`${remaining.toLocaleString()} tokens`}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
