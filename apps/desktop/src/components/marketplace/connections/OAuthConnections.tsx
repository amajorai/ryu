import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	accessLevelSummary,
	ConnectionPermissionDialog,
} from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import {
	useConnectMcpOAuth,
	useDisconnectMcpOAuth,
	useMcpOAuthConnections,
	useMcpOAuthFlow,
} from "@/src/hooks/useMcpOAuth.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import type {
	AppInfo,
	McpOAuthServerDeclaration,
} from "@/src/lib/api/plugins.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { ConnectionStatusBadge } from "./ToolkitResults.tsx";

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
		return <SkeletonRows />;
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
	const tl = useLiteralMessages();
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
	const failedTitle = tl("{name} connection failed", { name: app.name });

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
				title: failedTitle,
			});
		}
	}, [app.name, failedTitle, flow.data, flowId, status.refetch]);

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
				title:
					error instanceof ApiError
						? (error.serverMessage ?? error.message)
						: error instanceof Error
							? error.message
							: "Could not disconnect.",
			});
		}
	};

	return (
		<article className="rounded-lg bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate font-medium text-sm" title={app.name}>
						{app.name}
					</p>
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
					aria-label={tl("{name} identity profile", { name: app.name })}
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
					{tl("Scopes: {scopes}", { scopes: connection.scopes.join(", ") })}
				</p>
			) : null}
			<Badge className="mt-2 w-fit" variant="outline">
				{tl("Access: {level}", {
					level: accessLevelSummary(connection?.accessLevel),
				})}
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
