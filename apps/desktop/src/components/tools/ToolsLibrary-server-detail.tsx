import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { OAuthServerCard } from "@/src/components/marketplace/ConnectionsTab.tsx";
import type {
	McpServer,
	McpTool,
	UpdateMcpServerInput,
} from "@/src/lib/api/mcp.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import { McpServerSettingsDialog } from "./ToolsLibrary-server-settings-dialog.tsx";

export function ServerDetail({
	apps,
	deleteServer,
	onUpdateServer,
	profileIds,
	server,
	tools,
	toolsStatus,
}: {
	apps: AppInfo[];
	deleteServer: (name: string) => Promise<{ error?: string; ok: boolean }>;
	onUpdateServer: (
		name: string,
		input: UpdateMcpServerInput
	) => Promise<{ error?: string; ok: boolean; server?: McpServer }>;
	profileIds: string[];
	server: McpServer;
	tools: McpTool[];
	toolsStatus: string | null;
}) {
	const tl = useLiteralMessages();
	return (
		<ListingDetailShell
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Transport", value: server.transport ?? "Built-in" },
							{
								label: server.url ? "Endpoint" : "Command",
								value: server.url ?? server.command,
							},
							{
								label: "State",
								value: server.enabled ? "Enabled" : "Disabled",
							},
							{
								label: "Installed",
								value: server.available === false ? "No" : "Yes",
							},
							{ label: "Tools", value: toolsStatus ?? `${tools.length}` },
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[
						server.available === false
							? "Not installed"
							: server.enabled
								? null
								: "Disabled",
					].filter((b): b is string => Boolean(b))}
					icon={<HugeiconsIcon className="size-8" icon={ServerStack01Icon} />}
					name={server.name}
					tagline={server.description ?? "MCP server"}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{
							label: "Tools",
							sub: tools.length === 1 ? "tool" : "tools",
							value: toolsStatus ? "—" : `${tools.length}`,
						},
						{
							label: "State",
							value: server.enabled ? "Enabled" : "Disabled",
						},
						{
							label: "Installed",
							value: server.available === false ? "No" : "Yes",
						},
					]}
				/>
			}
		>
			<ListingSection title="About">
				<p className="text-pretty text-muted-foreground text-sm">
					{server.description ?? "No description provided."}
				</p>
			</ListingSection>

			<ListingSection title="Authentication">
				<McpAuthentication
					apps={apps}
					profileIds={profileIds}
					server={server}
				/>
			</ListingSection>

			{server.envKeys.length > 0 || server.headerNames.length > 0 ? (
				<ListingSection title="Configuration">
					<div className="flex flex-col gap-2 text-muted-foreground text-sm">
						{server.envKeys.length > 0 ? (
							<p>
								{tl("Environment variables: {keys}", {
									keys: server.envKeys.join(", "),
								})}
							</p>
						) : null}
						{server.headerNames.length > 0 ? (
							<p>
								{tl("Request headers: {names}", {
									names: server.headerNames.join(", "),
								})}
							</p>
						) : null}
					</div>
				</ListingSection>
			) : null}

			<ListingSection title={server.url ? "Endpoint" : "Command"}>
				<code className="block overflow-x-auto whitespace-pre rounded-lg bg-muted px-2 py-1.5 font-mono text-muted-foreground text-xs">
					{server.url ?? [server.command, ...server.args].join(" ")}
				</code>
			</ListingSection>

			{tools.length > 0 ? (
				<ListingSection
					title={tl("Tools ({count})", { count: String(tools.length) })}
				>
					{/* A flush list: one hairline per row, no per-tool box. */}
					<ul className="flex flex-col">
						{tools.map((tool) => (
							<li
								className="flex min-h-10 min-w-0 items-baseline gap-3 border-border border-b py-2 text-sm last:border-b-0"
								key={tool.id}
							>
								<div
									className="shrink-0 truncate font-mono text-xs"
									title={tool.name}
								>
									{tool.name}
								</div>
								{tool.description ? (
									<div
										className="min-w-0 truncate text-detail text-muted-foreground"
										title={tool.description}
									>
										{tool.description}
									</div>
								) : null}
							</li>
						))}
					</ul>
				</ListingSection>
			) : null}

			{server.ownerPluginId === null && server.transport !== null ? (
				<ListingSection title="Server settings">
					<McpServerSettingsDialog
						deleteServer={deleteServer}
						onUpdateServer={onUpdateServer}
						server={server}
					/>
				</ListingSection>
			) : null}
		</ListingDetailShell>
	);
}

export function McpAuthentication({
	apps,
	profileIds,
	server,
}: {
	apps: AppInfo[];
	profileIds: string[];
	server: McpServer;
}) {
	if (!server.authRequired) {
		return (
			<p className="text-muted-foreground text-sm">
				No authentication required.
			</p>
		);
	}

	if (server.authType === "oauth" && server.ownerPluginId) {
		const app = apps.find((candidate) => candidate.id === server.ownerPluginId);
		const declaration = app?.mcpOAuthServers.find(
			(candidate) => candidate.name === (server.ownerServerName ?? server.name)
		);
		if (app && declaration) {
			return (
				<OAuthServerCard
					app={app}
					profileIds={profileIds}
					server={declaration}
				/>
			);
		}
	}

	return (
		<div className="flex flex-col gap-1">
			{server.authConfigured ? (
				<p className="text-sm">Credentials configured</p>
			) : (
				<Badge className="w-fit" variant="outline">
					Authentication required
				</Badge>
			)}
			<p className="text-detail text-muted-foreground">
				{server.authType === "oauth"
					? "Connect the account in Marketplace → Connections."
					: server.authType === "env"
						? "Set the credential variable in Server settings. Values stay on the node."
						: "Set the credential header in Server settings. Values stay on the node."}
			</p>
		</div>
	);
}
