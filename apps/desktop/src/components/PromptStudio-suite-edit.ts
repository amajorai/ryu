// Prompt Studio: test-case, prompt-variant, and model list editing callbacks.

import { useCallback } from "react";
import {
	isRecord,
	isString,
	newTestCaseRow,
	parseCodeEvaluators,
	type TestCaseRow,
} from "@/src/lib/prompt-studio.ts";
import type { PromptfooConfig } from "@/src/lib/promptfoo.ts";
import {
	numericRunOption,
	type PromptVariantRow,
	promptfooConfigExtras,
	promptfooRunConfig,
	promptfooTestToRow,
	promptVariantFromConfig,
	runTagsFromConfig,
} from "./PromptStudio-suite-config.ts";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function usePromptSuiteEditing(
	state: PromptSuiteState,
	promptDraft: string,
	onPromptChange: (value: string) => void
) {
	const {
		setRows,
		setVariants,
		newModel,
		setExtraModels,
		setNewModel,
		setConfigExtras,
		setCodeEvaluators,
		setDefaultTest,
		setJudgeModel,
		setEvaluatorIds,
		setMaxConcurrency,
		setTimeoutMs,
		setRepeat,
		setCache,
		setRunTags,
	} = state;

	const addRow = useCallback(() => {
		setRows((prev) => [...prev, newTestCaseRow()]);
	}, []);

	const removeRow = useCallback((id: string) => {
		setRows((prev) => prev.filter((r) => r.id !== id));
	}, []);

	const updateRow = useCallback((id: string, patch: Partial<TestCaseRow>) => {
		setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	}, []);

	const moveRow = useCallback((id: string, direction: -1 | 1) => {
		setRows((previous) => {
			const index = previous.findIndex((row) => row.id === id);
			const nextIndex = index + direction;
			if (index < 0 || nextIndex < 0 || nextIndex >= previous.length) {
				return previous;
			}
			const next = previous.slice();
			[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
			return next;
		});
	}, []);

	const duplicateRow = useCallback((id: string) => {
		setRows((previous) => {
			const index = previous.findIndex((row) => row.id === id);
			const source = previous[index];
			if (!source) {
				return previous;
			}
			const duplicate = {
				...source,
				id: crypto.randomUUID(),
				name: `${source.name || `Case ${index + 1}`} copy`,
				metadata: { ...source.metadata },
				options: { ...source.options },
				providers: [...source.providers],
				vars: { ...source.vars },
				assertions: source.assertions.map((assertion) =>
					structuredClone(assertion)
				),
			};
			return [
				...previous.slice(0, index + 1),
				duplicate,
				...previous.slice(index + 1),
			];
		});
	}, []);

	const addVariant = useCallback(() => {
		setVariants((prev) => [
			...prev,
			{
				content: promptDraft,
				id: `prompt-${crypto.randomUUID()}`,
				messages: [],
				name: `Variant ${prev.length + 1}`,
				type: "text",
			},
		]);
	}, [promptDraft]);

	const updateVariant = useCallback(
		(id: string, patch: Partial<PromptVariantRow>) => {
			setVariants((prev) =>
				prev.map((variant) =>
					variant.id === id ? { ...variant, ...patch } : variant
				)
			);
		},
		[]
	);

	const removeVariant = useCallback((id: string) => {
		setVariants((prev) => prev.filter((variant) => variant.id !== id));
	}, []);

	const moveVariant = useCallback((id: string, direction: -1 | 1) => {
		setVariants((previous) => {
			const index = previous.findIndex((variant) => variant.id === id);
			const nextIndex = index + direction;
			if (index < 0 || nextIndex < 0 || nextIndex >= previous.length) {
				return previous;
			}
			const next = previous.slice();
			[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
			return next;
		});
	}, []);

	const duplicateVariant = useCallback((id: string) => {
		setVariants((previous) => {
			const index = previous.findIndex((variant) => variant.id === id);
			const source = previous[index];
			if (!source) {
				return previous;
			}
			const duplicate = {
				...source,
				id: `prompt-${crypto.randomUUID()}`,
				messages: source.messages.map((message) => ({ ...message })),
				name: `${source.name || `Variant ${index + 1}`} copy`,
			};
			return [
				...previous.slice(0, index + 1),
				duplicate,
				...previous.slice(index + 1),
			];
		});
	}, []);

	const addExtraModel = useCallback(() => {
		const m = newModel.trim();
		if (!m) {
			return;
		}
		setExtraModels((prev) => (prev.includes(m) ? prev : [...prev, m]));
		setNewModel("");
	}, [newModel]);

	const removeExtraModel = useCallback((m: string) => {
		setExtraModels((prev) => prev.filter((x) => x !== m));
	}, []);

	const applyConfig = useCallback(
		(config: PromptfooConfig) => {
			setConfigExtras(promptfooConfigExtras(config));
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
			const importedRunConfig = promptfooRunConfig(config);
			setMaxConcurrency(
				numericRunOption(
					importedRunConfig,
					"max_concurrency",
					"maxConcurrency"
				) ?? 4
			);
			setTimeoutMs(
				numericRunOption(importedRunConfig, "timeout_ms", "timeoutMs") ??
					120_000
			);
			setRepeat(numericRunOption(importedRunConfig, "repeat") ?? 1);
			setCache(importedRunConfig.cache !== false);
			setRunTags(runTagsFromConfig(importedRunConfig));
			setVariants(config.prompts.slice(1).map(promptVariantFromConfig));
			if (config.prompts[0]?.content !== undefined) {
				onPromptChange(config.prompts[0].content);
			}
		},
		[onPromptChange]
	);

	return {
		addExtraModel,
		addRow,
		addVariant,
		applyConfig,
		duplicateRow,
		duplicateVariant,
		moveRow,
		moveVariant,
		removeExtraModel,
		removeRow,
		removeVariant,
		updateRow,
		updateVariant,
	};
}
