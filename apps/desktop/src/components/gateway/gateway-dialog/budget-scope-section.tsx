import { Delete01Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { ReactElement } from "react";
import { useState } from "react";
import {
	formatBudgetUsd,
	microUsdToBudgetInput,
} from "@/src/components/gateway/budget-copy.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { BudgetRule } from "@/src/lib/api/gateway.ts";
import { DEFAULT_BUDGET_INCLUSION } from "@/src/lib/api/gateway.ts";
import {
	ACTION_LABELS,
	ALERT_TIER_LABELS,
	formToRule,
} from "./budget-form.tsx";
import { BudgetRuleDialog } from "./budget-rule-dialog.tsx";

/**
 * A keyed budget scope (per-user or per-agent): a labelled header with an add
 * button, then a list of rules each with inline edit + delete dialogs. Mirrors
 * the agent-budget UX the card previously inlined.
 */
export function BudgetScopeSection({
	label,
	entries,
	emptyText,
	addDialog,
	editIdLabel,
	onSave,
	onRemove,
	canConfigure,
	target,
}: {
	label: string;
	entries: [string, BudgetRule][];
	emptyText: string;
	addDialog: ReactElement;
	editIdLabel: string;
	onSave: (id: string, rule: BudgetRule) => Promise<void>;
	onRemove: (id: string) => Promise<void>;
	/** When false the caller lacks `gateway.configure`; edit/remove disabled. */
	canConfigure: boolean;
	/** Node target — threaded to each row's edit dialog for the model picker. */
	target: ApiTarget;
}) {
	const [removingId, setRemovingId] = useState<string | null>(null);
	const tl = useLiteralMessages();
	const [removeError, setRemoveError] = useState<{
		id: string;
		message: string;
	} | null>(null);

	const remove = async (id: string) => {
		setRemovingId(id);
		setRemoveError(null);
		try {
			await onRemove(id);
		} catch (e) {
			setRemoveError({
				id,
				message: e instanceof Error ? e.message : "Failed to remove budget.",
			});
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<SettingsSection headerAction={addDialog} title={label}>
			{entries.length === 0 ? (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					{emptyText}
				</SettingsCard>
			) : (
				<SettingsGroup>
					{entries.map(([id, rule]) => (
						<SettingsItem
							actions={
								<div className="flex shrink-0 items-center gap-1">
									<BudgetRuleDialog
										agentIdReadOnly
										description="Update the charged-spend cap, categories, or action for this entry."
										idLabel={editIdLabel}
										initial={{
											agentId: id,
											include: {
												...DEFAULT_BUDGET_INCLUSION,
												...rule.include,
											},
											limitUsd: microUsdToBudgetInput(rule.limit),
											action: rule.action,
											// Seeded, not defaulted: without this the edit dialog opens
											// at `silent` and Save demotes a rule that was fanning out.
											alert: rule.alert ?? "silent",
											downgrade_to: rule.downgrade_to ?? "",
											restrict_max_tokens: String(
												rule.restrict_max_tokens ?? 256
											),
										}}
										onSave={async (form) => {
											await onSave(id, formToRule(form));
										}}
										target={target}
										title="Edit budget"
										trigger={
											<Button
												disabled={!canConfigure}
												size="icon"
												variant="ghost"
											>
												<HugeiconsIcon
													className="size-3.5"
													icon={PencilEdit01Icon}
												/>
												<span className="sr-only">
													{tl("Edit budget for {id}", { id })}
												</span>
											</Button>
										}
									/>
									<Button
										disabled={!canConfigure || removingId === id}
										onClick={() => void remove(id)}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5 text-status-destructive"
											icon={Delete01Icon}
										/>
										<span className="sr-only">
											{tl("Remove budget for {id}", { id })}
										</span>
									</Button>
									{removeError?.id === id ? (
										<div className="flex items-center gap-2">
											<p
												className="text-status-destructive text-xs"
												role="alert"
											>
												{tl("Couldn't remove budget: {message}", {
													message: removeError.message,
												})}
											</p>
											<Button
												disabled={removingId === id}
												loading={removingId === id}
												onClick={() => void remove(id)}
												size="sm"
												variant="ghost"
											>
												Retry
											</Button>
										</div>
									) : null}
								</div>
							}
							key={id}
							title={
								<span className="flex min-w-0 flex-col">
									<span className="truncate">{id}</span>
									<span className="text-muted-foreground text-xs">
										{rule.limit === 0
											? "unlimited"
											: tl("{amount} spend", {
													amount: formatBudgetUsd(rule.limit),
												})}
										{" · "}
										{ACTION_LABELS[rule.action] ?? rule.action}
										{rule.action === "downgrade" && rule.downgrade_to
											? ` → ${rule.downgrade_to}`
											: null}
										{rule.action === "restrict" && rule.restrict_max_tokens
											? ` ${tl("(max {restrict_max_tokens})", { restrict_max_tokens: String(rule.restrict_max_tokens) })}`
											: null}
										{/* Only shown once raised: `silent` is every rule's default, so
										    printing it on every row would be noise. */}
										{rule.alert && rule.alert !== "silent"
											? ` · ${tl("notifies {tier}", { tier: ALERT_TIER_LABELS[rule.alert] })}`
											: null}
									</span>
								</span>
							}
						/>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
