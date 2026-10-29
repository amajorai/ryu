// apps/desktop/src/components/chat/RunTracePanel.tsx
//
// Per-run trace waterfall (M4 / issue #178, hierarchical traces).
//
// Shows the selected conversation's spans as a tree — agent runs, model and
// tool calls, retrieval, memory, workflow steps, guardrails — positioned on the
// run's timeline. Spans come from Core (`GET /api/runs/:id/trace?format=tree`);
// tokens and cost come from Gateway audit (joined on the model-call span's
// session id). When the Gateway is unreachable the waterfall still renders,
// without usage.

import {
	AiBrain01Icon,
	AlertCircleIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	ComputerTerminal01Icon,
	DatabaseIcon,
	Loading01Icon,
	RoboticIcon,
	Search01Icon,
	Shield01Icon,
	WorkflowSquare01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchGatewayAudit } from "@/src/lib/api/gateway.ts";
import { formatMicroUsd } from "@/src/lib/api/optimizer.ts";
import {
	fetchRunTraceTree,
	flattenTraceTree,
	joinTraceUsage,
	type RunTraceTree,
	type TraceNode,
	usageTotals,
} from "@/src/lib/api/runs.ts";

interface RunTracePanelProps {
	runId: string;
	target: ApiTarget;
}

interface KindStyle {
	bar: string;
	icon: typeof ZapIcon;
	label: string;
	text: string;
}

const KIND_STYLES: Record<string, KindStyle> = {
	agent_run: {
		bar: "bg-primary/70",
		icon: RoboticIcon,
		label: "Agent run",
		text: "text-primary",
	},
	workflow_run: {
		bar: "bg-primary/70",
		icon: WorkflowSquare01Icon,
		label: "Workflow",
		text: "text-primary",
	},
	workflow_step: {
		bar: "bg-primary/40",
		icon: WorkflowSquare01Icon,
		label: "Step",
		text: "text-primary",
	},
	model_call: {
		bar: "bg-info",
		icon: ZapIcon,
		label: "Model",
		text: "text-status-info",
	},
	tool_call: {
		bar: "bg-warning",
		icon: ComputerTerminal01Icon,
		label: "Tool",
		text: "text-status-warning",
	},
	retrieval: {
		bar: "bg-success",
		icon: Search01Icon,
		label: "Retrieval",
		text: "text-status-success",
	},
	memory: {
		bar: "bg-success",
		icon: AiBrain01Icon,
		label: "Memory",
		text: "text-status-success",
	},
	guardrail: {
		bar: "bg-muted-foreground/50",
		icon: Shield01Icon,
		label: "Guardrail",
		text: "text-muted-foreground",
	},
};

const FALLBACK_STYLE: KindStyle = {
	bar: "bg-muted-foreground/50",
	icon: DatabaseIcon,
	label: "Span",
	text: "text-muted-foreground",
};

function kindStyle(node: TraceNode): KindStyle {
	const kind = node.normalizedKind ?? node.span.kind.replace("-", "_");
	return KIND_STYLES[kind] ?? FALLBACK_STYLE;
}

export function formatDuration(ms: number | null): string {
	if (ms === null) {
		return "in flight";
	}
	if (ms < 1000) {
		return `${Math.max(0, Math.round(ms))}ms`;
	}
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function formatTokens(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** Bar geometry as percentages of the run's total duration. */
export function barGeometry(
	node: TraceNode,
	totalMs: number
): { left: number; width: number } {
	const total = Math.max(totalMs, 1);
	const left = Math.min(100, Math.max(0, (node.offsetMs / total) * 100));
	const duration = node.durationMs ?? total - node.offsetMs;
	const width = Math.max(0.5, Math.min(100 - left, (duration / total) * 100));
	return { left, width };
}

function runTotalMs(tree: RunTraceTree): number {
	if (tree.durationMs !== null) {
		return tree.durationMs;
	}
	if (tree.startedAt === null) {
		return 1;
	}
	return Math.max(1, Date.now() - tree.startedAt);
}

function payloadText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function SpanDetail({ node }: { node: TraceNode }) {
	const tl = useLiteralMessages();
	const { span, usage } = node;
	const attributes = Object.entries(span.attributes);
	return (
		<div
			className="space-y-1 border-t bg-muted/30 px-3 py-2 text-xs"
			data-testid="trace-span-detail"
		>
			<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
				<dt className="text-muted-foreground">Status</dt>
				<dd
					className={cn(span.status === "error" && "text-status-destructive")}
				>
					{span.status}
				</dd>
				{span.agentId ? (
					<>
						<dt className="text-muted-foreground">Agent</dt>
						<dd className="font-mono">{span.agentId}</dd>
					</>
				) : null}
				{span.argsHash ? (
					<>
						<dt className="text-muted-foreground">Input fingerprint</dt>
						<dd className="font-mono">{span.argsHash.slice(0, 16)}…</dd>
					</>
				) : null}
				{usage ? (
					<>
						<dt className="text-muted-foreground">Tokens</dt>
						<dd>
							{tl("{inputTokens} in · {outputTokens} out", {
								inputTokens: String(usage.inputTokens ?? 0),
								outputTokens: String(usage.outputTokens ?? 0),
							})}
						</dd>
						<dt className="text-muted-foreground">Cost</dt>
						<dd>{formatMicroUsd(usage.costMicroUsd)}</dd>
						<dt className="text-muted-foreground">Provider latency</dt>
						<dd>{formatDuration(usage.latencyMs)}</dd>
					</>
				) : null}
				{attributes.map(([key, value]) => (
					<div className="contents" key={key}>
						<dt className="text-muted-foreground">{key}</dt>
						<dd className="break-all font-mono">
							{typeof value === "string" ? value : JSON.stringify(value)}
						</dd>
					</div>
				))}
			</dl>
			{span.error ? (
				<p className="text-status-destructive">{span.error}</p>
			) : null}
			{span.input === undefined ? null : (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">
					{payloadText(span.input)}
				</pre>
			)}
			{span.output === undefined ? null : (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">
					{payloadText(span.output)}
				</pre>
			)}
		</div>
	);
}

interface WaterfallRowProps {
	collapsed: boolean;
	hasChildren: boolean;
	node: TraceNode;
	onSelect: () => void;
	onToggle: () => void;
	selected: boolean;
	totalMs: number;
}

function WaterfallRow({
	collapsed,
	hasChildren,
	node,
	onSelect,
	onToggle,
	selected,
	totalMs,
}: WaterfallRowProps) {
	const style = kindStyle(node);
	const failed = node.span.status === "error";
	const { left, width } = barGeometry(node, totalMs);
	const totals = node.children.length > 0 ? usageTotals(node) : null;
	const tokens = node.usage
		? (node.usage.inputTokens ?? 0) + (node.usage.outputTokens ?? 0)
		: (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
	return (
		<div
			className={cn(
				"grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2 py-1",
				selected && "bg-muted/50"
			)}
			data-testid="trace-waterfall-row"
		>
			<div
				className="flex min-w-0 items-center gap-1"
				style={{ paddingLeft: `${node.depth * 12}px` }}
			>
				{hasChildren ? (
					<button
						aria-expanded={!collapsed}
						aria-label={collapsed ? "Expand span" : "Collapse span"}
						className="rounded p-0.5 text-muted-foreground hover:bg-muted"
						onClick={onToggle}
						type="button"
					>
						<HugeiconsIcon
							className="size-3"
							icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
						/>
					</button>
				) : (
					<span className="w-4 shrink-0" />
				)}
				<button
					aria-pressed={selected}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
					onClick={onSelect}
					type="button"
				>
					<HugeiconsIcon
						className={cn(
							"size-3 shrink-0",
							failed ? "text-status-destructive" : style.text
						)}
						icon={failed ? AlertCircleIcon : style.icon}
					/>
					<span className="truncate font-mono text-foreground text-xs">
						{node.span.name}
					</span>
					<span className="type-compact shrink-0 text-muted-foreground">
						{style.label}
					</span>
				</button>
			</div>
			<div className="flex min-w-0 items-center gap-2">
				<div className="relative h-3 min-w-0 flex-1 rounded-sm bg-muted">
					<div
						className={cn(
							"absolute top-0 h-3 rounded-sm",
							failed ? "bg-destructive/70" : style.bar,
							node.span.status === "running" && "animate-pulse"
						)}
						style={{ left: `${left}%`, width: `${width}%` }}
					/>
				</div>
				<span className="type-compact w-14 shrink-0 text-right font-mono text-muted-foreground">
					{formatDuration(node.durationMs)}
				</span>
				<span className="type-compact w-12 shrink-0 text-right font-mono text-muted-foreground">
					{tokens > 0 ? formatTokens(tokens) : ""}
				</span>
			</div>
		</div>
	);
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function RunTracePanel({ runId, target }: RunTracePanelProps) {
	const tl = useLiteralMessages();
	const [tree, setTree] = useState<RunTraceTree | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [spans, audit] = await Promise.all([
				fetchRunTraceTree(target, runId),
				// Usage is optional: a stopped Gateway still leaves the waterfall.
				fetchGatewayAudit(target, { sessionId: runId, limit: 500 }).catch(
					() => null
				),
			]);
			setTree(audit?.reachable ? joinTraceUsage(spans, audit.entries) : spans);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load trace");
		} finally {
			setLoading(false);
		}
	}, [target, runId]);

	useEffect(() => {
		load();
	}, [load]);

	const rows = useMemo(
		() => (tree ? flattenTraceTree(tree.roots, collapsed) : []),
		[tree, collapsed]
	);
	const totals = useMemo(() => {
		const sum = { costMicroUsd: 0, modelCalls: 0, tokens: 0 };
		for (const root of tree?.roots ?? []) {
			const next = usageTotals(root);
			sum.costMicroUsd += next.costMicroUsd;
			sum.modelCalls += next.modelCalls;
			sum.tokens += next.inputTokens + next.outputTokens;
		}
		return sum;
	}, [tree]);
	const totalMs = tree ? runTotalMs(tree) : 1;
	const spanCount = tree?.spanCount ?? 0;
	const errorCount = tree?.errorCount ?? 0;

	const toggle = (id: string) =>
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});

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
				<HugeiconsIcon
					className="h-3 w-3 shrink-0 text-muted-foreground"
					icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
				/>
				<span className="font-medium text-foreground">Run trace</span>
				{loading && (
					<HugeiconsIcon
						className="ml-1 h-3 w-3 shrink-0 animate-spin text-muted-foreground"
						icon={Loading01Icon}
					/>
				)}
				{!loading && spanCount > 0 && (
					<span className="ml-auto shrink-0 text-muted-foreground">
						{errorCount > 0
							? tl(
									"{spanCount, plural, one {{spanLabel} span} other {{spanLabel} spans}} · {errorCount} failed",
									{
										errorCount: String(errorCount),
										spanCount,
										spanLabel: String(spanCount),
									}
								)
							: tl(
									"{spanCount, plural, one {{spanLabel} span} other {{spanLabel} spans}}",
									{ spanCount, spanLabel: String(spanCount) }
								)}
					</span>
				)}
			</button>

			{expanded && (
				<div className="border-t px-3 py-2" data-testid="run-trace-waterfall">
					{error && (
						<p className="type-caption text-status-destructive">{error}</p>
					)}
					{!error && spanCount === 0 && !loading && (
						<p className="type-caption text-muted-foreground">
							No spans recorded for this run.
						</p>
					)}
					{tree && spanCount > 0 && (
						<>
							<div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
								<span>
									{tl("Duration {duration}", {
										duration: formatDuration(tree.durationMs),
									})}
								</span>
								{totals.modelCalls > 0 ? (
									<>
										<span>
											{tl("{tokenCount} tokens", {
												tokenCount: formatTokens(totals.tokens),
											})}
										</span>
										<span>{formatMicroUsd(totals.costMicroUsd)}</span>
									</>
								) : null}
							</div>
							<div className="flex flex-col">
								{rows.map(({ node, hasChildren }) => (
									<div key={node.span.id}>
										<WaterfallRow
											collapsed={collapsed.has(node.span.id)}
											hasChildren={hasChildren}
											node={node}
											onSelect={() =>
												setSelectedId((current) =>
													current === node.span.id ? null : node.span.id
												)
											}
											onToggle={() => toggle(node.span.id)}
											selected={selectedId === node.span.id}
											totalMs={totalMs}
										/>
										{selectedId === node.span.id ? (
											<SpanDetail node={node} />
										) : null}
									</div>
								))}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
