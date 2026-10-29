// apps/desktop/src/components/agents/AgentOptimizationsView.tsx
//
// Agent-scoped cost optimizations. Core reads the agent's recent sessions,
// replays a sample on cheaper models through the Gateway eval runner (one fixed
// judge scores each output against the agent's real production reply), and
// flags allowed tools the agent never called. Nothing changes until a person
// applies a recommendation; applying goes through the normal agent update, so
// the Versions view can restore the previous configuration.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AgentOptimizations,
	analyzeAgentOptimizations,
	applyAgentOptimization,
	dismissAgentOptimization,
	fetchAgentOptimizations,
	formatMicroUsd,
	formatShare,
	type OptimizerRecommendation,
	optimizationRecoveryRequired,
} from "@/src/lib/api/optimizer.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

export interface AgentOptimizationsViewProps {
	agentId: string;
	/** Disable apply/analyze (locked or read-only agents). */
	disabled?: boolean;
	/** Called after a recommendation changed the agent, so the editor reloads. */
	onApplied?: () => Promise<void> | void;
	target: ApiTarget;
}

const STATUS_LABELS = {
	applied: "Applied",
	dismissed: "Dismissed",
	pending: "Suggested",
	superseded: "Replaced by a newer analysis",
} satisfies Record<OptimizerRecommendation["status"], string>;

function errorMessage<TCause>(cause: TCause, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback;
}

function parseModelList(value: string): string[] {
	return value
		.split(",")
		.map((model) => model.trim())
		.filter((model) => model.length > 0);
}

function ChangeLine({ rec }: { rec: OptimizerRecommendation }) {
	const tl = useLiteralMessages();
	if (rec.change.type === "set_model") {
		return (
			<p className="text-muted-foreground text-xs">
				{tl("Model: {from} → {to}", {
					from: rec.change.from,
					to: rec.change.to,
				})}
			</p>
		);
	}
	return (
		<p className="text-muted-foreground text-xs">
			{tl("Remove: {tools}", { tools: rec.change.remove.join(", ") })}
		</p>
	);
}

function ModelEvidence({ rec }: { rec: OptimizerRecommendation }) {
	const models = rec.evidence.models ?? [];
	if (models.length === 0) {
		return null;
	}
	return (
		<table className="w-full text-left text-xs">
			<caption className="sr-only">Replay results per model</caption>
			<thead className="text-muted-foreground">
				<tr>
					<th className="py-1 font-medium" scope="col">
						Model
					</th>
					<th className="py-1 font-medium" scope="col">
						Quality
					</th>
					<th className="py-1 font-medium" scope="col">
						Replay cost
					</th>
					<th className="py-1 font-medium" scope="col">
						Failed
					</th>
				</tr>
			</thead>
			<tbody>
				{models.map((score) => (
					<tr className="border-border border-t" key={score.model}>
						<td className="py-1">{score.model}</td>
						<td className="py-1">{formatShare(score.quality)}</td>
						<td className="py-1">{formatMicroUsd(score.costMicroUsd)}</td>
						<td className="py-1">
							{score.errors}/{score.cases}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function RecommendationCard({
	busy,
	disabled,
	onApply,
	onDismiss,
	rec,
}: {
	busy: boolean;
	disabled: boolean;
	onApply: (id: string) => void;
	onDismiss: (id: string) => void;
	rec: OptimizerRecommendation;
}) {
	const tl = useLiteralMessages();
	const pending = rec.status === "pending";
	return (
		<SettingsCard className="flex flex-col gap-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex flex-col gap-1">
					<p className="font-medium text-sm">{rec.title}</p>
					<ChangeLine rec={rec} />
				</div>
				<div className="flex flex-wrap items-center gap-1">
					{rec.evidence.savings === undefined ? null : (
						<Badge variant="secondary">
							{tl("{savings} cheaper", {
								savings: formatShare(rec.evidence.savings),
							})}
						</Badge>
					)}
					<Badge variant="outline">
						{rec.evidence.verified ? "Replayed and judged" : "Usage only"}
					</Badge>
					{pending ? null : (
						<Badge variant="ghost">{STATUS_LABELS[rec.status]}</Badge>
					)}
				</div>
			</div>
			<p className="text-sm">{rec.summary}</p>
			{rec.kind === "model" ? <ModelEvidence rec={rec} /> : null}
			<p className="text-muted-foreground text-xs">
				{tl("Based on {sessions} sessions · {createdAt}", {
					createdAt: formatDateTime(rec.createdAt),
					sessions: String(rec.evidence.sessions),
				})}
			</p>
			{pending ? (
				<div className="flex flex-wrap justify-end gap-2">
					<Button
						disabled={disabled || busy}
						onClick={() => onDismiss(rec.id)}
						variant="ghost"
					>
						Dismiss
					</Button>
					<Button disabled={disabled || busy} onClick={() => onApply(rec.id)}>
						{busy ? <Spinner className="size-4" /> : null}
						Apply
					</Button>
				</div>
			) : null}
		</SettingsCard>
	);
}

export function AgentOptimizationsView({
	agentId,
	disabled = false,
	onApplied,
	target,
}: AgentOptimizationsViewProps) {
	const tl = useLiteralMessages();
	const [state, setState] = useState<AgentOptimizations | null>(null);
	const [loading, setLoading] = useState(true);
	const [analyzing, setAnalyzing] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [candidates, setCandidates] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [recoveries, setRecoveries] = useState<OptimizerRecommendation[]>([]);
	const generation = useRef(0);

	const load = useCallback(async () => {
		const requestGeneration = generation.current;
		setLoading(true);
		setError(null);
		try {
			const next = await fetchAgentOptimizations(target, agentId);
			if (requestGeneration !== generation.current) {
				return;
			}
			setState(next);
			setRecoveries((current) => next.recoveryRecommendations ?? current);
		} catch (cause) {
			if (requestGeneration === generation.current) {
				setError(errorMessage(cause, "Optimizations are unavailable."));
			}
		} finally {
			if (requestGeneration === generation.current) {
				setLoading(false);
			}
		}
	}, [agentId, target]);

	useEffect(() => {
		generation.current += 1;
		setRecoveries([]);
		setState(null);
		setBusyId(null);
		setAnalyzing(false);
		load().catch(() => undefined);
		return () => {
			generation.current += 1;
		};
	}, [load]);

	const handleAnalyze = async () => {
		const requestGeneration = generation.current;
		setAnalyzing(true);
		setError(null);
		try {
			const next = await analyzeAgentOptimizations(target, agentId, {
				candidateModels: parseModelList(candidates),
			});
			if (requestGeneration !== generation.current) {
				return;
			}
			setState(next);
			await load();
		} catch (cause) {
			if (requestGeneration === generation.current) {
				setError(errorMessage(cause, "The analysis failed."));
			}
		} finally {
			if (requestGeneration === generation.current) {
				setAnalyzing(false);
			}
		}
	};

	const decide = async (id: string, apply: boolean) => {
		const requestGeneration = generation.current;
		setBusyId(id);
		setError(null);
		try {
			if (apply) {
				await applyAgentOptimization(target, agentId, id);
				if (requestGeneration !== generation.current) {
					return;
				}
				setRecoveries((current) => current.filter((rec) => rec.id !== id));
				await onApplied?.();
			} else {
				await dismissAgentOptimization(target, agentId, id);
			}
			if (requestGeneration !== generation.current) {
				return;
			}
			await load();
		} catch (cause) {
			if (requestGeneration !== generation.current) {
				return;
			}
			if (apply && optimizationRecoveryRequired(cause, id)) {
				const rec =
					state?.recommendations.find((item) => item.id === id) ??
					recoveries.find((item) => item.id === id);
				if (rec) {
					setRecoveries((current) =>
						current.some((item) => item.id === id) ? current : [...current, rec]
					);
				}
				try {
					await onApplied?.();
					if (requestGeneration !== generation.current) {
						return;
					}
					await load();
				} catch (reloadError) {
					if (requestGeneration === generation.current) {
						setError(
							errorMessage(
								reloadError,
								"The agent could not be reloaded. Retry recording the suggestion."
							)
						);
					}
					return;
				}
			}
			if (requestGeneration === generation.current) {
				setError(errorMessage(cause, "The recommendation could not be saved."));
			}
		} finally {
			if (requestGeneration === generation.current) {
				setBusyId(null);
			}
		}
	};

	const readiness = state?.readiness;
	const recommendations = state?.recommendations ?? [];
	const pending = recommendations.filter(
		(rec) =>
			rec.status === "pending" && !recoveries.some((item) => item.id === rec.id)
	);
	const history = recommendations.filter((rec) => rec.status !== "pending");
	const analysis = state?.lastAnalysis ?? null;

	return (
		<SettingsSection
			caption="Find cheaper settings that keep quality. Ryu replays this agent's recent requests on less expensive models, has one judge score each answer against the reply the agent really gave, and flags allowed tools it never calls. Nothing changes until you apply a suggestion, and Versions can undo it."
			title="Optimizations"
		>
			{loading ? (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading optimizations…
				</div>
			) : (
				<div className="flex flex-col gap-4">
					<SettingsCard className="flex flex-col gap-3">
						<div className="flex flex-wrap items-start justify-between gap-2">
							<div>
								<p className="font-medium text-sm">Analyze recent sessions</p>
								<p className="text-muted-foreground text-xs">
									{readiness
										? tl("{sessions} of {required} sessions needed", {
												required: String(readiness.required),
												sessions: String(readiness.sessions),
											})
										: "Session history unavailable"}
									{analysis
										? ` · ${tl("Last analyzed {analyzedAt}", {
												analyzedAt: formatDateTime(analysis.at),
											})}`
										: ""}
								</p>
							</div>
							<Button
								disabled={disabled || analyzing || !readiness?.ready}
								onClick={() => handleAnalyze()}
							>
								{analyzing ? <Spinner className="size-4" /> : null}
								{analyzing ? "Analyzing…" : "Run analysis"}
							</Button>
						</div>
						<label
							className="flex flex-col gap-1 text-xs"
							htmlFor="optimizer-candidates"
						>
							<span className="text-muted-foreground">
								Models to compare (optional, comma-separated). Leave empty to
								try cheaper models this node can route to.
							</span>
							<Input
								disabled={disabled || analyzing}
								id="optimizer-candidates"
								onChange={(event) => setCandidates(event.target.value)}
								placeholder="e.g. gpt-4o-mini, claude-haiku-4-5"
								value={candidates}
							/>
						</label>
						{analyzing ? (
							<p className="text-muted-foreground text-xs">
								Replaying requests on each model. This uses provider credits and
								can take a few minutes.
							</p>
						) : null}
						{analysis && analysis.notes.length > 0 ? (
							<ul className="list-disc ps-4 text-muted-foreground text-xs">
								{analysis.notes.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						) : null}
					</SettingsCard>

					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
					{state?.historyUnavailable ? (
						<p className="text-muted-foreground text-sm">
							Suggestion history is unavailable. Saved changes that need
							recording are shown below.
						</p>
					) : null}

					{recoveries.map((rec) => (
						<SettingsCard
							className="flex flex-col gap-3"
							key={`recovery:${rec.id}`}
						>
							<p className="font-medium text-sm">{rec.title}</p>
							<p className="text-sm">
								The agent was updated. Finish recording this suggestion;
								retrying will not apply the change again.
							</p>
							<Button
								disabled={disabled || busyId !== null}
								onClick={() => decide(rec.id, true)}
							>
								{busyId === rec.id ? <Spinner className="size-4" /> : null}
								Retry recording suggestion
							</Button>
						</SettingsCard>
					))}

					{pending.length === 0 && analysis ? (
						<p className="text-muted-foreground text-sm">
							No open suggestions. The latest analysis found nothing worth
							changing.
						</p>
					) : null}

					{pending.map((rec) => (
						<RecommendationCard
							busy={busyId === rec.id}
							disabled={disabled}
							key={rec.id}
							onApply={(id) => decide(id, true)}
							onDismiss={(id) => decide(id, false)}
							rec={rec}
						/>
					))}

					{history.length > 0 ? (
						<details className="flex flex-col gap-2">
							<summary className="cursor-pointer text-muted-foreground text-sm">
								{tl("Earlier suggestions ({count})", {
									count: String(history.length),
								})}
							</summary>
							<div className="mt-2 flex flex-col gap-2">
								{history.map((rec) => (
									<RecommendationCard
										busy={false}
										disabled
										key={rec.id}
										onApply={() => undefined}
										onDismiss={() => undefined}
										rec={rec}
									/>
								))}
							</div>
						</details>
					) : null}
				</div>
			)}
		</SettingsSection>
	);
}
