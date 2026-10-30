// Prompt Studio: the searchable, filterable, exportable results matrix.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { EvalCaseScore, ModelEvalResult } from "@/src/lib/api/gateway.ts";
import type { PromptReview } from "@/src/lib/api/prompt-suites.ts";
import {
	type PromptVariantRun,
	resultFilterSchema,
	type TestCaseRow,
} from "@/src/lib/prompt-studio.ts";
import { pct } from "./PromptStudio-format.ts";
import {
	PromptResultCard,
	type PromptScoreWidth,
} from "./PromptStudio-prompt-results.tsx";
import {
	exportDpoJsonl,
	exportHumanEvalYaml,
	exportRowsCsv,
	flattenResultRows,
	matchesMetadataQuery,
	type ResultFilter,
	resultModels,
} from "./PromptStudio-results-export.ts";

interface ResultsMatrixProps {
	comparisonResults: PromptVariantRun[] | null;
	comparisonRunId: string | null;
	model: string;
	onReviewSaved: (review: PromptReview) => void;
	results: PromptVariantRun[];
	reviews: Record<string, PromptReview>;
	rows: TestCaseRow[];
	runId: string | null;
	suiteId: string | null;
	target: ApiTarget;
}

export function ResultsMatrix({
	comparisonResults,
	comparisonRunId,
	model,
	onReviewSaved,
	results,
	reviews,
	rows,
	runId,
	suiteId,
	target,
}: ResultsMatrixProps) {
	const tl = useLiteralMessages();
	const [filter, setFilter] = useState<ResultFilter>("all");
	const [query, setQuery] = useState("");
	const [metadataQuery, setMetadataQuery] = useState("");
	const [regexQuery, setRegexQuery] = useState(false);
	const [exportFormat, setExportFormat] = useState<
		"csv" | "json" | "yaml" | "failed_json" | "dpo_jsonl" | "human_yaml"
	>("json");
	const [copyMessage, setCopyMessage] = useState<string | null>(null);
	useEffect(() => {
		if (globalThis.window === undefined) {
			return;
		}
		const queryString = window.location.hash.split("?")[1];
		if (!queryString) {
			return;
		}
		const params = new URLSearchParams(queryString);
		const linkedFilter = params.get("filter");
		if (
			linkedFilter &&
			["all", "pass", "fail", "error", "different", "highlighted"].includes(
				linkedFilter
			)
		) {
			setFilter(resultFilterSchema.parse(linkedFilter));
		}
		setQuery(params.get("q") ?? "");
		setMetadataQuery(params.get("metadata") ?? "");
		setRegexQuery(params.get("regex") === "1");
	}, []);

	useEffect(() => {
		if (globalThis.window === undefined) {
			return;
		}
		const params = new URLSearchParams();
		if (runId) {
			params.set("run_id", runId);
		}
		if (filter !== "all") {
			params.set("filter", filter);
		}
		if (query) {
			params.set("q", query);
		}
		if (metadataQuery) {
			params.set("metadata", metadataQuery);
		}
		if (regexQuery) {
			params.set("regex", "1");
		}
		const hash = params.size > 0 ? `#promptfoo-results?${params}` : "";
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${window.location.search}${hash}`
		);
	}, [filter, metadataQuery, query, regexQuery, runId]);
	const exportRows = useMemo(
		() => flattenResultRows(results, model, rows),
		[model, results, rows]
	);
	const isDifferent = useCallback(
		(promptResult: PromptVariantRun, caseIndex: number) => {
			const outputs = resultModels(promptResult, model)
				.map((entry) => entry.cases[caseIndex]?.response_text)
				.filter((value): value is string => value !== undefined);
			return new Set(outputs).size > 1;
		},
		[model]
	);
	const matches = useCallback(
		(
			promptResult: PromptVariantRun,
			entry: ModelEvalResult,
			caseIndex: number,
			score: EvalCaseScore | undefined
		) => {
			if (!score) {
				return false;
			}
			const resultKey = `${promptResult.promptId}:${entry.model}:${caseIndex}`;
			const row = rows[caseIndex];
			const haystack = JSON.stringify({
				case: row?.name,
				metadata: score.metadata ?? row?.metadata,
				model: entry.model,
				prompt: score.prompt,
				response: score.response_text,
			});
			if (query.trim()) {
				if (regexQuery) {
					try {
						if (!new RegExp(query, "i").test(haystack)) {
							return false;
						}
					} catch {
						return false;
					}
				} else if (
					!haystack.toLowerCase().includes(query.trim().toLowerCase())
				) {
					return false;
				}
			}
			if (
				metadataQuery.trim() &&
				!matchesMetadataQuery(
					score.metadata ?? row?.metadata ?? {},
					metadataQuery
				)
			) {
				return false;
			}
			if (filter === "pass" && !score.assertions_pass) {
				return false;
			}
			if (filter === "fail" && (score.assertions_pass || score.error)) {
				return false;
			}
			if (filter === "error" && !score.error) {
				return false;
			}
			if (filter === "different" && !isDifferent(promptResult, caseIndex)) {
				return false;
			}
			if (filter === "highlighted" && !reviews[resultKey]?.highlighted) {
				return false;
			}
			return true;
		},
		[filter, isDifferent, metadataQuery, query, regexQuery, reviews, rows]
	);

	const copy = useCallback(async (text: string) => {
		if (!navigator.clipboard) {
			return;
		}
		await navigator.clipboard.writeText(text);
		setCopyMessage("Copied");
		window.setTimeout(() => setCopyMessage(null), 1500);
	}, []);

	const downloadResults = () => {
		const filteredRows = exportRows.filter((row) => {
			const promptResult = results.find(
				(result) => result.promptId === row.resultKey.split(":")[0]
			);
			const entry = promptResult
				? resultModels(promptResult, model).find(
						(candidate) => candidate.model === row.model
					)
				: undefined;
			return promptResult && entry
				? matches(promptResult, entry, row.caseIndex, row.score)
				: false;
		});
		let text: string;
		let extension = exportFormat;
		if (exportFormat === "csv") {
			text = exportRowsCsv(filteredRows);
		} else if (exportFormat === "yaml") {
			text = stringifyYaml(filteredRows.map((row) => row.score));
		} else if (exportFormat === "failed_json") {
			text = JSON.stringify(
				filteredRows.filter(
					(row) => !row.score.assertions_pass || row.score.error
				),
				null,
				2
			);
			extension = "json";
		} else if (exportFormat === "dpo_jsonl") {
			text = exportDpoJsonl(filteredRows);
		} else if (exportFormat === "human_yaml") {
			text = exportHumanEvalYaml(filteredRows, reviews);
			extension = "yaml";
		} else {
			text = JSON.stringify(filteredRows, null, 2);
		}
		const link = document.createElement("a");
		const url = URL.createObjectURL(
			new Blob([text], {
				type:
					exportFormat === "csv"
						? "text/csv"
						: exportFormat === "yaml" || exportFormat === "human_yaml"
							? "text/yaml"
							: "application/json",
			})
		);
		link.href = url;
		link.download = `promptfoo-results.${extension}`;
		link.click();
		URL.revokeObjectURL(url);
	};

	const visibleCount = results.reduce(
		(total, promptResult) =>
			total +
			resultModels(promptResult, model).reduce(
				(entryTotal, entry) =>
					entryTotal +
					entry.cases.filter((score, caseIndex) =>
						matches(promptResult, entry, caseIndex, score)
					).length,
				0
			),
		0
	);
	const runMean = useMemo(() => {
		const values = results.flatMap((result) =>
			resultModels(result, model).map((entry) => entry.aggregate.mean_overall)
		);
		return values.length > 0
			? values.reduce((sum, value) => sum + value, 0) / values.length
			: 0;
	}, [model, results]);
	const comparisonMean = useMemo(() => {
		if (!comparisonResults) {
			return null;
		}
		const values = comparisonResults.flatMap((result) =>
			resultModels(result, model).map((entry) => entry.aggregate.mean_overall)
		);
		return values.length > 0
			? values.reduce((sum, value) => sum + value, 0) / values.length
			: 0;
	}, [comparisonResults, model]);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-xs">Results matrix</span>
					<Badge variant="outline">
						{tl("{count} visible cells", { count: String(visibleCount) })}
					</Badge>
					<span className="type-compact text-muted-foreground">
						Search, facet, review, compare, and export this run.
					</span>
				</div>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
					<Input
						aria-label="Search result matrix"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search cases, prompts, outputs, models"
						size="dense"
						value={query}
					/>
					<Input
						aria-label="Filter result metadata"
						onChange={(event) => setMetadataQuery(event.target.value)}
						placeholder="Metadata facet, e.g. team=support"
						size="dense"
						value={metadataQuery}
					/>
					<label className="type-compact flex items-center justify-between gap-2 rounded-md border px-2">
						<span>Regex search</span>
						<Switch
							aria-label="Regex result search"
							checked={regexQuery}
							onCheckedChange={setRegexQuery}
						/>
					</label>
					<NativeSelect
						appearance="dense"
						aria-label="Result matrix filter"
						onChange={(event) =>
							setFilter(resultFilterSchema.parse(event.target.value))
						}
						value={filter}
					>
						<NativeSelectOption value="all">All cells</NativeSelectOption>
						<NativeSelectOption value="pass">Passing</NativeSelectOption>
						<NativeSelectOption value="fail">Failing</NativeSelectOption>
						<NativeSelectOption value="error">Errors</NativeSelectOption>
						<NativeSelectOption value="different">
							Different outputs
						</NativeSelectOption>
						<NativeSelectOption value="highlighted">
							Human highlighted
						</NativeSelectOption>
					</NativeSelect>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<NativeSelect
						appearance="dense"
						aria-label="Results export format"
						className="w-40"
						onChange={(event) =>
							setExportFormat(
								z
									.enum([
										"yaml",
										"json",
										"csv",
										"failed_json",
										"dpo_jsonl",
										"human_yaml",
									])
									.parse(event.target.value)
							)
						}
						value={exportFormat}
					>
						<NativeSelectOption value="json">JSON</NativeSelectOption>
						<NativeSelectOption value="yaml">YAML</NativeSelectOption>
						<NativeSelectOption value="csv">CSV</NativeSelectOption>
						<NativeSelectOption value="failed_json">
							Failed only (JSON)
						</NativeSelectOption>
						<NativeSelectOption value="dpo_jsonl">
							DPO preferences (JSONL)
						</NativeSelectOption>
						<NativeSelectOption value="human_yaml">
							Human eval (YAML)
						</NativeSelectOption>
					</NativeSelect>
					<Button onClick={downloadResults} size="sm" variant="outline">
						Export selected
					</Button>
					{copyMessage ? (
						<span className="text-status-success text-xs" role="status">
							{copyMessage}
						</span>
					) : null}
				</div>
			</div>
			{comparisonResults && comparisonMean !== null ? (
				<div className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/10 p-3">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium text-xs">Run comparison</span>
						<Badge variant="outline">vs {comparisonRunId}</Badge>
					</div>
					<div className="grid grid-cols-2 gap-3 text-xs">
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground">Current run</span>
							<div className="h-2 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full w-(--prompt-score-width) rounded-full bg-primary"
									style={
										/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
											"--prompt-score-width": `${Math.round(runMean * 100)}%`,
										} as PromptScoreWidth
									}
								/>
							</div>
							<span className="font-medium">{pct(runMean)}</span>
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground">Compared run</span>
							<div className="h-2 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full w-(--prompt-score-width) rounded-full bg-secondary-foreground"
									style={
										/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
											"--prompt-score-width": `${Math.round(comparisonMean * 100)}%`,
										} as PromptScoreWidth
									}
								/>
							</div>
							<span className="font-medium">{pct(comparisonMean)}</span>
						</div>
					</div>
				</div>
			) : null}
			{results.map((promptResult) => (
				<PromptResultCard
					copy={copy}
					key={promptResult.promptId}
					matches={matches}
					model={model}
					onReviewSaved={onReviewSaved}
					promptResult={promptResult}
					reviews={reviews}
					rows={rows}
					runId={runId}
					suiteId={suiteId}
					target={target}
				/>
			))}
		</div>
	);
}
