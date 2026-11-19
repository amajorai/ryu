// Leases issued by dynamic roles, newest first: who holds each one, when it
// expires, and Renew (by the role's default TTL, up to its maximum) or Revoke.
// A lease row never carries the credential it was issued with.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	changeVaultLease,
	listVaultLeases,
	type VaultLease,
} from "@/src/lib/api/vault-dynamic.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { VaultListRow } from "./VaultListRow.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import { timestampMillis } from "./vault-ttl.ts";

export type LeaseState = "active" | "expired" | "revoked";

export function leaseState(lease: VaultLease, now = Date.now()): LeaseState {
	if (lease.revokedAt !== null) {
		return "revoked";
	}
	const expires = timestampMillis(lease.expiresAt);
	return expires !== null && expires <= now ? "expired" : "active";
}

function when(value: string | number): string {
	const millis = timestampMillis(value);
	return millis === null ? String(value) : formatDateTime(millis);
}

export function VaultLeasesSection({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [includeRevoked, setIncludeRevoked] = useState(false);
	const leasesQuery = useQuery({
		queryKey: ["vault", "dynamic", "leases", target.url, includeRevoked],
		queryFn: () => listVaultLeases(target, { includeRevoked }),
	});
	const act = useMutation({
		mutationFn: (action: { id: string; op: "renew" | "revoke" }) =>
			changeVaultLease(target, action.id, action.op),
		onSuccess: async (lease, action) => {
			await queryClient.invalidateQueries({
				queryKey: ["vault", "dynamic", "leases"],
			});
			sileo.success({
				title:
					action.op === "renew"
						? tl("Renewed until {expires}", { expires: when(lease.expiresAt) })
						: tl("Revoked {lease}", { lease: lease.id }),
			});
		},
		onError: (error) => {
			sileo.error({
				title: tl("That did not work"),
				description: vaultErrorMessage(error, "Try again.", tl),
			});
		},
	});
	const busy = (id: string) => act.isPending && act.variables?.id === id;
	const leases = leasesQuery.data ?? [];

	return (
		<SettingsSection
			caption="Credentials issued from dynamic roles. Revoking a lease removes its credential at the provider."
			headerAction={
				<div className="flex items-center gap-2">
					<Label
						htmlFor="vault-leases-revoked"
						size="compact"
						tone="muted"
						typography="normal"
					>
						Show revoked
					</Label>
					<Switch
						checked={includeRevoked}
						id="vault-leases-revoked"
						onCheckedChange={(checked: boolean) => setIncludeRevoked(checked)}
						size="sm"
					/>
				</div>
			}
			title="Leases"
		>
			<SettingsCard className="p-0">
				{leasesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : leasesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(leasesQuery.error, "Could not load leases.", tl)}
					</p>
				) : leases.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No leases.
					</p>
				) : (
					<ul className="divide-y">
						{leases.map((lease) => {
							const state = leaseState(lease);
							return (
								<VaultListRow
									actions={
										state === "active" ? (
											<>
												{lease.renewable ? (
													<Button
														aria-label={tl("Renew {lease}", {
															lease: lease.id,
														})}
														disabled={busy(lease.id)}
														onClick={() =>
															act.mutate({ id: lease.id, op: "renew" })
														}
														size="sm"
														variant="ghost"
													>
														Renew
													</Button>
												) : null}
												<Button
													aria-label={tl("Revoke {lease}", { lease: lease.id })}
													disabled={busy(lease.id)}
													onClick={() =>
														act.mutate({ id: lease.id, op: "revoke" })
													}
													size="sm"
													variant="ghost"
												>
													Revoke
												</Button>
											</>
										) : undefined
									}
									detail={
										state === "active"
											? tl("{holder} · expires {expires}", {
													holder: lease.issuedTo ?? "-",
													expires: when(lease.expiresAt),
												})
											: tl("{holder} · issued {issued}", {
													holder: lease.issuedTo ?? "-",
													issued: when(lease.createdAt),
												})
									}
									key={lease.id}
									title={
										<>
											<span className="font-medium">{lease.role}</span>
											<code className="font-mono text-xs">{lease.id}</code>
											{state === "active" ? null : (
												<Badge variant="outline">
													{state === "revoked" ? "Revoked" : "Expired"}
												</Badge>
											)}
										</>
									}
								/>
							);
						})}
					</ul>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
