// Control-group requests: reveals a policy gates behind named approvers. Core
// lists a request to its requester, to the people who may approve it, and to
// `sys/control-groups` admins. Approving here records every factor the caller
// satisfies; the requester redeems the value with `ryu secrets control-group
// redeem`, so no value or token is ever shown on this page.

import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	authorizeVaultControlGroup,
	controlGroupProgress,
	listVaultControlGroups,
} from "@/src/lib/api/vault-admin.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

function whenLabel(value: string | number): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : formatDateTime(value);
}

export function VaultControlGroups({
	callerSubject,
	target,
}: {
	callerSubject: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const groupsQuery = useQuery({
		queryKey: ["vault", "control-groups", target.url],
		queryFn: () => listVaultControlGroups(target),
	});
	const authorizeMutation = useMutation({
		mutationFn: (id: string) => authorizeVaultControlGroup(target, id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["vault", "control-groups"],
			});
			sileo.success({ title: tl("Approved") });
		},
		onError: (error) => {
			sileo.error({
				title: tl("Could not approve the request"),
				description: vaultErrorMessage(error, tl("Try again."), tl),
			});
		},
	});

	const groups = (groupsQuery.data ?? []).filter(
		(group) => group.status === "pending" || group.status === "approved"
	);
	if (groups.length === 0) {
		return null;
	}

	return (
		<SettingsSection
			caption="Reading these values needs approval from named people first. Approved requests are redeemed once by the person who asked."
			title="Value approvals"
		>
			<SettingsCard className="divide-y p-0">
				{groups.map((group) => {
					const mine = group.requester === callerSubject;
					const busy =
						authorizeMutation.isPending &&
						authorizeMutation.variables === group.id;
					return (
						<div
							className="flex items-center justify-between gap-4 px-4 py-3"
							key={group.id}
						>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<code className="font-medium font-mono text-sm">
										{group.policyKey}
									</code>
									{controlGroupProgress(group).map((step) => (
										<Badge key={step.factor} variant="outline">
											{tl("{factor}: {given}/{required} approvals", {
												factor: step.factor,
												given: step.given,
												required: step.required,
											})}
										</Badge>
									))}
								</div>
								<p className="mt-1 truncate text-muted-foreground text-xs">
									{mine ? tl("you") : group.requester} ·{" "}
									{tl("expires {when}", { when: whenLabel(group.expiresAt) })}
								</p>
							</div>
							{group.status === "approved" ? (
								<Badge variant="secondary">Approved</Badge>
							) : mine ? (
								<Badge variant="outline">Waiting</Badge>
							) : (
								<Button
									disabled={busy}
									onClick={() => authorizeMutation.mutate(group.id)}
									size="sm"
									variant="outline"
								>
									<HugeiconsIcon
										className="size-4"
										icon={CheckmarkCircle02Icon}
									/>
									Approve
								</Button>
							)}
						</div>
					);
				})}
			</SettingsCard>
		</SettingsSection>
	);
}
