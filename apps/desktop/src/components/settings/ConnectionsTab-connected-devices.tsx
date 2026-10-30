import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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
import { RowTitle } from "./ConnectionsTab-row-title.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

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
