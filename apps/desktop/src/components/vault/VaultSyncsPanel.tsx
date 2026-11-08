// Secret syncs: the stores this node pushes to (GitHub Actions, Vercel, AWS
// Secrets Manager, Google Cloud Secret Manager, or an OpenBao, HashiCorp
// Vault or Infisical store), the folders synced to them with their last push,
// and folders sourced from external stores. Managing a store needs `admin` on
// `sys/external/<store>`; syncing a folder also needs `read` and `list` on it.
// No credential or value is shown.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
	deleteVaultExternalDestination,
	deleteVaultExternalStore,
	listVaultExternalDestinations,
	listVaultExternalSources,
	listVaultExternalStores,
	pushVaultExternalDestination,
	syncVaultExternalSource,
	testVaultExternalStore,
} from "@/src/lib/api/vault-external.ts";
import { VaultSyncDialog } from "./VaultSyncDialog.tsx";
import { VaultSyncTargetDialog } from "./VaultSyncTargetDialog.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import {
	storeSummary,
	syncStatus,
	syncTargetLabel,
} from "./vault-sync-form.ts";

const KEY = ["vault", "external"] as const;

function Row({
	actions,
	detail,
	title,
}: {
	actions: React.ReactNode;
	detail: React.ReactNode;
	title: React.ReactNode;
}) {
	return (
		<li className="flex items-center justify-between gap-4 px-4 py-3">
			<div className="min-w-0">
				<p className="flex flex-wrap items-center gap-2 text-sm">{title}</p>
				<p className="mt-0.5 truncate text-muted-foreground text-xs">
					{detail}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1">{actions}</div>
		</li>
	);
}

export function VaultSyncsPanel({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [connecting, setConnecting] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const storesQuery = useQuery({
		queryKey: [...KEY, "stores", target.url],
		queryFn: () => listVaultExternalStores(target),
	});
	const syncsQuery = useQuery({
		queryKey: [...KEY, "destinations", target.url],
		queryFn: () => listVaultExternalDestinations(target),
	});
	const sourcesQuery = useQuery({
		queryKey: [...KEY, "sources", target.url],
		queryFn: () => listVaultExternalSources(target),
	});
	const act = useMutation({
		mutationFn: async (action: {
			id: string;
			kind: string;
			name: string;
		}): Promise<string> => {
			switch (action.kind) {
				case "test": {
					const result = await testVaultExternalStore(target, action.id);
					if (!result.ok) {
						throw new Error(
							result.error ?? "The store refused the credentials"
						);
					}
					return tl("{name} is reachable", { name: action.name });
				}
				case "push": {
					const pushed = await pushVaultExternalDestination(target, action.id);
					return tl("Pushed {count, plural, one {# key} other {# keys}}", {
						count: pushed,
					});
				}
				case "pull": {
					const report = await syncVaultExternalSource(target, action.id);
					return tl("Pulled {count, plural, one {# key} other {# keys}}", {
						count: report.written + report.unchanged,
					});
				}
				case "remove-store":
					await deleteVaultExternalStore(target, action.id);
					return tl("Removed {name}", { name: action.name });
				default:
					await deleteVaultExternalDestination(target, action.id);
					return "Sync removed; values already pushed stay in place";
			}
		},
		onSuccess: async (title) => {
			await queryClient.invalidateQueries({ queryKey: [...KEY] });
			sileo.success({ title });
		},
		onError: async (error) => {
			await queryClient.invalidateQueries({ queryKey: [...KEY] });
			sileo.error({
				title: "That did not work",
				description: vaultErrorMessage(error, "Try again.", tl),
			});
		},
	});
	const busy = (id: string) => act.isPending && act.variables?.id === id;
	const stores = storesQuery.data ?? [];
	const names = new Map(stores.map((store) => [store.id, store.name]));
	const syncs = syncsQuery.data ?? [];
	const sources = sourcesQuery.data ?? [];

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Platforms and stores this node can push folders to. Credentials are never shown again after you connect one."
				headerAction={
					<Button onClick={() => setConnecting(true)} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Connect target
					</Button>
				}
				title="Sync targets"
			>
				<SettingsCard className="p-0">
					{storesQuery.isLoading ? (
						<SkeletonRows inset="panel" rows={2} />
					) : storesQuery.error ? (
						<p className="p-4 text-sm text-status-destructive">
							{vaultErrorMessage(
								storesQuery.error,
								"Could not load stores.",
								tl
							)}
						</p>
					) : stores.length === 0 ? (
						<p className="p-6 text-center text-muted-foreground text-sm">
							No sync targets yet.
						</p>
					) : (
						<ul className="divide-y">
							{stores.map((store) => (
								<Row
									actions={
										<>
											<Button
												aria-label={tl("Test {name}", { name: store.name })}
												disabled={busy(store.id)}
												onClick={() =>
													act.mutate({
														id: store.id,
														kind: "test",
														name: store.name,
													})
												}
												size="sm"
												variant="ghost"
											>
												Test
											</Button>
											<Button
												aria-label={tl("Remove {name}", { name: store.name })}
												disabled={busy(store.id)}
												onClick={() =>
													act.mutate({
														id: store.id,
														kind: "remove-store",
														name: store.name,
													})
												}
												size="sm"
												variant="ghost"
											>
												Remove
											</Button>
										</>
									}
									detail={storeSummary(store)}
									key={store.id}
									title={
										<>
											<span className="font-medium">{store.name}</span>
											<Badge variant="outline">
												{syncTargetLabel(store.kind)}
											</Badge>
										</>
									}
								/>
							))}
						</ul>
					)}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Folders pushed after every change and on a schedule. A failing push is retried with backoff."
				headerAction={
					<Button
						disabled={stores.length === 0}
						onClick={() => setSyncing(true)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Sync a folder
					</Button>
				}
				title="Syncs"
			>
				<SettingsCard className="p-0">
					{syncsQuery.isLoading ? (
						<SkeletonRows inset="panel" rows={2} />
					) : syncs.length === 0 ? (
						<p className="p-6 text-center text-muted-foreground text-sm">
							No folders are synced.
						</p>
					) : (
						<ul className="divide-y">
							{syncs.map((sync) => {
								const status = syncStatus(sync, tl);
								const folder = `${sync.environment}:${sync.path}`;
								return (
									<Row
										actions={
											<>
												<Button
													aria-label={tl("Push {folder} now", { folder })}
													disabled={busy(sync.id)}
													onClick={() =>
														act.mutate({
															id: sync.id,
															kind: "push",
															name: folder,
														})
													}
													size="sm"
													variant="ghost"
												>
													Push now
												</Button>
												<Button
													aria-label={tl("Stop syncing {folder}", { folder })}
													disabled={busy(sync.id)}
													onClick={() =>
														act.mutate({
															id: sync.id,
															kind: "unsync",
															name: folder,
														})
													}
													size="sm"
													variant="ghost"
												>
													Stop
												</Button>
											</>
										}
										detail={
											<span
												className={
													status.tone === "error"
														? "text-status-destructive"
														: undefined
												}
											>
												{status.label}
											</span>
										}
										key={sync.id}
										title={
											<>
												<span className="font-medium">{folder}</span>
												<span className="text-muted-foreground">→</span>
												<span>{names.get(sync.storeId) ?? sync.storeId}</span>
												{sync.remotePath ? (
													<code className="font-mono text-xs">
														{sync.remotePath}
													</code>
												) : null}
											</>
										}
									/>
								);
							})}
						</ul>
					)}
				</SettingsCard>
			</SettingsSection>

			{sources.length > 0 ? (
				<SettingsSection
					caption="Folders read from OpenBao, HashiCorp Vault or Infisical. Change these values in the store."
					title="Sources"
				>
					<SettingsCard className="p-0">
						<ul className="divide-y">
							{sources.map((source) => {
								const folder = `${source.environment}:${source.path}`;
								return (
									<Row
										actions={
											<Button
												aria-label={tl("Pull {folder} now", { folder })}
												disabled={busy(source.id)}
												onClick={() =>
													act.mutate({
														id: source.id,
														kind: "pull",
														name: folder,
													})
												}
												size="sm"
												variant="ghost"
											>
												Pull now
											</Button>
										}
										detail={
											source.lastStatus === "error"
												? (source.lastError ?? "The last read failed")
												: tl(
														"{mode} · {count, plural, one {# key} other {# keys}}",
														{ count: source.lastCount, mode: source.mode }
													)
										}
										key={source.id}
										title={
											<>
												<span className="font-medium">{folder}</span>
												<span className="text-muted-foreground">←</span>
												<span>
													{names.get(source.storeId) ?? source.storeId}
												</span>
											</>
										}
									/>
								);
							})}
						</ul>
					</SettingsCard>
				</SettingsSection>
			) : null}

			<VaultSyncTargetDialog
				onOpenChange={setConnecting}
				open={connecting}
				target={target}
			/>
			<VaultSyncDialog
				environment={environment}
				onOpenChange={setSyncing}
				open={syncing}
				stores={stores}
				target={target}
			/>
		</div>
	);
}
