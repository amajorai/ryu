// Prompt Studio: the Promptfoo suite editor's state.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeEvaluatorSpec } from "@/src/lib/api/gateway.ts";
import type {
	PromptReview,
	PromptRunMeta,
	PromptSuiteRecord,
	PromptSuiteVersionMeta,
} from "@/src/lib/api/prompt-suites.ts";
import {
	loadTestSuite,
	type PromptVariantRun,
	type TestCaseRow,
} from "@/src/lib/prompt-studio.ts";
import type { PromptfooDocument } from "@/src/lib/promptfoo.ts";
import type {
	PendingPromptfooImport,
	PromptVariantRow,
} from "./PromptStudio-suite-config.ts";

export function usePromptSuiteState(agentId: string | null) {
	const localSuite = useMemo(() => loadTestSuite(agentId), [agentId]);
	const [rows, setRows] = useState<TestCaseRow[]>(() => localSuite.rows);
	const [codeEvaluators, setCodeEvaluators] = useState<CodeEvaluatorSpec[]>(
		() => localSuite.codeEvaluators ?? []
	);
	const [configExtras, setConfigExtras] = useState<PromptfooDocument>({});
	const [codeEvaluatorText, setCodeEvaluatorText] = useState(() =>
		JSON.stringify(localSuite.codeEvaluators ?? [], null, 2)
	);
	const [defaultTest, setDefaultTest] = useState<PromptfooDocument>(
		() => localSuite.defaultTest ?? {}
	);
	const [defaultTestText, setDefaultTestText] = useState(() =>
		JSON.stringify(localSuite.defaultTest ?? {}, null, 2)
	);
	const [extraModels, setExtraModels] = useState<string[]>(
		() => localSuite.extraModels
	);
	const [newModel, setNewModel] = useState("");
	const [judgeModel, setJudgeModel] = useState(() => localSuite.judgeModel);
	const [evaluatorIds, setEvaluatorIds] = useState<string[]>(
		() => localSuite.evaluatorIds
	);
	const [maxConcurrency, setMaxConcurrency] = useState(
		() => localSuite.maxConcurrency ?? 4
	);
	const [timeoutMs, setTimeoutMs] = useState(
		() => localSuite.timeoutMs ?? 120_000
	);
	const [repeat, setRepeat] = useState(() => localSuite.repeat ?? 1);
	const [cache, setCache] = useState(true);
	const [runTags, setRunTags] = useState(() =>
		Object.entries(localSuite.tags ?? {})
			.map(([key, value]) => `${key}=${value}`)
			.join(", ")
	);
	const [runPrefix, setRunPrefix] = useState("");
	const [runSuffix, setRunSuffix] = useState("");
	const [suite, setSuite] = useState<PromptSuiteRecord | null>(null);
	const [suiteName, setSuiteName] = useState("Promptfoo regression suite");
	const [suiteVersions, setSuiteVersions] = useState<PromptSuiteVersionMeta[]>(
		[]
	);
	const [suiteRuns, setSuiteRuns] = useState<PromptRunMeta[]>([]);
	const [suiteLoading, setSuiteLoading] = useState(false);
	const [suiteSaving, setSuiteSaving] = useState(false);
	const [suiteError, setSuiteError] = useState<string | null>(null);
	const [pendingImport, setPendingImport] =
		useState<PendingPromptfooImport | null>(null);
	const [saveLabel, setSaveLabel] = useState("");
	const [exportFormat, setExportFormat] = useState<
		"csv" | "json" | "jsonl" | "yaml"
	>("yaml");
	const [variants, setVariants] = useState<PromptVariantRow[]>([]);
	const [running, setRunning] = useState(false);
	const [results, setResults] = useState<PromptVariantRun[] | null>(null);
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const [reviews, setReviews] = useState<Record<string, PromptReview>>({});
	const [comparisonResults, setComparisonResults] = useState<
		PromptVariantRun[] | null
	>(null);
	const [comparisonRunId, setComparisonRunId] = useState<string | null>(null);
	useEffect(() => {
		setCodeEvaluatorText(JSON.stringify(codeEvaluators, null, 2));
	}, [codeEvaluators]);
	useEffect(() => {
		setDefaultTestText(JSON.stringify(defaultTest, null, 2));
	}, [defaultTest]);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const loadedSuiteAgentRef = useRef<string | null>(null);
	const importAppliedRef = useRef(false);
	return {
		rows,
		setRows,
		codeEvaluators,
		setCodeEvaluators,
		configExtras,
		setConfigExtras,
		codeEvaluatorText,
		setCodeEvaluatorText,
		defaultTest,
		setDefaultTest,
		defaultTestText,
		setDefaultTestText,
		extraModels,
		setExtraModels,
		newModel,
		setNewModel,
		judgeModel,
		setJudgeModel,
		evaluatorIds,
		setEvaluatorIds,
		maxConcurrency,
		setMaxConcurrency,
		timeoutMs,
		setTimeoutMs,
		repeat,
		setRepeat,
		cache,
		setCache,
		runTags,
		setRunTags,
		runPrefix,
		setRunPrefix,
		runSuffix,
		setRunSuffix,
		suite,
		setSuite,
		suiteName,
		setSuiteName,
		suiteVersions,
		setSuiteVersions,
		suiteRuns,
		setSuiteRuns,
		suiteLoading,
		setSuiteLoading,
		suiteSaving,
		setSuiteSaving,
		suiteError,
		setSuiteError,
		pendingImport,
		setPendingImport,
		saveLabel,
		setSaveLabel,
		exportFormat,
		setExportFormat,
		variants,
		setVariants,
		running,
		setRunning,
		results,
		setResults,
		activeRunId,
		setActiveRunId,
		reviews,
		setReviews,
		comparisonResults,
		setComparisonResults,
		comparisonRunId,
		setComparisonRunId,
		error,
		setError,
		abortRef,
		loadedSuiteAgentRef,
		importAppliedRef,
	};
}

export type PromptSuiteState = ReturnType<typeof usePromptSuiteState>;
