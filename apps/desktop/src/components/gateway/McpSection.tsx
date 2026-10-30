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
// An inventory + status view with one write: each user-owned server's
// enabled switch. Adding/removing servers and editing per-agent allowlists is
// the Tools page in the app (see `@ryu/blocks` Tools surface).

import { Refresh01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useState } from "react";
import { CaptionInfo, StatusText } from "@/src/components/gateway/quiet.tsx";
import {
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
	type McpTransport,
	updateMcpServer,
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

const MCP_TRANSPORTS: readonly McpTransport[] = [
	"stdio",
	"streamable-http",
	"sse",
];

function isMcpTransport(value: string | null): value is McpTransport {
	return MCP_TRANSPORTS.includes(value as McpTransport);
}

function McpEmpty({ children }: { children: string }) {
	return <p className="py-3 text-muted-foreground text-sm">{children}</p>;
}

function ServersList({
	servers,
	loading,
	error,
	onRetry,
	onToggle,
	pending,
}: {
	error: string | null;
	loading: boolean;
	onRetry: () => void;
	onToggle: (server: McpServer, enabled: boolean) => void;
	pending: ReadonlySet<string>;
	servers: McpServer[];
}) {
	if (loading) {
		return <SkeletonRows label="Loading…" spacing="panel" />;
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
						<div className="flex items-center gap-3">
							{s.available === false ? (
								<StatusText tone="destructive">Missing</StatusText>
							) : null}
							<McpAuthStatus server={s} />
							<Switch
								aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
								checked={s.enabled}
								disabled={s.ownerPluginId !== null || pending.has(s.name)}
								onCheckedChange={(checked) => onToggle(s, checked)}
							/>
						</div>
					}
					description={
						<span className="block max-w-full truncate">
							{s.transport ? `${s.transport} · ` : ""}
							<span className="font-mono text-xs">
								{s.url ?? s.command}
								{!s.url && s.args.length > 0 ? ` ${s.args.join(" ")}` : ""}
							</span>
						</span>
					}
					key={s.name}
					title={s.name}
				/>
			))}
		</SettingsGroup>
	);
}

/**
 * Auth only speaks up when it needs attention. "No auth", "OAuth" and stored
 * credentials are normal states and render nothing.
 */
function McpAuthStatus({ server }: { server: McpServer }) {
	if (
		!server.authRequired ||
		server.authType === "oauth" ||
		server.authConfigured
	) {
		return null;
	}
	return <StatusText tone="warning">Needs credentials</StatusText>;
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
		return <SkeletonRows label="Loading…" spacing="panel" />;
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
				<SettingsItem
					description={
						<span className="font-mono text-xs">
							{/* One element per tool so each name stays findable on its own. */}
							{list.map((t, index) => (
								<span key={t.id}>
									{index > 0 ? ", " : ""}
									<span>{t.name}</span>
								</span>
							))}
						</span>
					}
					key={server}
					title={server}
				/>
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
	const reloadQuietly = () =>
		Promise.all([fetchMcpServers(target), fetchMcpTools(target)]).then(
			([nextServers, nextTools]) => {
				setServers(nextServers);
				setTools(nextTools);
			},
			() => undefined
		);

	// Enable/disable writes through Core and reloads its registry. The row
	// flips optimistically and reverts with one plain sentence on failure.
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const toggleServer = (server: McpServer, enabled: boolean) => {
		const flip = (value: boolean) =>
			setServers((list) =>
				list.map((s) => (s.name === server.name ? { ...s, enabled: value } : s))
			);
		const settle = () =>
			setPending((current) => {
				const next = new Set(current);
				next.delete(server.name);
				return next;
			});
		flip(enabled);
		setPending((current) => new Set(current).add(server.name));
		updateMcpServer(target, server.name, {
			enabled,
			// Core rewrites the transport on every update; send the current one so
			// a toggle never turns a legacy SSE server into Streamable HTTP.
			...(isMcpTransport(server.transport)
				? { transport: server.transport }
				: {}),
		})
			.then((result) => {
				if (!result.ok) {
					throw new Error(result.error ?? "update refused");
				}
				// Re-read quietly: the switch keeps focus and the list never drops
				// to a skeleton, but the tools list picks up the change.
				return reloadQuietly();
			})
			.catch((cause: unknown) => {
				flip(!enabled);
				const notOwned =
					cause instanceof Error &&
					cause.message.includes("not user-configured");
				toast.error({
					title: `Couldn't ${enabled ? "enable" : "disable"} ${server.name}`,
					description: notOwned
						? "Only servers you added can be switched here."
						: "Check that Core is running, then try again.",
				});
			})
			.finally(settle);
	};

	return (
		<div>
			{/* An iOS-style search field above the lists it filters, not a toolbar
			    squeezed into a section header. */}
			<InputGroup className="mb-6 w-full">
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
				caption={
					<CaptionInfo
						detail={
							"A host (Claude Desktop, Cursor, …) that connects to Ryu can call the tools below through the same governance as everything else."
						}
					>
						{
							"The MCP servers this node exposes to hosts like Claude Desktop or Cursor."
						}
					</CaptionInfo>
				}
				headerAction={
					<Button
						aria-label={
							loading ? "Refreshing MCP inventory" : "Refresh MCP inventory"
						}
						disabled={loading}
						onClick={refresh}
						size="icon-sm"
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
					onToggle={toggleServer}
					pending={pending}
					servers={filteredServers}
				/>
			</SettingsSection>

			<SettingsSection
				caption="Tools from enabled servers. Per-agent allowlists live on the Tools page."
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
