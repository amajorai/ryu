// Credential broker: the services agents may reach through the broker proxy
// and the agent proposals waiting for a decision. Approving a proposal creates
// its services; credentials it asks for are added as ordinary secrets. A
// password-manager request (the first use of an `op://` or `bws://` reference
// by one agent or person) is approved once or for a chosen lifetime. Listing
// needs `list` on `sys/broker`, deciding needs `admin`. Card spend approvals
// (a payment card's use through the broker, a fill, or a reveal) need `write`
// on the card item to decide. No values appear here.

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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	decideVaultBrokerProposal,
	decideVaultCardApproval,
	listVaultBrokerProposals,
	listVaultBrokerServices,
	listVaultCardApprovals,
	type VaultBrokerProposal,
	type VaultBrokerService,
	type VaultCardApproval,
	type VaultCardDecision,
	type VaultPasswordManagerGrantMode,
} from "@/src/lib/api/vault.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { isForbidden, vaultErrorMessage } from "./vault-errors.ts";

type Decision = "approve" | "reject";

const DECISION_TOAST = {
	approve: "Proposal approved",
	reject: "Proposal rejected",
} satisfies Record<Decision, string>;

function whenLabel(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : formatDateTime(value);
}

function upstream(service: VaultBrokerService): string {
	const port = service.port ? `:${service.port}` : "";
	const prefix = service.pathPrefix === "/" ? "" : service.pathPrefix;
	return `${service.host}${port}${prefix}`;
}

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
		parts.push(`Services: ${services.join(", ")}`);
	}
	if (proposal.credentials.length > 0) {
		parts.push(
			`Credentials: ${proposal.credentials.map((credential) => credential.ref).join(", ")}`
		);
	}
	return parts.join(" · ");
}

function BrokerProposals({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
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
		onSuccess: async (_, { decision }) => {
			await queryClient.invalidateQueries({ queryKey: ["vault", "broker"] });
			sileo.success({ title: DECISION_TOAST[decision] });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not update the proposal",
				description: vaultErrorMessage(error, "Try again."),
			});
		},
	});
	const proposals = proposalsQuery.data ?? [];

	return (
		<SettingsSection
			caption="Agents propose new services or credentials here, and ask before their first use of a password-manager reference. Nothing is brokered until someone approves."
			title="Pending proposals"
		>
			<SettingsCard className="divide-y p-0">
				{proposalsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : proposalsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							proposalsQuery.error,
							"Could not load proposals."
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
						return (
							<div
								className="flex items-center justify-between gap-4 px-4 py-3"
								key={proposal.id}
							>
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium text-sm">
											{proposal.message || "Broker proposal"}
										</span>
										<Badge variant="outline">{proposal.environment}</Badge>
										{proposal.credentialUse ? (
											<Badge variant="secondary">
												{proposal.credentialUse.provider}
											</Badge>
										) : null}
									</div>
									<p className="mt-1 truncate text-muted-foreground text-xs">
										{[
											proposalSummary(proposal, tl),
											proposal.requestedBy,
											`expires ${whenLabel(proposal.expiresAt)}`,
										]
											.filter(Boolean)
											.join(" · ")}
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

const CARD_DECISION_TOAST = {
	reject: "Card use rejected",
	once: "Card use approved once (within 15 minutes)",
	grant: "Card use approved for 15 minutes",
} satisfies Record<VaultCardDecision, string>;

const CARD_CHANNEL_LABEL = {
	broker: "agent request",
	fill: "fill",
	reveal: "reveal",
} satisfies Record<VaultCardApproval["channel"], string>;

function cardApprovalSummary(approval: VaultCardApproval): string {
	const card = [
		approval.brand ?? "card",
		approval.last4 && `•••• ${approval.last4}`,
	]
		.filter(Boolean)
		.join(" ");
	return [
		card,
		approval.merchantHost && `at ${approval.merchantHost}`,
		CARD_CHANNEL_LABEL[approval.channel],
		approval.field && `field ${approval.field}`,
		approval.requester,
		`expires ${whenLabel(approval.requestExpiresAt)}`,
	]
		.filter(Boolean)
		.join(" · ");
}

function CardApprovals({ target }: { target: ApiTarget }) {
	const queryClient = useQueryClient();
	const approvalsQuery = useQuery({
		queryKey: ["vault", "broker", "card-approvals", target.url],
		queryFn: () => listVaultCardApprovals(target),
	});
	const decideMutation = useMutation({
		mutationFn: ({
			decision,
			id,
		}: {
			decision: VaultCardDecision;
			id: string;
		}) => decideVaultCardApproval(target, id, decision),
		onSuccess: async (_, { decision }) => {
			await queryClient.invalidateQueries({ queryKey: ["vault", "broker"] });
			sileo.success({ title: CARD_DECISION_TOAST[decision] });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not update the card approval",
				description: vaultErrorMessage(error, "Try again."),
			});
		},
	});
	const approvals = approvalsQuery.data ?? [];

	return (
		<SettingsSection
			caption="Every use of a payment card waits here until someone approves it. Card numbers are never shown."
			title="Card spend approvals"
		>
			<SettingsCard className="divide-y p-0">
				{approvalsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : approvalsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							approvalsQuery.error,
							"Could not load card approvals."
						)}
					</p>
				) : approvals.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No card uses are waiting.
					</p>
				) : (
					approvals.map((approval) => {
						const busy =
							decideMutation.isPending &&
							decideMutation.variables?.id === approval.id;
						const decide = (decision: VaultCardDecision) =>
							decideMutation.mutate({ decision, id: approval.id });
						return (
							<div
								className="flex items-center justify-between gap-4 px-4 py-3"
								key={approval.id}
							>
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<code className="font-medium font-mono text-sm">
											{approval.key}
										</code>
										<Badge variant="outline">{approval.environment}</Badge>
									</div>
									<p
										className="mt-1 truncate text-muted-foreground text-xs"
										title={cardApprovalSummary(approval)}
									>
										{cardApprovalSummary(approval)}
									</p>
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										disabled={busy}
										onClick={() => decide("reject")}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
										Reject
									</Button>
									{approval.channel === "reveal" ? null : (
										<Button
											disabled={busy}
											onClick={() => decide("grant")}
											size="sm"
											variant="ghost"
										>
											Allow 15 min
										</Button>
									)}
									<Button
										disabled={busy}
										onClick={() => decide("once")}
										size="sm"
										variant="outline"
									>
										<HugeiconsIcon
											className="size-4"
											icon={CheckmarkCircle02Icon}
										/>
										Approve once
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

function BrokerServices({ target }: { target: ApiTarget }) {
	const servicesQuery = useQuery({
		queryKey: ["vault", "broker", "services", target.url],
		queryFn: () => listVaultBrokerServices(target),
	});
	const services = servicesQuery.data ?? [];

	return (
		<SettingsSection
			caption="Agents started with the broker reach these hosts through a local proxy that adds the credential, so the agent never sees it."
			title="Services"
		>
			<SettingsCard className="divide-y p-0">
				{servicesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={3} />
				) : servicesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							servicesQuery.error,
							"Could not load broker services."
						)}
					</p>
				) : services.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No broker services yet.
					</p>
				) : (
					<ul className="divide-y">
						{services.map((service) => (
							<li
								className="flex items-start justify-between gap-4 px-4 py-3"
								key={`${service.environment}/${service.name}`}
							>
								<div className="min-w-0">
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<code className="font-medium font-mono">
											{service.name}
										</code>
										<Badge variant="outline">{service.environment}</Badge>
										{service.enabled ? null : (
											<Badge variant="secondary">Disabled</Badge>
										)}
									</p>
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{[upstream(service), service.description]
											.filter(Boolean)
											.join(" · ")}
									</p>
								</div>
								<span className="shrink-0 text-muted-foreground text-xs">
									{whenLabel(service.updatedAt)}
								</span>
							</li>
						))}
					</ul>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}

export function VaultBrokerPanel({ target }: { target: ApiTarget }) {
	const accessQuery = useQuery({
		queryKey: ["vault", "broker", "proposals", target.url],
		queryFn: () => listVaultBrokerProposals(target),
	});
	if (isForbidden(accessQuery.error)) {
		// Card approvals authorize per card, so a card owner still sees them.
		return (
			<div className="space-y-6">
				<CardApprovals target={target} />
				<SettingsCard className="p-6 text-center">
					<p className="font-medium text-sm">Broker admins only</p>
					<p className="mt-1 text-muted-foreground text-sm">
						Ask a vault admin for access to the credential broker.
					</p>
				</SettingsCard>
			</div>
		);
	}
	return (
		<div className="space-y-6">
			<CardApprovals target={target} />
			<BrokerProposals target={target} />
			<BrokerServices target={target} />
		</div>
	);
}
