// apps/desktop/src/components/gateway/McpSection.tsx
//
// The Gateway "MCP" surface — the Ryu MCP server layer. Two blocks:
//
//  1. Servers — every MCP server Core has registered (`/api/mcp/servers`), with
//     its transport and command/endpoint, enabled state, and availability.
//  2. Tools — every tool the registered servers advertise (`/api/mcp/tools`),
//     grouped by server, so you can see what a host (Claude Desktop, Cursor)
//     can reach through this node.
//
// This is a READ-ONLY inventory + status view — the mechanism for adding/
// removing servers and editing per-agent allowlists is the Tools page in the
// app (see `@ryu/blocks` Tools surface). Management links out from here.

import { Refresh01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchMcpServers,
	fetchMcpTools,
	type McpServer,
	type McpTool,
} from "@/src/lib/api/mcp.ts";
import { SettingsNotice } from "./SettingsNotice.tsx";

// Load failures read as one plain sentence; the request summary stays as a
// muted second line so it can still be matched against Core logs.
function McpLoadError({
	error,
	onRetry,
	subject,
}: {
	error: string;
	onRetry: () => void;
	subject: string;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsNotice
			action={
				<Button onClick={onRetry} size="sm" variant="outline">
					Retry
				</Button>
			}
			role="alert"
			secondary={error}
		>
			{tl("Couldn’t load {subject}.", { subject })}
		</SettingsNotice>
	);
}

function McpEmpty({ children }: { children: string }) {
	return (
		<SettingsCard>
			<p className="text-center text-muted-foreground text-sm">{children}</p>
		</SettingsCard>
	);
}

function ServersList({
	servers,
	loading,
	error,
	onRetry,
}: {
	error: string | null;
	loading: boolean;
	onRetry: () => void;
	servers: McpServer[];
}) {
	if (loading) {
		return (
			<SettingsCard>
				<SkeletonRows label="Loading…" spacing="panel" />
			</SettingsCard>
		);
	}
	if (error) {
		return (
			<McpLoadError error={error} onRetry={onRetry} subject="MCP servers" />
		);
	}
	if (servers.length === 0) {
		return (
			<McpEmpty>
				No MCP servers registered. Add one from the Tools page.
			</McpEmpty>
		);
	}
	return (
		<SettingsGroup>
			{servers.map((s) => (
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							{s.transport ? (
								<Badge variant="secondary">{s.transport}</Badge>
							) : null}
							<McpAuthStatus server={s} />
							{s.enabled ? (
								<Badge variant="default">enabled</Badge>
							) : (
								<Badge variant="secondary">disabled</Badge>
							)}
							{s.available === false ? (
								<Badge variant="destructive">missing</Badge>
							) : null}
						</div>
					}
					description={
						<span className="block max-w-full truncate font-mono text-xs">
							{s.url ?? s.command}
							{!s.url && s.args.length > 0 ? ` ${s.args.join(" ")}` : ""}
						</span>
					}
					key={s.name}
					title={s.name}
				/>
			))}
		</SettingsGroup>
	);
}

function McpAuthStatus({ server }: { server: McpServer }) {
	if (!server.authRequired) {
		return <Badge variant="outline">no auth</Badge>;
	}
	if (server.authType === "oauth") {
		return <Badge variant="outline">OAuth</Badge>;
	}
	return (
		<Badge variant={server.authConfigured ? "default" : "destructive"}>
			{server.authConfigured ? "credentials set" : "auth required"}
		</Badge>
	);
}

function ToolsList({
	servers,
	tools,
	loading,
	error,
	onRetry,
}: {
	error: string | null;
	loading: boolean;
	onRetry: () => void;
	servers: McpServer[];
	tools: McpTool[];
}) {
	const byServer = new Map<string, McpTool[]>();
	for (const t of tools) {
		const list = byServer.get(t.server) ?? [];
		list.push(t);
		byServer.set(t.server, list);
	}
	const enabled = new Set(servers.filter((s) => s.enabled).map((s) => s.name));
	const visible = [...byServer.entries()].filter(([server]) =>
		enabled.has(server)
	);

	if (loading) {
		return (
			<SettingsCard>
				<SkeletonRows label="Loading…" spacing="panel" />
			</SettingsCard>
		);
	}
	if (error) {
		return <McpLoadError error={error} onRetry={onRetry} subject="MCP tools" />;
	}
	if (tools.length === 0) {
		return (
			<McpEmpty>No tools advertised by the registered servers yet.</McpEmpty>
		);
	}
	if (visible.length === 0) {
		return <McpEmpty>No enabled servers advertise tools.</McpEmpty>;
	}
	return (
		<SettingsGroup>
			{visible.map(([server, list]) => (
				<SettingsItem key={server} title={server}>
					<div className="flex flex-wrap gap-1.5">
						{list.map((t) => (
							<Badge key={t.id} typography="code" variant="secondary">
								{t.name}
							</Badge>
						))}
					</div>
				</SettingsItem>
			))}
		</SettingsGroup>
	);
}

export function McpSection({ target }: { target: ApiTarget }) {
	const [servers, setServers] = useState<McpServer[]>([]);
	const [tools, setTools] = useState<McpTool[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [refreshKey, setRefreshKey] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		Promise.all([fetchMcpServers(target), fetchMcpTools(target)])
			.then(([s, t]) => {
				if (!cancelled) {
					setServers(s);
					setTools(t);
					setError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setError(
						e instanceof Error ? e.message : "Failed to load MCP servers"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey, target]);
	const needle = query.trim().toLowerCase();
	const filteredServers = servers.filter((server) =>
		server.name.toLowerCase().includes(needle)
	);
	const filteredTools = tools.filter((tool) =>
		[tool.name, tool.server, tool.id].some((value) =>
			value.toLowerCase().includes(needle)
		)
	);

	const refresh = () => setRefreshKey((current) => current + 1);

	return (
		<div className="flex flex-col gap-6">
			{/* An iOS-style search field above the lists it filters, not a toolbar
			    squeezed into a section header. */}
			<InputGroup className="w-full">
				<InputGroupAddon>
					<HugeiconsIcon className="size-4" icon={Search01Icon} />
				</InputGroupAddon>
				<InputGroupInput
					aria-label="Search MCP servers and tools"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search servers and tools…"
					value={query}
				/>
			</InputGroup>
			<SettingsSection
				caption="The MCP servers this node exposes. A host (Claude Desktop, Cursor, …) that connects to Ryu can call the tools below through the same governance as everything else."
				headerAction={
					<Button
						aria-label={
							loading ? "Refreshing MCP inventory" : "Refresh MCP inventory"
						}
						disabled={loading}
						onClick={refresh}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden
							className={cn("size-4", loading && "animate-spin")}
							icon={Refresh01Icon}
						/>
					</Button>
				}
				title="MCP servers"
			>
				<ServersList
					error={error}
					loading={loading}
					onRetry={refresh}
					servers={filteredServers}
				/>
			</SettingsSection>

			<SettingsSection
				caption="Tools advertised by enabled servers, grouped by server. Per-agent allowlists are managed on the Tools page."
				title="Available tools"
			>
				<ToolsList
					error={error}
					loading={loading}
					onRetry={refresh}
					servers={servers}
					tools={filteredTools}
				/>
			</SettingsSection>
		</div>
	);
}
