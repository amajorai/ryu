import {
	Delete02Icon,
	FileExportIcon,
	FileImportIcon,
	Key01Icon,
	RefreshIcon,
	RestoreBinIcon,
	ShieldKeyIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { Badge } from "@ryu/ui/components/badge.tsx";
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
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { VaultAuditPanel } from "@/src/components/vault/VaultAuditPanel.tsx";
import { VaultBrokerPanel } from "@/src/components/vault/VaultBrokerPanel.tsx";
import { VaultChangeRequests } from "@/src/components/vault/VaultChangeRequests.tsx";
import { VaultSealControl } from "@/src/components/vault/VaultSealControl.tsx";
import { VaultSecretDialog } from "@/src/components/vault/VaultSecretDialog.tsx";
import {
	VaultTransferDialog,
	type VaultTransferMode,
} from "@/src/components/vault/VaultTransferDialog.tsx";
import { vaultErrorMessage } from "@/src/components/vault/vault-errors.ts";
import {
	buildFolderTree,
	callerSubject,
	inFolder,
	isVaultAdmin,
	normalizeFolder,
	ROOT_FOLDER,
	STATUS_COPY,
	secretKey,
	withSharedFallback,
} from "@/src/components/vault/vault-view.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteVaultSecret,
	listVaultEnvironments,
	listVaultFolders,
	restoreVaultSecret,
	setVaultSecret,
	type VaultScope,
	type VaultSecret,
	vaultCoordsOf,
} from "@/src/lib/api/vault.ts";
import { vaultSecretsQuery } from "@/src/lib/route-queries.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import styles from "./VaultPage.module.css";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SCOPE_COPY = {
	user: {
		label: "User",
		description: "Only your verified chat sessions",
	},
	node: {
		label: "Node",
		description: "Every governed session on this node",
	},
	team: {
		label: "Team",
		description: "Verified members of one team",
	},
	org: {
		label: "Organization",
		description: "Verified members of this organization",
	},
} satisfies Record<VaultScope, { description: string; label: string }>;

const MCP_EXAMPLE = [
	"{",
	'  "headers": {',
	'    "Authorization": "Bearer secret:GITHUB_TOKEN"',
	"  },",
	'  "env": {',
	'    "GITHUB_TOKEN": "secret:GITHUB_TOKEN"',
	"  }",
	"}",
].join("\n");

type VaultTab = "secrets" | "broker" | "audit";

const VAULT_TABS: readonly VaultTab[] = ["secrets", "broker", "audit"];

function vaultTab(value: string): VaultTab {
	return VAULT_TABS.find((tab) => tab === value) ?? "secrets";
}

function scopeLabel(scope: VaultScope): string {
	return SCOPE_COPY[scope].label;
}

function formatUpdatedAt(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "recently" : formatDateTime(value);
}

function scopeIdLabel(scope: VaultScope, scopeId: string): string {
	if (scope === "user") {
		return "your user scope";
	}
	if (scope === "node") {
		return "this node";
	}
	return scopeId;
}

export default function VaultPage() {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<VaultTab>("secrets");
	const [scope, setScope] = useState<VaultScope>("user");
	const [scopeId, setScopeId] = useState("");
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [bindingId, setBindingId] = useState("");
	const [formFolder, setFormFolder] = useState("");
	/** `null` follows the node's active environment. */
	const [environment, setEnvironment] = useState<string | null>(null);
	const [folder, setFolder] = useState(ROOT_FOLDER);
	const [showDeleted, setShowDeleted] = useState(false);
	const [detail, setDetail] = useState<VaultSecret | null>(null);
	const [transfer, setTransfer] = useState<VaultTransferMode | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<VaultSecret | null>(null);

	const vaultQuery = useQuery({
		...vaultSecretsQuery(target, {
			environment: environment ?? undefined,
			includeDeleted: showDeleted,
		}),
		placeholderData: keepPreviousData,
	});
	const state = vaultQuery.data;
	const activeEnvironment =
		environment ?? state?.activeEnvironment ?? "default";

	const environmentsQuery = useQuery({
		queryKey: ["vault", "environments", target.url],
		queryFn: () => listVaultEnvironments(target),
	});
	const foldersQuery = useQuery({
		queryKey: ["vault", "folders", target.url, activeEnvironment],
		queryFn: () => listVaultFolders(target, activeEnvironment),
	});

	const invalidateVault = async () => {
		await queryClient.invalidateQueries({ queryKey: ["vault"] });
	};

	const saveMutation = useMutation({
		mutationFn: async () => {
			const trimmedName = name.trim();
			if (!NAME_PATTERN.test(trimmedName)) {
				throw new Error(
					"Use a letter or underscore followed by letters, numbers, or underscores."
				);
			}
			if (scope === "team" && scopeId.trim() === "") {
				throw new Error("A team scope needs a team id.");
			}
			const result = await setVaultSecret(target, trimmedName, {
				scope,
				...(scope === "team" ? { scopeId: scopeId.trim() } : undefined),
				...(bindingId.trim()
					? { binding: { kind: "mcp" as const, id: bindingId.trim() } }
					: undefined),
				environment: activeEnvironment,
				path: formFolder.trim() ? normalizeFolder(formFolder) : folder,
				value,
			});
			return result.kind;
		},
		onSuccess: async (kind) => {
			setValue("");
			await invalidateVault();
			sileo.success({
				title: kind === "pending" ? "Sent for approval" : "Vault secret saved",
			});
		},
	});
	const deleteMutation = useMutation({
		mutationFn: async () => {
			if (!deleteTarget) {
				return null;
			}
			const result = await deleteVaultSecret(
				target,
				deleteTarget.name,
				vaultCoordsOf(deleteTarget)
			);
			return result.kind;
		},
		onSuccess: async (kind) => {
			setDeleteTarget(null);
			await invalidateVault();
			sileo.success({
				title:
					kind === "pending" ? "Sent for approval" : "Vault secret deleted",
			});
		},
	});
	const restoreMutation = useMutation({
		mutationFn: (secret: VaultSecret) =>
			restoreVaultSecret(target, secret.name, vaultCoordsOf(secret)),
		onSuccess: async () => {
			await invalidateVault();
			sileo.success({ title: "Vault secret restored" });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not restore",
				description: vaultErrorMessage(error, "Try again."),
			});
		},
	});

	const availableScopes = useMemo(() => {
		const scopes: VaultScope[] = ["user", "node"];
		if (state?.node.orgId) {
			scopes.push("team", "org");
		}
		return scopes;
	}, [state?.node.orgId]);
	const teamIds = state?.caller?.teamIds ?? [];
	const sharedDisabled = Boolean(
		state?.node.orgId && !state.canManageShared && state.caller
	);
	const isAdmin = isVaultAdmin(state);
	const importScopes = availableScopes.filter(
		(item) => !(item === "org" && sharedDisabled)
	);

	const environmentOptions = useMemo(() => {
		const listed = environmentsQuery.data?.environments ?? [];
		const options = listed.map((item) => ({
			value: item.slug,
			label: item.name || item.slug,
			protected: item.protected,
		}));
		for (const slug of [activeEnvironment, state?.activeEnvironment]) {
			if (slug && !options.some((item) => item.value === slug)) {
				options.push({ value: slug, label: slug, protected: false });
			}
		}
		return options;
	}, [environmentsQuery.data, activeEnvironment, state?.activeEnvironment]);
	const selectedEnvironment = environmentOptions.find(
		(item) => item.value === activeEnvironment
	);

	const secretsInEnvironment = useMemo(
		() =>
			(state?.secrets ?? [])
				.filter((secret) => secret.environment === activeEnvironment)
				.map((secret) =>
					withSharedFallback(secret, state?.canManageShared ?? false)
				),
		[state?.secrets, state?.canManageShared, activeEnvironment]
	);
	const folderTree = useMemo(
		() =>
			buildFolderTree([
				...(foldersQuery.data ?? []),
				...secretsInEnvironment.map((secret) => secret.path),
			]),
		[foldersQuery.data, secretsInEnvironment]
	);
	const visibleSecrets = secretsInEnvironment.filter((secret) =>
		inFolder(secret.path, folder)
	);

	const selectScope = (next: string | null) => {
		if (
			next === "user" ||
			next === "node" ||
			next === "team" ||
			next === "org"
		) {
			setScope(next);
			if (next !== "team") {
				setScopeId("");
			}
		}
	};

	const selectEnvironment = (next: string) => {
		setEnvironment(next);
		setFolder(ROOT_FOLDER);
	};

	if (vaultQuery.isLoading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 pb-12">
				<header className="flex items-start justify-between gap-4">
					<div>
						<div className="mb-2 flex items-center gap-2">
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={ShieldKeyIcon}
								size={18}
							/>
							<h1 className="font-medium text-xl">Vault</h1>
						</div>
						<p className="max-w-2xl text-muted-foreground text-sm">
							Store your own secrets once and let governed MCP calls use them
							without putting the value in the chat, transcript, or tool
							arguments.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-1">
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
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={RefreshIcon} />
						</Button>
					</div>
				</header>

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
						<div className="rounded-xl border border-border/70 bg-muted/20 p-4">
							<div className="flex items-start gap-3">
								<HugeiconsIcon
									className="mt-0.5 text-muted-foreground"
									icon={Key01Icon}
									size={16}
								/>
								<div className="space-y-1 text-sm">
									<p className="font-medium">Hidden by default</p>
									<p className="text-muted-foreground">
										Core encrypts values at rest. Lists only show names, scope,
										and details. People with read access can reveal or export a
										value, and every reveal is audited. Use{" "}
										<code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
											secret:NAME
										</code>{" "}
										in an MCP header or environment entry to resolve it during
										the call.
									</p>
								</div>
							</div>
						</div>

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
									<HugeiconsIcon className="size-4" icon={FileImportIcon} />
									Import
								</Button>
								<Button
									onClick={() => setTransfer("export")}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={FileExportIcon} />
									Export
								</Button>
							</div>
						</div>
						{selectedEnvironment?.protected ? (
							<p className="-mt-3 text-muted-foreground text-xs">
								This environment is protected. Changes need approval.
							</p>
						) : null}

						<VaultChangeRequests
							callerSubject={callerSubject(state)}
							target={target}
						/>

						<SettingsSection
							caption="The same name can exist at multiple levels. A user value supersedes a node value, which supersedes a team value, which supersedes an organization value. An MCP-bound value wins over an unbound value at the same level."
							title="Add or rotate a secret"
						>
							<SettingsCard className="grid gap-4 p-4 sm:grid-cols-2">
								<div className="space-y-1.5">
									<Label htmlFor="vault-secret-name">Name</Label>
									<Input
										autoComplete="off"
										id="vault-secret-name"
										onChange={(event) => setName(event.target.value)}
										placeholder="GITHUB_TOKEN"
										value={name}
									/>
									<p className="text-muted-foreground text-xs">
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
														(item === "team" || item === "org") &&
														sharedDisabled
													}
													key={item}
													value={item}
												>
													<div className="flex flex-col">
														<span>{scopeLabel(item)}</span>
														<span className="text-muted-foreground text-xs">
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
										Folder{" "}
										<span className="text-muted-foreground">(optional)</span>
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
									<p className="text-muted-foreground text-xs">
										When set, only that MCP server or owning plugin can resolve
										this name. Skills remain instructions and never receive raw
										secret values.
									</p>
								</div>
								<div className="flex items-center justify-between gap-3 sm:col-span-2">
									<p className="text-muted-foreground text-xs">
										{scope === "user"
											? "Saved for your verified sessions"
											: scope === "node"
												? `Saved for ${state?.node.id ?? "this node"}`
												: scope === "team"
													? `Saved for team ${scopeId || "…"}`
													: `Saved for ${state?.node.orgId ?? "this organization"}`}{" "}
										in {activeEnvironment}.
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
									>
										Save secret
									</Button>
								</div>
								{saveMutation.error ? (
									<p className="text-sm text-status-destructive sm:col-span-2">
										{vaultErrorMessage(
											saveMutation.error,
											"Could not save secret."
										)}
									</p>
								) : null}
							</SettingsCard>
						</SettingsSection>

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
										onCheckedChange={(checked: boolean) =>
											setShowDeleted(checked)
										}
										size="sm"
									/>
								</div>
							}
							title="Stored secrets"
						>
							{state?.sharedError ? (
								<p className="px-3.5 text-status-destructive text-xs">
									Shared secrets could not be loaded. Showing this node's
									secrets only.
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
															aria-current={
																folder === item.path ? "true" : undefined
															}
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
								<SettingsCard className="divide-y p-0">
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
												Add a secret above, then reference it from an MCP
												server.
											</p>
										</div>
									)}
								</SettingsCard>
							</div>
						</SettingsSection>

						<SettingsSection
							caption="Put the reference in the MCP server configuration. Core expands it only when the governed call is dispatched. Use secret:ENV:/folder/NAME to pick an environment and folder."
							title="Use it from MCP"
						>
							<SettingsCard className="space-y-3 p-4">
								<pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-6">
									{MCP_EXAMPLE}
								</pre>
								<p className="text-muted-foreground text-xs">
									The resolved value is kept out of the model-visible schema and
									chat transcript. A missing, expired, or unauthorized reference
									is omitted instead of being sent as literal text.
								</p>
							</SettingsCard>
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
							{deleteTarget?.name} stops resolving in its{" "}
							{deleteTarget ? scopeLabel(deleteTarget.scope).toLowerCase() : ""}{" "}
							scope. You can restore it from Show deleted.
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

function SecretRow({
	deleteDisabled,
	onDelete,
	onOpen,
	onRestore,
	restoreDisabled,
	secret,
}: {
	deleteDisabled: boolean;
	onDelete: () => void;
	onOpen: () => void;
	onRestore: () => void;
	restoreDisabled: boolean;
	secret: VaultSecret;
}) {
	const statusCopy =
		secret.status === "active" ? null : STATUS_COPY[secret.status];
	const isDeleted = secret.status === "deleted";
	return (
		<div className="flex items-center justify-between gap-4 p-4">
			<button
				aria-label={`Open ${secret.name}`}
				className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
				onClick={onOpen}
				type="button"
			>
				<span className="flex flex-wrap items-center gap-2">
					<code
						className={
							isDeleted
								? "font-medium font-mono text-muted-foreground text-sm line-through"
								: "font-medium font-mono text-sm"
						}
					>
						{secret.name}
					</code>
					<Badge variant="secondary">{scopeLabel(secret.scope)}</Badge>
					{secret.source === "control-plane" ? (
						<Badge variant="outline">Shared</Badge>
					) : null}
					{secret.binding ? (
						<Badge typography="code" variant="outline">
							mcp:{secret.binding.id}
						</Badge>
					) : (
						<Badge variant="outline">all MCP consumers</Badge>
					)}
					{statusCopy ? (
						<Badge variant={statusCopy.variant}>{statusCopy.label}</Badge>
					) : null}
				</span>
				<span className="mt-1 block truncate text-muted-foreground text-xs">
					{scopeIdLabel(secret.scope, secret.scopeId)}
					{secret.path === ROOT_FOLDER ? "" : ` · ${secret.path}`} · v
					{secret.version} · updated {formatUpdatedAt(secret.updatedAt)}
				</span>
			</button>
			{isDeleted ? (
				secret.capabilities.includes("write") ? (
					<Button
						aria-label={`Restore ${secret.name}`}
						disabled={restoreDisabled}
						onClick={onRestore}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={RestoreBinIcon} />
					</Button>
				) : null
			) : secret.capabilities.includes("delete") ? (
				<Button
					aria-label={`Delete ${secret.name}`}
					disabled={deleteDisabled}
					onClick={onDelete}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				</Button>
			) : null}
		</div>
	);
}
