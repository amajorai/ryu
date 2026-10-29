import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_WARN_PCT,
	ContextRing,
	type ContextUsage,
} from "../context-usage.tsx";
import {
	isNonPositiveContextCount,
	isPositiveContextCount,
	nativeContextPct,
	nativeContextRemaining,
} from "../native-context-usage.mjs";
import { PromptCacheSummary } from "../prompt-cache-summary.tsx";

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
 * reasoning / total), the window utilization, mirroring assistant-ui's
 * ContextDisplay, and the prompt cache's hit rate and estimated warmth.
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
	const tl = useLiteralMessages();
	const { used, total } = usage;
	if (!isPositiveContextCount(total) || isNonPositiveContextCount(used)) {
		return null;
	}
	const pct = nativeContextPct(used, total);
	const remaining = nativeContextRemaining(
		() => total,
		() => used
	);
	const near = pct >= CONTEXT_WARN_PCT;
	const over = pct >= CONTEXT_CRITICAL_PCT;
	const rows: Array<{
		label: string;
		value: string;
	}> = [];
	if (isNativeNumber(usage.promptTokens)) {
		rows.push({
			label: "Input",
			value: formatCount(usage.promptTokens) ?? "—",
		});
	}
	const cacheReadTokens = usage.cacheReadTokens ?? usage.cachedTokens;
	if (isNativeNumber(cacheReadTokens)) {
		rows.push({
			label: "Cache hits",
			value: formatCount(cacheReadTokens) ?? "—",
		});
	}
	if (isNativeNumber(usage.cacheWriteTokens)) {
		rows.push({
			label: "Cache writes",
			value: formatCount(usage.cacheWriteTokens) ?? "—",
		});
	}
	if (isNativeNumber(usage.cacheMissTokens)) {
		rows.push({
			label: "Cache misses",
			value: formatCount(usage.cacheMissTokens) ?? "—",
		});
	}
	if (isNativeNumber(usage.completionTokens)) {
		rows.push({
			label: "Output",
			value: formatCount(usage.completionTokens) ?? "—",
		});
	}
	if (isNativeNumber(usage.reasoningTokens)) {
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
				appearance="context-meter"
				aria-label={
					onOpen
						? tl("Context {percent}% used — open breakdown", {
								percent: String(Math.round(pct)),
							})
						: tl("Context {percent}% used", {
								percent: String(Math.round(pct)),
							})
				}
				className={cn(className)}
				closeDelay={80}
				contextTone={over ? "destructive" : near ? "warning" : undefined}
				delay={120}
				interactive={!!onOpen}
				onClick={onOpen}
				// A real <button> only when it does something: rendering one with no
				// handler would put an empty stop in the composer's tab order.
				render={onOpen ? <button type="button" /> : undefined}
			>
				<ContextRing pct={pct} />
				<span>{Math.round(pct)}%</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-64" typography="compact">
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
					<PromptCacheSummary
						className="mt-1 border-border border-t pt-2"
						usage={usage}
					/>
					{onOpen ? (
						<div className="type-caption pt-1 text-muted-foreground">
							Click for the full breakdown
						</div>
					) : null}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
