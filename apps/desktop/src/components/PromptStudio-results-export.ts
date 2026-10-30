// Prompt Studio: result filtering, flattening, and export serializers.

import { stringify as stringifyYaml } from "yaml";
import type { EvalCaseScore, ModelEvalResult } from "@/src/lib/api/gateway.ts";
import type { PromptReview } from "@/src/lib/api/prompt-suites.ts";
import {
	isRecord,
	isString,
	type PromptVariantRun,
	type TestCaseRow,
} from "@/src/lib/prompt-studio.ts";
import {
	type PromptfooDocument,
	parsePromptfooDocument,
	parsePromptfooValue,
} from "@/src/lib/promptfoo.ts";

export type ResultFilter =
	| "all"
	| "pass"
	| "fail"
	| "error"
	| "different"
	| "highlighted";

export function matchesMetadataQuery(
	metadataInput: Parameters<typeof parsePromptfooValue>[0],
	query: string
): boolean {
	const metadata = parsePromptfooValue(metadataInput);
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return true;
	}
	const separatorIndex = normalizedQuery.indexOf("=");
	if (separatorIndex < 0) {
		return JSON.stringify(metadata ?? {})
			.toLowerCase()
			.includes(normalizedQuery);
	}
	if (!isRecord(metadata)) {
		return false;
	}
	const key = normalizedQuery.slice(0, separatorIndex).trim();
	const expectedValue = normalizedQuery.slice(separatorIndex + 1).trim();
	const actual = Object.entries(metadata).find(
		([name]) => name.toLowerCase() === key
	)?.[1];
	if (actual === undefined) {
		return false;
	}
	return JSON.stringify(actual).toLowerCase().includes(expectedValue);
}

export interface ResultExportRow {
	caseIndex: number;
	caseName: string;
	model: string;
	prompt: string;
	promptName: string;
	resultKey: string;
	score: EvalCaseScore;
}

export function resultModels(
	promptResult: PromptVariantRun,
	fallbackModel: string
): ModelEvalResult[] {
	return (
		promptResult.result.models ?? [
			{
				model: fallbackModel,
				cases: promptResult.result.cases,
				aggregate: promptResult.result.aggregate,
			},
		]
	);
}

export function flattenResultRows(
	results: PromptVariantRun[],
	model: string,
	rows: TestCaseRow[]
): ResultExportRow[] {
	const output: ResultExportRow[] = [];
	for (const promptResult of results) {
		for (const entry of resultModels(promptResult, model)) {
			for (const [caseIndex, score] of entry.cases.entries()) {
				output.push({
					caseIndex,
					caseName: rows[caseIndex]?.name || `Case ${caseIndex + 1}`,
					model: entry.model,
					prompt: score.prompt,
					promptName: promptResult.promptName,
					resultKey: `${promptResult.promptId}:${entry.model}:${caseIndex}`,
					score,
				});
			}
		}
	}
	return output;
}

export function exportRowsCsv(rows: ResultExportRow[]): string {
	const cell = (input: Parameters<typeof parsePromptfooValue>[0]): string => {
		const value = parsePromptfooValue(input);
		const text = isString(value) ? value : JSON.stringify(value ?? "");
		return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	return [
		"prompt,model,case,overall,assertion_score,assertions_pass,error,response,latency_score,latency_available,policy_available,input_tokens,output_tokens,cost_micro_usd,metadata",
		...rows.map(({ caseName, model, promptName, score }) =>
			[
				promptName,
				model,
				caseName,
				score.overall,
				score.assertion_score,
				score.assertions_pass,
				score.error ?? "",
				score.response_text,
				score.latency_score,
				score.latency_available ?? true,
				score.policy_available ?? true,
				score.input_tokens ?? "",
				score.output_tokens ?? "",
				score.cost_micro_usd ?? "",
				score.metadata ?? {},
			]
				.map(cell)
				.join(",")
		),
	].join("\n");
}

export function exportDpoJsonl(rows: ResultExportRow[]): string {
	const byPromptAndCase = new Map<string, ResultExportRow[]>();
	for (const row of rows) {
		const key = `${row.promptName}:${row.caseIndex}`;
		const group = byPromptAndCase.get(key) ?? [];
		group.push(row);
		byPromptAndCase.set(key, group);
	}
	const preferences: PromptfooDocument[] = [];
	for (const group of byPromptAndCase.values()) {
		if (group.length < 2) {
			continue;
		}
		const ranked = [...group].sort(
			(left, right) => right.score.overall - left.score.overall
		);
		const chosen = ranked[0];
		const rejected = ranked.at(-1);
		if (!(chosen && rejected) || chosen.model === rejected.model) {
			continue;
		}
		preferences.push({
			chosen: chosen.score.response_text,
			chosen_model: chosen.model,
			metadata: parsePromptfooDocument(chosen.score.metadata ?? {}),
			prompt: chosen.prompt,
			rejected: rejected.score.response_text,
			rejected_model: rejected.model,
		});
	}
	return preferences.map((row) => JSON.stringify(row)).join("\n");
}

export function exportHumanEvalYaml(
	rows: ResultExportRow[],
	reviews: Record<string, PromptReview>
): string {
	return stringifyYaml(
		rows.map(({ caseName, model, prompt, promptName, resultKey, score }) => {
			const review = reviews[resultKey];
			return {
				case: caseName,
				comment: review?.comment ?? null,
				highlighted: review?.highlighted ?? false,
				input: prompt,
				model,
				output: score.response_text,
				pass: review?.pass ?? null,
				prompt: promptName,
				score: review?.score ?? score.overall,
			};
		})
	);
}
