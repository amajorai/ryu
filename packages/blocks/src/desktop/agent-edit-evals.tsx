"use client";

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";

// ── Evals view ─────────────────────────────────────────────────────────────────

export interface EvalStat {
	label: string;
	tone?: string;
	value: string;
}

export interface EvalCaseRow {
	/** Substring-match label already formatted (e.g. "100%") or null for "—". */
	matchLabel: string | null;
	prompt: string;
	responseText: string;
	scoreLabel: string;
	scoreTone?: string;
}

export interface AuditRow {
	id: string;
	isError?: boolean;
	latencyLabel: string;
	model: string;
	scoreLabel: string;
	time: string;
	tokens: number;
}

/** One per-evaluator aggregate row (from `aggregate.evaluators`). */
export interface EvaluatorResultRow {
	/** Honesty: false when the evaluator never actually executed. */
	didExecute?: boolean;
	/** Executed-case count, e.g. "4 / 4" or "not run (0)". */
	executed: string;
	id: string;
	/** Mean score formatted (e.g. "82%"). */
	meanScore: string;
	/** Display name (falls back to the id when the catalog lacks it). */
	name: string;
	/** Pass rate formatted (e.g. "3/4" or "75%"). */
	passRate: string;
	/** Tone class for the score cell. */
	tone?: string;
}

export interface AgentEvalsViewProps {
	cases?: EvalCaseRow[];
	/**
	 * The shared evaluator catalog picker (offline mode), injected by the
	 * container so this presentational block stays app-decoupled. Rendered inside
	 * the Run-evals card so selection sits next to the Run button.
	 */
	catalog?: ReactNode;
	/** Per-evaluator aggregate rows for the selected offline evaluators. */
	evaluatorRows?: EvaluatorResultRow[];
	historyEntries?: AuditRow[];
	historyLoading?: boolean;
	historyReachable?: boolean | null;
	model?: string;
	/**
	 * Why Run is disabled when no model is set (e.g. the node has no default
	 * model configured). Shown under the model field; `null` hides it.
	 */
	modelHint?: string | null;
	onModelChange?: (v: string) => void;
	onReloadHistory?: () => void;
	onRun?: () => void;
	runError?: string | null;
	running?: boolean;
	stats?: EvalStat[];
}

function EvalStatCard({ label, value, tone }: EvalStat) {
	return (
		<div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 p-2">
			<span className="type-compact text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<span className={`font-medium text-sm ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

export function AgentEvalsView({
	model = "",
	modelHint = null,
	running,
	runError,
	stats = [],
	cases = [],
	catalog,
	evaluatorRows = [],
	historyLoading,
	historyReachable,
	historyEntries = [],
	onModelChange,
	onRun,
	onReloadHistory,
}: AgentEvalsViewProps) {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
			<SettingsSection
				caption="Scores latency · tokens · policy · expected-match."
				title="Run evals"
			>
				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="eval-model" size="compact">
								Model
							</Label>
							<Input
								className="w-56"
								id="eval-model"
								onChange={(e) => onModelChange?.(e.target.value)}
								placeholder="Model id"
								size="compact"
								value={model}
							/>
						</div>
						<Button
							disabled={!model.trim()}
							loading={running}
							onClick={onRun}
							size="sm"
						>
							{running ? "Running…" : "Run evals"}
						</Button>
					</div>

					{modelHint ? (
						<p className="text-muted-foreground text-xs">{modelHint}</p>
					) : null}

					{runError ? (
						<p className="text-status-destructive text-xs">{runError}</p>
					) : null}

					{catalog ? (
						<div className="rounded-lg border bg-muted/20 p-3">{catalog}</div>
					) : null}

					{stats.length > 0 ? (
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							{stats.map((s) => (
								<EvalStatCard
									key={s.label}
									label={s.label}
									tone={s.tone}
									value={s.value}
								/>
							))}
						</div>
					) : null}

					{cases.length > 0 ? (
						<div className="overflow-hidden rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Prompt</th>
										<th className="px-2 py-1.5 font-medium">Response</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Match
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Score
										</th>
									</tr>
								</thead>
								<tbody>
									{cases.map((c, i) => (
										<tr
											className="border-t align-top"
											key={`${c.prompt.slice(0, 16)}-${i}`}
										>
											<td
												className="max-w-40 truncate px-2 py-1.5"
												title={c.prompt}
											>
												{c.prompt}
											</td>
											<td
												className="max-w-64 truncate px-2 py-1.5 text-muted-foreground"
												title={c.responseText}
											>
												{c.responseText}
											</td>
											<td className="px-2 py-1.5 text-right tabular-nums">
												{c.matchLabel ?? "—"}
											</td>
											<td
												className={`px-2 py-1.5 text-right font-medium tabular-nums ${c.scoreTone ?? ""}`}
											>
												{c.scoreLabel}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}

					{evaluatorRows.length > 0 ? (
						<div className="overflow-hidden rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Evaluator</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Mean score
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Pass rate
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Executed
										</th>
									</tr>
								</thead>
								<tbody>
									{evaluatorRows.map((r) => (
										<tr className="border-t align-top" key={r.id}>
											<td className="px-2 py-1.5">
												<span className="font-medium">{r.name}</span>
												{r.didExecute === false ? (
													<Badge
														appearance="agent-count"
														className="ml-1.5"
														variant="outline"
													>
														not run
													</Badge>
												) : null}
											</td>
											<td
												className={`px-2 py-1.5 text-right font-medium tabular-nums ${r.tone ?? ""}`}
											>
												{r.meanScore}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{r.passRate}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{r.executed}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Recent model calls through the gateway."
				headerAction={
					<Button
						aria-label="Reload run history"
						loading={historyLoading}
						onClick={onReloadHistory}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3.5" icon={Refresh01Icon} />
					</Button>
				}
				title="Run history"
			>
				<SettingsCard className="flex flex-col gap-3">
					{historyReachable === false ? (
						<p className="text-muted-foreground text-xs">
							Gateway audit is unavailable (gateway down or auditing disabled).
						</p>
					) : null}

					{historyEntries.length === 0 && historyReachable !== false ? (
						<p className="text-muted-foreground text-xs">
							{historyLoading ? "Loading…" : "No runs recorded yet."}
						</p>
					) : null}

					{historyEntries.length > 0 ? (
						<div className="overflow-auto rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Time</th>
										<th className="px-2 py-1.5 font-medium">Model</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Tokens
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Latency
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Score
										</th>
									</tr>
								</thead>
								<tbody>
									{historyEntries.map((e) => (
										<tr className="border-t" key={e.id}>
											<td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
												{e.time}
											</td>
											<td className="max-w-40 truncate px-2 py-1.5">
												{e.isError ? (
													<Badge variant="destructive">error</Badge>
												) : null}
												{e.model}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{formatCount(e.tokens) ?? "—"}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{e.latencyLabel}
											</td>
											<td className="px-2 py-1.5 text-right tabular-nums">
												{e.scoreLabel}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
