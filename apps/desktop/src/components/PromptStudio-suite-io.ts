// Prompt Studio: Promptfoo import, durable save/restore, and config export.

import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createPromptSuite,
	listPromptRuns,
	listPromptSuiteVersions,
	restorePromptSuiteVersion,
	updatePromptSuite,
} from "@/src/lib/api/prompt-suites.ts";
import {
	normalizePromptfooConfig,
	type PromptfooConfig,
	type PromptfooRelatedFiles,
	parsePromptfooFile,
	serializePromptfooConfig,
} from "@/src/lib/promptfoo.ts";
import {
	promptfooImportWarnings,
	runConfigFromEditor,
	suiteConfigFromEditor,
} from "./PromptStudio-suite-config.ts";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function usePromptSuiteIo(
	state: PromptSuiteState,
	{
		agentId,
		applyConfig,
		locked,
		promptDraft,
		target,
	}: {
		agentId: string | null;
		applyConfig: (config: PromptfooConfig) => void;
		locked: boolean;
		promptDraft: string;
		target: ApiTarget;
	}
) {
	const tl = useLiteralMessages();
	const {
		setPendingImport,
		setSuiteError,
		importAppliedRef,
		pendingImport,
		setSuiteName,
		setSuite,
		setSuiteVersions,
		setSuiteRuns,
		setSuiteSaving,
		variants,
		rows,
		extraModels,
		judgeModel,
		evaluatorIds,
		codeEvaluators,
		defaultTest,
		maxConcurrency,
		timeoutMs,
		repeat,
		cache,
		runTags,
		configExtras,
		suite,
		saveLabel,
		suiteName,
		setSaveLabel,
	} = state;

	const importFile = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []);
			const file = files[0];
			event.target.value = "";
			if (!file) {
				return;
			}
			try {
				const relatedFiles: PromptfooRelatedFiles = Object.fromEntries(
					await Promise.all(
						files
							.slice(1)
							.map(async (related) => [related.name, await related.text()])
					)
				);
				const parsed = parsePromptfooFile(
					await file.text(),
					file.name,
					relatedFiles
				);
				setPendingImport({
					config: parsed.config,
					filename: file.name,
					warnings: promptfooImportWarnings(parsed.config),
				});
				setSuiteError(null);
			} catch (importError) {
				setSuiteError(
					importError instanceof Error
						? tl("Import failed: {message}", {
								message: importError.message,
							})
						: "Import failed"
				);
			}
		},
		[applyConfig, tl]
	);

	const applyPendingImport = useCallback(() => {
		if (!pendingImport) {
			return;
		}
		importAppliedRef.current = true;
		applyConfig(pendingImport.config);
		setSuiteName(
			pendingImport.filename.replace(/\.[^.]+$/, "") || "Imported suite"
		);
		setSuite(null);
		setSuiteVersions([]);
		setSuiteRuns([]);
		setPendingImport(null);
	}, [applyConfig, pendingImport]);

	const saveSuite = useCallback(async () => {
		if (!agentId || locked) {
			return;
		}
		setSuiteSaving(true);
		setSuiteError(null);
		try {
			const config = suiteConfigFromEditor(
				promptDraft,
				variants,
				rows,
				extraModels,
				judgeModel,
				evaluatorIds,
				codeEvaluators,
				defaultTest,
				runConfigFromEditor(maxConcurrency, timeoutMs, repeat, cache, runTags),
				configExtras
			);
			const response = suite
				? await updatePromptSuite(target, suite.id, {
						config,
						label: saveLabel,
						name: suiteName,
					})
				: await createPromptSuite(target, {
						agentId,
						config,
						label: saveLabel,
						name: suiteName,
					});
			setSuite(response.suite);
			if (response.version) {
				const version = response.version;
				setSuiteVersions((prev) => [version, ...prev]);
			}
			setSaveLabel("");
			setSuiteRuns(await listPromptRuns(target, response.suite.id));
		} catch (saveError) {
			setSuiteError(
				saveError instanceof Error ? saveError.message : "Failed to save suite"
			);
		} finally {
			setSuiteSaving(false);
		}
	}, [
		agentId,
		extraModels,
		configExtras,
		judgeModel,
		evaluatorIds,
		codeEvaluators,
		defaultTest,
		maxConcurrency,
		timeoutMs,
		repeat,
		cache,
		runTags,
		locked,
		promptDraft,
		rows,
		saveLabel,
		suite,
		suiteName,
		target,
		variants,
	]);

	const restoreSuiteVersion = useCallback(
		async (versionId: string) => {
			if (!suite || locked) {
				return;
			}
			try {
				const restored = await restorePromptSuiteVersion(
					target,
					suite.id,
					versionId
				);
				setSuite(restored);
				applyConfig(normalizePromptfooConfig(restored.config));
				setSuiteVersions(await listPromptSuiteVersions(target, suite.id));
			} catch (restoreError) {
				setSuiteError(
					restoreError instanceof Error
						? restoreError.message
						: "Failed to restore suite version"
				);
			}
		},
		[applyConfig, locked, suite, target]
	);

	const exportConfig = useCallback(
		(format: "csv" | "json" | "jsonl" | "yaml") => {
			const config = suiteConfigFromEditor(
				promptDraft,
				variants,
				rows,
				extraModels,
				judgeModel,
				evaluatorIds,
				codeEvaluators,
				defaultTest,
				runConfigFromEditor(maxConcurrency, timeoutMs, repeat, cache, runTags),
				configExtras
			);
			const text = serializePromptfooConfig(config, format);
			const link = document.createElement("a");
			link.href = URL.createObjectURL(
				new Blob([text], {
					type: format === "yaml" ? "text/yaml" : "application/json",
				})
			);
			link.download = `${suiteName.trim() || "promptfoo-suite"}.${format}`;
			link.click();
			URL.revokeObjectURL(link.href);
		},
		[
			extraModels,
			evaluatorIds,
			judgeModel,
			codeEvaluators,
			configExtras,
			defaultTest,
			maxConcurrency,
			timeoutMs,
			repeat,
			cache,
			runTags,
			promptDraft,
			rows,
			suiteName,
			variants,
		]
	);

	return {
		applyPendingImport,
		exportConfig,
		importFile,
		restoreSuiteVersion,
		saveSuite,
	};
}
