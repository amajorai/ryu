// Broker sessions: the live `rvb_` sessions on this node, with Revoke, and a
// form that mints one for chosen services. The minted token and the proxy
// environment that embeds it are shown once, held only in this component's
// state (never React Query, storage or logs), and dropped when the dialog
// closes. Listing needs `admin` on `sys/broker`; minting needs `use` on each
// service; a session's minter may always revoke it.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
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
	listVaultBrokerSessions,
	revokeVaultBrokerSession,
	type VaultBrokerSession,
} from "@/src/lib/api/vault-broker-console.ts";
import { VaultBrokerMintDialog } from "./VaultBrokerMintDialog.tsx";
import { expiresLabel } from "./vault-broker-summary.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

export function sessionSummary(
	session: VaultBrokerSession,
	tl: LiteralMessage
): string {
	return [
		session.services.length > 0
			? session.services.join(", ")
			: tl("no services"),
		session.mintedBy,
		expiresLabel(session.expiresAt, tl),
	].join(" · ");
}

export function BrokerSessions({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [minting, setMinting] = useState(false);
	const sessionsQuery = useQuery({
		queryKey: ["vault", "broker", "sessions", target.url],
		queryFn: () => listVaultBrokerSessions(target),
	});
	const revokeMutation = useMutation({
		mutationFn: (id: string) => revokeVaultBrokerSession(target, id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["vault", "broker", "sessions"],
			});
			sileo.success({ title: "Session revoked" });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not revoke the session",
				description: vaultErrorMessage(error, "Try again.", tl),
			});
		},
	});
	const sessions = sessionsQuery.data ?? [];

	return (
		<SettingsSection
			caption="Each session is a proxy credential for the services it names. Revoking one stops its traffic at the next request."
			headerAction={
				<Button onClick={() => setMinting(true)} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New session
				</Button>
			}
			title="Sessions"
		>
			<SettingsCard className="divide-y p-0">
				{sessionsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : sessionsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							sessionsQuery.error,
							"Could not load broker sessions.",
							tl
						)}
					</p>
				) : sessions.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No live sessions.
					</p>
				) : (
					<ul className="divide-y">
						{sessions.map((session) => (
							<li
								className="flex items-center justify-between gap-4 px-4 py-3"
								key={session.id}
							>
								<div className="min-w-0">
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<span className="font-medium">
											{session.label || session.id}
										</span>
										<Badge variant="outline">{session.environment}</Badge>
									</p>
									<p
										className="mt-0.5 truncate text-muted-foreground text-xs"
										title={sessionSummary(session, tl)}
									>
										{sessionSummary(session, tl)}
									</p>
								</div>
								<Button
									disabled={
										revokeMutation.isPending &&
										revokeMutation.variables === session.id
									}
									onClick={() => revokeMutation.mutate(session.id)}
									size="sm"
									variant="ghost"
								>
									Revoke
								</Button>
							</li>
						))}
					</ul>
				)}
			</SettingsCard>
			<VaultBrokerMintDialog
				environment={environment}
				onOpenChange={setMinting}
				open={minting}
				target={target}
			/>
		</SettingsSection>
	);
}
