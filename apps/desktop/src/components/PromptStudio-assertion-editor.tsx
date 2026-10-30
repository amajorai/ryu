// Prompt Studio: a single assertion's kind, value, and options editor.

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback } from "react";
import type { Assertion, AssertionOptions } from "@/src/lib/api/gateway.ts";
import {
	ASSERTION_KINDS,
	ASSERTION_LABELS,
	type AssertionKind,
	assertionKindSchema,
	assertionText,
	defaultAssertion,
	parseThreshold,
	withAssertionText,
} from "@/src/lib/prompt-studio.ts";

interface AssertionEditorProps {
	assertion: Assertion;
	onRemove: () => void;
	onUpdate: (a: Assertion) => void;
}

export function AssertionEditor({
	assertion,
	onUpdate,
	onRemove,
}: AssertionEditorProps) {
	const needsText = ![
		"json_valid",
		"is_json",
		"is_html",
		"is_xml",
		"is_sql",
		"is_refusal",
		"assert_set",
	].includes(assertion.kind);
	const isJudge = [
		"llm_judge",
		"llm_rubric",
		"factuality",
		"context_faithfulness",
		"answer_relevance",
	].includes(assertion.kind);

	const handleKindChange = useCallback(
		(kind: AssertionKind) => {
			// Preserve the existing text payload where the new kind supports one.
			const text = assertionText(assertion);
			const base = defaultAssertion(kind);
			onUpdate(
				withAssertionText(
					assertion.options ? { ...base, options: assertion.options } : base,
					text
				)
			);
		},
		[assertion, onUpdate]
	);

	const handleTextChange = useCallback(
		(text: string) => {
			onUpdate(withAssertionText(assertion, text));
		},
		[assertion, onUpdate]
	);

	const updateOptions = useCallback(
		(patch: Partial<AssertionOptions>) => {
			onUpdate({
				...assertion,
				options: { ...assertion.options, ...patch },
			});
		},
		[assertion, onUpdate]
	);

	let placeholder = "Value";
	if (isJudge) {
		placeholder = "Rubric: what the answer must satisfy";
	} else if (assertion.kind === "regex") {
		placeholder = "Regular expression";
	} else if (
		["javascript", "python", "ruby", "webhook"].includes(assertion.kind)
	) {
		placeholder = "Runtime expression or endpoint configuration";
	} else if (
		assertion.kind === "contains_any" ||
		assertion.kind === "contains_all" ||
		assertion.kind === "icontains_any" ||
		assertion.kind === "icontains_all"
	) {
		placeholder = "Comma-separated values";
	} else if (assertion.kind === "latency") {
		placeholder = "Maximum latency in milliseconds";
	} else if (assertion.kind === "cost") {
		placeholder = "Maximum cost in micro-USD";
	} else if (assertion.kind === "assert_set") {
		placeholder = '[{"kind":"contains","value":"expected"}]';
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<NativeSelect
					appearance="dense"
					aria-label="Assertion type"
					className="w-36"
					onChange={(e) =>
						handleKindChange(assertionKindSchema.parse(e.target.value))
					}
					value={assertion.kind}
				>
					{ASSERTION_KINDS.map((k) => (
						<NativeSelectOption key={k} value={k}>
							{ASSERTION_LABELS[k]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{needsText ? (
					<Input
						aria-label="Assertion value"
						className="flex-1"
						onChange={(e) => handleTextChange(e.target.value)}
						placeholder={placeholder}
						size="dense"
						value={assertionText(assertion)}
					/>
				) : (
					<span className="flex-1 text-muted-foreground text-xs">
						{assertion.kind === "assert_set"
							? "JSON array of nested assertions."
							: "Passes when the response matches this structural assertion."}
					</span>
				)}
				<Button
					aria-label="Remove assertion"
					onClick={onRemove}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
				</Button>
			</div>
			<div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
				<Input
					aria-label="Assertion threshold"
					inputMode="decimal"
					max="1"
					min="0"
					onChange={(event) =>
						updateOptions({ threshold: parseThreshold(event.target.value) })
					}
					placeholder="Threshold"
					size="micro"
					step="0.05"
					type="number"
					value={assertion.options?.threshold ?? ""}
				/>
				<Input
					aria-label="Assertion weight"
					inputMode="decimal"
					min="0"
					onChange={(event) => {
						const parsed = Number.parseFloat(event.target.value);
						updateOptions({
							weight: Number.isFinite(parsed) ? parsed : undefined,
						});
					}}
					placeholder="Weight"
					size="micro"
					step="0.1"
					type="number"
					value={assertion.options?.weight ?? ""}
				/>
				<Input
					aria-label="Assertion provider"
					onChange={(event) =>
						updateOptions({ provider: event.target.value || undefined })
					}
					placeholder="Judge model/provider"
					size="micro"
					value={assertion.options?.provider ?? ""}
				/>
				<Input
					aria-label="Assertion transform"
					onChange={(event) =>
						updateOptions({ transform: event.target.value || undefined })
					}
					placeholder="Transform (exported)"
					size="micro"
					value={assertion.options?.transform ?? ""}
				/>
				<label className="type-compact flex items-center justify-between gap-1 rounded-md border px-2">
					<span>Negate</span>
					<Switch
						aria-label="Negate assertion"
						checked={assertion.options?.not === true}
						onCheckedChange={(checked) => updateOptions({ not: checked })}
					/>
				</label>
			</div>
		</div>
	);
}
