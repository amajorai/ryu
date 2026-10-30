"use client";

// The inline evaluators section of the policy rules editor.

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "../settings-items.tsx";
import type { PolicyRulesEditorProps } from "./policy-rules-editor.tsx";
import {
	actionFrom,
	EVALUATOR_ACTION_OPTIONS,
} from "./policy-rules-editor-options.ts";
import type { GuardrailFirewallAction } from "./types.ts";

interface EvaluatorRow {
	id: string;
	inlineAction?: GuardrailFirewallAction;
	rowId: string;
}

export function EvaluatorRules({
	disabled = false,
	onChange,
	value,
}: PolicyRulesEditorProps) {
	const tl = useLiteralMessages();
	const [rows, setRows] = useState<EvaluatorRow[]>(() =>
		value.evaluators.map((evaluator) => ({
			...evaluator,
			rowId: crypto.randomUUID(),
		}))
	);

	const commit = (next: EvaluatorRow[]) => {
		setRows(next);
		onChange({
			...value,
			evaluators: next.map(({ id, inlineAction }) =>
				inlineAction ? { id, inlineAction } : { id }
			),
		});
	};

	return (
		<SettingsSection
			caption="Inline evaluators by catalog id, for example a hazard or PII evaluator. Each runs on the request path with its own action."
			headerAction={
				<Button
					disabled={disabled}
					onClick={() =>
						commit([...rows, { id: "", rowId: crypto.randomUUID() }])
					}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add evaluator
				</Button>
			}
			title="Evaluators"
		>
			{rows.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No evaluators.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{rows.map((row, index) => (
						<div
							className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
							key={row.rowId}
						>
							<Input
								aria-label={tl("Evaluator {number} id", { number: index + 1 })}
								className="min-w-40 flex-1"
								disabled={disabled}
								onChange={(event) =>
									commit(
										rows.map((entry) =>
											entry.rowId === row.rowId
												? { ...entry, id: event.target.value.trim() }
												: entry
										)
									)
								}
								placeholder="Evaluator id"
								value={row.id}
								variant="code-caption"
							/>
							<Select
								disabled={disabled}
								items={EVALUATOR_ACTION_OPTIONS}
								onValueChange={(next: string | null) =>
									commit(
										rows.map((entry) =>
											entry.rowId === row.rowId
												? { ...entry, inlineAction: actionFrom(next) }
												: entry
										)
									)
								}
								value={row.inlineAction ?? "default"}
							>
								<SelectTrigger
									aria-label={tl("Evaluator {number} action", {
										number: index + 1,
									})}
									className="w-44"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{EVALUATOR_ACTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								aria-label={tl("Remove evaluator {number}", {
									number: index + 1,
								})}
								disabled={disabled}
								onClick={() =>
									commit(rows.filter((entry) => entry.rowId !== row.rowId))
								}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Delete01Icon} />
							</Button>
						</div>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
