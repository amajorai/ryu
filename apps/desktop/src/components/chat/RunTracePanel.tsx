// apps/desktop/src/components/chat/RunTracePanel.tsx
//
// Per-run observability trace timeline (M4 / issue #178).
//
// Shows the ordered span list for the selected conversation/run fetched from
// Core's `GET /api/runs/:id/trace` endpoint.  Reachable from the Conversations
// (ChatPage) view — displayed below the DiffReviewPane when a run is active or
// when the user expands the "Trace" toggle for the current conversation.
//
// Core-vs-Gateway: spans record *what ran* (Core concern).  Token counts,
// cost, and provider-latency live in Gateway audit only and are NOT shown here.

import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	ComputerTerminal01Icon,
	Loading01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchRunTrace, type RunSpan } from "@/src/lib/api/runs.ts";

interface RunTracePanelProps {
	runId: string;
	target: ApiTarget;
}

// ── Duration formatting ───────────────────────────────────────────────────────

function fmtDuration(startedAt: number, endedAt: number | null): string {
	if (endedAt === null) {
		return "in-flight";
	}
	const ms = endedAt - startedAt;
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

// ── Single span row ───────────────────────────────────────────────────────────

function SpanRow({ span }: { span: RunSpan }) {
	const isToolCall = span.kind === "tool-call";
	const isModelCall = span.kind === "model-call";
	const hasError = Boolean(span.error);

	let borderColor = "border-l-border";
	if (hasError) {
		borderColor = "border-l-destructive";
	} else if (isModelCall) {
		borderColor = "border-l-blue-400";
	} else if (isToolCall) {
		borderColor = "border-l-amber-400";
	}

	return (
		<div className={`border-l-2 ${borderColor} py-1 pl-3`}>
			<div className="flex items-center gap-2">
				{isModelCall ? (
					<HugeiconsIcon
						className="h-3 w-3 shrink-0 text-info"
						icon={ZapIcon}
					/>
				) : (
					<HugeiconsIcon
						className="h-3 w-3 shrink-0 text-warning"
						icon={ComputerTerminal01Icon}
					/>
				)}
				<span className="font-mono text-foreground text-xs">{span.name}</span>
				<span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
					{fmtDuration(span.startedAt, span.endedAt)}
				</span>
			</div>
			{span.argsHash && (
				<p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
					args: {span.argsHash.slice(0, 12)}...
				</p>
			)}
			{hasError && (
				<p className="mt-0.5 text-[10px] text-destructive">{span.error}</p>
			)}
		</div>
	);
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function RunTracePanel({ runId, target }: RunTracePanelProps) {
	const [spans, setSpans] = useState<RunSpan[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await fetchRunTrace(target, runId);
			setSpans(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load trace");
		} finally {
			setLoading(false);
		}
	}, [target, runId]);

	useEffect(() => {
		load();
	}, [load]);

	const toolCallCount = spans.filter((s) => s.kind === "tool-call").length;

	return (
		<div className="rounded-md bg-card text-card-foreground">
			<button
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50"
				onClick={() => {
					if (!expanded) {
						load();
					}
					setExpanded((v) => !v);
				}}
				type="button"
			>
				{expanded ? (
					<HugeiconsIcon
						className="h-3 w-3 shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
					/>
				) : (
					<HugeiconsIcon
						className="h-3 w-3 shrink-0 text-muted-foreground"
						icon={ArrowRight01Icon}
					/>
				)}
				<span className="font-medium text-foreground">Run trace</span>
				{loading && (
					<HugeiconsIcon
						className="ml-1 h-3 w-3 shrink-0 animate-spin text-muted-foreground"
						icon={Loading01Icon}
					/>
				)}
				{!loading && spans.length > 0 && (
					<span className="ml-auto shrink-0 text-muted-foreground">
						{toolCallCount} tool call{toolCallCount === 1 ? "" : "s"}
					</span>
				)}
			</button>

			{expanded && (
				<div className="border-t px-3 py-2">
					{error && <p className="text-[11px] text-destructive">{error}</p>}
					{!error && spans.length === 0 && !loading && (
						<p className="text-[11px] text-muted-foreground">
							No spans recorded for this run.
						</p>
					)}
					{spans.length > 0 && (
						<div className="flex flex-col gap-1">
							{spans.map((span) => (
								<SpanRow key={span.id} span={span} />
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
