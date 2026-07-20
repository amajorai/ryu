// apps/desktop/src/components/agents/AgentEvalsView.tsx
//
// Thin container for the agent-scoped Evals + run history surface. The
// presentational layer is `@ryu/blocks/desktop/agent-edit#AgentEvalsView`; this
// owns the eval-run + audit-history query state and derives the display rows.
//
// The eval run reuses `runGatewayEvals` (POST /api/gateway/evals/run): it scores
// each case on latency / token-efficiency / policy-pass / optional substring
// match, PLUS any offline evaluators the user selects from the shared catalog.
// Selected registry evaluators ride the `evaluators` array; custom Code
// evaluators are split into `code_evaluators` (Core runs them locally). Run
// history reuses `fetchGatewayAudit`. Both are gateway concerns (measurement),
// so nothing here re-implements policy — it only displays it.

import {
	AgentEvalsView as AgentEvalsViewBlock,
	type AuditRow,
	type EvalCaseRow,
	type EvalStat,
	type EvaluatorResultRow,
} from "@ryu/blocks/desktop/agent-edit";
import { EvaluatorCatalog } from "@ryu/blocks/desktop/evaluator-catalog";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProLockedBadge } from "@/src/components/billing/ProLockedBadge.tsx";
import {
	splitOfflineSelection,
	toCatalogItem,
} from "@/src/components/evaluators/catalog-utils.ts";
import {
	EvaluatorEditorDialog,
	type EvaluatorEditorMode,
} from "@/src/components/evaluators/EvaluatorEditorDialog.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AuditEntry,
	deleteCustomEvaluator,
	type EvalDatasetCase,
	type EvalRunResult,
	type Evaluator,
	fetchEvaluators,
	fetchGatewayAudit,
	runGatewayEvals,
} from "@/src/lib/api/gateway.ts";

export interface AgentEvalsViewProps {
	/** Agent the evals are scoped to (forwarded for per-agent budget tracking). */
	agentId: string | null;
	/** The agent's chat model — the default model to evaluate. */
	defaultModel: string;
	/** Core API target (url + token). */
	target: ApiTarget;
}

function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function scoreTone(score: number): string {
	if (score >= 0.75) {
		return "text-success dark:text-success";
	}
	if (score >= 0.5) {
		return "text-warning dark:text-warning";
	}
	return "text-destructive";
}

export function AgentEvalsView({
	agentId,
	defaultModel,
	target,
}: AgentEvalsViewProps) {
	const { canUse } = useEntitlementContext();
	// ── Eval runner state ──────────────────────────────────────────────────────
	const [model, setModel] = useState(defaultModel || "gpt-4o-mini");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<EvalRunResult | null>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	// ── Evaluator catalog + selection ──────────────────────────────────────────
	const [catalog, setCatalog] = useState<Evaluator[]>([]);
	const [catalogLoading, setCatalogLoading] = useState(true);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [search, setSearch] = useState("");
	const [editorMode, setEditorMode] = useState<EvaluatorEditorMode | null>(
		null
	);
	const [reloadKey, setReloadKey] = useState(0);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	useEffect(() => {
		if (defaultModel) {
			setModel(defaultModel);
		}
	}, [defaultModel]);

	useEffect(() => {
		let cancelled = false;
		setCatalogLoading(true);
		fetchEvaluators(target)
			.then((list) => {
				if (!cancelled) {
					setCatalog(list);
					setCatalogError(null);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setCatalogError(
						e instanceof Error ? e.message : "Failed to load evaluator catalog"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setCatalogLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, reloadKey]);

	const catalogItems = useMemo(() => catalog.map(toCatalogItem), [catalog]);
	const customSet = useMemo(() => catalog.filter((e) => !e.builtin), [catalog]);
	const allIds = useMemo(() => catalog.map((e) => e.id), [catalog]);
	const nameById = useMemo(
		() => new Map(catalog.map((e) => [e.id, e.name])),
		[catalog]
	);

	const run = useCallback(async () => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setRunError(null);
		try {
			// Empty dataset → the gateway falls back to its built-in 3-case set,
			// so the panel is useful before any custom cases exist.
			const dataset: EvalDatasetCase[] = [];
			const { evaluators, codeEvaluators } = splitOfflineSelection(
				Array.from(selected),
				catalog
			);
			const res = await runGatewayEvals(
				target,
				{
					agent_id: agentId,
					model,
					dataset,
					evaluators,
					code_evaluators: codeEvaluators,
				},
				controller.signal
			);
			setResult(res);
		} catch (e) {
			if (!controller.signal.aborted) {
				setRunError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			setRunning(false);
		}
	}, [agentId, model, target, selected, catalog]);

	useEffect(() => () => abortRef.current?.abort(), []);

	// ── Run history (audit) state ──────────────────────────────────────────────
	const [entries, setEntries] = useState<AuditEntry[]>([]);
	const [reachable, setReachable] = useState<boolean | null>(null);
	const [historyLoading, setHistoryLoading] = useState(false);

	const loadHistory = useCallback(async () => {
		setHistoryLoading(true);
		try {
			const res = await fetchGatewayAudit(target, { limit: 50 });
			setEntries(res.entries);
			setReachable(res.reachable);
		} finally {
			setHistoryLoading(false);
		}
	}, [target]);

	useEffect(() => {
		loadHistory().catch(() => undefined);
	}, [loadHistory]);

	// ── Derive display rows ────────────────────────────────────────────────────
	const agg = result?.aggregate;
	const stats: EvalStat[] = agg
		? [
				{
					label: "Overall",
					value: pct(agg.mean_overall),
					tone: scoreTone(agg.mean_overall),
				},
				{ label: "Policy pass", value: pct(agg.policy_pass_rate) },
				{ label: "Mean latency", value: `${Math.round(agg.mean_latency)} ms` },
				{ label: "Cases", value: String(agg.total_cases) },
			]
		: [];

	const cases: EvalCaseRow[] = (result?.cases ?? []).map((c) => ({
		prompt: c.prompt,
		responseText: c.response_text,
		matchLabel: c.substring_match === null ? null : pct(c.substring_match),
		scoreLabel: pct(c.overall),
		scoreTone: scoreTone(c.overall),
	}));

	const totalCases = agg?.total_cases ?? 0;
	const evaluatorRows: EvaluatorResultRow[] = Object.entries(
		agg?.evaluators ?? {}
	).map(([id, a]) => {
		const didExecute = a.executedCount > 0;
		return {
			id,
			name: nameById.get(id) ?? id,
			meanScore: didExecute ? pct(a.meanScore) : "—",
			passRate: didExecute ? pct(a.passRate) : "—",
			executed: `${a.executedCount} / ${totalCases}`,
			tone: didExecute ? scoreTone(a.meanScore) : undefined,
			didExecute,
		};
	});

	const historyEntries: AuditRow[] = entries.map((e) => ({
		id: e.id,
		time: new Date(e.timestamp).toLocaleTimeString(),
		model: e.model ?? "—",
		isError: Boolean(e.error),
		tokens: (e.input_tokens ?? 0) + (e.output_tokens ?? 0),
		latencyLabel: e.latency_ms == null ? "—" : `${e.latency_ms} ms`,
		scoreLabel: e.eval_score == null ? "—" : pct(e.eval_score),
	}));

	const toggleSelected = (id: string, on: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	};

	// Delete a custom (builtin=false) evaluator from the catalog where it renders.
	// Persists the trimmed custom set via updateGatewayConfig + restartGateway, then
	// refetches. Also drops the id from the current selection so a deleted code
	// evaluator's stale id is never re-sent as a registry id on the next run.
	const deleteCustom = async (id: string) => {
		setDeletingId(id);
		try {
			await deleteCustomEvaluator(target, id, customSet);
			setSelected((prev) => {
				if (!prev.has(id)) {
					return prev;
				}
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
			setReloadKey((k) => k + 1);
		} catch (e) {
			setCatalogError(
				e instanceof Error ? e.message : "Failed to delete evaluator"
			);
		} finally {
			setDeletingId(null);
		}
	};

	// Band-2 gate (free-tier plan): offline eval runs are a Pro feature. Show the
	// surface locked with an upsell rather than hiding it. Placed after every hook.
	if (!canUse("evals")) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center">
				<div className="flex items-center gap-2">
					<span className="font-medium text-sm">Agent evals</span>
					<ProLockedBadge feature="evals" />
				</div>
				<p className="max-w-sm text-muted-foreground text-xs">
					Score this agent on latency, token efficiency, and policy-pass across
					a dataset. Offline evals are a Pro feature — upgrade to run them.
				</p>
			</div>
		);
	}

	const catalogNode = (
		<EvaluatorCatalog
			disabled={deletingId !== null}
			error={catalogError}
			items={catalogItems}
			loading={catalogLoading}
			mode="offline"
			onCreateCode={() => setEditorMode("code")}
			onCreateJudge={() => setEditorMode("judge")}
			onDeleteCustom={(id) => {
				deleteCustom(id).catch(() => undefined);
			}}
			onSearchChange={setSearch}
			renderControl={(item) => (
				<Checkbox
					aria-label={`Select ${item.name}`}
					checked={selected.has(item.id)}
					onCheckedChange={(c) => toggleSelected(item.id, c === true)}
				/>
			)}
			search={search}
		/>
	);

	return (
		<>
			<AgentEvalsViewBlock
				cases={cases}
				catalog={catalogNode}
				evaluatorRows={evaluatorRows}
				historyEntries={historyEntries}
				historyLoading={historyLoading}
				historyReachable={reachable}
				model={model}
				onModelChange={setModel}
				onReloadHistory={() => {
					loadHistory().catch(() => undefined);
				}}
				onRun={() => {
					run().catch(() => undefined);
				}}
				runError={runError}
				running={running}
				stats={stats}
			/>
			<EvaluatorEditorDialog
				existingCustom={customSet}
				existingIds={allIds}
				mode={editorMode ?? "judge"}
				onOpenChange={(o) => {
					if (!o) {
						setEditorMode(null);
					}
				}}
				onSaved={() => setReloadKey((k) => k + 1)}
				open={editorMode !== null}
				target={target}
			/>
		</>
	);
}
