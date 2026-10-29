"use client";

// The list of named policies with their assignment chips. Each row is a
// button that opens the policy; a policy with no assignment says that it
// enforces nothing.

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
} from "../settings-items.tsx";
import {
	type PolicyScopeOptions,
	type PolicyView,
	scopeChipLabel,
	UNASSIGNED_POLICY_COPY,
} from "./policy-model.ts";

export function PolicyList({
	emptyLabel = "No policies yet. Create one to get started.",
	onOpen,
	policies,
	scopeOptions,
}: {
	emptyLabel?: string;
	onOpen: (policyId: string) => void;
	policies: PolicyView[];
	scopeOptions: PolicyScopeOptions | null;
}) {
	if (policies.length === 0) {
		return (
			<SettingsCard className="text-center text-muted-foreground text-sm">
				{emptyLabel}
			</SettingsCard>
		);
	}
	return (
		<SettingsGroup>
			{policies.map((policy) => (
				<SettingsItem
					actions={
						<HugeiconsIcon
							className="size-4 text-muted-foreground/70"
							icon={ArrowRight01Icon}
						/>
					}
					className="relative"
					key={policy.id}
					title={
						<button
							className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left"
							data-policy-return={`policy:${policy.id}`}
							onClick={() => onOpen(policy.id)}
							type="button"
						>
							<span className="flex items-center gap-2">
								<span className="truncate">{policy.name}</span>
								<span className="text-muted-foreground text-xs tabular-nums">
									v{policy.version}
								</span>
							</span>
							{policy.description ? (
								<span className="line-clamp-2 font-normal text-muted-foreground text-xs">
									{policy.description}
								</span>
							) : null}
							<span aria-hidden="true" className="absolute inset-0" />
						</button>
					}
				>
					<div className="flex flex-wrap gap-1.5">
						{policy.assignments.length === 0 ? (
							<Badge size="compact" variant="secondary">
								{UNASSIGNED_POLICY_COPY}
							</Badge>
						) : (
							policy.assignments.map((assignment) => (
								<Badge key={assignment.id} size="compact" variant="outline">
									{scopeChipLabel(assignment.scope, scopeOptions)}
								</Badge>
							))
						)}
					</div>
				</SettingsItem>
			))}
		</SettingsGroup>
	);
}
