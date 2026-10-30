// Prompt Studio: the gateway-backed Promptfoo suite / test-cases runner.

import { PlayIcon, Square01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useMemo } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { LARGE_MATRIX_THRESHOLD } from "./PromptStudio-format.ts";
import { ModelControls, RunHint } from "./PromptStudio-model-controls.tsx";
import { ResultsMatrix } from "./PromptStudio-results-matrix.tsx";
import { PromptRunHistory } from "./PromptStudio-run-history.tsx";
import { usePromptRunHistoryActions } from "./PromptStudio-run-history-actions.ts";
import { PromptRunOptions } from "./PromptStudio-run-options.tsx";
import type { PromptVariantRow } from "./PromptStudio-suite-config.ts";
import { usePromptSuiteEditing } from "./PromptStudio-suite-edit.ts";
import { usePromptSuiteIo } from "./PromptStudio-suite-io.ts";
import { usePromptSuiteLoad } from "./PromptStudio-suite-load.ts";
import { usePromptSuiteRun } from "./PromptStudio-suite-run.ts";
import { usePromptSuiteState } from "./PromptStudio-suite-state.ts";
import { PromptSuiteToolbar } from "./PromptStudio-suite-toolbar.tsx";
import { TestCaseTable } from "./PromptStudio-test-case-table.tsx";
import { PromptVariantsEditor } from "./PromptStudio-variants-editor.tsx";

export interface PromptTestCasesProps {
	agentId: string | null;
	engine: string;
	locked: boolean;
	model: string;
	onPromptChange: (value: string) => void;
	promptDraft: string;
	target: ApiTarget;
}

export function PromptTestCases({
	promptDraft,
	agentId,
	target,
	model,
	engine,
	locked,
	onPromptChange,
}: PromptTestCasesProps) {
	const state = usePromptSuiteState(agentId);
	usePromptSuiteLoad(state, agentId, onPromptChange, target);
	const {
		activeRunId,
		comparisonResults,
		comparisonRunId,
		error,
		extraModels,
		judgeModel,
		newModel,
		results,
		reviews,
		rows,
		running,
		setJudgeModel,
		setNewModel,
		setReviews,
		suite,
		suiteRuns,
		variants,
	} = state;

	// The full model list for this run: the agent's model plus any extras.
	const selectedModels = useMemo(() => {
		const all = [model, ...extraModels].map((m) => m.trim()).filter(Boolean);
		return Array.from(new Set(all));
	}, [model, extraModels]);
	const promptVariants = useMemo<PromptVariantRow[]>(
		() => [
			{
				content: promptDraft,
				id: "primary",
				messages: [],
				name: "Primary",
				type: "text",
			},
			...variants,
		],
		[promptDraft, variants]
	);

	const isAcp = engine.startsWith("acp:");
	const matrixSize =
		selectedModels.length * Math.max(rows.length, 1) * promptVariants.length;
	const largeMatrix = matrixSize > LARGE_MATRIX_THRESHOLD;

	const runDisabled = running || !agentId || !model.trim() || isAcp || locked;

	const {
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
	} = usePromptSuiteEditing(state, promptDraft, onPromptChange);
	const {
		applyPendingImport,
		exportConfig,
		importFile,
		restoreSuiteVersion,
		saveSuite,
	} = usePromptSuiteIo(state, {
		agentId,
		applyConfig,
		locked,
		promptDraft,
		target,
	});
	const { handleRun, stop } = usePromptSuiteRun(state, {
		agentId,
		model,
		promptVariants,
		selectedModels,
		target,
	});
	const {
		handleCompareRun,
		handleDeleteRun,
		handleDuplicateRun,
		handleLoadRun,
		handleRenameRun,
	} = usePromptRunHistoryActions(state, target);

	return (
		<section className="flex flex-col gap-3 rounded-xl border p-4">
			<PromptSuiteToolbar
				agentId={agentId}
				applyPendingImport={applyPendingImport}
				exportConfig={exportConfig}
				importFile={importFile}
				locked={locked}
				restoreSuiteVersion={restoreSuiteVersion}
				saveSuite={saveSuite}
				state={state}
			/>

			<PromptVariantsEditor
				locked={locked}
				onAdd={addVariant}
				onDuplicate={duplicateVariant}
				onMove={moveVariant}
				onRemove={removeVariant}
				onUpdate={updateVariant}
				variants={variants}
			/>

			{/* Test-case table */}
			<TestCaseTable
				locked={locked}
				onAddRow={addRow}
				onDuplicateRow={duplicateRow}
				onMoveRow={moveRow}
				onRemoveRow={removeRow}
				onUpdateRow={updateRow}
				rows={rows}
			/>

			{/* Model + judge inputs */}
			<ModelControls
				extraModels={extraModels}
				judgeModel={judgeModel}
				locked={locked}
				newModel={newModel}
				onAddModel={addExtraModel}
				onJudgeChange={setJudgeModel}
				onNewModelChange={setNewModel}
				onRemoveModel={removeExtraModel}
				primaryModel={model}
			/>
			<PromptRunOptions locked={locked} state={state} />

			{/* Run controls */}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					disabled={runDisabled}
					loading={running}
					onClick={handleRun}
					size="sm"
				>
					<HugeiconsIcon className="size-3" icon={PlayIcon} />
					{running ? "Running…" : "Run test cases"}
				</Button>
				{running ? (
					<Button onClick={stop} size="sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Square01Icon} />
						Stop
					</Button>
				) : null}
				<RunHint
					isAcp={isAcp}
					largeMatrix={largeMatrix}
					missingModel={!model.trim()}
				/>
			</div>

			{error ? (
				<p className="text-status-destructive text-xs">{error}</p>
			) : null}

			<PromptRunHistory
				onCompare={handleCompareRun}
				onDelete={handleDeleteRun}
				onDuplicate={handleDuplicateRun}
				onRename={handleRenameRun}
				onSelect={handleLoadRun}
				runs={suiteRuns}
				selectedRunId={activeRunId}
			/>

			{/* Results matrix */}
			{results ? (
				<ResultsMatrix
					comparisonResults={comparisonResults}
					comparisonRunId={comparisonRunId}
					model={model}
					onReviewSaved={(review) =>
						setReviews((previous) => ({
							...previous,
							[review.resultKey]: review,
						}))
					}
					results={results}
					reviews={reviews}
					rows={rows}
					runId={activeRunId}
					suiteId={suite?.id ?? null}
					target={target}
				/>
			) : null}
		</section>
	);
}
