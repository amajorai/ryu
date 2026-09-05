import {
	Delete02Icon,
	Key01Icon,
	RefreshIcon,
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
} from "@ryu/ui/components/alert-dialog";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteVaultSecret,
	listVaultSecrets,
	setVaultSecret,
	type VaultScope,
} from "@/src/lib/api/vault.ts";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SCOPE_COPY: Record<VaultScope, { description: string; label: string }> = {
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
};

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

function scopeLabel(scope: VaultScope): string {
	return SCOPE_COPY[scope].label;
}

function formatUpdatedAt(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString();
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
	const [scope, setScope] = useState<VaultScope>("user");
	const [scopeId, setScopeId] = useState("");
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [bindingId, setBindingId] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<{
		name: string;
		scope: VaultScope;
		scopeId: string;
		bindingId?: string;
	} | null>(null);

	const listKey = ["vault", "secrets", target.url] as const;
	const vaultQuery = useQuery({
		queryKey: listKey,
		queryFn: () => listVaultSecrets(target),
	});
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
			await setVaultSecret(target, trimmedName, {
				scope,
				...(scope === "team" ? { scopeId: scopeId.trim() } : {}),
				...(bindingId.trim()
					? { binding: { kind: "mcp" as const, id: bindingId.trim() } }
					: {}),
				value,
			});
		},
		onSuccess: async () => {
			setValue("");
			await queryClient.invalidateQueries({ queryKey: listKey });
			sileo.success({ title: "Vault secret saved" });
		},
	});
	const deleteMutation = useMutation({
		mutationFn: async () => {
			if (!deleteTarget) {
				return;
			}
			await deleteVaultSecret(target, deleteTarget.name, {
				scope: deleteTarget.scope,
				...(deleteTarget.scope === "team"
					? { scopeId: deleteTarget.scopeId }
					: {}),
				...(deleteTarget.bindingId
					? {
							binding: {
								kind: "mcp" as const,
								id: deleteTarget.bindingId,
							},
						}
					: {}),
			});
		},
		onSuccess: async () => {
			setDeleteTarget(null);
			await queryClient.invalidateQueries({ queryKey: listKey });
			sileo.success({ title: "Vault secret cleared" });
		},
	});

	const state = vaultQuery.data;
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

	if (vaultQuery.isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
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
					<Button
						aria-label="Refresh vault"
						disabled={vaultQuery.isFetching}
						onClick={() => vaultQuery.refetch()}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={RefreshIcon} />
					</Button>
				</header>

				<div className="rounded-xl border border-border/70 bg-muted/20 p-4">
					<div className="flex items-start gap-3">
						<HugeiconsIcon
							className="mt-0.5 text-muted-foreground"
							icon={Key01Icon}
							size={16}
						/>
						<div className="space-y-1 text-sm">
							<p className="font-medium">Write-only by design</p>
							<p className="text-muted-foreground">
								Core encrypts values at rest. The API and this page only show
								names, scope, and MCP bindings. Use{" "}
								<code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
									secret:NAME
								</code>{" "}
								in an MCP header or environment entry to resolve it during the
								call.
							</p>
						</div>
					</div>
				</div>

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
								placeholder="Paste once; it will not be shown again"
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
												<span className="text-muted-foreground text-xs">
													{SCOPE_COPY[item].description}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
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
								When set, only that MCP server or owning plugin can resolve this
								name. Skills remain instructions and never receive raw secret
								values.
							</p>
						</div>
						<div className="flex items-center justify-between gap-3 sm:col-span-2">
							<p className="text-muted-foreground text-xs">
								{scope === "user"
									? "Saved for your verified sessions."
									: scope === "node"
										? `Saved for ${state?.node.id ?? "this node"}.`
										: scope === "team"
											? `Saved for team ${scopeId || "…"}.`
											: `Saved for ${state?.node.orgId ?? "this organization"}.`}
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
							<p className="text-destructive text-sm sm:col-span-2">
								{saveMutation.error instanceof Error
									? saveMutation.error.message
									: "Could not save secret."}
							</p>
						) : null}
					</SettingsCard>
				</SettingsSection>

				<SettingsSection
					caption={
						state?.caller
							? "Showing the scopes available to " +
								state.caller.userId +
								". Values are never returned."
							: "Showing node-local metadata. Sign in to a managed node to see user, team, or organization scopes."
					}
					title="Stored secrets"
				>
					<SettingsCard className="divide-y">
						{vaultQuery.error ? (
							<p className="p-4 text-destructive text-sm">
								{vaultQuery.error instanceof Error
									? vaultQuery.error.message
									: "Could not load vault secrets."}
							</p>
						) : state?.secrets.length ? (
							state.secrets.map((secret) => (
								<div
									className="flex items-center justify-between gap-4 p-4"
									key={[
										secret.scope,
										secret.scopeId,
										secret.binding?.id ?? "",
										secret.name,
									].join(":")}
								>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<code className="font-medium font-mono text-sm">
												{secret.name}
											</code>
											<Badge variant="secondary">
												{scopeLabel(secret.scope)}
											</Badge>
											{secret.binding ? (
												<Badge className="font-mono" variant="outline">
													mcp:{secret.binding.id}
												</Badge>
											) : (
												<Badge variant="outline">all MCP consumers</Badge>
											)}
										</div>
										<p className="mt-1 truncate text-muted-foreground text-xs">
											{scopeIdLabel(secret.scope, secret.scopeId)} · updated{" "}
											{formatUpdatedAt(secret.updatedAt)}
										</p>
									</div>
									<Button
										aria-label={`Clear ${secret.name}`}
										disabled={deleteMutation.isPending}
										onClick={() =>
											setDeleteTarget({
												name: secret.name,
												scope: secret.scope,
												scopeId: secret.scopeId,
												bindingId: secret.binding?.id,
											})
										}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={Delete02Icon} />
									</Button>
								</div>
							))
						) : (
							<div className="p-6 text-center">
								<p className="font-medium text-sm">No secrets stored</p>
								<p className="mt-1 text-muted-foreground text-sm">
									Add a secret above, then reference it from an MCP server.
								</p>
							</div>
						)}
					</SettingsCard>
				</SettingsSection>

				<SettingsSection
					caption="Put the reference in the MCP server configuration. Core expands it only when the governed call is dispatched."
					title="Use it from MCP"
				>
					<SettingsCard className="space-y-3 p-4">
						<pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-6">
							{MCP_EXAMPLE}
						</pre>
						<p className="text-muted-foreground text-xs">
							The resolved value is kept out of the model-visible schema and
							chat transcript. A missing or unauthorized reference is omitted
							instead of being sent as literal text.
						</p>
					</SettingsCard>
				</SettingsSection>
			</div>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setDeleteTarget(null);
					}
				}}
				open={deleteTarget !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Clear this secret?</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget?.name} will be removed from its{" "}
							{deleteTarget ? scopeLabel(deleteTarget.scope).toLowerCase() : ""}{" "}
							scope. The value cannot be recovered from Ryu.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={deleteMutation.isPending}
							onClick={(event) => {
								event.preventDefault();
								deleteMutation.mutate();
							}}
						>
							{deleteMutation.isPending ? "Clearing…" : "Clear secret"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
