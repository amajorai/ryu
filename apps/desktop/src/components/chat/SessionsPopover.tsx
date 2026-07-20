// apps/desktop/src/components/chat/SessionsPopover.tsx
//
// Read-only view of the per-Runnable sessions that ran on the active
// conversation (Core's /api/conversations/:id/sessions). Surfaced as a small
// titlebar popover next to the council participants. Sessions are created and
// advanced by Core during a run, so this is intentionally read-only.

import { ActivityIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type AuditEntry, fetchGatewayAudit } from "@/src/lib/api/gateway.ts";
import {
	listSessionsForConversation,
	type Session,
	type SessionStatus,
} from "@/src/lib/api/sessions.ts";
import { compactAge } from "@/src/lib/time.ts";

/** Per-run cost + latency rollup for a conversation, summed over its model calls. */
interface RunCostSummary {
	/** Number of model calls audited for this conversation. */
	callCount: number;
	/** Total estimated cost in micro-USD; `null` if cost attribution is off. */
	costMicroUsd: number | null;
	/** Summed wall-clock latency across the calls, in milliseconds. */
	totalLatencyMs: number;
}

/** Reduce a conversation's audit entries to a single cost/latency rollup. */
function summarizeRun(entries: AuditEntry[]): RunCostSummary {
	let costMicroUsd: number | null = null;
	let totalLatencyMs = 0;
	let callCount = 0;
	for (const e of entries) {
		if (e.event_type && e.event_type !== "model_call") {
			continue;
		}
		callCount += 1;
		totalLatencyMs += e.latency_ms ?? 0;
		if (e.cost_micro_usd != null) {
			costMicroUsd = (costMicroUsd ?? 0) + e.cost_micro_usd;
		}
	}
	return { callCount, costMicroUsd, totalLatencyMs };
}

/** Format micro-USD as a short dollar string (e.g. 2500 -> "$0.0025"). */
function formatCost(microUsd: number): string {
	const usd = microUsd / 1_000_000;
	if (usd === 0) {
		return "$0";
	}
	// Show enough precision for sub-cent costs without trailing noise.
	return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`;
}

/** Format a millisecond latency compactly (e.g. 1234 -> "1.2s", 800 -> "800ms"). */
function formatLatency(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const STATUS_COLOR: Record<SessionStatus, string> = {
	idle: "bg-muted-foreground/40",
	running: "bg-warning",
	completed: "bg-success",
	failed: "bg-destructive",
};

export function SessionsPopover({
	conversationId,
	target,
}: {
	conversationId: string | null;
	target: ApiTarget;
}) {
	const [open, setOpen] = useState(false);
	const [sessions, setSessions] = useState<Session[]>([]);
	const [costSummary, setCostSummary] = useState<RunCostSummary | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!conversationId) {
			return;
		}
		setLoading(true);
		try {
			setSessions(await listSessionsForConversation(target, conversationId));
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load sessions.");
		} finally {
			setLoading(false);
		}
		// Per-run cost + latency (#548, P6) is best-effort and independent of the
		// session list: the gateway audit may be disabled/unreachable while sessions
		// still load. A failure just hides the rollup, never blocks the popover.
		try {
			const audit = await fetchGatewayAudit(target, {
				sessionId: conversationId,
				limit: 200,
			});
			setCostSummary(audit.reachable ? summarizeRun(audit.entries) : null);
		} catch {
			setCostSummary(null);
		}
	}, [conversationId, target]);

	// Fetch when the popover opens (sessions change as runs happen).
	useEffect(() => {
		if (open) {
			load().catch(() => undefined);
		}
	}, [open, load]);

	if (!conversationId) {
		return null;
	}

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							aria-label="Sessions"
							className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<HugeiconsIcon className="size-4" icon={ActivityIcon} />
						</PopoverTrigger>
					}
				/>
				<TooltipContent>Sessions</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-72 p-0" side="bottom">
				<div className="border-b px-3 py-2">
					<p className="font-medium text-sm">Sessions</p>
					<p className="text-muted-foreground text-xs">
						Runs on this conversation
					</p>
					{costSummary && costSummary.callCount > 0 ? (
						<div className="mt-2 flex items-center gap-3 text-xs tabular-nums">
							<span className="text-muted-foreground">
								{costSummary.callCount} call
								{costSummary.callCount === 1 ? "" : "s"}
							</span>
							<span title="Estimated cost across this conversation's model calls">
								{costSummary.costMicroUsd == null
									? "—"
									: formatCost(costSummary.costMicroUsd)}
							</span>
							<span
								className="text-muted-foreground"
								title="Total model-call latency"
							>
								{formatLatency(costSummary.totalLatencyMs)}
							</span>
						</div>
					) : null}
				</div>
				{loading ? (
					<div className="flex items-center justify-center py-6">
						<Spinner />
					</div>
				) : error ? (
					<p className="px-3 py-4 text-destructive text-xs">{error}</p>
				) : sessions.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No sessions yet.
					</p>
				) : (
					<ul className="max-h-64 overflow-y-auto py-1">
						{sessions.map((s) => (
							<li
								className="flex items-center gap-2 px-3 py-1.5 text-xs"
								key={s.id}
							>
								<span
									aria-label={s.status}
									className={`size-1.5 shrink-0 rounded-full ${STATUS_COLOR[s.status]}`}
								/>
								<Tooltip>
									<TooltipTrigger
										render={
											<span className="min-w-0 flex-1 truncate">
												{s.runnableId}
											</span>
										}
									/>
									<TooltipContent>{s.runnableId}</TooltipContent>
								</Tooltip>
								<Badge className="shrink-0 text-[9px]" variant="secondary">
									{s.runnableKind}
								</Badge>
								<span className="shrink-0 text-muted-foreground tabular-nums">
									{compactAge(s.updatedAt)}
								</span>
							</li>
						))}
					</ul>
				)}
			</PopoverContent>
		</Popover>
	);
}
