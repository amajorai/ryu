import type { LiteralMessage } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { CSSProperties } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { vaultErrorMessage } from "@/src/components/vault/vault-errors.ts";
import { secretKey } from "@/src/components/vault/vault-view.ts";
import {
	SCOPE_COPY,
	scopeLabel,
	vaultSavedForCopy,
} from "./VaultPage.model.ts";
import styles from "./VaultPage.module.css";
import { SecretRow } from "./VaultPage.secret-row.tsx";
import type { useVaultPageState } from "./VaultPage.state.ts";

type VaultSecretFormInput = Pick<
	ReturnType<typeof useVaultPageState>,
	| "activeEnvironment"
	| "availableScopes"
	| "bindingId"
	| "folder"
	| "formFolder"
	| "name"
	| "saveMutation"
	| "scope"
	| "scopeId"
	| "selectScope"
	| "setBindingId"
	| "setFormFolder"
	| "setName"
	| "setScopeId"
	| "setValue"
	| "sharedDisabled"
	| "state"
	| "teamIds"
	| "value"
> & { tl: LiteralMessage };

/** The add-or-rotate secret form. A plain render call, so the React tree is unchanged. */
export function renderVaultSecretForm({
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
	tl,
	value,
}: VaultSecretFormInput) {
	return (
		<SettingsSection
			caption="The same name can exist at multiple levels. A user value supersedes a node value, which supersedes a team value, which supersedes an organization value. An MCP-bound value wins over an unbound value at the same level."
			title="Add or rotate a secret"
		>
			<SettingsCard className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="vault-secret-name">Name</Label>
					<Input
						autoComplete="off"
						id="vault-secret-name"
						onChange={(event) => setName(event.target.value)}
						placeholder="GITHUB_TOKEN"
						value={name}
					/>
					<p className="text-detail text-muted-foreground">
						Letters, numbers, and underscores only.
					</p>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-secret-value">Value</Label>
					<Input
						autoComplete="new-password"
						id="vault-secret-value"
						onChange={(event) => setValue(event.target.value)}
						placeholder="Paste once; it stays hidden"
						type="password"
						value={value}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-secret-scope">Scope</Label>
					<Select
						items={availableScopes.map((item) => ({
							value: item,
							label: scopeLabel(item),
						}))}
						onValueChange={selectScope}
						value={scope}
					>
						<SelectTrigger id="vault-secret-scope">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{availableScopes.map((item) => (
								<SelectItem
									disabled={
										(item === "team" || item === "org") && sharedDisabled
									}
									key={item}
									value={item}
								>
									<div className="flex flex-col">
										<span>{scopeLabel(item)}</span>
										<span className="text-detail text-muted-foreground">
											{SCOPE_COPY[item].description}
										</span>
									</div>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-secret-folder">
						Folder <span className="text-muted-foreground">(optional)</span>
					</Label>
					<Input
						autoComplete="off"
						id="vault-secret-folder"
						onChange={(event) => setFormFolder(event.target.value)}
						placeholder={folder}
						value={formFolder}
					/>
				</div>
				{scope === "team" ? (
					<div className="space-y-1.5">
						<Label htmlFor="vault-secret-team">Team id</Label>
						<Input
							id="vault-secret-team"
							list="vault-team-ids"
							onChange={(event) => setScopeId(event.target.value)}
							placeholder={teamIds[0] ?? "team-id"}
							value={scopeId}
						/>
						<datalist id="vault-team-ids">
							{teamIds.map((teamId) => (
								<option key={teamId} value={teamId} />
							))}
						</datalist>
					</div>
				) : null}
				<div className="space-y-1.5 sm:col-span-2">
					<Label htmlFor="vault-secret-binding">
						MCP binding{" "}
						<span className="text-muted-foreground">(optional)</span>
					</Label>
					<Input
						id="vault-secret-binding"
						onChange={(event) => setBindingId(event.target.value)}
						placeholder="github or io.example/github"
						value={bindingId}
					/>
					<p className="text-detail text-muted-foreground">
						When set, only that MCP server or owning plugin can resolve this
						name. Skills remain instructions and never receive raw secret
						values.
					</p>
				</div>
				<div className="flex items-center justify-between gap-3 sm:col-span-2">
					<p className="text-detail text-muted-foreground">
						{vaultSavedForCopy(tl, {
							environment: activeEnvironment,
							nodeId: state?.node.id,
							orgId: state?.node.orgId,
							scope,
							scopeId,
						})}
					</p>
					<Button
						disabled={
							saveMutation.isPending ||
							name.trim() === "" ||
							value === "" ||
							(scope === "team" && scopeId.trim() === "") ||
							((scope === "team" || scope === "org") && sharedDisabled)
						}
						loading={saveMutation.isPending}
						onClick={() => saveMutation.mutate()}
						variant="mono"
					>
						Save secret
					</Button>
				</div>
				{saveMutation.error ? (
					<p className="text-sm text-status-destructive sm:col-span-2">
						{vaultErrorMessage(saveMutation.error, "Could not save secret.")}
					</p>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

type VaultSecretListInput = Pick<
	ReturnType<typeof useVaultPageState>,
	| "deleteMutation"
	| "folder"
	| "folderTree"
	| "restoreMutation"
	| "setDeleteTarget"
	| "setDetail"
	| "setFolder"
	| "setShowDeleted"
	| "showDeleted"
	| "state"
	| "vaultQuery"
	| "visibleSecrets"
>;

/** The scoped secret list with folders and deleted-secret recovery. A plain render call, so the React tree is unchanged. */
export function renderVaultSecretList({
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
}: VaultSecretListInput) {
	return (
		<SettingsSection
			caption={
				state?.caller
					? "Showing the scopes available to " +
						state.caller.userId +
						". Select a secret to see its details and history."
					: "Showing node-local metadata. Sign in to a managed node to see user, team, or organization scopes."
			}
			headerAction={
				<div className="flex items-center gap-2">
					<Label
						htmlFor="vault-show-deleted"
						size="compact"
						tone="muted"
						typography="normal"
					>
						Show deleted
					</Label>
					<Switch
						checked={showDeleted}
						id="vault-show-deleted"
						onCheckedChange={(checked: boolean) => setShowDeleted(checked)}
						size="sm"
					/>
				</div>
			}
			title="Stored secrets"
		>
			{state?.sharedError ? (
				<p className="text-sm text-status-destructive">
					Shared secrets could not be loaded. Showing this node's secrets only.
				</p>
			) : null}
			<div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
				<nav aria-label="Folders">
					<SettingsCard className="p-1.5">
						<ul className="flex flex-col">
							{folderTree.map((item) => {
								const folderStyle: CSSProperties & {
									"--vault-folder-inset": string;
								} = {
									"--vault-folder-inset": `${0.5 + item.depth * 0.75}rem`,
								};
								return (
									<li key={item.path}>
										<button
											aria-current={folder === item.path ? "true" : undefined}
											className={`w-full truncate rounded-lg px-2 py-1 text-left font-mono text-xs hover:bg-muted aria-[current=true]:bg-muted aria-[current=true]:font-medium ${styles.folder}`}
											onClick={() => setFolder(item.path)}
											style={folderStyle}
											type="button"
										>
											{item.depth === 0 ? "All folders" : item.label}
										</button>
									</li>
								);
							})}
						</ul>
					</SettingsCard>
				</nav>
				<SettingsCard className="divide-y divide-border">
					{vaultQuery.error ? (
						<p className="p-4 text-sm text-status-destructive">
							{vaultErrorMessage(
								vaultQuery.error,
								"Could not load vault secrets."
							)}
						</p>
					) : visibleSecrets.length ? (
						visibleSecrets.map((secret) => (
							<SecretRow
								deleteDisabled={deleteMutation.isPending}
								key={secretKey(secret)}
								onDelete={() => setDeleteTarget(secret)}
								onOpen={() => setDetail(secret)}
								onRestore={() => restoreMutation.mutate(secret)}
								restoreDisabled={restoreMutation.isPending}
								secret={secret}
							/>
						))
					) : (
						<div className="p-6 text-center">
							<p className="font-medium text-sm">No secrets here</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Add a secret above, then reference it from an MCP server.
							</p>
						</div>
					)}
				</SettingsCard>
			</div>
		</SettingsSection>
	);
}
