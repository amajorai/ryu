// Prompt Studio: load the durable suite from Core and persist the local draft.

import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getPromptRun,
	listPromptReviews,
	listPromptRuns,
	listPromptSuites,
	listPromptSuiteVersions,
} from "@/src/lib/api/prompt-suites.ts";
import {
	isRecord,
	isString,
	linkedPromptRunId,
	loadTestSuite,
	parseCodeEvaluators,
	parseRunTags,
	persistTestSuite,
	promptVariantRunsSchema,
} from "@/src/lib/prompt-studio.ts";
import { normalizePromptfooConfig } from "@/src/lib/promptfoo.ts";
import {
	numericRunOption,
	promptfooConfigExtras,
	promptfooRunConfig,
	promptfooTestToRow,
	promptVariantFromConfig,
	runTagsFromConfig,
} from "./PromptStudio-suite-config.ts";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function usePromptSuiteLoad(
	state: PromptSuiteState,
	agentId: string | null,
	onPromptChange: (value: string) => void,
	target: ApiTarget
): void {
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const {
		abortRef,
		importAppliedRef,
		loadedSuiteAgentRef,
		setSuiteLoading,
		setSuiteError,
		setResults,
		setActiveRunId,
		setReviews,
		setComparisonResults,
		setComparisonRunId,
		setSuite,
		setConfigExtras,
		setSuiteName,
		setCodeEvaluators,
		setDefaultTest,
		setRows,
		setExtraModels,
		setJudgeModel,
		setEvaluatorIds,
		setMaxConcurrency,
		setTimeoutMs,
		setRepeat,
		setCache,
		setRunTags,
		setVariants,
		setSuiteVersions,
		setSuiteRuns,
		codeEvaluators,
		defaultTest,
		evaluatorIds,
		extraModels,
		judgeModel,
		maxConcurrency,
		repeat,
		runTags,
		timeoutMs,
		rows,
	} = state;

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		let cancelled = false;
		importAppliedRef.current = false;
		const load = async () => {
			loadedSuiteAgentRef.current = null;
			setSuiteLoading(true);
			setSuiteError(null);
			setResults(null);
			setActiveRunId(null);
			setReviews({});
			setComparisonResults(null);
			setComparisonRunId(null);
			try {
				if (!agentId) {
					return;
				}
				const suites = await listPromptSuites(target, agentId);
				if (cancelled || importAppliedRef.current) {
					return;
				}
				const nextSuite = suites[0];
				if (!nextSuite) {
					const local = loadTestSuite(agentId);
					setSuite(null);
					setConfigExtras({});
					setSuiteName("Promptfoo regression suite");
					setCodeEvaluators(local.codeEvaluators ?? []);
					setDefaultTest(local.defaultTest ?? {});
					setRows(local.rows);
					setExtraModels(local.extraModels);
					setJudgeModel(local.judgeModel);
					setEvaluatorIds(local.evaluatorIds);
					setMaxConcurrency(local.maxConcurrency ?? 4);
					setTimeoutMs(local.timeoutMs ?? 120_000);
					setRepeat(local.repeat ?? 1);
					setRunTags(
						Object.entries(local.tags ?? {})
							.map(([key, value]) => `${key}=${value}`)
							.join(", ")
					);
					setVariants([]);
					setSuiteVersions([]);
					setSuiteRuns([]);
					setComparisonResults(null);
					setComparisonRunId(null);
					return;
				}
				const config = normalizePromptfooConfig(nextSuite.config);
				setSuite(nextSuite);
				setConfigExtras(promptfooConfigExtras(config));
				setSuiteName(nextSuite.name);
				setCodeEvaluators(parseCodeEvaluators(config.code_evaluators));
				setDefaultTest(isRecord(config.defaultTest) ? config.defaultTest : {});
				setRows(config.tests.map(promptfooTestToRow));
				setExtraModels(config.providers);
				setJudgeModel(isString(config.judge_model) ? config.judge_model : "");
				setEvaluatorIds(
					Array.isArray(config.evaluators)
						? config.evaluators.filter((value): value is string =>
								isString(value)
							)
						: []
				);
				const savedRunConfig = promptfooRunConfig(config);
				setMaxConcurrency(
					numericRunOption(
						savedRunConfig,
						"max_concurrency",
						"maxConcurrency"
					) ?? 4
				);
				setTimeoutMs(
					numericRunOption(savedRunConfig, "timeout_ms", "timeoutMs") ?? 120_000
				);
				setRepeat(numericRunOption(savedRunConfig, "repeat") ?? 1);
				setCache(savedRunConfig.cache !== false);
				setRunTags(runTagsFromConfig(savedRunConfig));
				setVariants(config.prompts.slice(1).map(promptVariantFromConfig));
				if (config.prompts[0]?.content) {
					onPromptChange(config.prompts[0].content);
				}
				const [versions, runs] = await Promise.all([
					listPromptSuiteVersions(target, nextSuite.id),
					listPromptRuns(target, nextSuite.id),
				]);
				if (!(cancelled || importAppliedRef.current)) {
					setSuiteVersions(versions);
					setSuiteRuns(runs);
					const linkedRunId = linkedPromptRunId();
					if (linkedRunId && runs.some((run) => run.id === linkedRunId)) {
						const [linkedRun, linkedReviews] = await Promise.all([
							getPromptRun(target, nextSuite.id, linkedRunId),
							listPromptReviews(target, nextSuite.id, linkedRunId),
						]);
						const linkedResults = isRecord(linkedRun.result)
							? linkedRun.result.variants
							: undefined;
						if (
							!(cancelled || importAppliedRef.current) &&
							Array.isArray(linkedResults)
						) {
							setResults(promptVariantRunsSchema.parse(linkedResults));
							setActiveRunId(linkedRunId);
							setReviews(
								Object.fromEntries(
									linkedReviews.map((review) => [review.resultKey, review])
								)
							);
						}
					}
				}
			} catch (loadError) {
				if (!(cancelled || importAppliedRef.current)) {
					// Core may be on an older build while the editor is being upgraded;
					// preserve the local draft and surface the durable-sync state.
					const local = agentId ? loadTestSuite(agentId) : null;
					if (local) {
						setRows(local.rows);
						setCodeEvaluators(local.codeEvaluators ?? []);
						setDefaultTest(local.defaultTest ?? {});
						setExtraModels(local.extraModels);
						setJudgeModel(local.judgeModel);
						setEvaluatorIds(local.evaluatorIds);
						setMaxConcurrency(local.maxConcurrency ?? 4);
						setTimeoutMs(local.timeoutMs ?? 120_000);
						setRepeat(local.repeat ?? 1);
						setRunTags(
							Object.entries(local.tags ?? {})
								.map(([key, value]) => `${key}=${value}`)
								.join(", ")
						);
					}
					setSuiteError(
						loadError instanceof Error
							? tlRef.current("Durable suite unavailable: {message}", {
									message: loadError.message,
								})
							: "Durable suite unavailable"
					);
				}
			} finally {
				if (!cancelled) {
					setSuiteLoading(false);
					loadedSuiteAgentRef.current = agentId;
				}
			}
		};
		load().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [agentId, onPromptChange, target]);

	useEffect(() => {
		if (!agentId || loadedSuiteAgentRef.current !== agentId) {
			return;
		}
		persistTestSuite(agentId, {
			codeEvaluators,
			defaultTest,
			evaluatorIds,
			extraModels,
			judgeModel,
			maxConcurrency,
			repeat,
			tags: parseRunTags(runTags),
			timeoutMs,
			rows,
		});
	}, [
		agentId,
		codeEvaluators,
		defaultTest,
		evaluatorIds,
		extraModels,
		judgeModel,
		maxConcurrency,
		repeat,
		runTags,
		timeoutMs,
		rows,
	]);
}
