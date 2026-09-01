import {
	Add01Icon,
	Cancel01Icon,
	CloudServerIcon,
	GoogleIcon,
	Link01Icon,
	Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ACCOUNT_LINKING_PROVIDERS,
	type LinkedAccountProvider,
} from "@ryu/blocks/web/linked-account-providers.ts";
import { DISCORD_SVGL, SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
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
} from "@ryu/ui/components/alert-dialog";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { authClient } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { ConnectDeviceQR } from "@/src/components/devices/ConnectDeviceQR.tsx";
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
	getNodeAuthState,
	type NodeAuthState,
} from "@/src/lib/api/node-auth.ts";
import {
	DEFAULT_CLOUD_SYNC,
	getCloudSyncEnabled,
	setCloudSyncEnabled,
} from "@/src/lib/api/preferences.ts";
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
 * The cross-device sync switch (M10). Writes Core's `cloud-sync-enabled` pref on
 * the ACTIVE node; Core's sync loop re-reads it every tick, so a flip takes effect
 * without a restart (`apps/core/src/server/sync.rs`).
 *
 * Two truths the copy must not paper over:
 *  - the loop also needs the NODE to be signed in (it no-ops as `Unauthenticated`
 *    otherwise), so we read the node's own auth status — not this window's session;
 *  - `RYU_SYNC_ENABLED` in the node's environment overrides the pref, so OFF here
 *    does not prove sync is off on a node that sets it.
 */
function CloudSyncSection() {
	const activeNode = useActiveNode();
	// Depend on the PRIMITIVES, not the node object: `getActiveNode` rebuilds its
	// result whenever the node list is re-decorated, and a fresh object each render
	// would refire the load effect — which opens with `setLoaded(false)`, so the
	// switch would flicker disabled and refetch on every render. Same reasoning as
	// PrivacySettings.
	const target: ApiTarget = useMemo(
		() => toTarget(activeNode),
		[activeNode.url, activeNode.token]
	);

	const [enabled, setEnabled] = useState(DEFAULT_CLOUD_SYNC);
	const [nodeAuth, setNodeAuth] = useState<NodeAuthState>(null);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		Promise.all([getCloudSyncEnabled(target), getNodeAuthState(target)]).then(
			([syncOn, auth]) => {
				if (cancelled) {
					return;
				}
				setEnabled(syncOn);
				setNodeAuth(auth);
				setLoaded(true);
			}
		);
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleToggle = useCallback(
		async (next: boolean) => {
			setEnabled(next); // optimistic
			const ok = await setCloudSyncEnabled(target, next);
			if (!ok) {
				// The write never landed — revert so the switch never shows a choice
				// that wasn't saved.
				setEnabled(!next);
				sileo.error({
					title: "Couldn't save your sync choice",
					description: "Check your connection to this node and try again.",
				});
			}
		},
		[target]
	);

	// Fail OPEN on an unreadable status: only a node we KNOW is signed out blocks
	// the switch, so an unreachable/older Core never locks the control.
	const signedOut = nodeAuth === "signed-out";
	const description = signedOut
		? "Sign in on this node to sync across devices. Until then, syncing stays paused even when this is on."
		: "Off by default. When on, this node mirrors your chats and editable Spaces documents to your Ryu account so your other devices can pick them up. Binary file attachments stay local. Takes effect within a minute, with no restart.";

	return (
		<SettingsSection
			caption="Keep chats and Spaces documents in step across the devices signed in to your account. Everything stays on this device until you turn this on."
			title="Cross-device sync"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Sync my chats and Spaces across devices"
							checked={enabled}
							disabled={!loaded || signedOut}
							id="cloud-sync-enabled"
							onCheckedChange={handleToggle}
						/>
					}
					description={description}
					title="Sync my chats and Spaces across devices"
				/>
			</SettingsGroup>
		</SettingsSection>
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
			description={
				<span className="flex items-center gap-1.5">
					<span>{surface.label}</span>
					<span aria-hidden>·</span>
					<span>{relativeLastSeen(client.lastSeen)}</span>
				</span>
			}
			key={client.clientId}
			title={
				<span className="flex min-w-0 items-center gap-3">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background">
						<HugeiconsIcon className="size-4" icon={surface.icon} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate">
							{connectionDisplayName(client)}
						</span>
						<span className="mt-0.5 block truncate text-muted-foreground text-xs">
							{surface.label} · {relativeLastSeen(client.lastSeen)}
						</span>
					</span>
				</span>
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
				<div className="flex items-center gap-2 px-3 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Checking connected devices…
				</div>
			) : null}
			{query.error ? (
				<p className="px-3 text-muted-foreground text-sm">
					Connected-device presence is unavailable on this node.
				</p>
			) : null}
			{query.data && query.data.clients.length === 0 ? (
				<p className="px-3 text-muted-foreground text-sm">
					No other devices have connected recently.
				</p>
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
							className="font-mono text-xs"
							disabled={saving}
							id="remote-node-url"
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://server.example.com:7980"
							value={url}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-token">Access token (optional)</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							className="font-mono text-xs"
							disabled={saving}
							id="remote-node-token"
							onChange={(event) => setToken(event.target.value)}
							placeholder="Paste a node token when required"
							type="password"
							value={token}
						/>
					</div>
					{error ? (
						<p className="text-destructive text-xs" role="alert">
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
										<span className="font-mono text-[11px]">{node.url}</span>
									}
									key={node.name}
									title={
										<span className="flex min-w-0 items-center gap-3">
											<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background">
												<HugeiconsIcon
													className="size-4"
													icon={CloudServerIcon}
												/>
											</span>
											<span className="min-w-0 flex-1 truncate">
												{node.name}
											</span>
										</span>
									}
								/>
							);
						})}
					</SettingsGroup>
				) : (
					<SettingsCard>
						<div className="flex flex-col items-center gap-3 py-6 text-center">
							<HugeiconsIcon
								className="size-7 text-muted-foreground/60"
								icon={CloudServerIcon}
							/>
							<div>
								<p className="font-medium text-sm">No remote nodes yet</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Add a node to browse and work on another machine.
								</p>
							</div>
						</div>
					</SettingsCard>
				)}
				<Button
					className="mt-3"
					onClick={() => setAddOpen(true)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
					Add remote
				</Button>
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
							className="font-mono text-xs"
							id="ssh-connection-host"
							onChange={(event) => setHost(event.target.value)}
							placeholder="host.com or user@host.com"
							value={host}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-user">Username</Label>
							<Input
								autoCapitalize="off"
								autoCorrect="off"
								className="font-mono text-xs"
								id="ssh-connection-user"
								onChange={(event) => setUsername(event.target.value)}
								placeholder="Optional"
								value={username}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-port">SSH port</Label>
							<Input
								className="font-mono text-xs"
								id="ssh-connection-port"
								inputMode="numeric"
								onChange={(event) => setPort(event.target.value)}
								placeholder="22"
								value={port}
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
								className="font-mono text-xs"
								id="ssh-connection-identity"
								onChange={(event) => setIdentityFile(event.target.value)}
								placeholder="~/.ssh/id_ed25519"
								value={identityFile}
							/>
						</div>
					) : null}
					{error ? (
						<p className="text-destructive text-xs" role="alert">
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
									<span className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5 font-mono text-[11px]">
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
									<span className="flex min-w-0 items-center gap-3">
										<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background">
											<HugeiconsIcon className="size-4" icon={Link01Icon} />
										</span>
										<span className="min-w-0 flex-1 truncate">
											{connection.name}
										</span>
									</span>
								}
							/>
						))}
					</SettingsGroup>
				) : (
					<SettingsCard>
						<div className="flex flex-col items-center gap-3 py-6 text-center">
							<HugeiconsIcon
								className="size-7 text-muted-foreground/60"
								icon={Link01Icon}
							/>
							<div>
								<p className="font-medium text-sm">No SSH connections yet</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Add a profile for a host you use from this device.
								</p>
							</div>
						</div>
					</SettingsCard>
				)}
				<Button className="mt-3" onClick={openAdd} size="sm" variant="ghost">
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
					Add manually
				</Button>
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

interface AccountInfo {
	accountId: string;
	createdAt: Date;
	id: string;
	providerId: string;
}

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
			return (result.data as unknown as AccountInfo[] | null) ?? [];
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
			});
			if (result.error) {
				throw new Error(result.error.message);
			}
			// Open in browser for OAuth flow
			const url = (result.data as { url?: string } | null)?.url;
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
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	return (
		<div
			aria-label="Connections"
			className="space-y-6"
			data-testid="connections-hub"
		>
			<div>
				<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
					Connections
				</p>
				<h2 className="mt-2 font-semibold text-2xl tracking-tight">
					One place for every machine
				</h2>
				<p className="mt-1 max-w-xl text-muted-foreground text-sm">
					Choose where projects run, approve devices, and keep SSH hosts close
					at hand.
				</p>
			</div>
			<Tabs defaultValue="this-device">
				<TabsList className="w-full justify-start" variant="text">
					<TabsTrigger value="this-device">Control this device</TabsTrigger>
					<TabsTrigger value="other-devices">Control other devices</TabsTrigger>
					<TabsTrigger value="ssh">SSH</TabsTrigger>
				</TabsList>
				<TabsContent className="space-y-6" value="this-device">
					<NodeAccessSettings />
					<ConnectedDevicesSection />
					<SettingsSection
						caption="Link individual social identities to this Ryu account. Social sign-in remains Google-only."
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
										description={account ? "Connected" : provider.description}
										key={provider.id}
										title={
											<span className="flex items-center gap-3">
												<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background">
													{provider.id === "google" ? (
														<HugeiconsIcon
															className="size-4"
															icon={GoogleIcon}
														/>
													) : provider.id === "github" ? (
														<Github className="size-4" />
													) : (
														<SvglIcon size={16} spec={DISCORD_SVGL} />
													)}
												</span>
												{provider.label}
											</span>
										}
									/>
								);
							})}
						</SettingsGroup>
						<p className="px-3 text-muted-foreground text-xs">
							Telegram Login is organization/channel-level, so it is not
							included here.
						</p>
					</SettingsSection>
					<SettingsSection
						caption="Scan the QR code with the Ryu mobile app to connect your phone to this device."
						title="Connect a phone"
					>
						<SettingsGroup>
							<div className="px-4 py-4">
								<ConnectDeviceQR />
							</div>
						</SettingsGroup>
					</SettingsSection>
					<CloudSyncSection />
				</TabsContent>
				<TabsContent className="space-y-6" value="other-devices">
					<RemoteNodesSection />
				</TabsContent>
				<TabsContent className="space-y-6" value="ssh">
					<SshConnectionsSection />
				</TabsContent>
			</Tabs>
		</div>
	);
}
