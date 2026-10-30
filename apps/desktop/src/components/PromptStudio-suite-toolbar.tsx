// Prompt Studio: suite name/save/restore/import/export toolbar and import preview.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { z } from "zod";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function PromptSuiteToolbar({
	agentId,
	applyPendingImport,
	exportConfig,
	importFile,
	locked,
	restoreSuiteVersion,
	saveSuite,
	state,
}: {
	agentId: string | null;
	applyPendingImport: () => void;
	exportConfig: (format: "csv" | "json" | "jsonl" | "yaml") => void;
	importFile: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
	locked: boolean;
	restoreSuiteVersion: (versionId: string) => Promise<void>;
	saveSuite: () => Promise<void>;
	state: PromptSuiteState;
}) {
	const tl = useLiteralMessages();
	const {
		suite,
		suiteVersions,
		suiteLoading,
		suiteName,
		setSuiteName,
		saveLabel,
		setSaveLabel,
		suiteSaving,
		exportFormat,
		setExportFormat,
		suiteError,
		pendingImport,
		setPendingImport,
	} = state;
	return (
		<>
			<div className="flex items-center gap-2">
				<span className="font-medium text-base">Promptfoo suite</span>
				{suite ? (
					<Badge variant="secondary">
						{tl("{count} versions", {
							count: String(suiteVersions.length),
						})}
					</Badge>
				) : null}
				<span className="text-muted-foreground text-xs">
					{suiteLoading
						? "Loading durable suite…"
						: "Prompts, providers, tests, assertions, runs, and reviews"}
				</span>
			</div>

			<div className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/20 p-3">
				<div className="flex min-w-56 flex-1 flex-col gap-1">
					<Label htmlFor="promptfoo-suite-name" size="caption">
						Suite name
					</Label>
					<Input
						disabled={locked}
						id="promptfoo-suite-name"
						onChange={(event) => setSuiteName(event.target.value)}
						size="compact"
						value={suiteName}
					/>
				</div>
				<div className="flex min-w-44 flex-col gap-1">
					<Label htmlFor="promptfoo-save-label" size="caption">
						Version label (optional)
					</Label>
					<Input
						disabled={locked}
						id="promptfoo-save-label"
						onChange={(event) => setSaveLabel(event.target.value)}
						placeholder="Baseline, stricter rubric…"
						size="compact"
						value={saveLabel}
					/>
				</div>
				<Button
					disabled={locked || !agentId || suiteSaving || suiteLoading}
					loading={suiteSaving}
					onClick={() => saveSuite().catch(() => undefined)}
					size="sm"
				>
					Save suite
				</Button>
				{suiteVersions.length > 0 ? (
					<NativeSelect
						appearance="compact"
						aria-label="Restore suite version"
						className="max-w-44"
						disabled={locked}
						onChange={(event) => {
							if (event.target.value) {
								restoreSuiteVersion(event.target.value).catch(() => undefined);
							}
						}}
						value=""
					>
						<NativeSelectOption value="">Restore version…</NativeSelectOption>
						{suiteVersions.map((version) => (
							<NativeSelectOption key={version.id} value={version.id}>
								{version.label || new Date(version.createdAt).toLocaleString()}
							</NativeSelectOption>
						))}
					</NativeSelect>
				) : null}
				<label className="inline-flex cursor-pointer items-center">
					<span className="sr-only">Import Promptfoo config</span>
					<Input
						accept=".csv,.json,.jsonl,.md,.txt,.yaml,.yml,.j2"
						className="hidden"
						disabled={locked}
						multiple
						onChange={(event) => importFile(event).catch(() => undefined)}
						type="file"
					/>
					<span className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
						Import
					</span>
				</label>
				<NativeSelect
					appearance="compact"
					aria-label="Export format"
					className="w-24"
					onChange={(event) =>
						setExportFormat(
							z.enum(["yaml", "json", "jsonl", "csv"]).parse(event.target.value)
						)
					}
					value={exportFormat}
				>
					<NativeSelectOption value="yaml">YAML</NativeSelectOption>
					<NativeSelectOption value="json">JSON</NativeSelectOption>
					<NativeSelectOption value="jsonl">JSONL</NativeSelectOption>
					<NativeSelectOption value="csv">CSV</NativeSelectOption>
				</NativeSelect>
				<Button
					onClick={() => exportConfig(exportFormat)}
					size="sm"
					variant="outline"
				>
					Export
				</Button>
			</div>

			{suiteError ? (
				<p className="text-status-destructive text-xs">{suiteError}</p>
			) : null}
			{pendingImport ? (
				<div
					aria-live="polite"
					className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/20 p-3"
					data-testid="promptfoo-import-preview"
				>
					<div>
						<p className="font-medium text-xs">Import ready</p>
						<p className="type-caption text-muted-foreground">
							{tl(
								"{filename} contains {promptCount, plural, one {{promptCountText} prompt} other {{promptCountText} prompts}}, {testCount, plural, one {{testCountText} test} other {{testCountText} tests}}, and {providerCount, plural, one {{providerCountText} provider} other {{providerCountText} providers}}. Applying it replaces the current draft.",
								{
									filename: pendingImport.filename,
									promptCount: pendingImport.config.prompts.length,
									promptCountText: String(pendingImport.config.prompts.length),
									providerCount: pendingImport.config.providers.length,
									providerCountText: String(
										pendingImport.config.providers.length
									),
									testCount: pendingImport.config.tests.length,
									testCountText: String(pendingImport.config.tests.length),
								}
							)}
						</p>
					</div>
					{pendingImport.warnings.map((warning) => (
						<p className="type-caption text-status-warning" key={warning}>
							{warning}
						</p>
					))}
					<div className="flex flex-wrap gap-2">
						<Button onClick={applyPendingImport} size="sm">
							Apply import
						</Button>
						<Button
							onClick={() => setPendingImport(null)}
							size="sm"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
				</div>
			) : null}
		</>
	);
}
