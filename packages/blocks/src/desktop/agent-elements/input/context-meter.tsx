import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
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
 * With `onOpen` the meter also becomes a button that opens the full Context
 * panel — the hover card is the summary, the panel is the per-category
 * attribution (skills, tool definitions, memory, history). Without it the meter
 * stays a non-interactive readout, so surfaces with no workspace docks (the
 * island, the extension) are unaffected.
 *
 * Renders nothing until the window size is known AND a turn has reported usage
 * (usage is live-only), so a fresh/reloaded chat shows no meter rather than a
 * misleading empty ring.
 */
export function ContextMeter({
	usage,
	className,
	onOpen,
}: {
	usage: ContextUsage;
	className?: string;
	/** Open the full breakdown. Omit to leave the meter non-interactive. */
	onOpen?: () => void;
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
			value: formatCount(usage.promptTokens) ?? "—",
		});
	}
	if (typeof usage.cachedTokens === "number") {
		rows.push({
			label: "Cached",
			value: formatCount(usage.cachedTokens) ?? "—",
		});
	}
	if (typeof usage.completionTokens === "number") {
		rows.push({
			label: "Output",
			value: formatCount(usage.completionTokens) ?? "—",
		});
	}
	if (typeof usage.reasoningTokens === "number") {
		rows.push({
			label: "Reasoning",
			value: formatCount(usage.reasoningTokens) ?? "—",
		});
	}

	// Delays live on the TRIGGER in Base UI (`delay`/`closeDelay`); on the root
	// they were unknown props and silently ignored.
	//
	// Clickability arrives through `render`, NOT by nesting a <button> child:
	// a Base UI trigger renders its own element and wrapping a button inside one
	// crashes. `render` swaps the element the trigger IS, which keeps the hover
	// card and the click on the same node.
	return (
		<HoverCard>
			<HoverCardTrigger
				aria-label={
					onOpen
						? `Context ${Math.round(pct)}% used — open breakdown`
						: `Context ${Math.round(pct)}% used`
				}
				className={cn(
					"flex h-7 w-fit shrink-0 select-none items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground tabular-nums",
					onOpen
						? "cursor-pointer hover:bg-accent hover:text-foreground"
						: "cursor-default",
					near && "text-warning",
					over && "text-destructive",
					className
				)}
				closeDelay={80}
				delay={120}
				onClick={onOpen}
				// A real <button> only when it does something: rendering one with no
				// handler would put an empty stop in the composer's tab order.
				render={onOpen ? <button type="button" /> : undefined}
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
						value={`${formatCount(used)} / ${formatCount(total)}`}
					/>
					<BreakdownRow
						label="Remaining"
						muted
						value={`${formatCount(remaining)} tokens`}
					/>
					{onOpen ? (
						<div className="pt-1 text-[11px] text-muted-foreground">
							Click for the full breakdown
						</div>
					) : null}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
