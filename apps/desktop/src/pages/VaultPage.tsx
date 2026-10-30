import {
	FileExportIcon,
	FileImportIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";

import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";

import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";

import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import { VaultAuditPanel } from "@/src/components/vault/VaultAuditPanel.tsx";
import { VaultBrokerPanel } from "@/src/components/vault/VaultBrokerPanel.tsx";
import { VaultChangeRequests } from "@/src/components/vault/VaultChangeRequests.tsx";
import { VaultSealControl } from "@/src/components/vault/VaultSealControl.tsx";
import { VaultSecretDialog } from "@/src/components/vault/VaultSecretDialog.tsx";
import { VaultTransferDialog } from "@/src/components/vault/VaultTransferDialog.tsx";
import { vaultErrorMessage } from "@/src/components/vault/vault-errors.ts";
import { callerSubject } from "@/src/components/vault/vault-view.ts";
import { PageTop } from "@/src/components/views/page-layout.tsx";
import { MCP_EXAMPLE, scopeLabel, vaultTab } from "./VaultPage.model.ts";
import {
	renderVaultSecretForm,
	renderVaultSecretList,
} from "./VaultPage.sections.tsx";
import { useVaultPageState } from "./VaultPage.state.ts";

export default function VaultPage() {
	const tl = useLiteralMessages();
	const {
		activeEnvironment,
		availableScopes,
		bindingId,
		deleteMutation,
		deleteTarget,
		detail,
		environmentOptions,
		folder,
		folderTree,
		formFolder,
		importScopes,
		invalidateVault,
		isAdmin,
		name,
		restoreMutation,
		saveMutation,
		scope,
		scopeId,
		selectEnvironment,
		selectScope,
		selectedEnvironment,
		setBindingId,
		setDeleteTarget,
		setDetail,
		setFolder,
		setFormFolder,
		setName,
		setScopeId,
		setShowDeleted,
		setTab,
		setTransfer,
		setValue,
		sharedDisabled,
		showDeleted,
		state,
		tab,
		target,
		teamIds,
		transfer,
		value,
		vaultQuery,
		visibleSecrets,
	} = useVaultPageState();

	if (vaultQuery.isLoading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	return (
		<div className="scroll-fade h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 pt-6 pb-12">
				<PageTop
					actions={
						<>
							{state?.seal ? (
								<VaultSealControl
									canManage={isAdmin}
									seal={state.seal}
									target={target}
								/>
							) : null}
							<Button
								aria-label="Refresh vault"
								disabled={vaultQuery.isFetching}
								onClick={() => invalidateVault()}
								size="icon-sm"
								variant="ghost-muted"
							>
								<HugeiconsIcon icon={RefreshIcon} size={16} />
							</Button>
						</>
					}
					subtitle={
						<>
							Encrypted secrets that MCP calls use through{" "}
							<code className="font-mono">secret:NAME</code>, never through the
							chat.
						</>
					}
					title="Vault"
				/>

				{isAdmin ? (
					<Tabs
						onValueChange={(next: string) => setTab(vaultTab(next))}
						value={tab}
					>
						<TabsList variant="pills">
							<TabsTrigger value="secrets">Secrets</TabsTrigger>
							<TabsTrigger value="broker">Broker</TabsTrigger>
							<TabsTrigger value="audit">Audit</TabsTrigger>
						</TabsList>
					</Tabs>
				) : null}

				{isAdmin && tab === "audit" ? (
					<VaultAuditPanel target={target} />
				) : isAdmin && tab === "broker" ? (
					<VaultBrokerPanel target={target} />
				) : (
					<>
						<div className="flex flex-wrap items-end justify-between gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="vault-environment">Environment</Label>
								<Select
									items={environmentOptions}
									onValueChange={(next: string) => selectEnvironment(next)}
									value={activeEnvironment}
								>
									<SelectTrigger
										className="min-w-40"
										id="vault-environment"
										variant="default"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{environmentOptions.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
												{item.protected ? " (protected)" : ""}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex items-center gap-1">
								<Button
									onClick={() => setTransfer("import")}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon icon={FileImportIcon} size={16} />
									Import
								</Button>
								<Button
									onClick={() => setTransfer("export")}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon icon={FileExportIcon} size={16} />
									Export
								</Button>
							</div>
						</div>
						{selectedEnvironment?.protected ? (
							<p className="-mt-3 text-detail text-muted-foreground">
								This environment is protected. Changes need approval.
							</p>
						) : null}

						<VaultChangeRequests
							callerSubject={callerSubject(state)}
							target={target}
						/>

						{renderVaultSecretForm({
							tl,
							activeEnvironment,
							availableScopes,
							bindingId,
							folder,
							formFolder,
							name,
							saveMutation,
							scope,
							scopeId,
							selectScope,
							setBindingId,
							setFormFolder,
							setName,
							setScopeId,
							setValue,
							sharedDisabled,
							state,
							teamIds,
							value,
						})}

						{renderVaultSecretList({
							deleteMutation,
							folder,
							folderTree,
							restoreMutation,
							setDeleteTarget,
							setDetail,
							setFolder,
							setShowDeleted,
							showDeleted,
							state,
							vaultQuery,
							visibleSecrets,
						})}

						<SettingsSection
							caption="Core expands the reference only when the governed call runs. Use secret:ENV:/folder/NAME for an environment and folder."
							title="Use it from MCP"
						>
							<pre className="mt-2 overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-xs leading-6">
								{MCP_EXAMPLE}
							</pre>
							<p className="mt-2 text-detail text-muted-foreground">
								A missing, expired, or unauthorized reference is omitted, never
								sent as literal text.
							</p>
						</SettingsSection>
					</>
				)}
			</div>
			<VaultSecretDialog
				onOpenChange={(open) => {
					if (!open) {
						setDetail(null);
					}
				}}
				secret={detail}
				target={target}
			/>
			<VaultTransferDialog
				environment={activeEnvironment}
				folder={folder}
				importScopes={importScopes}
				mode={transfer}
				onOpenChange={(open) => {
					if (!open) {
						setTransfer(null);
					}
				}}
				target={target}
			/>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setDeleteTarget(null);
						deleteMutation.reset();
					}
				}}
				open={deleteTarget !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this secret?</AlertDialogTitle>
						<AlertDialogDescription>
							{tl(
								"{name} stops resolving in its {scope} scope. You can restore it from Show deleted.",
								{
									name: deleteTarget?.name ?? "",
									scope: deleteTarget
										? scopeLabel(deleteTarget.scope).toLowerCase()
										: "",
								}
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{deleteMutation.error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{vaultErrorMessage(deleteMutation.error, "Could not delete.")}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={deleteMutation.isPending}
							onClick={(event) => {
								event.preventDefault();
								deleteMutation.mutate();
							}}
						>
							{deleteMutation.isPending ? "Deleting…" : "Delete secret"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
