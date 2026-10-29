import {
	Add01Icon,
	Cancel01Icon,
	CloudServerIcon,
	GoogleIcon,
	Link01Icon,
	Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import {
	ACCOUNT_LINKING_PROVIDERS,
	type LinkedAccountProvider,
} from "@ryu/blocks/web/linked-account-providers.ts";
import {
	DISCORD_SVGL,
	GITHUB_SVGL,
	SvglIcon,
} from "@ryu/blocks/web/svgl-icon.tsx";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { authClient } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { ConnectDeviceQR } from "@/src/components/devices/ConnectDeviceQR.tsx";
import { CloudSyncSection } from "@/src/components/settings/CloudSyncSection.tsx";
import { NodeAccessSettings } from "@/src/components/settings/NodeAccessSettings.tsx";

import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type ApiTarget,
	currentClientId,
	toTarget,
} from "@/src/lib/api/client.ts";
import {
	type ConnectedClient,
	fetchConnections,
} from "@/src/lib/api/connections.ts";
import {
	connectionDisplayName,
	connectionSurfaceMeta,
} from "@/src/lib/connection-surface.ts";
import {
	loadSshConnections,
	normalizeSshConnection,
	type SshAuthMode,
	type SshConnection,
	saveSshConnections,
} from "@/src/lib/ssh-connections.ts";
import {
	isLocalNode,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * A list row's title: leading tile, the name, and an optional muted detail line
 * under it. Use `detail` when the row's secondary text belongs inside the card;
 * rows whose secondary text is an iOS footer pass it as `description` instead.
 */
function RowTitle({
	detail,
	leading,
	name,
}: {
	detail?: ReactNode;
	leading: ReactNode;
	name: ReactNode;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2.5">
			{leading}
			<span className="min-w-0 flex-1">
				<span
					className="block truncate"
					title={typeof name === "string" ? name : undefined}
				>
					{name}
				</span>
				{detail ? (
					<span
						className="mt-0.5 block truncate text-muted-foreground text-xs"
						title={typeof detail === "string" ? detail : undefined}
					>
						{detail}
					</span>
				) : null}
			</span>
		</span>
	);
}

function relativeLastSeen(lastSeen: number): string {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - lastSeen);
	if (seconds < 10) {
		return "Active now";
	}
	if (seconds < 60) {
		return `Active ${seconds}s ago`;
	}
	return `Active ${Math.floor(seconds / 60)}m ago`;
}

function ConnectedDeviceRow({
	client,
	self,
}: {
	client: ConnectedClient;
	self: boolean;
}) {
	const surface = connectionSurfaceMeta(client.surface);
	return (
		<SettingsItem
			actions={self ? <Badge variant="secondary">This device</Badge> : null}
			key={client.clientId}
			title={
				<RowTitle
					detail={`${surface.label} · ${relativeLastSeen(client.lastSeen)}`}
					leading={<SettingsIconTile icon={surface.icon} tint="blue" />}
					name={connectionDisplayName(client)}
				/>
			}
		/>
	);
}

export function ConnectedDevicesSection() {
	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(
		() => toTarget(activeNode),
		[activeNode.url, activeNode.token]
	);
	const query = useQuery({
		queryKey: ["node-connections-settings", target.url, target.token],
		queryFn: ({ signal }) => fetchConnections(target, signal),
		enabled: Boolean(target.url),
		refetchInterval: 15_000,
		retry: false,
	});
	const selfClientId = currentClientId();

	return (
		<SettingsSection
			caption="Presence is a short-lived view of clients that recently talked to this node. It identifies the calling surface, not who is authorized to access data."
			title="Connected devices"
		>
			{query.isLoading ? (
				<SkeletonRows label="Checking connected devices…" spacing="panel" />
			) : null}
			{query.error ? (
				<SettingsCard className="flex items-center justify-between gap-3">
					<p
						className="text-muted-foreground text-sm"
						title={query.error.message}
					>
						Connected-device presence is unavailable on this node.
					</p>
					<Button
						aria-label="Retry connected device presence"
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
						size="sm"
						variant="outline"
					>
						{query.isFetching ? "Retrying…" : "Retry"}
					</Button>
				</SettingsCard>
			) : null}
			{query.data && query.data.clients.length === 0 ? (
				<SettingsCard>
					<p className="text-center text-muted-foreground text-sm">
						No other devices have connected recently.
					</p>
				</SettingsCard>
			) : null}
			{query.data && query.data.clients.length > 0 ? (
				<SettingsGroup>
					{query.data.clients.map((client) => (
						<ConnectedDeviceRow
							client={client}
							key={client.clientId}
							self={client.clientId === selfClientId}
						/>
					))}
				</SettingsGroup>
			) : null}
		</SettingsSection>
	);
}

function RemoteNodeDialog({
	onOpenChange,
	open,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const addNode = useNodeStore((state) => state.addNode);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setName("");
			setUrl("");
			setToken("");
			setError(null);
		}
	}, [open]);

	const handleAdd = async () => {
		if (!(name.trim() && url.trim()) || saving) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await addNode(name.trim(), url.trim(), token.trim() || undefined);
			onOpenChange(false);
			sileo.success({ title: "Remote node added" });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add remote node</DialogTitle>
					<DialogDescription>
						Connect a Ryu node so its folders can be used as remote projects.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-name">Display name</Label>
						<Input
							disabled={saving}
							id="remote-node-name"
							onChange={(event) => setName(event.target.value)}
							placeholder="Build server"
							value={name}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-url">Node URL</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							disabled={saving}
							id="remote-node-url"
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://server.example.com:7980"
							value={url}
							variant="code-caption"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-token">Access token (optional)</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							disabled={saving}
							id="remote-node-token"
							onChange={(event) => setToken(event.target.value)}
							placeholder="Paste a node token when required"
							type="password"
							value={token}
							variant="code-caption"
						/>
					</div>
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => onOpenChange(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={!(name.trim() && url.trim())}
						loading={saving}
						onClick={() => void handleAdd()}
						type="button"
					>
						Add remote
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RemoteNodesSection() {
	const nodes = useNodeStore((state) => state.nodes);
	const defaultNode = useNodeStore((state) => state.defaultNode);
	const setDefault = useNodeStore((state) => state.setDefault);
	const removeNode = useNodeStore((state) => state.removeNode);
	const remoteNodes = useMemo(
		() => nodes.filter((node) => !isLocalNode(node)),
		[nodes]
	);
	const [addOpen, setAddOpen] = useState(false);

	const useNode = async (node: Node) => {
		try {
			await setDefault(node.name);
			sileo.success({ title: `${node.name} is now active` });
		} catch (cause) {
			sileo.error({
				title: "Could not switch nodes",
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};

	const remove = async (node: Node) => {
		try {
			await removeNode(node.name);
			sileo.success({ title: `${node.name} removed` });
		} catch (cause) {
			sileo.error({
				title: "Could not remove node",
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};

	return (
		<>
			<SettingsSection
				caption="Remote projects run on a connected Ryu node. The node keeps its files, Git credentials, and agent runtime; this device stores only its connection details."
				headerAction={
					<Button onClick={() => setAddOpen(true)} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add remote
					</Button>
				}
				title="Remote nodes"
			>
				{remoteNodes.length > 0 ? (
					<SettingsGroup>
						{remoteNodes.map((node) => {
							const active = node.name === defaultNode;
							return (
								<SettingsItem
									actions={
										<div className="flex items-center gap-1">
											{active ? (
												<Badge variant="secondary">Active</Badge>
											) : (
												<Button
													onClick={() => void useNode(node)}
													size="sm"
													variant="ghost"
												>
													Use
												</Button>
											)}
											<Button
												aria-label={`Remove ${node.name}`}
												onClick={() => void remove(node)}
												size="sm"
												variant="ghost"
											>
												<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
											</Button>
										</div>
									}
									description={
										<span className="type-caption font-mono">{node.url}</span>
									}
									key={node.name}
									title={
										<RowTitle
											leading={
												<SettingsIconTile
													icon={CloudServerIcon}
													tint="indigo"
												/>
											}
											name={node.name}
										/>
									}
								/>
							);
						})}
					</SettingsGroup>
				) : (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							No remote nodes yet. Add a node to browse and work on another
							machine.
						</p>
					</SettingsCard>
				)}
			</SettingsSection>
			<RemoteNodeDialog onOpenChange={setAddOpen} open={addOpen} />
		</>
	);
}

function SshConnectionDialog({
	connection,
	onOpenChange,
	onSave,
	open,
}: {
	connection: SshConnection | null;
	onOpenChange: (open: boolean) => void;
	onSave: (connection: SshConnection) => void;
	open: boolean;
}) {
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [port, setPort] = useState("22");
	const [auth, setAuth] = useState<SshAuthMode>("none");
	const [identityFile, setIdentityFile] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setName(connection?.name ?? "");
		setHost(connection?.host ?? "");
		setUsername(connection?.username ?? "");
		setPort(String(connection?.port ?? 22));
		setAuth(connection?.auth ?? "none");
		setIdentityFile(connection?.identityFile ?? "");
		setError(null);
	}, [connection, open]);

	const handleSave = () => {
		const rawHost = host.trim();
		let parsedHost = rawHost;
		let parsedUsername = username.trim();
		const at = rawHost.lastIndexOf("@");
		if (at > 0 && !parsedUsername) {
			parsedUsername = rawHost.slice(0, at);
			parsedHost = rawHost.slice(at + 1);
		}
		if (auth === "identity" && !identityFile.trim()) {
			setError("Choose an identity file path");
			return;
		}
		const normalized = normalizeSshConnection({
			auth,
			host: parsedHost,
			id: connection?.id,
			identityFile: auth === "identity" ? identityFile : undefined,
			name,
			port: Number(port),
			username: parsedUsername,
		});
		if (!normalized) {
			setError("Enter a display name, valid host, and port from 1 to 65535");
			return;
		}
		onSave(normalized);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{connection ? "Edit SSH connection" : "Add SSH connection"}
					</DialogTitle>
					<DialogDescription>
						Save the host details here. Ryu never reads or stores your private
						key.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="ssh-connection-name">Display name</Label>
						<Input
							id="ssh-connection-name"
							onChange={(event) => setName(event.target.value)}
							placeholder="Build server"
							value={name}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="ssh-connection-host">Hostname</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							id="ssh-connection-host"
							onChange={(event) => setHost(event.target.value)}
							placeholder="host.com or user@host.com"
							value={host}
							variant="code-caption"
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-user">Username</Label>
							<Input
								autoCapitalize="off"
								autoCorrect="off"
								id="ssh-connection-user"
								onChange={(event) => setUsername(event.target.value)}
								placeholder="Optional"
								value={username}
								variant="code-caption"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-port">SSH port</Label>
							<Input
								id="ssh-connection-port"
								inputMode="numeric"
								onChange={(event) => setPort(event.target.value)}
								placeholder="22"
								value={port}
								variant="code-caption"
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<p className="font-medium text-sm">Authentication</p>
						<div
							aria-label="SSH authentication"
							className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1"
							role="group"
						>
							<Button
								aria-pressed={auth === "none"}
								className="w-full"
								onClick={() => setAuth("none")}
								size="sm"
								variant={auth === "none" ? "secondary" : "ghost"}
							>
								No auth
							</Button>
							<Button
								aria-pressed={auth === "identity"}
								className="w-full"
								onClick={() => setAuth("identity")}
								size="sm"
								variant={auth === "identity" ? "secondary" : "ghost"}
							>
								Identity file
							</Button>
						</div>
					</div>
					{auth === "identity" ? (
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-identity">
								Identity file path
							</Label>
							<Input
								autoCapitalize="off"
								autoCorrect="off"
								id="ssh-connection-identity"
								onChange={(event) => setIdentityFile(event.target.value)}
								placeholder="~/.ssh/id_ed25519"
								value={identityFile}
								variant="code-caption"
							/>
						</div>
					) : null}
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button onClick={handleSave} type="button">
						Save connection
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SshConnectionsSection() {
	const [connections, setConnections] = useState<SshConnection[]>(() =>
		loadSshConnections()
	);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<SshConnection | null>(null);

	const openAdd = () => {
		setEditing(null);
		setDialogOpen(true);
	};

	const openEdit = (connection: SshConnection) => {
		setEditing(connection);
		setDialogOpen(true);
	};

	const handleSave = (connection: SshConnection) => {
		const next = editing
			? connections.map((item) => (item.id === editing.id ? connection : item))
			: [...connections, connection];
		saveSshConnections(next);
		setConnections(next);
		setDialogOpen(false);
		sileo.success({
			title: editing ? "SSH connection updated" : "SSH connection saved",
		});
	};

	const handleRemove = (connection: SshConnection) => {
		const next = connections.filter((item) => item.id !== connection.id);
		saveSshConnections(next);
		setConnections(next);
		sileo.success({ title: `${connection.name} removed` });
	};

	return (
		<>
			<SettingsSection
				caption="These profiles stay on this device and contain only connection metadata. Private keys remain in the identity-file location you choose."
				headerAction={
					<Button onClick={openAdd} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add manually
					</Button>
				}
				title="SSH connections from this device"
			>
				{connections.length > 0 ? (
					<SettingsGroup>
						{connections.map((connection) => (
							<SettingsItem
								actions={
									<div className="flex items-center gap-1">
										<Button
											onClick={() => openEdit(connection)}
											size="sm"
											variant="ghost"
										>
											Edit
										</Button>
										<Button
											aria-label={`Remove ${connection.name}`}
											onClick={() => handleRemove(connection)}
											size="sm"
											variant="ghost"
										>
											<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
										</Button>
									</div>
								}
								description={
									<span className="type-caption flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5 font-mono">
										<span>
											{connection.username
												? `${connection.username}@${connection.host}`
												: connection.host}
											:{connection.port}
										</span>
										<span aria-hidden>·</span>
										<span>
											{connection.auth === "identity"
												? (connection.identityFile ?? "Identity file")
												: "Default SSH auth"}
										</span>
									</span>
								}
								key={connection.id}
								title={
									<RowTitle
										leading={<SettingsIconTile icon={Link01Icon} tint="gray" />}
										name={connection.name}
									/>
								}
							/>
						))}
					</SettingsGroup>
				) : (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							No SSH connections yet. Add a profile for a host you use from this
							device.
						</p>
					</SettingsCard>
				)}
			</SettingsSection>
			<SshConnectionDialog
				connection={editing}
				onOpenChange={setDialogOpen}
				onSave={handleSave}
				open={dialogOpen}
			/>
		</>
	);
}

type AccountInfo = NonNullable<
	Awaited<ReturnType<typeof authClient.listAccounts>>["data"]
>[number];

export function ConnectionsTab() {
	const queryClient = useQueryClient();
	const [linkingProvider, setLinkingProvider] =
		useState<LinkedAccountProvider | null>(null);
	const [unlinkingProvider, setUnlinkingProvider] =
		useState<LinkedAccountProvider | null>(null);

	const { data: accounts, isLoading } = useQuery({
		queryKey: ["linked-accounts"],
		queryFn: async () => {
			const result = await authClient.listAccounts();
			if (result.error) {
				throw new Error(result.error.message);
			}
			return result.data ?? [];
		},
	});

	const handleLinkAccount = async (provider: LinkedAccountProvider) => {
		setLinkingProvider(provider);
		const label =
			ACCOUNT_LINKING_PROVIDERS.find((item) => item.id === provider)?.label ??
			provider;
		try {
			const callbackUrl = `${WEB_URL}/settings?tab=connections`;
			const result = await authClient.linkSocial({
				provider,
				callbackURL: callbackUrl,
				disableRedirect: true,
			});
			if (result.error) {
				throw new Error(result.error.message);
			}
			// Open in browser for OAuth flow
			const url = result.data?.url;
			if (url) {
				await openExternal(url);
				sileo.success({
					title: `Complete ${label} account linking in your browser`,
				});
			} else {
				sileo.error({
					title: `Couldn't start ${label} account linking`,
					description: "Please try again in a moment.",
				});
			}
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: `Failed to link ${label} account`,
			});
		} finally {
			setLinkingProvider(null);
		}
	};

	const handleUnlinkAccount = async (account: AccountInfo) => {
		const provider = ACCOUNT_LINKING_PROVIDERS.find(
			(item) => item.id === account.providerId
		);
		if (!provider) {
			return;
		}
		setUnlinkingProvider(provider.id);
		try {
			const result = await authClient.unlinkAccount({
				accountId: account.accountId,
			});
			if (result.error) {
				throw new Error(result.error.message);
			}
			sileo.success({ title: `${provider.label} account unlinked` });
			queryClient.invalidateQueries({ queryKey: ["linked-accounts"] });
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: `Failed to unlink ${provider.label} account`,
			});
		} finally {
			setUnlinkingProvider(null);
		}
	};

	if (isLoading) {
		return <SkeletonRows spacing="section" />;
	}

	return (
		<div
			aria-label="Connections"
			className="space-y-6"
			data-testid="connections-hub"
		>
			<Tabs defaultValue="this-device">
				<TabsList
					aria-label="Connection scope"
					className="grid w-full grid-cols-3"
					manageLayout={false}
					persistLayout={false}
					variant="segmented"
				>
					<TabsTrigger value="this-device">Control this device</TabsTrigger>
					<TabsTrigger value="other-devices">Control other devices</TabsTrigger>
					<TabsTrigger value="ssh">SSH</TabsTrigger>
				</TabsList>
				<TabsContent spacing="comfortable" value="this-device">
					<NodeAccessSettings />
					<ConnectedDevicesSection />
					<SettingsSection
						caption="Link individual social identities to this Ryu account. Social sign-in remains Google-only. Telegram Login is organization/channel-level, so it is not included here."
						title="Linked accounts"
					>
						<SettingsGroup>
							{ACCOUNT_LINKING_PROVIDERS.map((provider) => {
								const account = accounts?.find(
									(candidate) => candidate.providerId === provider.id
								);
								const isLinking = linkingProvider === provider.id;
								const isUnlinking = unlinkingProvider === provider.id;
								return (
									<SettingsItem
										actions={
											account ? (
												<AlertDialog>
													<AlertDialogTrigger
														render={
															<Button
																aria-label={`Unlink ${provider.label} account`}
																disabled={unlinkingProvider !== null}
																size="sm"
																variant="ghost"
															/>
														}
													>
														<HugeiconsIcon
															className="mr-2 size-4"
															icon={Unlink01Icon}
														/>
														{isUnlinking ? "Unlinking…" : "Unlink"}
													</AlertDialogTrigger>
													<AlertDialogContent>
														<AlertDialogHeader>
															<AlertDialogTitle>
																Unlink {provider.label} account?
															</AlertDialogTitle>
															<AlertDialogDescription>
																This removes the account link from your Ryu
																user. Your existing Ryu sign-in methods stay
																unchanged.
															</AlertDialogDescription>
														</AlertDialogHeader>
														<AlertDialogFooter>
															<AlertDialogCancel>Cancel</AlertDialogCancel>
															<AlertDialogAction
																disabled={isUnlinking}
																onClick={() => {
																	void handleUnlinkAccount(account);
																}}
															>
																Unlink
															</AlertDialogAction>
														</AlertDialogFooter>
													</AlertDialogContent>
												</AlertDialog>
											) : (
												<Button
													aria-label={`Link ${provider.label} account`}
													disabled={
														linkingProvider !== null ||
														unlinkingProvider !== null
													}
													onClick={() => {
														void handleLinkAccount(provider.id);
													}}
													size="sm"
													variant="ghost"
												>
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={Link01Icon}
													/>
													{isLinking ? "Opening browser…" : "Link"}
												</Button>
											)
										}
										key={provider.id}
										title={
											<RowTitle
												detail={account ? "Connected" : provider.description}
												leading={
													<span
														aria-hidden="true"
														className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-background"
													>
														{provider.id === "google" ? (
															<HugeiconsIcon
																className="size-4"
																icon={GoogleIcon}
															/>
														) : provider.id === "github" ? (
															<SvglIcon size={16} spec={GITHUB_SVGL} />
														) : (
															<SvglIcon size={16} spec={DISCORD_SVGL} />
														)}
													</span>
												}
												name={provider.label}
											/>
										}
									/>
								);
							})}
						</SettingsGroup>
					</SettingsSection>
					<SettingsSection
						caption="Scan the QR code with the Ryu mobile app to connect your phone to this device."
						title="Connect a phone"
					>
						<SettingsCard>
							<ConnectDeviceQR />
						</SettingsCard>
					</SettingsSection>
					<CloudSyncSection />
				</TabsContent>
				<TabsContent spacing="comfortable" value="other-devices">
					<RemoteNodesSection />
				</TabsContent>
				<TabsContent spacing="comfortable" value="ssh">
					<SshConnectionsSection />
				</TabsContent>
			</Tabs>
		</div>
	);
}
