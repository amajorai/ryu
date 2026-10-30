import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	NO_DEFAULT_MODEL_HINT,
	useNodeDefaultModel,
} from "@/src/hooks/useNodeDefaultModel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AuditEntry,
	fetchGatewayAudit,
	pruneGatewayAudit,
	type RedTeamRunResult,
	runGatewayRedTeam,
	scoreGatewayOutput,
} from "@/src/lib/api/gateway.ts";
import { getModelContextWindow } from "@/src/lib/api/inference.ts";
import {
	createPromptSuite,
	importPromptTrace,
	listPromptSuites,
} from "@/src/lib/api/prompt-suites.ts";
import { fetchRunTrace, type RunSpan } from "@/src/lib/api/runs.ts";
import {
	discoverGroups,
	filterAuditEntries,
	type ObservabilityFilter,
	type ObservabilityWindow,
	REFRESH_INTERVAL_MS,
	type SavedObservabilityView,
	savedObservabilityViewSchema,
	savedViewsKey,
	summarizeAudit,
	windowStart,
} from "./AgentObservabilityView-audit.ts";
import { ObservabilityDiscoverSection } from "./AgentObservabilityView-discover.tsx";
import { ObservabilityExplorerSection } from "./AgentObservabilityView-explorer.tsx";
import { ObservabilityOverviewSection } from "./AgentObservabilityView-overview.tsx";
import { ObservabilitySecuritySection } from "./AgentObservabilityView-security.tsx";
import { ObservabilitySelectedSection } from "./AgentObservabilityView-selected.tsx";

export {
	filterAuditEntries,
	type ObservabilitySummary,
	promptCacheStatus,
	summarizeAudit,
} from "./AgentObservabilityView-audit.ts";

export interface AgentObservabilityViewProps {
	agentId: string;
	/** The agent's own model id. Blank → the node's configured default model. */
	defaultModel?: string;
	onOpenRun?: (conversationId: string) => void;
	target: ApiTarget;
}

export function AgentObservabilityView({
	agentId,
	defaultModel,
	onOpenRun,
	target,
}: AgentObservabilityViewProps) {
	const tl = useLiteralMessages();
	const [entries, setEntries] = useState<AuditEntry[]>([]);
	const [reachable, setReachable] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<ObservabilityFilter>("all");
	const [timeRange, setTimeRange] = useState<ObservabilityWindow>("24h");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedContextWindow, setSelectedContextWindow] = useState<
		number | null
	>(null);
	const [contextWindowLoading, setContextWindowLoading] = useState(false);
	const [trace, setTrace] = useState<RunSpan[]>([]);
	const [traceLoading, setTraceLoading] = useState(false);
	const [traceError, setTraceError] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [importMessage, setImportMessage] = useState<string | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const nodeDefault = useNodeDefaultModel(target);
	const effectiveModel = defaultModel?.trim() || nodeDefault.model;
	const [securityRunning, setSecurityRunning] = useState(false);
	const [securityResult, setSecurityResult] = useState<RedTeamRunResult | null>(
		null
	);
	const [securityError, setSecurityError] = useState<string | null>(null);
	const [savedViews, setSavedViews] = useState<SavedObservabilityView[]>([]);
	const [viewName, setViewName] = useState("");
	const [pruning, setPruning] = useState(false);
	const [pruneMessage, setPruneMessage] = useState<string | null>(null);
	const [pruneError, setPruneError] = useState<string | null>(null);
	const [scoreResponse, setScoreResponse] = useState("");
	const [scoreRubric, setScoreRubric] = useState("");
	const [scoring, setScoring] = useState(false);
	const [scoreResult, setScoreResult] = useState<number | null>(null);
	const [scoreError, setScoreError] = useState<string | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			try {
				const response = await fetchGatewayAudit(
					target,
					{ agentId, from: windowStart(timeRange), limit: 100 },
					signal
				);
				if (!signal?.aborted) {
					setEntries(response.entries);
					setReachable(response.reachable);
					setError(null);
				}
			} catch (cause) {
				if (!signal?.aborted) {
					setError(
						cause instanceof Error
							? cause.message
							: "Failed to load observability"
					);
				}
			} finally {
				if (!signal?.aborted) {
					setLoading(false);
				}
			}
		},
		[agentId, target, timeRange]
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal).catch(() => undefined);
		// Polls share the effect's signal so cleanup also cancels an in-flight
		// poll for the previous agent/target/range instead of letting it land.
		const timer = window.setInterval(() => {
			load(controller.signal).catch(() => undefined);
		}, REFRESH_INTERVAL_MS);
		return () => {
			controller.abort();
			window.clearInterval(timer);
		};
	}, [load]);

	const visibleEntries = useMemo(
		() => filterAuditEntries(entries, query, filter),
		[entries, filter, query]
	);
	const summary = useMemo(() => summarizeAudit(entries), [entries]);
	const discoveredGroups = useMemo(() => discoverGroups(entries), [entries]);
	const selected = entries.find((entry) => entry.id === selectedId) ?? null;
	const selectedRunId = selected?.session_id ?? null;

	useEffect(() => {
		if (selected?.event_type !== "model_call" || !selected.model) {
			setSelectedContextWindow(null);
			setContextWindowLoading(false);
			return;
		}

		let active = true;
		setSelectedContextWindow(null);
		setContextWindowLoading(true);
		getModelContextWindow(target, selected.model)
			.then((contextWindow) => {
				if (active) {
					setSelectedContextWindow(contextWindow);
				}
			})
			.finally(() => {
				if (active) {
					setContextWindowLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [selected?.event_type, selected?.model, target]);

	useEffect(() => {
		if (!globalThis.window) {
			return;
		}
		try {
			const raw = window.localStorage.getItem(savedViewsKey(agentId));
			if (!raw) {
				setSavedViews([]);
				return;
			}
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				setSavedViews([]);
				return;
			}
			setSavedViews(
				parsed.flatMap((value) => {
					const view = savedObservabilityViewSchema.safeParse(value);
					return view.success ? [view.data] : [];
				})
			);
		} catch {
			setSavedViews([]);
		}
	}, [agentId]);

	const saveView = useCallback(() => {
		const name = viewName.trim();
		if (!(name && globalThis.window)) {
			return;
		}
		const next = [
			{
				filter,
				id: crypto.randomUUID(),
				name,
				query,
				timeRange,
			},
			...savedViews,
		].slice(0, 12);
		setSavedViews(next);
		setViewName("");
		window.localStorage.setItem(savedViewsKey(agentId), JSON.stringify(next));
	}, [agentId, filter, query, savedViews, timeRange, viewName]);

	const deleteView = useCallback(
		(id: string) => {
			const next = savedViews.filter((view) => view.id !== id);
			setSavedViews(next);
			window.localStorage.setItem(savedViewsKey(agentId), JSON.stringify(next));
		},
		[agentId, savedViews]
	);

	const pruneAudit = useCallback(async () => {
		setPruning(true);
		setPruneMessage(null);
		setPruneError(null);
		try {
			const result = await pruneGatewayAudit(target);
			setPruneMessage(
				tl("Retention applied · {count} rows removed", {
					count: String(result.deleted_rows ?? 0),
				})
			);
			await load();
		} catch (cause) {
			// The raw status line stays behind "Copy details"; the row says what failed.
			setPruneError(
				cause instanceof Error ? cause.message : "Retention pass failed"
			);
		} finally {
			setPruning(false);
		}
	}, [load, target, tl]);

	const scoreOnline = useCallback(async () => {
		if (!scoreResponse.trim()) {
			return;
		}
		setScoring(true);
		setScoreError(null);
		try {
			const result = await scoreGatewayOutput(target, {
				agent_id: agentId,
				assertions: scoreRubric.trim()
					? [{ kind: "llm_rubric", rubric: scoreRubric.trim() }]
					: [],
				model: selected?.model || effectiveModel || undefined,
				prompt: selected?.request_id ?? "observability trace",
				response: scoreResponse,
			});
			setScoreResult(result.score.overall);
		} catch (cause) {
			setScoreError(
				cause instanceof Error ? cause.message : "Online scoring failed"
			);
		} finally {
			setScoring(false);
		}
	}, [agentId, effectiveModel, scoreResponse, scoreRubric, selected, target]);
	useEffect(() => {
		if (!selected?.session_id) {
			setTrace([]);
			setTraceError(null);
			return;
		}
		const controller = new AbortController();
		setTraceLoading(true);
		setTraceError(null);
		setImportMessage(null);
		setImportError(null);
		fetchRunTrace(target, selected.session_id, controller.signal)
			.then((spans) => setTrace(spans))
			.catch((cause) => {
				if (!controller.signal.aborted) {
					setTraceError(
						cause instanceof Error ? cause.message : "Failed to load trace"
					);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setTraceLoading(false);
				}
			});
		return () => controller.abort();
	}, [selected?.session_id, target]);

	const importSelectedTrace = useCallback(async () => {
		if (!selectedRunId) {
			return;
		}
		setImporting(true);
		setImportMessage(null);
		setImportError(null);
		try {
			const suites = await listPromptSuites(target, agentId);
			const suite =
				suites[0] ??
				(
					await createPromptSuite(target, {
						agentId,
						config: {
							prompts: [],
							providers: selected?.model ? [selected.model] : [],
							tests: [],
						},
						label: "Trace baseline",
						name: "Agent regression suite",
					})
				).suite;
			const result = await importPromptTrace(target, suite.id, selectedRunId);
			setImportMessage(
				result.added
					? tl("Added to {name} as a versioned test case.", {
							name: result.suite.name,
						})
					: tl("This trace is already in {name}.", {
							name: result.suite.name,
						})
			);
		} catch (cause) {
			setImportError(
				cause instanceof Error
					? cause.message
					: "Failed to add trace to Quality tests"
			);
		} finally {
			setImporting(false);
		}
	}, [agentId, selected?.model, selectedRunId, target, tl]);

	const runSecuritySweep = useCallback(async () => {
		if (!effectiveModel) {
			setSecurityError(NO_DEFAULT_MODEL_HINT);
			return;
		}
		setSecurityRunning(true);
		setSecurityError(null);
		try {
			const result = await runGatewayRedTeam(target, {
				agent_id: agentId,
				model: effectiveModel,
			});
			setSecurityResult(result);
		} catch (cause) {
			setSecurityError(
				cause instanceof Error ? cause.message : "Security sweep failed"
			);
		} finally {
			setSecurityRunning(false);
		}
	}, [agentId, effectiveModel, target]);

	return (
		<div
			className="mx-auto flex w-full max-w-5xl flex-col"
			data-testid="agent-observability"
		>
			<ObservabilityOverviewSection
				error={error}
				loading={loading}
				onPrune={() => pruneAudit().catch(() => undefined)}
				onRefresh={() => load().catch(() => undefined)}
				pruneError={pruneError}
				pruneMessage={pruneMessage}
				pruning={pruning}
				reachable={reachable}
				summary={summary}
				timeRange={timeRange}
			/>

			<ObservabilityExplorerSection
				filter={filter}
				loading={loading}
				query={query}
				selectedId={selectedId}
				setFilter={setFilter}
				setQuery={setQuery}
				setSelectedId={setSelectedId}
				setTimeRange={setTimeRange}
				timeRange={timeRange}
				visibleEntries={visibleEntries}
			/>

			<ObservabilityDiscoverSection
				deleteView={deleteView}
				discoveredGroups={discoveredGroups}
				entries={entries}
				savedViews={savedViews}
				saveView={saveView}
				setFilter={setFilter}
				setQuery={setQuery}
				setTimeRange={setTimeRange}
				setViewName={setViewName}
				timeRange={timeRange}
				viewName={viewName}
			/>

			{selected ? (
				<ObservabilitySelectedSection
					contextWindowLoading={contextWindowLoading}
					importError={importError}
					importing={importing}
					importMessage={importMessage}
					importSelectedTrace={importSelectedTrace}
					onOpenRun={onOpenRun}
					scoreError={scoreError}
					scoreOnline={scoreOnline}
					scoreResponse={scoreResponse}
					scoreResult={scoreResult}
					scoreRubric={scoreRubric}
					scoring={scoring}
					selected={selected}
					selectedContextWindow={selectedContextWindow}
					selectedRunId={selectedRunId}
					setScoreResponse={setScoreResponse}
					setScoreRubric={setScoreRubric}
					trace={trace}
					traceError={traceError}
					traceLoading={traceLoading}
				/>
			) : null}

			<ObservabilitySecuritySection
				effectiveModel={effectiveModel}
				modelLoading={nodeDefault.loading}
				onRun={() => runSecuritySweep().catch(() => undefined)}
				securityError={securityError}
				securityResult={securityResult}
				securityRunning={securityRunning}
			/>
		</div>
	);
}
