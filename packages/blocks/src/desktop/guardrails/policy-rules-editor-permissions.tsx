"use client";

// The permissions section of the policy rules editor.

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
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
import {
	POLICY_PERMISSION_ACTIONS,
	POLICY_PERMISSION_EFFECTS,
	type PolicyPermission,
	type PolicyPermissionAction,
	type PolicyPermissionEffect,
} from "./policy-model.ts";
import type { PolicyRulesEditorProps } from "./policy-rules-editor.tsx";
import {
	PERMISSION_ACTION_OPTIONS,
	PERMISSION_EFFECT_OPTIONS,
	pick,
} from "./policy-rules-editor-options.ts";

type PermissionRow = PolicyPermission & { rowId: string };

export function PermissionRules({
	disabled = false,
	onChange,
	value,
}: PolicyRulesEditorProps) {
	const tl = useLiteralMessages();
	const [rows, setRows] = useState<PermissionRow[]>(() =>
		value.permissions.map((permission) => ({
			...permission,
			rowId: crypto.randomUUID(),
		}))
	);

	const commit = (next: PermissionRow[]) => {
		setRows(next);
		onChange({
			...value,
			permissions: next.map(({ action, effect, resource }) => ({
				action,
				effect,
				resource,
			})),
		});
	};

	const update = (rowId: string, patch: Partial<PolicyPermission>) =>
		commit(
			rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
		);

	const move = (index: number, offset: -1 | 1) => {
		const target = index + offset;
		if (target < 0 || target >= rows.length) {
			return;
		}
		const next = [...rows];
		const [row] = next.splice(index, 1);
		if (row) {
			next.splice(target, 0, row);
		}
		commit(next);
	};

	const add = () =>
		commit([
			...rows,
			{
				action: "tool.call",
				effect: "deny",
				resource: "*",
				rowId: crypto.randomUUID(),
			},
		]);

	return (
		<SettingsSection
			caption="OpenCode-style permissions for tool calls, MCP servers and models. Within this policy the last matching rule wins, so put a catch-all first. Across scopes a lower scope can only tighten (allow, then ask, then deny). Ask acts as deny on requests with no approval path. Use * and ? as wildcards; models take an exact id or *."
			headerAction={
				<Button disabled={disabled} onClick={add} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add rule
				</Button>
			}
			title="Permissions"
		>
			{rows.length === 0 ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No permission rules.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{rows.map((row, index) => (
						<div
							className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
							key={row.rowId}
						>
							<Select
								disabled={disabled}
								items={PERMISSION_ACTION_OPTIONS}
								onValueChange={(next: string | null) =>
									update(row.rowId, {
										action: pick<PolicyPermissionAction>(
											POLICY_PERMISSION_ACTIONS,
											next,
											"tool.call"
										),
									})
								}
								value={row.action}
							>
								<SelectTrigger
									aria-label={tl("Rule {number} applies to", {
										number: index + 1,
									})}
									className="w-36"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PERMISSION_ACTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Input
								aria-label={tl("Rule {number} pattern", { number: index + 1 })}
								className="min-w-32 flex-1"
								disabled={disabled}
								onChange={(event) =>
									update(row.rowId, { resource: event.target.value })
								}
								placeholder="*"
								value={row.resource}
								variant="code-caption"
							/>
							<Select
								disabled={disabled}
								items={PERMISSION_EFFECT_OPTIONS}
								onValueChange={(next: string | null) =>
									update(row.rowId, {
										effect: pick<PolicyPermissionEffect>(
											POLICY_PERMISSION_EFFECTS,
											next,
											"deny"
										),
									})
								}
								value={row.effect}
							>
								<SelectTrigger
									aria-label={tl("Rule {number} effect", { number: index + 1 })}
									className="w-28"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PERMISSION_EFFECT_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<div className="flex items-center">
								<Button
									aria-label={tl("Move rule {number} up", {
										number: index + 1,
									})}
									disabled={disabled || index === 0}
									onClick={() => move(index, -1)}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
								</Button>
								<Button
									aria-label={tl("Move rule {number} down", {
										number: index + 1,
									})}
									disabled={disabled || index === rows.length - 1}
									onClick={() => move(index, 1)}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
								</Button>
								<Button
									aria-label={tl("Remove rule {number}", { number: index + 1 })}
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
						</div>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
