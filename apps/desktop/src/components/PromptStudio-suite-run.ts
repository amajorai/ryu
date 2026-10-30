// Prompt Studio: run the suite's prompt variants through Gateway evals.

import { useCallback } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type EvalDatasetCase,
	runGatewayEvals,
} from "@/src/lib/api/gateway.ts";
import { savePromptRun } from "@/src/lib/api/prompt-suites.ts";
import {
	gatewayAssertion,
	isBoolean,
	isNumber,
	isString,
	type PromptVariantRun,
	parseRunTags,
	parseThreshold,
} from "@/src/lib/prompt-studio.ts";
import {
	type PromptVariantRow,
	runConfigFromEditor,
} from "./PromptStudio-suite-config.ts";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function usePromptSuiteRun(
	state: PromptSuiteState,
	{
		agentId,
		model,
		promptVariants,
		selectedModels,
		target,
	}: {
		agentId: string | null;
		model: string;
		promptVariants: PromptVariantRow[];
		selectedModels: string[];
		target: ApiTarget;
	}
) {
	const {
		abortRef,
		setRunning,
		setError,
		rows,
		judgeModel,
		evaluatorIds,
		codeEvaluators,
		maxConcurrency,
		timeoutMs,
		repeat,
		cache,
		runTags,
		runPrefix,
		runSuffix,
		setResults,
		setReviews,
		setComparisonResults,
		setComparisonRunId,
		suite,
		suiteName,
		setActiveRunId,
		setSuiteRuns,
	} = state;

	const stop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const run = useCallback(async () => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setError(null);
		try {
			const dataset: EvalDatasetCase[] = rows.map((r) => ({
				description: r.name.trim() || undefined,
				id: r.id,
				messages: r.messages,
				prompt: r.input,
				vars: r.vars,
				assertions: r.assertions.map(gatewayAssertion),
				context: r.context,
				expected: r.expected.trim() ? r.expected : undefined,
				threshold: parseThreshold(r.threshold),
				metadata: r.metadata,
				options: {
					cache: isBoolean(r.options.cache) ? r.options.cache : undefined,
					prefix: isString(r.options.prefix) ? r.options.prefix : undefined,
					suffix: isString(r.options.suffix) ? r.options.suffix : undefined,
					timeout_ms: isNumber(r.options.timeout_ms)
						? r.options.timeout_ms
						: undefined,
					transform: isString(r.options.transform)
						? r.options.transform
						: undefined,
					transform_vars: isString(r.options.transform_vars)
						? r.options.transform_vars
						: isString(r.options.transformVars)
							? r.options.transformVars
							: undefined,
				},
				provider: r.provider,
				providers: r.providers,
				provider_output: r.providerOutput,
			}));
			const runResults: PromptVariantRun[] = [];
			for (const variant of promptVariants) {
				if (controller.signal.aborted) {
					return;
				}
				const multi = selectedModels.length > 1;
				const res = await runGatewayEvals(
					target,
					{
						agent_id: agentId,
						model,
						models: multi ? selectedModels : undefined,
						system_prompt: variant.content,
						system_messages:
							variant.type === "chat" ? variant.messages : undefined,
						judge_model: judgeModel.trim() || undefined,
						evaluators: evaluatorIds,
						code_evaluators: codeEvaluators,
						dataset,
						max_concurrency: Math.max(1, Math.min(32, maxConcurrency)),
						timeout_ms: Math.max(100, Math.min(120_000, timeoutMs)),
						repeat: Math.max(1, Math.min(20, repeat)),
						cache,
						tags: parseRunTags(runTags),
						prefix: runPrefix || undefined,
						suffix: runSuffix || undefined,
						prompt_id: variant.id,
					},
					controller.signal
				);
				runResults.push({
					promptId: variant.id,
					promptName: variant.name,
					result: res,
				});
			}
			setResults(runResults);
			setReviews({});
			setComparisonResults(null);
			setComparisonRunId(null);
			if (suite) {
				const saved = await savePromptRun(target, suite.id, {
					name: `${suiteName} · ${new Date().toLocaleString()}`,
					request: {
						dataset,
						judge_model: judgeModel,
						models: selectedModels,
						prompts: promptVariants,
						run_config: runConfigFromEditor(
							maxConcurrency,
							timeoutMs,
							repeat,
							cache,
							runTags
						),
					},
					result: { variants: runResults },
				});
				setActiveRunId(saved.id);
				setSuiteRuns((prev) => [saved, ...prev]);
			}
		} catch (e) {
			if (!controller.signal.aborted) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			setRunning(false);
		}
	}, [
		agentId,
		cache,
		codeEvaluators,
		judgeModel,
		evaluatorIds,
		maxConcurrency,
		model,
		promptVariants,
		repeat,
		rows,
		runPrefix,
		runSuffix,
		runTags,
		selectedModels,
		suite,
		suiteName,
		target,
		timeoutMs,
	]);

	const handleRun = useCallback(() => {
		run().catch(() => {
			// errors are surfaced via setError inside run().
		});
	}, [run]);

	return { handleRun, stop };
}
