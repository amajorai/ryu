// apps/desktop/src/components/marketplace/ConnectionsTab.tsx
//
// Marketplace → Connections: the global Composio surface. Browse the full
// toolkit catalog, see which accounts are connected, connect new ones (OAuth via
// Composio-managed auth), and drill into a toolkit's actions/triggers. Per the
// connect-on-execute history, connecting here is the *proactive* path — the
// agent editor then attaches already-connected toolkits per agent.
//
// All data lives in Core (`/api/composio/*`); this component is a thin GUI over
// the catalog + connection hooks. The Composio key itself is set in Gateway →
// Keys; when it's missing we surface an actionable prompt instead of empty grids.

import {
	ArrowRight01Icon,
	Idea01Icon,
	Link01Icon,
	PlugSocketIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	accessLevelSummary,
	ConnectionPermissionDialog,
} from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	useComposioActions,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
	useComposioTriggers,
	useInitiateComposioConnection,
} from "@/src/hooks/useComposioCatalog.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import {
	useConnectMcpOAuth,
	useDisconnectMcpOAuth,
	useMcpOAuthConnections,
	useMcpOAuthFlow,
} from "@/src/hooks/useMcpOAuth.ts";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import type {
	AppInfo,
	McpOAuthServerDeclaration,
} from "@/src/lib/api/plugins.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

export default function ConnectionsTab() {
	const { apps, loading: appsLoading } = useApps();
	const openGateway = useGatewayDialog((state) => state.openGateway);
	const status = useComposioStatus();
	const keyConfigured = status.data?.configured ?? false;

	const toolkits = useComposioToolkits(keyConfigured);
	const connections = useComposioConnections("", keyConfigured);
	const [query, setQuery] = useState("");

	// Map toolkit slug → its connection, preferring an active one.
	const connectionByToolkit = useMemo(() => {
		const map = new Map<string, ComposioConnection>();
		for (const conn of connections.data ?? []) {
			const existing = map.get(conn.toolkit);
			if (!existing || (conn.active && !existing.active)) {
				map.set(conn.toolkit, conn);
			}
		}
		return map;
	}, [connections.data]);

	const filtered = useMemo(() => {
		const term = query.trim().toLowerCase();
		const all = toolkits.data ?? [];
		if (!term) {
			return all;
		}
		return all.filter(
			(t) =>
				t.name.toLowerCase().includes(term) ||
				t.slug.toLowerCase().includes(term) ||
				(t.description?.toLowerCase().includes(term) ?? false)
		);
	}, [toolkits.data, query]);

	const oauthApps = apps.filter(
		(app) => app.enabled && app.mcpOAuthServers.length > 0
	);

	return (
		<div className="mx-auto max-w-5xl px-6 py-6">
			<div className="mb-5">
				<h2 className="font-medium text-lg">Connections</h2>
				<p className="text-muted-foreground text-sm">
					Connect your accounts once here, then attach their tools to any agent.
				</p>
			</div>

			<OAuthConnections apps={oauthApps} loading={appsLoading} />

			<div className="mt-8 mb-4">
				<h3 className="font-medium text-sm">Managed integrations</h3>
				<p className="text-muted-foreground text-xs">
					Additional account connections powered by Composio.
				</p>
			</div>

			{status.isLoading ? (
				<div className="flex justify-center py-12">
					<Spinner className="size-5" />
				</div>
			) : null}
			{status.isLoading || keyConfigured ? null : (
				<KeyMissingState onOpenKeys={() => openGateway("keys")} />
			)}
			{!status.isLoading && keyConfigured ? (
				<>
					<div className="relative mb-5">
						<HugeiconsIcon
							className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							className="pl-9"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setQuery(e.target.value)
							}
							placeholder="Search integrations (Gmail, Slack, GitHub…)"
							value={query}
						/>
					</div>

					<ToolkitResults
						connectionByToolkit={connectionByToolkit}
						error={toolkits.error as Error | null}
						isLoading={toolkits.isLoading}
						onClearQuery={() => setQuery("")}
						query={query}
						toolkits={filtered}
					/>
				</>
			) : null}
		</div>
	);
}

export function OAuthConnections({
	apps,
	loading,
}: {
	apps: AppInfo[];
	loading: boolean;
}) {
	const identities = useIdentities();
	const profileIds = Array.from(
		new Set(["personal", ...identities.profileIds])
	).sort();
	if (loading) {
		return <Spinner className="size-4" />;
	}
	if (apps.length === 0) {
		return null;
	}
	return (
		<section>
			<div className="mb-3">
				<h3 className="font-medium text-sm">App and plugin accounts</h3>
				<p className="text-muted-foreground text-xs">
					Credentials stay encrypted on this node and are sent only to the
					declared MCP server.
				</p>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{apps.flatMap((app) =>
					app.mcpOAuthServers.map((server) => (
						<OAuthServerCard
							app={app}
							key={`${app.id}:${server.name}`}
							profileIds={profileIds}
							server={server}
						/>
					))
				)}
			</div>
		</section>
	);
}

export function OAuthServerCard({
	app,
	profileIds,
	server,
}: {
	app: AppInfo;
	profileIds: string[];
	server: McpOAuthServerDeclaration;
}) {
	const [profileId, setProfileId] = useState("personal");
	const [flowId, setFlowId] = useState<string | null>(null);
	const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
	const status = useMcpOAuthConnections(app.id);
	const flow = useMcpOAuthFlow(app.id, flowId);
	const connect = useConnectMcpOAuth(app.id);
	const disconnect = useDisconnectMcpOAuth(app.id);
	const serverStatus = status.data?.find(
		(candidate) => candidate.serverName === server.name
	);
	const connection = serverStatus?.connections.find(
		(candidate) => candidate.profileId === profileId
	);
	const connected = connection?.status === "connected";
	const pending = connect.isPending || flow.data?.status === "pending";

	useEffect(() => {
		if (!flowId) {
			return;
		}
		if (flow.data?.status === "connected") {
			setFlowId(null);
			status.refetch();
			sileo.success({ title: `${app.name} connected` });
			return;
		}
		if (flow.data?.status === "failed") {
			setFlowId(null);
			sileo.error({
				description: flow.data.error ?? undefined,
				title: `${app.name} connection failed`,
			});
		}
	}, [app.name, flow.data, flowId, status.refetch]);

	const handleConnect = async (accessLevel: ConnectionAccessLevel) => {
		const started = await connect.mutateAsync({
			accessLevel,
			profileId,
			serverName: server.name,
		});
		setFlowId(started.flowId);
		await openExternal(started.authorizationUrl);
		sileo.success({
			description: "Authorize in your browser, then return to Ryu.",
			title: `Connecting ${app.name}…`,
		});
	};

	const handleDisconnect = async () => {
		try {
			const result = await disconnect.mutateAsync({
				profileId,
				serverName: server.name,
			});
			sileo.success({
				description:
					result.revocation === "confirmed"
						? "The provider token was revoked."
						: "Local credentials were removed; provider revocation could not be confirmed.",
				title: `${app.name} disconnected`,
			});
		} catch (error) {
			sileo.error({
				title: error instanceof Error ? error.message : "Could not disconnect.",
			});
		}
	};

	return (
		<article className="rounded-lg bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate font-medium text-sm">{app.name}</p>
					<p className="truncate text-muted-foreground text-xs">
						{server.name} · {server.resource}
					</p>
				</div>
				<ConnectionStatusBadge connected={connected} pending={pending} />
			</div>
			<Select
				onValueChange={(value) => {
					if (value) {
						setProfileId(value);
					}
				}}
				value={profileId}
			>
				<SelectTrigger
					aria-label={`${app.name} identity profile`}
					className="mt-3 h-8 w-full"
					size="sm"
				>
					<SelectValue placeholder="Identity profile" />
				</SelectTrigger>
				<SelectContent>
					{profileIds.map((id) => (
						<SelectItem key={id} value={id}>
							{id}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{connection?.scopes.length ? (
				<p className="mt-2 line-clamp-2 text-muted-foreground text-xs">
					Scopes: {connection.scopes.join(", ")}
				</p>
			) : null}
			<Badge className="mt-2 w-fit" variant="outline">
				Access: {accessLevelSummary(connection?.accessLevel)}
			</Badge>
			<div className="mt-3 flex justify-end gap-2">
				{app.enabled ? null : (
					<span className="mr-auto self-center text-muted-foreground text-xs">
						Enable to connect
					</span>
				)}
				{connected ? (
					<Button
						disabled={disconnect.isPending || !app.enabled}
						onClick={handleDisconnect}
						size="sm"
						variant="ghost"
					>
						Log out
					</Button>
				) : null}
				<Button
					disabled={profileId.trim().length === 0 || !app.enabled}
					loading={pending}
					onClick={() => setPermissionDialogOpen(true)}
					size="sm"
					variant={connected ? "outline" : "default"}
				>
					{connected ? "Reconnect" : "Connect"}
				</Button>
			</div>
			<ConnectionPermissionDialog
				connectionName={app.name}
				connectionType="MCP"
				currentLevel={connection?.accessLevel}
				onConfirm={handleConnect}
				onOpenChange={setPermissionDialogOpen}
				open={permissionDialogOpen}
			/>
		</article>
	);
}

/** The toolkit grid body: handles loading / error / empty / results without
 *  nested ternaries (early returns keep each state readable). */
function ToolkitResults({
	toolkits,
	connectionByToolkit,
	isLoading,
	error,
	onClearQuery,
	query,
}: {
	toolkits: ComposioToolkit[];
	connectionByToolkit: Map<string, ComposioConnection>;
	isLoading: boolean;
	error: Error | null;
	onClearQuery: () => void;
	query: string;
}) {
	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<p className="text-destructive text-sm">
				Couldn't load integrations: {error.message}
			</p>
		);
	}
	if (toolkits.length === 0) {
		return (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PlugSocketIcon} />
					</EmptyMedia>
					<EmptyTitle>No integrations match “{query}”</EmptyTitle>
					<EmptyDescription>Try a different search term.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearQuery} size="sm" variant="ghost">
						Clear search
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{toolkits.map((toolkit) => (
				<ToolkitCard
					connection={connectionByToolkit.get(toolkit.slug) ?? null}
					key={toolkit.slug}
					toolkit={toolkit}
				/>
			))}
		</div>
	);
}

function KeyMissingState({ onOpenKeys }: { onOpenKeys: () => void }) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Idea01Icon} />
				</EmptyMedia>
				<EmptyTitle>Add your Composio key to connect accounts</EmptyTitle>
				<EmptyDescription>
					Connections are powered by Composio. Add your Composio API key in
					Gateway → API keys, then your available integrations appear here.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onOpenKeys} size="sm">
					Open Gateway keys
				</Button>
			</EmptyContent>
		</Empty>
	);
}

/** Connected / pending / nothing — extracted so the card avoids a nested ternary. */
function ConnectionStatusBadge({
	connected,
	pending,
}: {
	connected: boolean;
	pending: boolean;
}) {
	if (connected) {
		return (
			<Badge className="gap-1" variant="secondary">
				<span className="size-1.5 rounded-full bg-success" />
				Connected
			</Badge>
		);
	}
	if (pending) {
		return <Badge variant="outline">Pending…</Badge>;
	}
	return null;
}

function ToolkitCard({
	toolkit,
	connection,
}: {
	toolkit: ComposioToolkit;
	connection: ComposioConnection | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
	const initiate = useInitiateComposioConnection();
	const isConnected = connection?.active ?? false;
	const isPending = Boolean(connection) && !isConnected;

	const handleConnect = async (accessLevel: ConnectionAccessLevel) => {
		const result = await initiate.mutateAsync({
			accessLevel,
			toolkit: toolkit.slug,
		});
		if (!result.redirectUrl) {
			throw new Error("Composio did not return a connect link.");
		}
		await openExternal(result.redirectUrl);
		sileo.success({
			title: `Connecting ${toolkit.name}…`,
			description:
				"Authorize in your browser. The connection turns active here when you return.",
		});
	};

	return (
		<div className="rounded-lg bg-card p-4">
			<div className="flex items-start gap-3">
				<ToolkitLogo toolkit={toolkit} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium text-sm">{toolkit.name}</span>
						<ConnectionStatusBadge
							connected={isConnected}
							pending={isPending}
						/>
					</div>
					<Badge className="mt-1 w-fit" variant="outline">
						Access: {accessLevelSummary(connection?.accessLevel)}
					</Badge>
					{toolkit.description ? (
						<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
							{toolkit.description}
						</p>
					) : null}
				</div>
			</div>

			<div className="mt-3 flex items-center justify-between">
				<Button
					onClick={() => setExpanded((v) => !v)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className={`mr-1 size-3.5 transition-transform ${
							expanded ? "rotate-90" : ""
						}`}
						icon={ArrowRight01Icon}
					/>
					{expanded ? "Hide tools" : "View tools"}
				</Button>

				<Button
					disabled={permissionDialogOpen}
					loading={initiate.isPending}
					onClick={() => setPermissionDialogOpen(true)}
					size="sm"
					variant={isConnected ? "outline" : "default"}
				>
					{!initiate.isPending && (
						<HugeiconsIcon className="mr-1.5 size-3.5" icon={Link01Icon} />
					)}
					{isConnected ? "Reconnect" : "Connect"}
				</Button>
			</div>

			{expanded ? <ToolkitTools toolkit={toolkit.slug} /> : null}
			<ConnectionPermissionDialog
				connectionName={toolkit.name}
				connectionType="Composio"
				currentLevel={connection?.accessLevel}
				onConfirm={handleConnect}
				onOpenChange={setPermissionDialogOpen}
				open={permissionDialogOpen}
			/>
		</div>
	);
}

function ToolkitLogo({ toolkit }: { toolkit: ComposioToolkit }) {
	if (toolkit.logo) {
		return (
			// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; logo is a remote Composio URL
			// biome-ignore lint/correctness/useImageSize: sized via the `size-9` class, dimensions are fixed
			<img
				alt={`${toolkit.name} logo`}
				className="size-9 shrink-0 rounded-md bg-background object-contain p-1"
				draggable={false}
				src={toolkit.logo}
			/>
		);
	}
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
			<HugeiconsIcon
				className="size-4 text-muted-foreground"
				icon={PlugSocketIcon}
			/>
		</div>
	);
}

function ToolkitTools({ toolkit }: { toolkit: string }) {
	const actions = useComposioActions(toolkit);
	const triggers = useComposioTriggers(toolkit);

	return (
		<div className="mt-3 space-y-3 border-t pt-3">
			<ToolSection
				emptyLabel="No tools listed for this integration."
				error={actions.error as Error | null}
				items={(actions.data ?? []).map((a) => ({
					id: a.name,
					label: a.displayName,
					description: a.description,
				}))}
				loading={actions.isLoading}
				title="Tools"
			/>
			{triggers.data && triggers.data.length > 0 ? (
				<ToolSection
					emptyLabel="No triggers for this integration."
					error={triggers.error as Error | null}
					items={triggers.data.map((t) => ({
						id: t.name,
						label: t.displayName,
						description: t.description,
					}))}
					loading={triggers.isLoading}
					title="Triggers"
				/>
			) : null}
		</div>
	);
}

interface ToolSectionItem {
	description: string | null;
	id: string;
	label: string;
}

/** Renders one labelled list (Tools or Triggers); body via early returns. */
function ToolSectionBody({
	items,
	loading,
	error,
	emptyLabel,
}: {
	items: ToolSectionItem[];
	loading: boolean;
	error: Error | null;
	emptyLabel: string;
}) {
	if (loading) {
		return <Spinner className="size-4" />;
	}
	if (error) {
		return <p className="text-destructive text-xs">{error.message}</p>;
	}
	if (items.length === 0) {
		return <p className="text-muted-foreground text-xs">{emptyLabel}</p>;
	}
	return (
		<ul className="scroll-fade max-h-48 space-y-1 overflow-auto">
			{items.map((item) => (
				<li
					className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
					key={item.id}
				>
					<span className="font-medium">{item.label}</span>
					{item.description ? (
						<span className="block truncate text-muted-foreground">
							{item.description}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

function ToolSection({
	title,
	items,
	loading,
	error,
	emptyLabel,
}: {
	title: string;
	items: ToolSectionItem[];
	loading: boolean;
	error: Error | null;
	emptyLabel: string;
}) {
	return (
		<div>
			<p className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title}
			</p>
			<ToolSectionBody
				emptyLabel={emptyLabel}
				error={error}
				items={items}
				loading={loading}
			/>
		</div>
	);
}
