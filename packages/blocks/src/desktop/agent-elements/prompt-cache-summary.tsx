import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useState } from "react";
import type { ContextUsage } from "./context-usage.tsx";
import {
	formatCacheCountdown,
	formatCacheTtl,
	type PromptCacheStatus,
	promptCacheStatus,
} from "./prompt-cache.ts";

function statusLabel(status: PromptCacheStatus, tl: LiteralMessage): string {
	switch (status.state) {
		case "active":
			return "In use";
		case "warm":
			return tl("Warm · {remaining} left", {
				remaining: formatCacheCountdown(status.remainingMs ?? 0),
			});
		case "expired":
			return "Likely expired";
		case "unused":
			return "Not used last turn";
		default:
			return "Cached";
	}
}

function statusTone(status: PromptCacheStatus): string | undefined {
	if (status.state === "expired") {
		return "text-muted-foreground";
	}
	if (status.state === "warm" || status.state === "active") {
		return "text-status-success";
	}
	return;
}

function policyCaption(status: PromptCacheStatus): string | null {
	const { policy } = status;
	if (!policy) {
		return "Provider cache lifetime unknown.";
	}
	if (policy.kind === "managed") {
		return `${policy.provider}: ${policy.note}`;
	}
	return `${policy.provider} · ${formatCacheTtl(policy.ttlMs)} TTL. ${policy.note}`;
}

/** Re-render once a second while a countdown is on screen; idle otherwise. */
function useCountdownNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) {
			return;
		}
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active]);
	return now;
}

function Row({
	label,
	tone,
	value,
}: {
	label: string;
	tone?: string;
	value: string;
}) {
	return (
		<div className="flex items-center justify-between gap-6">
			<span className="text-muted-foreground">{label}</span>
			<span className={cn("font-mono tabular-nums", tone)}>{value}</span>
		</div>
	);
}

/**
 * Prompt-cache readout for the last reported turn: hit rate, estimated warmth
 * against the provider's default TTL, and the reminder that the cache is per
 * model. Renders nothing when the provider reported no cache counters.
 *
 * Mounted inside the composer's hover card (which unmounts on close) and the
 * Context panel, so the one-second ticker only runs while it is visible.
 */
export function PromptCacheSummary({
	className,
	usage,
}: {
	className?: string;
	usage: ContextUsage;
}) {
	const tl = useLiteralMessages();
	const initial = promptCacheStatus(usage, Date.now());
	const now = useCountdownNow(initial?.state === "warm");
	const status = promptCacheStatus(usage, now);
	if (!status) {
		return null;
	}
	const caption = policyCaption(status);
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<div className="font-medium">Prompt cache</div>
			{status.hitRate === undefined ? null : (
				<Row label="Hit rate" value={`${Math.round(status.hitRate * 100)}%`} />
			)}
			<Row
				label="Status"
				tone={statusTone(status)}
				value={statusLabel(status, tl)}
			/>
			{caption ? (
				<p className="text-muted-foreground text-xs">{caption}</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				Caches are per model — switching models starts a fresh one.
			</p>
		</div>
	);
}
