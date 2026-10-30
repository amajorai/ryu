// Prompt Studio: registry evaluators, run options, and Promptfoo defaults.

import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { isRecord, parseCodeEvaluators } from "@/src/lib/prompt-studio.ts";
import { parsePromptfooValue } from "@/src/lib/promptfoo.ts";
import type { PromptSuiteState } from "./PromptStudio-suite-state.ts";

export function PromptRunOptions({
	locked,
	state,
}: {
	locked: boolean;
	state: PromptSuiteState;
}) {
	const {
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
		defaultTestText,
		setDefaultTestText,
		setDefaultTest,
		codeEvaluatorText,
		setCodeEvaluatorText,
		setCodeEvaluators,
	} = state;
	return (
		<>
			<div className="flex flex-col gap-1 rounded-lg bg-muted/20 p-3">
				<Label htmlFor="promptfoo-evaluators" size="caption">
					Registry evaluators (optional, comma-separated)
				</Label>
				<Input
					disabled={locked}
					id="promptfoo-evaluators"
					onChange={(event) =>
						setEvaluatorIds(
							event.target.value
								.split(",")
								.map((id) => id.trim())
								.filter(Boolean)
						)
					}
					placeholder="assertions, exact_match, pii_detector…"
					size="dense"
					value={evaluatorIds.join(", ")}
				/>
				<p className="type-compact text-muted-foreground">
					Uses the shared Gateway evaluator catalog in addition to inline
					assertions.
				</p>
			</div>

			<details className="rounded-lg bg-muted/20 p-3" open>
				<summary className="cursor-pointer font-medium text-xs">
					Run options and Promptfoo defaults
				</summary>
				<div className="mt-3 flex flex-col gap-3">
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-concurrency" size="caption">
								Concurrency
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-concurrency"
								max={32}
								min={1}
								onChange={(event) =>
									setMaxConcurrency(
										Math.max(1, Math.min(32, Number(event.target.value) || 1))
									)
								}
								size="dense"
								type="number"
								value={maxConcurrency}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-timeout" size="caption">
								Timeout (ms)
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-timeout"
								max={120_000}
								min={100}
								onChange={(event) =>
									setTimeoutMs(
										Math.max(
											100,
											Math.min(120_000, Number(event.target.value) || 100)
										)
									)
								}
								size="dense"
								type="number"
								value={timeoutMs}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-repeat" size="caption">
								Repeat cases
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-repeat"
								max={20}
								min={1}
								onChange={(event) =>
									setRepeat(
										Math.max(1, Math.min(20, Number(event.target.value) || 1))
									)
								}
								size="dense"
								type="number"
								value={repeat}
							/>
						</div>
						<label className="type-caption flex items-center justify-between gap-2 rounded-md border px-2">
							<span>
								Cache outputs
								<span className="type-compact block text-muted-foreground">
									Reuse identical inputs in this run
								</span>
							</span>
							<Switch
								checked={cache}
								disabled={locked}
								id="promptfoo-cache"
								onCheckedChange={setCache}
							/>
						</label>
					</div>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-tags" size="caption">
								Run tags (key=value, comma-separated)
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-tags"
								onChange={(event) => setRunTags(event.target.value)}
								placeholder="branch=main, owner=evals"
								size="dense"
								value={runTags}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-prefix-suffix" size="caption">
								Prompt prefix / suffix
							</Label>
							<div className="flex gap-1">
								<Input
									aria-label="Prompt prefix"
									disabled={locked}
									onChange={(event) => setRunPrefix(event.target.value)}
									placeholder="prefix"
									size="dense"
									value={runPrefix}
								/>
								<Input
									aria-label="Prompt suffix"
									disabled={locked}
									onChange={(event) => setRunSuffix(event.target.value)}
									placeholder="suffix"
									size="dense"
									value={runSuffix}
								/>
							</div>
						</div>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="promptfoo-default-test" size="caption">
							Default test JSON (inherited by imported cases)
						</Label>
						<Textarea
							disabled={locked}
							id="promptfoo-default-test"
							onChange={(event) => {
								setDefaultTestText(event.target.value);
								try {
									const parsed = parsePromptfooValue(
										JSON.parse(event.target.value)
									);
									if (isRecord(parsed)) {
										setDefaultTest(parsed);
									}
								} catch {
									// Keep the last valid object while editing JSON.
								}
							}}
							placeholder='{"vars":{"locale":"en"},"assert":[{"type":"contains","value":"{{answer}}"}]}'
							size="dense"
							value={defaultTestText}
							variant="code"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="promptfoo-code-evaluators" size="caption">
							Custom JS/Python evaluators (Core sandbox)
						</Label>
						<Textarea
							disabled={locked}
							id="promptfoo-code-evaluators"
							onChange={(event) => {
								setCodeEvaluatorText(event.target.value);
								try {
									setCodeEvaluators(
										parseCodeEvaluators(
											parsePromptfooValue(JSON.parse(event.target.value))
										)
									);
								} catch {
									// Keep the last valid evaluator list while editing JSON.
								}
							}}
							placeholder='[{"id":"safe_output","lang":"js","source":"({ score: output.includes(\"safe\") ? 1 : 0 })"}]'
							size="compact"
							value={codeEvaluatorText}
							variant="code"
						/>
						<p className="type-compact text-muted-foreground">
							Code is never run in the renderer or Gateway; Core reports
							unavailable sandbox runtimes as not executed.
						</p>
					</div>
				</div>
			</details>
		</>
	);
}
