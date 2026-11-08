// Credential broker console. Requests holds card spend approvals, the agent
// proposals waiting for a decision, and the services agents may reach through
// the broker proxy (added from the catalog, edited and deleted here). Sessions,
// Activity (discovered hosts and the request log) and Settings (unmatched-host
// policy and agent skills) live in `VaultBrokerConsole.tsx`. Approving a
// proposal creates its services; credentials it asks for are added as
// ordinary secrets. A
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
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listVaultBrokerProposals } from "@/src/lib/api/vault-broker.ts";
import {
	decideVaultCardApproval,
	listVaultCardApprovals,
	type VaultCardDecision,
} from "@/src/lib/api/vault-cards.ts";
import {
	BrokerConsole,
	type BrokerConsoleView,
} from "./VaultBrokerConsole.tsx";
import { BrokerProposals } from "./VaultBrokerProposals.tsx";
import { BrokerServices } from "./VaultBrokerServices.tsx";
import { cardApprovalSummary } from "./vault-broker-summary.ts";
import { isForbidden, vaultErrorMessage } from "./vault-errors.ts";

type BrokerView = "requests" | BrokerConsoleView;

const VIEWS = [
	{ label: "Requests", value: "requests" },
	{ label: "Sessions", value: "sessions" },
	{ label: "Activity", value: "activity" },
	{ label: "Settings", value: "settings" },
] satisfies { label: string; value: BrokerView }[];

function brokerView(value: string): BrokerView {
	return VIEWS.find((view) => view.value === value)?.value ?? "requests";
}

const CARD_DECISION_TOAST = {
	reject: "Card use rejected",
	once: "Card use approved once (within 15 minutes)",
	grant: "Card use approved for 15 minutes",
} satisfies Record<VaultCardDecision, string>;

function CardApprovals({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
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
				description: vaultErrorMessage(error, "Try again.", tl),
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
							"Could not load card approvals.",
							tl
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
										title={cardApprovalSummary(approval, tl)}
									>
										{cardApprovalSummary(approval, tl)}
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

export function VaultBrokerPanel({
	environment: initialEnvironment = "default",
	target,
}: {
	/** The environment the console starts in (the Vault page's active one). */
	environment?: string;
	target: ApiTarget;
}) {
	const [view, setView] = useState<BrokerView>("requests");
	const [environment, setEnvironment] = useState(initialEnvironment);
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
			<Tabs
				onValueChange={(next: string) => setView(brokerView(next))}
				value={view}
			>
				<TabsList variant="text">
					{VIEWS.map((item) => (
						<TabsTrigger key={item.value} value={item.value}>
							{item.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			{view === "requests" ? (
				<>
					<CardApprovals target={target} />
					<BrokerProposals target={target} />
					<BrokerServices environment={environment} target={target} />
				</>
			) : (
				<BrokerConsole
					environment={environment}
					onEnvironmentChange={setEnvironment}
					target={target}
					view={view}
				/>
			)}
		</div>
	);
}
