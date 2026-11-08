// Pending broker proposals: what agents asked for (services, credentials, or
// a password-manager reference's first use), each with Approve and Reject. A
// tapped proposal notification highlights its proposal here (see
// `@/src/lib/vault-focus.ts`). No values appear here.

import {
	Cancel01Icon,
	CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { VaultPasswordManagerGrantMode } from "@/src/lib/api/vault.ts";
import {
	decideVaultBrokerProposal,
	listVaultBrokerProposals,
	type VaultBrokerProposal,
} from "@/src/lib/api/vault-broker.ts";
import { clearVaultFocus, useVaultFocus } from "@/src/lib/vault-focus.ts";
import { proposalDetail } from "./vault-broker-summary.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

type Decision = "approve" | "reject";

const DECISION_TOAST = {
	approve: "Proposal approved",
	reject: "Proposal rejected",
} satisfies Record<Decision, string>;

const GRANT_OPTIONS = [
	{ label: "Once", value: "once" },
	{ label: "1 hour", value: "1h" },
	{ label: "24 hours", value: "24h" },
	{ label: "30 days", value: "30d" },
] satisfies { label: string; value: VaultPasswordManagerGrantMode }[];

function isGrantMode(value: string): value is VaultPasswordManagerGrantMode {
	return GRANT_OPTIONS.some((option) => option.value === value);
}

function proposalSummary(
	proposal: VaultBrokerProposal,
	tl: LiteralMessage
): string {
	if (proposal.credentialUse) {
		const { account, ref, subject } = proposal.credentialUse;
		return tl("Password manager: {ref} for {subject} (account {account})", {
			account,
			ref,
			subject,
		});
	}
	const parts: string[] = [];
	const services = proposal.services
		.map((service) => service.name ?? service.host)
		.filter(Boolean);
	if (services.length > 0) {
		parts.push(tl("Services: {services}", { services: services.join(", ") }));
	}
	if (proposal.credentials.length > 0) {
		const credentials = proposal.credentials.map(
			(credential) => credential.ref
		);
		parts.push(
			tl("Credentials: {credentials}", { credentials: credentials.join(", ") })
		);
	}
	return parts.join(" · ");
}

/** Scrolls the proposal a deep link names into view once it renders. */
function scrollIntoViewOnMount(element: HTMLDivElement | null): void {
	element?.scrollIntoView?.({ block: "center" });
}

export function BrokerProposals({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const focusedId = useVaultFocus()?.proposalId ?? null;
	const proposalsQuery = useQuery({
		queryKey: ["vault", "broker", "proposals", target.url],
		queryFn: () => listVaultBrokerProposals(target),
	});
	const [grants, setGrants] = useState<
		Record<string, VaultPasswordManagerGrantMode>
	>({});
	const decideMutation = useMutation({
		mutationFn: ({
			decision,
			grant,
			id,
		}: {
			decision: Decision;
			grant?: VaultPasswordManagerGrantMode;
			id: string;
		}) => decideVaultBrokerProposal(target, id, decision, grant),
		onSuccess: async (_, { decision, id }) => {
			if (id === focusedId) {
				clearVaultFocus();
			}
			await queryClient.invalidateQueries({ queryKey: ["vault", "broker"] });
			sileo.success({ title: DECISION_TOAST[decision] });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not update the proposal",
				description: vaultErrorMessage(error, "Try again.", tl),
			});
		},
	});
	const proposals = proposalsQuery.data ?? [];
	const focusedMissing =
		focusedId !== null &&
		proposalsQuery.isSuccess &&
		!proposals.some((proposal) => proposal.id === focusedId);

	return (
		<SettingsSection
			caption="Agents propose new services or credentials here, and ask before their first use of a password-manager reference. Nothing is brokered until someone approves."
			title="Pending proposals"
		>
			<SettingsCard className="divide-y p-0">
				{focusedMissing ? (
					<p className="p-4 text-muted-foreground text-sm" role="status">
						The proposal from that notification was already decided or has
						expired.
					</p>
				) : null}
				{proposalsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : proposalsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							proposalsQuery.error,
							"Could not load proposals.",
							tl
						)}
					</p>
				) : proposals.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No pending proposals.
					</p>
				) : (
					proposals.map((proposal) => {
						const busy =
							decideMutation.isPending &&
							decideMutation.variables?.id === proposal.id;
						const grant = grants[proposal.id] ?? "30d";
						const focused = proposal.id === focusedId;
						return (
							<div
								aria-current={focused ? "true" : undefined}
								className={cn(
									"flex items-center justify-between gap-4 px-4 py-3",
									focused && "bg-accent/50 ring-2 ring-primary ring-inset"
								)}
								data-proposal-id={proposal.id}
								key={proposal.id}
								ref={focused ? scrollIntoViewOnMount : undefined}
							>
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium text-sm">
											{proposal.message || tl("Broker proposal")}
										</span>
										<Badge variant="outline">{proposal.environment}</Badge>
										{proposal.credentialUse ? (
											<Badge variant="secondary">
												{proposal.credentialUse.provider}
											</Badge>
										) : null}
									</div>
									<p className="mt-1 truncate text-muted-foreground text-xs">
										{proposalDetail(
											proposalSummary(proposal, tl),
											proposal.requestedBy,
											proposal.expiresAt,
											tl
										)}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									{proposal.credentialUse ? (
										<NativeSelect
											aria-label="Approval lasts"
											disabled={busy}
											onChange={(event) => {
												const value = event.target.value;
												if (isGrantMode(value)) {
													setGrants((current) => ({
														...current,
														[proposal.id]: value,
													}));
												}
											}}
											size="sm"
											value={grant}
										>
											{GRANT_OPTIONS.map((option) => (
												<NativeSelectOption
													key={option.value}
													value={option.value}
												>
													{option.label}
												</NativeSelectOption>
											))}
										</NativeSelect>
									) : null}
									<Button
										disabled={busy}
										onClick={() =>
											decideMutation.mutate({
												decision: "reject",
												id: proposal.id,
											})
										}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
										Reject
									</Button>
									<Button
										disabled={busy}
										onClick={() =>
											decideMutation.mutate({
												decision: "approve",
												grant: proposal.credentialUse ? grant : undefined,
												id: proposal.id,
											})
										}
										size="sm"
										variant="outline"
									>
										<HugeiconsIcon
											className="size-4"
											icon={CheckmarkCircle02Icon}
										/>
										Approve
									</Button>
								</div>
							</div>
						);
					})
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
