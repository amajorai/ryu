// Typed vault items (logins, cards and custom items) in one environment,
// each with its history. Listings carry metadata only; values stay on the
// item and are revealed elsewhere, never here.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultItems,
	type VaultItemSummary,
} from "@/src/lib/api/vault-items.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { VaultItemHistoryDialog } from "./VaultItemHistoryDialog.tsx";
import { VaultListRow } from "./VaultListRow.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import { timestampMillis } from "./vault-ttl.ts";

export function VaultItemsPanel({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [history, setHistory] = useState<VaultItemSummary | null>(null);
	const itemsQuery = useQuery({
		queryKey: ["vault", "items", "list", target.url, environment],
		queryFn: () => listVaultItems(target, { environment }),
	});
	const items = itemsQuery.data ?? [];

	return (
		<SettingsSection
			caption={tl(
				"Logins, cards and other typed items in {environment}. History shows what changed and who revealed a field.",
				{ environment }
			)}
			title="Items"
		>
			<SettingsCard className="p-0">
				{itemsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : itemsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(itemsQuery.error, "Could not load items.", tl)}
					</p>
				) : items.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No items in this environment.
					</p>
				) : (
					<ul className="divide-y">
						{items.map((item) => {
							const updated = timestampMillis(item.updatedAt);
							return (
								<VaultListRow
									actions={
										<Button
											aria-label={tl("History of {item}", { item: item.key })}
											onClick={() => setHistory(item)}
											size="sm"
											variant="ghost"
										>
											History
										</Button>
									}
									detail={tl(
										"{path} · version {version} · {count, plural, one {# field} other {# fields}} · updated {when}",
										{
											path: item.path,
											version: item.version,
											count: item.fieldCount,
											when: updated === null ? "" : formatDateTime(updated),
										}
									)}
									key={item.id}
									title={
										<>
											<span className="font-medium">{item.key}</span>
											<Badge variant="outline">{item.kind}</Badge>
											{item.status === "pending_collection" ? (
												<Badge variant="outline">Waiting for collection</Badge>
											) : null}
										</>
									}
								/>
							);
						})}
					</ul>
				)}
			</SettingsCard>
			<VaultItemHistoryDialog
				item={history}
				onOpenChange={(open) => {
					if (!open) {
						setHistory(null);
					}
				}}
				target={target}
			/>
		</SettingsSection>
	);
}
