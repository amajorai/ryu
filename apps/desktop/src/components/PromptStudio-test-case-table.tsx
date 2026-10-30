// Prompt Studio: the test-case table and per-case row editor.

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Copy01Icon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useMemo } from "react";
import type { Assertion } from "@/src/lib/api/gateway.ts";
import {
	assertionText,
	defaultAssertion,
	isRecord,
	parseEvalMessages,
	type TestCaseRow,
} from "@/src/lib/prompt-studio.ts";
import { parsePromptfooValue } from "@/src/lib/promptfoo.ts";
import { AssertionEditor } from "./PromptStudio-assertion-editor.tsx";
import {
	displayVariable,
	extractPlaceholders,
	parseVariable,
} from "./PromptStudio-format.ts";

interface TestCaseTableProps {
	locked: boolean;
	onAddRow: () => void;
	onDuplicateRow: (id: string) => void;
	onMoveRow: (id: string, direction: -1 | 1) => void;
	onRemoveRow: (id: string) => void;
	onUpdateRow: (id: string, patch: Partial<TestCaseRow>) => void;
	rows: TestCaseRow[];
}

export function TestCaseTable({
	locked,
	rows,
	onAddRow,
	onDuplicateRow,
	onMoveRow,
	onRemoveRow,
	onUpdateRow,
}: TestCaseTableProps) {
	return (
		<fieldset className="flex flex-col gap-2" disabled={locked}>
			{rows.length === 0 ? (
				<p className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-xs">
					No test cases. Add one to evaluate the draft prompt with assertions.
					With none, the gateway falls back to its built-in 3-case set.
				</p>
			) : null}
			{rows.map((row, i) => (
				<TestCaseRowEditor
					index={i}
					key={row.id}
					onDuplicate={() => onDuplicateRow(row.id)}
					onMove={(direction) => onMoveRow(row.id, direction)}
					onRemove={onRemoveRow}
					onUpdate={onUpdateRow}
					row={row}
					rowCount={rows.length}
				/>
			))}
			<div>
				<Button onClick={onAddRow} size="sm" variant="ghost">
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					Add test case
				</Button>
			</div>
		</fieldset>
	);
}

interface TestCaseRowEditorProps {
	index: number;
	onDuplicate: () => void;
	onMove: (direction: -1 | 1) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, patch: Partial<TestCaseRow>) => void;
	row: TestCaseRow;
	rowCount: number;
}

function TestCaseRowEditor({
	row,
	index,
	onDuplicate,
	onMove,
	onRemove,
	rowCount,
	onUpdate,
}: TestCaseRowEditorProps) {
	const tl = useLiteralMessages();
	// Var keys auto-suggested from the input + assertion text.
	const suggestedVars = useMemo(() => {
		const assertionBlob = row.assertions.map(assertionText).join("\n");
		return extractPlaceholders(`${row.input}\n${assertionBlob}`);
	}, [row.input, row.assertions]);

	const handleVarChange = useCallback(
		(name: string, val: string) => {
			onUpdate(row.id, { vars: { ...row.vars, [name]: parseVariable(val) } });
		},
		[onUpdate, row.id, row.vars]
	);

	const handleAddAssertion = useCallback(() => {
		onUpdate(row.id, {
			assertions: [...row.assertions, defaultAssertion("contains")],
		});
	}, [onUpdate, row.id, row.assertions]);

	const handleUpdateAssertion = useCallback(
		(idx: number, a: Assertion) => {
			const next = row.assertions.slice();
			next[idx] = a;
			onUpdate(row.id, { assertions: next });
		},
		[onUpdate, row.id, row.assertions]
	);

	const handleRemoveAssertion = useCallback(
		(idx: number) => {
			onUpdate(row.id, {
				assertions: row.assertions.filter((_, j) => j !== idx),
			});
		},
		[onUpdate, row.id, row.assertions]
	);

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-muted-foreground text-xs">
					{tl("Case {number}", { number: String(index + 1) })}
				</span>
				<Input
					aria-label={tl("Case {number} id", { number: String(index + 1) })}
					className="max-w-36"
					onChange={(e) => onUpdate(row.id, { id: e.target.value })}
					placeholder="Stable id"
					size="micro-dense"
					value={row.id}
					variant="code"
				/>
				<Input
					aria-label={tl("Case {number} name", { number: String(index + 1) })}
					autoComplete="off"
					className="max-w-48"
					name={`test-case-name-${row.id}`}
					onChange={(e) => onUpdate(row.id, { name: e.target.value })}
					placeholder="Name (optional)"
					size="dense"
					value={row.name}
				/>
				<Button
					aria-label={tl("Move case {number} up", {
						number: String(index + 1),
					})}
					className="size-7"
					disabled={index === 0}
					onClick={() => onMove(-1)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={ArrowUp01Icon} />
				</Button>
				<Button
					aria-label={tl("Move case {number} down", {
						number: String(index + 1),
					})}
					className="size-7"
					disabled={index === rowCount - 1}
					onClick={() => onMove(1)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={ArrowDown01Icon} />
				</Button>
				<Button
					aria-label={tl("Duplicate test case {number}", {
						number: String(index + 1),
					})}
					className="size-7"
					onClick={onDuplicate}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Copy01Icon} />
				</Button>
				<Button
					aria-label={tl("Remove test case {number}", {
						number: String(index + 1),
					})}
					className="ml-auto"
					onClick={() => onRemove(row.id)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Delete02Icon} />
				</Button>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-input-${row.id}`} size="compact">
					User message
				</Label>
				<Textarea
					id={`test-input-${row.id}`}
					name={`test-input-${row.id}`}
					onChange={(e) => onUpdate(row.id, { input: e.target.value })}
					placeholder="The user message. {{vars}} allowed."
					size="dense"
					value={row.input}
					variant="code"
				/>
			</div>

			{suggestedVars.length > 0 ? (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{suggestedVars.map((name) => (
						<div className="flex flex-col gap-1" key={name}>
							<Label size="caption">{name}</Label>
							<Input
								aria-label={name}
								autoComplete="off"
								name={`test-variable-${row.id}-${name}`}
								onChange={(e) => handleVarChange(name, e.target.value)}
								placeholder={`Value for {{${name}}}`}
								size="dense"
								value={displayVariable(row.vars[name])}
							/>
						</div>
					))}
				</div>
			) : null}

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-messages-${row.id}`} size="compact">
					Chat messages (optional JSON)
				</Label>
				<Textarea
					id={`test-messages-${row.id}`}
					onChange={(event) => {
						try {
							const parsed = parsePromptfooValue(
								JSON.parse(event.target.value)
							);
							if (!Array.isArray(parsed)) {
								return;
							}
							onUpdate(row.id, {
								messages: parseEvalMessages(parsed),
							});
						} catch {
							// Keep the last valid list while the user edits JSON.
						}
					}}
					placeholder='[{"role":"user","content":"Question for {{name}}"}]'
					size="dense"
					value={JSON.stringify(row.messages ?? [], null, 2)}
					variant="code"
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-expected-${row.id}`} size="compact">
					Expected (optional substring)
				</Label>
				<Input
					id={`test-expected-${row.id}`}
					name={`test-expected-${row.id}`}
					onChange={(e) => onUpdate(row.id, { expected: e.target.value })}
					placeholder="Substring the response should contain"
					size="dense"
					value={row.expected}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-context-${row.id}`} size="compact">
					Reference/context (optional JSON)
				</Label>
				<Textarea
					id={`test-context-${row.id}`}
					onChange={(event) => {
						if (!event.target.value.trim()) {
							onUpdate(row.id, { context: undefined });
							return;
						}
						try {
							onUpdate(row.id, {
								context: parsePromptfooValue(JSON.parse(event.target.value)),
							});
						} catch {
							// Keep the last valid context while the JSON is edited.
						}
					}}
					placeholder='{"source":"...","facts":["..."]}'
					size="dense"
					value={
						row.context === undefined
							? ""
							: JSON.stringify(row.context, null, 2)
					}
					variant="code"
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-threshold-${row.id}`} size="compact">
					Assertion threshold (optional)
				</Label>
				<Input
					id={`test-threshold-${row.id}`}
					inputMode="decimal"
					max="1"
					min="0"
					name={`test-threshold-${row.id}`}
					onChange={(e) => onUpdate(row.id, { threshold: e.target.value })}
					placeholder="1.0 means every assertion must pass"
					size="dense"
					step="0.05"
					type="number"
					value={row.threshold}
				/>
			</div>
			<label className="type-caption flex items-center justify-between gap-2 rounded-md border px-2 py-1">
				<span>
					Inherit suite default test
					<span className="type-compact block text-muted-foreground">
						Disable for a standalone case
					</span>
				</span>
				<Switch
					aria-label={tl("Inherit default test for case {number}", {
						number: String(index + 1),
					})}
					checked={row.inheritDefaultTest !== false}
					onCheckedChange={(checked) =>
						onUpdate(row.id, { inheritDefaultTest: checked })
					}
				/>
			</label>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-provider-${row.id}`} size="caption">
						Provider override (optional)
					</Label>
					<Input
						id={`test-provider-${row.id}`}
						onChange={(event) =>
							onUpdate(row.id, {
								provider: event.target.value.trim() || undefined,
							})
						}
						placeholder="openai:gpt-4o"
						size="dense"
						value={row.provider ?? ""}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-provider-output-${row.id}`} size="caption">
						Provider output fixture (optional JSON)
					</Label>
					<Input
						id={`test-provider-output-${row.id}`}
						onChange={(event) =>
							onUpdate(row.id, {
								providerOutput: event.target.value.trim()
									? parseVariable(event.target.value)
									: undefined,
							})
						}
						placeholder='{"choices":[{"message":{"content":"fixture"}}]}'
						size="dense"
						value={
							row.providerOutput === undefined
								? ""
								: displayVariable(row.providerOutput)
						}
						variant="code"
					/>
				</div>
			</div>

			<details className="rounded-md border border-dashed p-2">
				<summary className="type-caption cursor-pointer text-muted-foreground">
					Promptfoo case options (prefix, suffix, transform, timeout, cache)
				</summary>
				<Textarea
					aria-label="Promptfoo case options (JSON)"
					className="mt-2"
					onChange={(event) => {
						try {
							const parsed = parsePromptfooValue(
								JSON.parse(event.target.value)
							);
							if (isRecord(parsed)) {
								onUpdate(row.id, { options: parsed });
							}
						} catch {
							// Keep the last valid object while editing JSON.
						}
					}}
					placeholder='{"prefix":"","suffix":"","transform":"trim","timeout_ms":30000,"cache":true}'
					size="dense"
					value={JSON.stringify(row.options, null, 2)}
					variant="code"
				/>
			</details>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-providers-${row.id}`} size="caption">
						Providers (optional, comma-separated)
					</Label>
					<Input
						id={`test-providers-${row.id}`}
						onChange={(event) =>
							onUpdate(row.id, {
								providers: event.target.value
									.split(",")
									.map((provider) => provider.trim())
									.filter(Boolean),
							})
						}
						placeholder="openai:gpt-4o, anthropic:claude…"
						size="dense"
						value={row.providers.join(", ")}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-metadata-${row.id}`} size="caption">
						Metadata JSON
					</Label>
					<Input
						id={`test-metadata-${row.id}`}
						onChange={(event) => {
							try {
								const parsed = parsePromptfooValue(
									JSON.parse(event.target.value)
								);
								if (isRecord(parsed)) {
									onUpdate(row.id, { metadata: parsed });
								}
							} catch {
								// Keep the last valid object while editing.
							}
						}}
						placeholder='{"team":"support"}'
						size="dense"
						value={JSON.stringify(row.metadata)}
						variant="code"
					/>
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<Label size="compact">Assertions</Label>
				{row.assertions.map((a, idx) => (
					<AssertionEditor
						assertion={a}
						// assertions are positional within a row and have no stable id
						key={`assertion-${idx}`}
						onRemove={() => handleRemoveAssertion(idx)}
						onUpdate={(next) => handleUpdateAssertion(idx, next)}
					/>
				))}
				<div>
					<Button onClick={handleAddAssertion} size="sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Add01Icon} />
						Add assertion
					</Button>
				</div>
			</div>
		</div>
	);
}
