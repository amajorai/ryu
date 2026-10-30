import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { RoutingCondition, RoutingRule } from "@/src/lib/api/routing.ts";
import { conditionRows } from "./conditions.tsx";
import {
	conditionForSource,
	type ScopeOption,
	SOURCE_OPTIONS,
	sourceLabel,
} from "./shared.tsx";

export function RuleCard({
	canConfigure,
	creditProviders,
	index,
	onChange,
	onMove,
	onRemove,
	rule,
	scopes,
	target,
	total,
}: {
	canConfigure: boolean;
	creditProviders: string[];
	index: number;
	onChange: (next: RoutingRule) => void;
	onMove: (delta: number) => void;
	onRemove: () => void;
	rule: RoutingRule;
	scopes: ScopeOption[];
	target: ApiTarget;
	total: number;
}) {
	const disabled = !canConfigure;
	return (
		<div data-testid={`fallback-rule-${rule.id}`}>
			<SettingsGroup>
				<SettingsItem
					actions={
						<div className="flex items-center gap-1">
							<Switch
								aria-label="Rule enabled"
								checked={rule.enabled}
								className="mr-1"
								disabled={disabled}
								onCheckedChange={(enabled) => onChange({ ...rule, enabled })}
							/>
							<Button
								aria-label="Move rule up"
								disabled={disabled || index === 0}
								onClick={() => onMove(-1)}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon icon={ArrowUp01Icon} size={16} />
							</Button>
							<Button
								aria-label="Move rule down"
								disabled={disabled || index === total - 1}
								onClick={() => onMove(1)}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon icon={ArrowDown01Icon} size={16} />
							</Button>
							<Button
								aria-label="Delete rule"
								disabled={disabled}
								onClick={onRemove}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon icon={Delete01Icon} size={16} />
							</Button>
						</div>
					}
					title={sourceLabel(rule.when.source)}
				/>
				<SettingsItem
					actions={
						<Select<RoutingCondition["source"]>
							disabled={disabled}
							items={SOURCE_OPTIONS}
							onValueChange={(source) =>
								onChange({
									...rule,
									when: conditionForSource(
										source ?? "ryu_credits",
										scopes[0]?.scope ?? { agent_id: "" },
										creditProviders
									),
								})
							}
							value={rule.when.source}
						>
							<SelectTrigger
								className="h-8 w-56"
								id={`fallback-source-${rule.id}`}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SOURCE_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title={<label htmlFor={`fallback-source-${rule.id}`}>When</label>}
				/>
				{conditionRows({
					condition: rule.when,
					creditProviders,
					disabled,
					onChange: (when) => onChange({ ...rule, when }),
					ruleId: rule.id,
					scopes,
				})}
				<SettingsItem
					actions={
						<AgentSelectionField
							ariaLabel="Fallback agent or model"
							disabled={disabled}
							onChange={(fallback) => onChange({ ...rule, fallback })}
							placeholder="Just warn me — don't change the model"
							target={target}
							value={rule.fallback}
						/>
					}
					title="Then run"
				/>
				<SettingsItem
					actions={
						<Switch
							aria-label="Notify when this rule fires"
							checked={rule.notify}
							disabled={disabled}
							onCheckedChange={(notify) => onChange({ ...rule, notify })}
						/>
					}
					title="Show a notice above the composer when this fires"
				/>
			</SettingsGroup>
		</div>
	);
}
