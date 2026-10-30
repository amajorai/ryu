// The Tools section of the unified Library (`/tools`, `/library/tools`) — the MCP
// servers registered on the active node and the tools they expose.
//
// It used to live in the Store, which was the wrong shelf: the Store is where you
// FIND things to add, and this surface manages and invokes what is already
// installed (browse the catalog under Store → MCP). Alongside Agents, Workflows and
// Spaces in the Library, "the tools my agents can call" reads as another collection
// you own.
//
// Organisation is by SERVER, not one flat list. Previously the page rendered two
// undifferentiated lumps — every server, then every tool from every server mixed
// together — so with a handful of servers registered there was no way to see which
// tools came from where, or that a group of tools was dark because its server was
// disabled. A tool's server is the fact that decides whether it can run at all, so
// it is the axis worth grouping on: each server is a collapsible group carrying its
// own status and tool count, and its tools sit under it.
//
// Searching flattens the view on purpose: a query means "find me this tool", and
// matches must not hide inside a group the user has to guess at. The flat A–Z view
// stays available for the same reason.
//
// This is the desktop presentation. The @ryu/blocks `ToolsView` (used by the
// storyboard) is intentionally NOT reused here: store-catalog-layout imports from
// @ryu/blocks, so a blocks→marketplace dependency would be circular. The trade-off
// is that this view no longer shares its markup with the storyboard block.

import { ServerStack01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import StoreCatalogLayout from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useMemo, useState } from "react";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import type { McpServer, McpTool } from "@/src/lib/api/mcp.ts";
import { AddServerDialog } from "./ToolsLibrary-add-server-dialog.tsx";
import {
	FlatToolList,
	type ServerGroup,
	ServerToolGroup,
	ToolCards,
	ToolGroupShell,
} from "./ToolsLibrary-groups.tsx";
import { ServerDetail } from "./ToolsLibrary-server-detail.tsx";
import { ToolDetail } from "./ToolsLibrary-tool-detail.tsx";

const ALL_AGENTS = "__all__";

/** How the tool list is arranged. "server" groups every tool under the server that
 *  advertises it (the default, since the server decides whether the tool can run);
 *  "flat" is one A–Z list across all servers, for when you know the tool's name. */
type ToolsView = "server" | "flat";

/** Tools whose `server` matches no registered server.
 *
 *  This is not a theoretical case: a server can be removed from `mcp.json` while
 *  its tools are still in the live snapshot, and Core also exposes some tools that
 *  are not backed by a user-registered entry. Those tools used to vanish from the
 *  page the moment grouping was introduced — they belong to no group — so they get
 *  an explicit one instead of being silently dropped. */
const UNGROUPED_LABEL = "Other tools";

export default function ToolsLibrary() {
	const {
		servers,
		tools,
		agents,
		agentFilter,
		setAgentFilter,
		serversLoading: loading,
		serversError: error,
		toolsLoading,
		toolsError,
		callTool,
		createServer,
		deleteServer,
		reload,
		updateServer,
	} = useMcp();
	const { apps } = useApps();
	const identities = useIdentities();
	const profileIds = Array.from(
		new Set(["personal", ...identities.profileIds])
	).sort();

	const [query, setQuery] = useState("");
	const [view, setView] = useState<ToolsView>("server");
	// Selection id is namespaced: `server:<name>` or `tool:<id>`.
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matchServer = (s: McpServer) =>
			!q ||
			s.name.toLowerCase().includes(q) ||
			(s.description ?? "").toLowerCase().includes(q);
		const matchTool = (t: McpTool) =>
			!q ||
			t.name.toLowerCase().includes(q) ||
			t.server.toLowerCase().includes(q) ||
			(t.description ?? "").toLowerCase().includes(q);
		return {
			servers: servers.filter(matchServer),
			tools: tools.filter(matchTool),
		};
	}, [servers, tools, query]);

	// Group the filtered tools by server. A server matched by the query keeps its
	// group even when none of its own tools matched (searching "github" should show
	// the github server), and a server whose tools matched is kept even if its name
	// did not — so a match on either side of the relation surfaces the pair.
	const groups = useMemo<ServerGroup[]>(() => {
		const byServer = new Map<string, McpTool[]>();
		for (const tool of filtered.tools) {
			const list = byServer.get(tool.server);
			if (list) {
				list.push(tool);
			} else {
				byServer.set(tool.server, [tool]);
			}
		}
		const matchedServerNames = new Set(filtered.servers.map((s) => s.name));
		return (
			servers
				.filter((s) => matchedServerNames.has(s.name) || byServer.has(s.name))
				// Enabled first, then unavailable last, then by name — the order the
				// user cares about when scanning for "what can actually run".
				.sort((a, b) => {
					if (a.enabled !== b.enabled) {
						return a.enabled ? -1 : 1;
					}
					const aOff = a.available === false;
					const bOff = b.available === false;
					if (aOff !== bOff) {
						return aOff ? 1 : -1;
					}
					return a.name.localeCompare(b.name);
				})
				.map((server) => ({
					server,
					tools: (byServer.get(server.name) ?? []).sort((a, b) =>
						a.name.localeCompare(b.name)
					),
				}))
		);
	}, [servers, filtered]);

	// Tools with no registered server — see UNGROUPED_LABEL.
	const ungrouped = useMemo(() => {
		const known = new Set(servers.map((s) => s.name));
		return filtered.tools
			.filter((t) => !known.has(t.server))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [servers, filtered.tools]);

	const flatTools = useMemo(
		() => [...filtered.tools].sort((a, b) => a.name.localeCompare(b.name)),
		[filtered.tools]
	);

	// A query means "find this tool" — grouping would hide matches behind headers,
	// so searching always flattens regardless of the chosen view.
	const searching = query.trim().length > 0;
	const effectiveView: ToolsView = searching ? "flat" : view;

	const selectedServer =
		selectedId?.startsWith("server:") === true
			? (servers.find((s) => `server:${s.name}` === selectedId) ?? null)
			: null;
	const selectedTool =
		selectedId?.startsWith("tool:") === true
			? (tools.find((t) => `tool:${t.id}` === selectedId) ?? null)
			: null;

	if (loading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	if (error) {
		return (
			<QuietEmpty
				action={
					<Button
						onClick={() => reload().catch(() => undefined)}
						size="sm"
						variant="outline"
					>
						Try again
					</Button>
				}
				className="h-full"
				description="Check your connection and try again."
				icon={Wrench01Icon}
				title="Could not load tools"
			/>
		);
	}

	const toolsStatus = toolsLoading
		? "Loading tools…"
		: toolsError
			? "Tool discovery failed. Refresh to try again."
			: null;
	const hasNothing = servers.length === 0 && tools.length === 0 && !toolsStatus;

	return (
		<StoreCatalogLayout
			detail={
				selectedServer ? (
					<ServerDetail
						apps={apps}
						deleteServer={deleteServer}
						onUpdateServer={updateServer}
						profileIds={profileIds}
						server={selectedServer}
						tools={tools.filter((t) => t.server === selectedServer.name)}
						toolsStatus={toolsStatus}
					/>
				) : selectedTool ? (
					<ToolDetail
						agents={agents}
						onCallTool={callTool}
						tool={selectedTool}
					/>
				) : null
			}
			detailTitle={selectedServer?.name ?? selectedTool?.name ?? "Tool"}
			filter={{
				// The allowlist is a real filter on what is shown, so it gets the
				// active-count badge — an agent filter left on is otherwise invisible
				// and reads as "this agent has no tools".
				activeCount: agentFilter ? 1 : 0,
				label: "Filter & add",
				panel: (
					<div className="flex flex-col gap-4 p-4">
						<div className="flex flex-col gap-1.5">
							<Label size="compact" tone="muted">
								Arrange
							</Label>
							<ToggleGroup
								onValueChange={(value: string[]) => {
									const next = value[0];
									if (next === "server" || next === "flat") {
										setView(next);
									}
								}}
								size="sm"
								value={[view]}
								variant="outline"
							>
								<ToggleGroupItem value="server">By server</ToggleGroupItem>
								<ToggleGroupItem value="flat">All tools A–Z</ToggleGroupItem>
							</ToggleGroup>
							{searching ? (
								<p className="text-detail text-muted-foreground">
									Search results are always shown as one flat list.
								</p>
							) : null}
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-filter" size="compact" tone="muted">
								Allowlist
							</Label>
							<Select
								items={[
									{ value: ALL_AGENTS, label: "All tools" },
									...agents.map((a) => ({ value: a.id, label: a.name })),
								]}
								onValueChange={(v) =>
									setAgentFilter(!v || v === ALL_AGENTS ? null : v)
								}
								value={agentFilter ?? ALL_AGENTS}
							>
								<SelectTrigger className="w-full" id="agent-filter" size="sm">
									<SelectValue placeholder="All tools" />
								</SelectTrigger>
								<SelectContent alignItemWithTrigger={false}>
									<SelectItem value={ALL_AGENTS}>All tools</SelectItem>
									{agents.map((agent) => (
										<SelectItem key={agent.id} value={agent.id}>
											{agent.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-detail text-muted-foreground">
								Show only the tools one agent is allowed to call.
							</p>
						</div>
						<AddServerDialog onCreateServer={createServer} />
					</div>
				),
			}}
			hasSelection={selectedServer != null || selectedTool != null}
			list={
				<>
					{toolsStatus && (
						<div
							className="flex items-center gap-2 p-3 text-muted-foreground text-sm"
							role={toolsError ? "alert" : "status"}
						>
							{toolsLoading && <Spinner className="size-4" />}
							<span>{toolsStatus}</span>
							{toolsError && (
								<Button
									onClick={() => void reload().catch(() => undefined)}
									size="sm"
									variant="outline"
								>
									Refresh tools
								</Button>
							)}
						</div>
					)}
					{hasNothing ? (
						<QuietEmpty
							action={<AddServerDialog onCreateServer={createServer} />}
							description="Add a server to give your agents new tools."
							icon={ServerStack01Icon}
							title="No MCP servers registered"
						/>
					) : effectiveView === "flat" ? (
						toolsStatus && tools.length === 0 ? null : (
							<FlatToolList
								agentFilter={agentFilter}
								onClearFilters={() => {
									setAgentFilter(null);
									setQuery("");
									setView("server");
								}}
								onSelect={setSelectedId}
								searching={searching}
								selectedId={selectedId}
								tools={flatTools}
							/>
						)
					) : (
						<div className="flex flex-col gap-6 pt-2">
							{groups.map((group) => (
								<ServerToolGroup
									allowlisted={agentFilter !== null}
									group={group}
									key={group.server.name}
									onSelect={setSelectedId}
									selectedId={selectedId}
									toolsStatus={toolsStatus}
								/>
							))}
							{ungrouped.length > 0 ? (
								<ToolGroupShell
									count={ungrouped.length}
									label={UNGROUPED_LABEL}
									note="Advertised by a server that is no longer registered."
								>
									<ToolCards
										onSelect={setSelectedId}
										selectedId={selectedId}
										tools={ungrouped}
									/>
								</ToolGroupShell>
							) : null}
						</div>
					)}
				</>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search servers and tools…",
			}}
		/>
	);
}
