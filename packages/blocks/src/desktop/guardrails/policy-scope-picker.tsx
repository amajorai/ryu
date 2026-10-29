"use client";

// Choose one scope on the tenant ladder: the organization, a team, a member,
// a key or an agent. The host supplies the choices for each kind; an agent id
// can also be typed, because agents are not a closed list.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { SettingsGroup, SettingsItem } from "../settings-items.tsx";
import {
	POLICY_SCOPE_KIND_LABELS,
	POLICY_SCOPE_KINDS,
	type PolicyScopeKind,
	type PolicyScopeOptions,
	type PolicyScopeRef,
} from "./policy-model.ts";

export interface PolicyScopePickerProps {
	disabled?: boolean;
	/** Prefix for element ids, so two pickers can share a page. */
	idPrefix: string;
	/** Kinds this host offers, broadest first. Defaults to every kind. */
	kinds?: readonly PolicyScopeKind[];
	onChange: (next: PolicyScopeRef) => void;
	options: PolicyScopeOptions;
	value: PolicyScopeRef;
}

const ID_PLACEHOLDERS = {
	org: "",
	team: "Choose a team",
	member: "Choose a member",
	key: "Choose a key",
	agent: "Choose an agent",
} satisfies Record<PolicyScopeKind, string>;

/** The scope a kind starts at: the org itself, or the first choice. */
export function defaultScopeFor(
	kind: PolicyScopeKind,
	options: PolicyScopeOptions
): PolicyScopeRef {
	return { kind, id: options[kind][0]?.id ?? "" };
}

/** A settings card with two rows: the kind, then the specific scope. */
export function PolicyScopePicker({
	disabled = false,
	idPrefix,
	kinds = POLICY_SCOPE_KINDS,
	onChange,
	options,
	value,
}: PolicyScopePickerProps) {
	const tl = useLiteralMessages();
	const kindItems = kinds.map((kind) => ({
		value: kind,
		label: POLICY_SCOPE_KIND_LABELS[kind],
	}));
	const choices = options[value.kind];
	const kindId = `${idPrefix}-scope-kind`;
	const scopeId = `${idPrefix}-scope-id`;
	const agentListId = `${idPrefix}-agent-ids`;

	return (
		<SettingsGroup>
			<SettingsItem
				actions={
					<Select
						disabled={disabled}
						items={kindItems}
						onValueChange={(next: string | null) => {
							const kind =
								kinds.find((candidate) => candidate === next) ?? "org";
							onChange(defaultScopeFor(kind, options));
						}}
						value={value.kind}
					>
						<SelectTrigger className="w-44" id={kindId}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{kindItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
				title={<Label htmlFor={kindId}>Scope</Label>}
			/>
			{value.kind === "agent" ? (
				<SettingsItem
					actions={
						<>
							<Input
								className="w-56"
								disabled={disabled}
								id={scopeId}
								list={agentListId}
								onChange={(event) =>
									onChange({ kind: "agent", id: event.target.value.trim() })
								}
								placeholder="Agent id"
								value={value.id}
							/>
							<datalist id={agentListId}>
								{choices.map((choice) => (
									<option key={choice.id} value={choice.id}>
										{choice.label}
									</option>
								))}
							</datalist>
						</>
					}
					description="Pick a known agent or type its id. An agent policy carries firewall settings and evaluators only."
					title={<Label htmlFor={scopeId}>Agent</Label>}
				/>
			) : null}
			{value.kind === "org" || value.kind === "agent" ? null : (
				<SettingsItem
					actions={
						<Select
							disabled={disabled || choices.length === 0}
							items={choices.map((choice) => ({
								value: choice.id,
								label: choice.label,
							}))}
							onValueChange={(next: string | null) =>
								onChange({ kind: value.kind, id: next ?? "" })
							}
							value={value.id || null}
						>
							<SelectTrigger className="w-56" id={scopeId}>
								<SelectValue placeholder={ID_PLACEHOLDERS[value.kind]} />
							</SelectTrigger>
							<SelectContent>
								{choices.map((choice) => (
									<SelectItem key={choice.id} value={choice.id}>
										{choice.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={
						choices.length === 0
							? tl(
									"No {kind, select, org {organizations} team {teams} member {members} key {keys} agent {agents} other {choices}} to choose from yet.",
									{ kind: value.kind }
								)
							: undefined
					}
					title={
						<Label htmlFor={scopeId}>
							{POLICY_SCOPE_KIND_LABELS[value.kind]}
						</Label>
					}
				/>
			)}
		</SettingsGroup>
	);
}
