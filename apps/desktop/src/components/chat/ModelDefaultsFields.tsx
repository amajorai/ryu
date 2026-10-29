import { useProviderCatalog } from "@/src/hooks/provider-query-scope.ts";
// apps/desktop/src/components/chat/ModelDefaultsFields.tsx
//
// The four model-default rows every scope shares: Coordinator model and effort
// (main threads, which manage work and start sessions) and Thread model and
// effort (the sessions they start). Settings › Models (Gateway › Defaults) and
// the per-thread Defaults popover both render this, so a project, a bot and the
// whole node read the same way. A blank picker shows what it inherits, e.g.
// "Default (claude-opus-5-5)".

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { DefaultsRole, ScopeDefault } from "@/src/lib/api/hierarchy.ts";
import {
	defaultLabel,
	effortLabel,
	type RoleDefault,
	roleValue,
	withRoleValue,
} from "@/src/lib/model-defaults.ts";

// Base UI Select is unreliable with empty-string values, so "inherit" uses a
// real token mapped to "" at the edge (as `SideModelPicker` does).
const INHERIT = "__inherit__";
const FALLBACK_EFFORTS = ["low", "medium", "high"];

// Each row carries its whole labels, not a role word to splice into a phrase,
// so every label translates as one sentence.
const ROWS: {
	clearModelLabel: string;
	description: { effort: string; model: string };
	effortLabel: string;
	modelLabel: string;
	role: DefaultsRole;
}[] = [
	{
		role: "coordinator",
		modelLabel: "Coordinator model",
		effortLabel: "Coordinator effort",
		clearModelLabel: "Use the default coordinator model",
		description: {
			model: "Model for main threads that manage work and start sessions.",
			effort: "Effort for main threads that manage work and start sessions.",
		},
	},
	{
		role: "thread",
		modelLabel: "Thread model",
		effortLabel: "Thread effort",
		clearModelLabel: "Use the default thread model",
		description: {
			model: "Default model for new sessions.",
			effort: "Default effort for new sessions.",
		},
	},
];

function SettingRow({
	children,
	description,
	label,
}: {
	children: React.ReactNode;
	description: string;
	label: string;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
			<div className="min-w-0 flex-1 basis-40">
				<p className="text-sm">{label}</p>
				<p className="text-muted-foreground text-xs">{description}</p>
			</div>
			<div className="flex w-full items-center gap-1 sm:w-56">{children}</div>
		</div>
	);
}

export interface ModelDefaultsFieldsProps {
	disabled?: boolean;
	/** What each role inherits when its pickers are blank. */
	inherited: Record<DefaultsRole, RoleDefault>;
	onChange: (next: ScopeDefault) => void;
	target: ApiTarget;
	value: ScopeDefault;
}

export function ModelDefaultsFields({
	disabled,
	inherited,
	onChange,
	target,
	value,
}: ModelDefaultsFieldsProps) {
	const { data: catalog } = useProviderCatalog(target, {
		staleTime: 5 * 60 * 1000,
	});
	const efforts = catalog?.thinkingLevels?.length
		? catalog.thinkingLevels
		: FALLBACK_EFFORTS;

	return (
		<div className="flex flex-col gap-3" data-testid="model-defaults-fields">
			{ROWS.map((row) => {
				const current = roleValue(value, row.role);
				const below = inherited[row.role];
				const effortItems = [
					{
						value: INHERIT,
						label: defaultLabel(effortLabel(below.effort)),
					},
					...efforts.map((effort) => ({
						value: effort,
						label: effortLabel(effort),
					})),
				];
				return (
					<div className="flex flex-col gap-3" key={row.role}>
						<SettingRow
							description={row.description.model}
							label={row.modelLabel}
						>
							<AgentModelPickerField
								ariaLabel={row.modelLabel}
								className="flex-1"
								disabled={disabled}
								mode="model"
								onChange={(model) =>
									onChange(withRoleValue(value, row.role, { model }))
								}
								onModelPick={(providerId, model) =>
									onChange(
										withRoleValue(value, row.role, {
											model,
											provider: providerId ?? "",
										})
									)
								}
								placeholder={defaultLabel(below.model)}
								target={target}
								value={current.model}
							/>
							{current.model ? (
								<Button
									aria-label={row.clearModelLabel}
									disabled={disabled}
									onClick={() =>
										onChange(
											withRoleValue(value, row.role, {
												model: "",
												provider: "",
											})
										)
									}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon icon={Cancel01Icon} size={14} />
								</Button>
							) : null}
						</SettingRow>
						<SettingRow
							description={row.description.effort}
							label={row.effortLabel}
						>
							<Select
								disabled={disabled}
								items={effortItems}
								onValueChange={(next) =>
									onChange(
										withRoleValue(value, row.role, {
											effort: next && next !== INHERIT ? next : "",
										})
									)
								}
								value={current.effort || INHERIT}
							>
								<SelectTrigger
									aria-label={row.effortLabel}
									className="h-8 flex-1"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{effortItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingRow>
					</div>
				);
			})}
		</div>
	);
}
