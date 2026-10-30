// Prompt Studio: one prompt variant's per-model stats, charts, and case table.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import type { CSSProperties } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { EvalCaseScore, ModelEvalResult } from "@/src/lib/api/gateway.ts";
import type { PromptReview } from "@/src/lib/api/prompt-suites.ts";
import type { PromptVariantRun, TestCaseRow } from "@/src/lib/prompt-studio.ts";
import { pct } from "./PromptStudio-format.ts";
import {
	CaseLabel,
	MatrixCell,
	ModelStatCard,
} from "./PromptStudio-matrix-cell.tsx";
import { resultModels } from "./PromptStudio-results-export.ts";

export interface PromptScoreWidth extends CSSProperties {
	"--prompt-score-width": string;
}
export interface PromptScoreHeight extends CSSProperties {
	"--prompt-score-height": string;
}

export function PromptResultCard({
	copy,
	matches,
	model,
	onReviewSaved,
	promptResult,
	reviews,
	rows,
	runId,
	suiteId,
	target,
}: {
	copy: (text: string) => Promise<void>;
	matches: (
		promptResult: PromptVariantRun,
		entry: ModelEvalResult,
		caseIndex: number,
		score: EvalCaseScore | undefined
	) => boolean;
	model: string;
	onReviewSaved: (review: PromptReview) => void;
	promptResult: PromptVariantRun;
	reviews: Record<string, PromptReview>;
	rows: TestCaseRow[];
	runId: string | null;
	suiteId: string | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	// Back-compat read path: single-model responses have no `models` key.
	const models = resultModels(promptResult, model);
	const caseCount = Math.max(
		rows.length,
		...models.map((entry) => entry.cases.length)
	);
	const caseIndices = Array.from({ length: caseCount }, (_, i) => i);
	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-xs">{promptResult.promptName}</span>
				<Badge variant="outline">
					{tl("{count, plural, one {# model} other {# models}}", {
						count: models.length,
					})}
				</Badge>
			</div>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{models.map((entry) => (
					<ModelStatCard key={entry.model} result={entry} />
				))}
			</div>
			<div className="flex flex-col gap-1 rounded-lg border bg-muted/10 p-2">
				<span className="type-compact text-muted-foreground uppercase tracking-wide">
					Quality by model
				</span>
				{models.map((entry) => (
					<div className="flex items-center gap-2" key={`bar-${entry.model}`}>
						<span className="type-compact w-28 truncate" title={entry.model}>
							{entry.model}
						</span>
						<div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full w-(--prompt-score-width) rounded-full bg-primary"
								style={
									/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
										"--prompt-score-width": `${Math.round(entry.aggregate.mean_overall * 100)}%`,
									} as PromptScoreWidth
								}
							/>
						</div>
						<span className="type-compact w-10 text-right tabular-nums">
							{pct(entry.aggregate.mean_overall)}
						</span>
					</div>
				))}
			</div>
			<div className="flex flex-col gap-1 rounded-lg border bg-muted/10 p-2">
				<span className="type-compact text-muted-foreground uppercase tracking-wide">
					Score distribution
				</span>
				{(() => {
					const buckets = [0, 0, 0, 0];
					for (const entry of models) {
						for (const score of entry.cases) {
							const bucket = Math.min(3, Math.floor(score.overall * 4));
							buckets[bucket] = (buckets[bucket] ?? 0) + 1;
						}
					}
					const maximum = Math.max(...buckets, 1);
					return (
						<div className="grid grid-cols-4 gap-2">
							{buckets.map((count, index) => (
								<div className="flex flex-col gap-1" key={`bucket-${index}`}>
									<div className="flex h-8 items-end rounded bg-muted">
										<div
											className="h-(--prompt-score-height) w-full rounded bg-primary/70"
											style={
												/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
													"--prompt-score-height": `${Math.max(4, (count / maximum) * 100)}%`,
												} as PromptScoreHeight
											}
										/>
									</div>
									<span className="type-micro text-center text-muted-foreground">
										{index * 25}–{index === 3 ? 100 : (index + 1) * 25}% ·{" "}
										{count}
									</span>
								</div>
							))}
						</div>
					);
				})()}
			</div>
			<div className="overflow-auto rounded-lg border">
				<table className="w-full text-left text-xs">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th className="px-2 py-1.5 font-medium">Case</th>
							{models.map((entry) => (
								<th className="px-2 py-1.5 font-medium" key={entry.model}>
									{entry.model}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{caseIndices.map((idx) => {
							const visible = models.some((entry) =>
								matches(promptResult, entry, idx, entry.cases[idx])
							);
							if (!visible) {
								return null;
							}
							return (
								<tr className="border-t align-top" key={`case-${idx}`}>
									<td className="max-w-40 px-2 py-1.5">
										<CaseLabel
											fallback={models[0]?.cases[idx]?.prompt}
											row={rows[idx]}
										/>
									</td>
									{models.map((entry) => (
										<td
											className="min-w-48 max-w-72 px-2 py-1.5"
											key={entry.model}
										>
											<MatrixCell
												onCopy={copy}
												onReviewSaved={onReviewSaved}
												resultKey={`${promptResult.promptId}:${entry.model}:${idx}`}
												review={
													reviews[
														`${promptResult.promptId}:${entry.model}:${idx}`
													]
												}
												runId={runId}
												score={entry.cases[idx]}
												suiteId={suiteId}
												target={target}
											/>
										</td>
									))}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
