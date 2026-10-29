// apps/desktop/src/components/chat/SessionsPopover.tsx
//
// Read-only view of the per-Runnable sessions that ran on the active
// conversation (Core's /api/conversations/:id/sessions). Surfaced as a small
// titlebar popover next to the council participants. Sessions are created and
// advanced by Core during a run, so this is intentionally read-only.

import { ActivityIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** Format a millisecond latency compactly (e.g. 1234 -> "1.2s", 800 -> "800ms"). */
function formatLatency(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const STATUS_COLOR = {
	idle: "bg-muted-foreground/40",
	running: "bg-warning",
	completed: "bg-success",
	failed: "bg-destructive",
} satisfies Record<SessionStatus, string>;

export function SessionsPopover({
	conversationId,
	target,
}: {
	conversationId: string | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [sessions, setSessions] = useState<Session[]>([]);
	const [costSummary, setCostSummary] = useState<RunCostSummary | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const owner = useMemo(
		() => ({
			conversationId,
			target: { url: target.url, token: target.token, userJwt: target.userJwt },
		}),
		[conversationId, target.url, target.token, target.userJwt]
	);
	const ownerRef = useRef(owner);
	ownerRef.current = owner;
	const mounted = useRef(false);
	const loadSequence = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			loadSequence.current += 1;
		};
	}, []);
	useEffect(() => {
		if (ownerRef.current !== owner) {
			return;
		}
		setSessions([]);
		setCostSummary(null);
		setError(null);
	}, [owner]);
	const onOpenChange = useCallback((next: boolean) => {
		if (!next) {
			loadSequence.current += 1;
		}
		setOpen(next);
	}, []);
	const load = useCallback(async () => {
		const sequence = ++loadSequence.current;
		const ownsResult = () =>
			mounted.current &&
			ownerRef.current === owner &&
			loadSequence.current === sequence;
		if (!conversationId) {
			return;
		}
		setLoading(true);
		try {
			const nextSessions = await listSessionsForConversation(
				owner.target,
				conversationId
			);
			if (!ownsResult()) {
				return;
			}
			setSessions(nextSessions);
			setError(null);
		} catch (e) {
			if (!ownsResult()) {
				return;
			}
			setError(e instanceof Error ? e.message : "Could not load sessions.");
		} finally {
			if (ownsResult()) {
				setLoading(false);
			}
		}
		// Per-run cost + latency (#548, P6) is best-effort and independent of the
		// session list: the gateway audit may be disabled/unreachable while sessions
		// still load. A failure just hides the rollup, never blocks the popover.
		try {
			const audit = await fetchGatewayAudit(owner.target, {
				sessionId: conversationId,
				limit: 200,
			});
			if (ownsResult()) {
				setCostSummary(audit.reachable ? summarizeRun(audit.entries) : null);
			}
		} catch {
			if (ownsResult()) {
				setCostSummary(null);
			}
		}
	}, [conversationId, owner]);

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
		<Popover onOpenChange={onOpenChange} open={open}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger aria-label="Sessions" variant="sessions">
							<HugeiconsIcon className="size-4" icon={ActivityIcon} />
						</PopoverTrigger>
					}
				/>
				<TooltipContent>Sessions</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="end"
				className="w-72"
				side="bottom"
				spacing="flush"
			>
				<div className="border-b px-3 py-2">
					<p className="font-medium text-sm">Sessions</p>
					<p className="text-muted-foreground text-xs">
						Runs on this conversation
					</p>
					{costSummary && costSummary.callCount > 0 ? (
						<div className="mt-2 flex items-center gap-3 text-xs tabular-nums">
							<span className="text-muted-foreground">
								{tl(
									"{callCount, plural, one {{callLabel} call} other {{callLabel} calls}}",
									{
										callCount: costSummary.callCount,
										callLabel: String(costSummary.callCount),
									}
								)}
							</span>
							<Tooltip>
								<TooltipTrigger
									render={
										<span className="font-mono">
											{costSummary.costMicroUsd == null
												? "—"
												: formatMicroUsd(costSummary.costMicroUsd)}
										</span>
									}
								/>
								<TooltipContent>
									Estimated cost across this conversation's model calls
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger
									render={
										<span className="text-muted-foreground">
											{formatLatency(costSummary.totalLatencyMs)}
										</span>
									}
								/>
								<TooltipContent>Total model-call latency</TooltipContent>
							</Tooltip>
						</div>
					) : null}
				</div>
				{loading ? (
					<SkeletonRows spacing="generous" />
				) : error ? (
					<p className="px-3 py-4 text-status-destructive text-xs">{error}</p>
				) : sessions.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No sessions yet.
					</p>
				) : (
					<ul className="scroll-fade max-h-64 overflow-y-auto py-1">
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
								<Badge
									className="shrink-0"
									typography="micro"
									variant="secondary"
								>
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
