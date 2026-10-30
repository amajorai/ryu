// Prompt Studio: load, rename, duplicate, delete, and compare saved runs.

import { useCallback } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deletePromptRun,
	duplicatePromptRun,
	getPromptRun,
	listPromptReviews,
	renamePromptRun,
} from "@/src/lib/api/prompt-suites.ts";
import { isRecord, promptVariantRunsSchema } from "@/src/lib/prompt-studio.ts";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function usePromptRunHistoryActions(
	state: PromptSuiteState,
	target: ApiTarget
) {
	const {
		suite,
		setResults,
		setActiveRunId,
		setReviews,
		setError,
		setSuiteRuns,
		comparisonRunId,
		setComparisonResults,
		setComparisonRunId,
		activeRunId,
	} = state;

	const handleLoadRun = useCallback(
		async (runId: string) => {
			if (!suite) {
				return;
			}
			try {
				const [saved, savedReviews] = await Promise.all([
					getPromptRun(target, suite.id, runId),
					listPromptReviews(target, suite.id, runId),
				]);
				const savedResults = isRecord(saved.result)
					? saved.result.variants
					: undefined;
				if (Array.isArray(savedResults)) {
					setResults(promptVariantRunsSchema.parse(savedResults));
					setActiveRunId(runId);
					setReviews(
						Object.fromEntries(
							savedReviews.map((review) => [review.resultKey, review])
						)
					);
				}
			} catch (loadError) {
				setError(
					loadError instanceof Error ? loadError.message : "Failed to load run"
				);
			}
		},
		[suite, target]
	);

	const handleRenameRun = useCallback(
		async (runId: string, name: string) => {
			if (!(suite && name.trim())) {
				return;
			}
			try {
				const updated = await renamePromptRun(
					target,
					suite.id,
					runId,
					name.trim()
				);
				setSuiteRuns((prev) =>
					prev.map((run) => (run.id === runId ? updated : run))
				);
			} catch (renameError) {
				setError(
					renameError instanceof Error
						? renameError.message
						: "Failed to rename run"
				);
			}
		},
		[suite, target]
	);

	const handleDuplicateRun = useCallback(
		async (runId: string) => {
			if (!suite) {
				return;
			}
			try {
				const duplicate = await duplicatePromptRun(target, suite.id, runId);
				setSuiteRuns((prev) => [duplicate, ...prev]);
			} catch (duplicateError) {
				setError(
					duplicateError instanceof Error
						? duplicateError.message
						: "Failed to duplicate run"
				);
			}
		},
		[suite, target]
	);

	const handleDeleteRun = useCallback(
		async (runId: string) => {
			if (!suite) {
				return;
			}
			try {
				await deletePromptRun(target, suite.id, runId);
				setSuiteRuns((prev) => prev.filter((run) => run.id !== runId));
				if (comparisonRunId === runId) {
					setComparisonResults(null);
					setComparisonRunId(null);
				}
				if (activeRunId === runId) {
					setActiveRunId(null);
					setResults(null);
					setReviews({});
				}
			} catch (deleteError) {
				setError(
					deleteError instanceof Error
						? deleteError.message
						: "Failed to delete run"
				);
			}
		},
		[activeRunId, comparisonRunId, suite, target]
	);

	const handleCompareRun = useCallback(
		async (runId: string) => {
			if (!(suite && activeRunId) || activeRunId === runId) {
				setError(
					"Select one run first, then choose a different run to compare."
				);
				return;
			}
			try {
				const saved = await getPromptRun(target, suite.id, runId);
				const savedResults = isRecord(saved.result)
					? saved.result.variants
					: undefined;
				if (Array.isArray(savedResults)) {
					setComparisonResults(promptVariantRunsSchema.parse(savedResults));
					setComparisonRunId(runId);
				}
			} catch (compareError) {
				setError(
					compareError instanceof Error
						? compareError.message
						: "Failed to compare run"
				);
			}
		},
		[activeRunId, suite, target]
	);

	return {
		handleCompareRun,
		handleDeleteRun,
		handleDuplicateRun,
		handleLoadRun,
		handleRenameRun,
	};
}
