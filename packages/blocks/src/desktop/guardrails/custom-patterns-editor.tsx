"use client";

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { type ReactNode, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "../settings-items.tsx";
import { GUARDRAIL_PATTERN_KIND_OPTIONS, isValidJsRegex } from "./copy.ts";
import type {
	GuardrailPattern,
	GuardrailPatternKind,
	GuardrailScopeCtx,
} from "./types.ts";

type PatternRow = GuardrailPattern & { id: string };

function patternKindFrom(value: string | null): GuardrailPatternKind {
	return (
		GUARDRAIL_PATTERN_KIND_OPTIONS.find((option) => option.value === value)
			?.value ?? "pii"
	);
}

/**
 * Add, edit and remove custom firewall patterns for the active scope. The
 * parent remounts it (via a `key`) on scope or id change so its row state
 * reseeds from the new source.
 */
export function CustomPatternsEditor({
	caption,
	ctx,
}: {
	/** Overrides the default overlay caption. */
	caption?: ReactNode;
	ctx: GuardrailScopeCtx;
}) {
	const source =
		(ctx.isOverlay ? ctx.overlay.custom_patterns : ctx.node.custom_patterns) ??
		[];
	const [rows, setRows] = useState<PatternRow[]>(() =>
		source.map((pattern) => ({ ...pattern, id: crypto.randomUUID() }))
	);

	const editable = !ctx.disabled && (!ctx.isOverlay || ctx.overlayReady);

	const commit = (next: PatternRow[]) => {
		setRows(next);
		const serialized: GuardrailPattern[] = next.map((row) => ({
			name: row.name,
			regex: row.regex,
			kind: row.kind,
		}));
		if (ctx.isOverlay) {
			ctx.setOverlayField({ custom_patterns: serialized });
		} else {
			ctx.setNodeField({ custom_patterns: serialized });
		}
	};

	const updateRow = (id: string, patch: Partial<GuardrailPattern>) => {
		commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	};

	const removeRow = (id: string) => {
		commit(rows.filter((row) => row.id !== id));
	};

	const addRow = () => {
		commit([
			...rows,
			{ id: crypto.randomUUID(), name: "", regex: "", kind: "pii" },
		]);
	};

	const overlayCaption = ctx.isOverlay
		? "Overlay patterns are appended to the inherited set, never replacing it."
		: undefined;

	return (
		<SettingsSection
			caption={caption ?? overlayCaption}
			headerAction={
				<Button disabled={!editable} onClick={addRow} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add pattern
				</Button>
			}
			title="Custom patterns"
		>
			{rows.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No custom patterns.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{rows.map((row) => {
						const valid = isValidJsRegex(row.regex);
						return (
							<div className="flex flex-col gap-1.5 px-3.5 py-2.5" key={row.id}>
								<div className="flex items-center gap-2">
									<Input
										aria-label="Pattern name"
										disabled={!editable}
										onChange={(event) =>
											updateRow(row.id, { name: event.target.value })
										}
										placeholder="Name (e.g. internal_id)"
										value={row.name}
									/>
									<Select
										disabled={!editable}
										items={GUARDRAIL_PATTERN_KIND_OPTIONS}
										onValueChange={(next: string | null) =>
											updateRow(row.id, { kind: patternKindFrom(next) })
										}
										value={row.kind}
									>
										<SelectTrigger aria-label="Pattern kind" className="w-44">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{GUARDRAIL_PATTERN_KIND_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										aria-label="Remove pattern"
										disabled={!editable}
										onClick={() => removeRow(row.id)}
										size="icon-sm"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={Delete01Icon} />
									</Button>
								</div>
								<Input
									aria-invalid={!valid}
									aria-label="Pattern regex"
									disabled={!editable}
									onChange={(event) =>
										updateRow(row.id, { regex: event.target.value })
									}
									placeholder="Regex (Rust regex syntax)"
									value={row.regex}
									variant="code-caption"
								/>
								{valid ? null : (
									<p className="text-status-destructive text-xs">
										Invalid regex. Checked with the browser engine; the gateway
										uses Rust regex syntax, which differs slightly.
									</p>
								)}
							</div>
						);
					})}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
