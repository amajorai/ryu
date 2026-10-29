import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
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

import {
	Add01Icon,
	AlertCircleIcon,
	ArrowDown01Icon,
	ClipboardIcon,
	ComputerTerminal01Icon,
	Delete01Icon,
	ServerStack01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { ContextMenuItem } from "@ryu/ui/components/context-menu.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	type ChangeEvent,
	type Dispatch,
	type SetStateAction,
	useMemo,
	useState,
} from "react";
import { OAuthServerCard } from "@/src/components/marketplace/ConnectionsTab.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import type {
	CreateMcpServerInput,
	CreateMcpServerResult,
	McpCallResult,
	McpServer,
	McpTool,
	McpTransport,
	UpdateMcpServerInput,
} from "@/src/lib/api/mcp.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";

const ALL_AGENTS = "__all__";

/** How the tool list is arranged. "server" groups every tool under the server that
 *  advertises it (the default, since the server decides whether the tool can run);
 *  "flat" is one A–Z list across all servers, for when you know the tool's name. */
type ToolsView = "server" | "flat";

/** A server together with the tools it advertises, after search filtering. */
interface ServerGroup {
	server: McpServer;
	tools: McpTool[];
}

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
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Wrench01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not load tools</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading your tools. Check your connection
						and try again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => reload().catch(() => undefined)}
						size="sm"
						variant="ghost"
					>
						Try again
					</Button>
				</EmptyContent>
			</Empty>
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
								<p className="text-muted-foreground text-xs">
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
							<p className="text-muted-foreground text-xs">
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
						<Empty inset="compact">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={ServerStack01Icon} />
								</EmptyMedia>
								<EmptyTitle>No MCP servers registered</EmptyTitle>
								<EmptyDescription>
									Add a server to give your agents new tools, or browse the MCP
									catalog in the Store.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<AddServerDialog onCreateServer={createServer} />
							</EmptyContent>
						</Empty>
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
						<div className="flex flex-col gap-4 pt-2">
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

/** One server and its tools: a clickable header row (opens the server detail) over
 *  the server's tool cards, collapsible so a node with many servers stays scannable. */
function ServerToolGroup({
	group,
	onSelect,
	selectedId,
	allowlisted,
	toolsStatus,
}: {
	group: ServerGroup;
	toolsStatus: string | null;
	onSelect: (id: string) => void;
	selectedId: string | null;
	/** An agent allowlist filter is active, so an empty group means "none of this
	 *  server's tools are allowed for that agent" — NOT "this server has no tools".
	 *  Without this the page would assert something false about the server. */
	allowlisted: boolean;
}) {
	const { server, tools } = group;
	const unavailable = server.available === false;
	// Controlled rather than `defaultOpen` so the chevron rotation can be driven
	// off the same state — the pattern the settings accordions already use.
	const [open, setOpen] = useState(true);
	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<div className="flex items-center gap-2 px-1">
				<CollapsibleTrigger appearance="tools-server">
					<HugeiconsIcon
						className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
						icon={ArrowDown01Icon}
					/>
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={ServerStack01Icon}
					/>
					<span
						className="min-w-0 truncate font-medium text-sm"
						title={server.name}
					>
						{server.name}
					</span>
					<Badge variant="secondary">
						{toolsStatus ? "—" : (formatCount(tools.length) ?? "—")}
					</Badge>
					<McpAuthBadge server={server} />
					{server.enabled ? null : <Badge variant="outline">Disabled</Badge>}
					{unavailable ? (
						<Badge variant="outline">
							<HugeiconsIcon className="size-3" icon={AlertCircleIcon} />
							Not installed
						</Badge>
					) : null}
				</CollapsibleTrigger>
				<Button
					className="shrink-0"
					onClick={() => onSelect(`server:${server.name}`)}
					size="sm"
					variant="ghost"
				>
					Details
				</Button>
			</div>
			<CollapsibleContent>
				<div className="pt-1">
					{tools.length === 0 ? (
						<p className="px-1 pb-1 text-muted-foreground text-sm">
							{toolsStatus ??
								(allowlisted
									? "None of this server's tools are on the selected agent's allowlist."
									: server.enabled
										? "This server advertises no tools."
										: "Enable this server to see the tools it advertises.")}
						</p>
					) : (
						<ToolCards
							onSelect={onSelect}
							selectedId={selectedId}
							tools={tools}
						/>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function McpAuthBadge({ server }: { server: McpServer }) {
	if (!server.authRequired) {
		return <Badge variant="outline">No auth required</Badge>;
	}
	if (server.authType === "oauth") {
		return (
			<Badge variant="outline">
				{server.authConfigured ? "Authenticated" : "Authentication required"}
			</Badge>
		);
	}
	return (
		<Badge variant="outline">
			{server.authConfigured
				? "Credentials configured"
				: "Authentication required"}
		</Badge>
	);
}

/** A titled group shell for tool cards that are not owned by a live server. */
function ToolGroupShell({
	label,
	count,
	note,
	children,
}: {
	label: string;
	count: number;
	note?: string;
	children: React.ReactNode;
}) {
	return (
		<section>
			<h3 className="mb-2 flex items-center gap-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				<HugeiconsIcon className="size-3.5" icon={Wrench01Icon} />
				{label}
				<Badge variant="secondary">{formatCount(count) ?? "—"}</Badge>
			</h3>
			{note ? (
				<p className="mb-2 px-1 text-muted-foreground text-xs normal-case">
					{note}
				</p>
			) : null}
			{children}
		</section>
	);
}

/** The flat A–Z list (also the search-results view). Each card keeps its server
 *  badge, which is the only place the grouping information can live here. */
function FlatToolList({
	tools,
	selectedId,
	onSelect,
	agentFilter,
	onClearFilters,
	searching,
}: {
	tools: McpTool[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	agentFilter: string | null;
	onClearFilters: () => void;
	searching: boolean;
}) {
	if (tools.length === 0) {
		return (
			<Empty inset="compact">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Wrench01Icon} />
					</EmptyMedia>
					<EmptyTitle>No tools found</EmptyTitle>
					<EmptyDescription>
						{agentFilter
							? "This agent's allowlist exposes no matching tools."
							: "Try a different search."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearFilters} size="sm" variant="ghost">
						{agentFilter
							? "Clear filters"
							: searching
								? "Clear search"
								: "Show servers"}
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	return (
		<div className="pt-2">
			<ToolCards onSelect={onSelect} selectedId={selectedId} tools={tools} />
		</div>
	);
}

/** The card grid for a set of tools. */
function ToolCards({
	tools,
	selectedId,
	onSelect,
}: {
	tools: McpTool[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const displayToolName = (tool: McpTool) => {
		const separator = tool.id.indexOf(".");
		if (separator === -1) {
			return tool.name;
		}
		return tool.id
			.slice(separator + 1)
			.replace(/[_-]+/g, " ")
			.replace(/\b\w/g, (character) => character.toUpperCase());
	};

	return (
		<StoreCardGrid>
			{tools.map((tool) => (
				<StoreCatalogCard
					action={<Badge variant="secondary">{tool.server}</Badge>}
					// A tool has no lifecycle of its own (its SERVER is what gets added
					// or removed), so the menu carries the one thing you actually want
					// off this card: the exact name to type at an agent.
					contextMenu={
						<ContextMenuItem
							onClick={() => {
								navigator.clipboard
									.writeText(tool.name)
									.then(() => toast.success("Tool name copied"))
									.catch(() => toast.error("Couldn't copy the tool name"));
							}}
						>
							<HugeiconsIcon className="size-4" icon={ClipboardIcon} />
							Copy tool name
						</ContextMenuItem>
					}
					description={tool.description ?? "No description"}
					icon={
						<HugeiconsIcon className="size-5" icon={ComputerTerminal01Icon} />
					}
					key={tool.id}
					name={displayToolName(tool)}
					onClick={() => onSelect(`tool:${tool.id}`)}
					seedId={tool.id}
					selected={selectedId === `tool:${tool.id}`}
				/>
			))}
		</StoreCardGrid>
	);
}

function ServerDetail({
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
						server.enabled ? "Enabled" : "Disabled",
						server.available === false ? "Not installed" : null,
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
				<p className="text-muted-foreground text-sm leading-relaxed">
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
							<p>Environment variables: {server.envKeys.join(", ")}</p>
						) : null}
						{server.headerNames.length > 0 ? (
							<p>Request headers: {server.headerNames.join(", ")}</p>
						) : null}
					</div>
				</ListingSection>
			) : null}

			<ListingSection title={server.url ? "Endpoint" : "Command"}>
				<code className="block overflow-x-auto whitespace-pre rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
					{server.url ?? [server.command, ...server.args].join(" ")}
				</code>
			</ListingSection>

			{tools.length > 0 ? (
				<ListingSection title={`Tools (${tools.length})`}>
					{/* Two-up on a wide dialog: a tool row is a name plus one line, and
					    a single full-width column of them wasted most of the space. */}
					<ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{tools.map((tool) => (
							<li
								className="rounded-lg border border-border/60 px-3 py-2 text-sm"
								key={tool.id}
							>
								<div className="truncate font-medium" title={tool.name}>
									{tool.name}
								</div>
								{tool.description ? (
									<div
										className="truncate text-muted-foreground text-xs"
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

function McpAuthentication({
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
		<div className="flex flex-col gap-1.5">
			<Badge className="w-fit" variant="outline">
				{server.authConfigured
					? "Credentials configured"
					: "Authentication required"}
			</Badge>
			<p className="text-muted-foreground text-xs">
				{server.authType === "oauth"
					? "Open Marketplace → Connections to connect the account for this server."
					: server.authType === "env"
						? "Configure the credential environment variable in Server settings. Values stay on the Core node."
						: "Configure the credential header in Server settings. Values stay on the Core node."}
			</p>
		</div>
	);
}

interface McpKeyValueRow {
	key: string;
	value: string;
}

function McpKeyValueRows({
	label,
	onChange,
	onRemove,
	rows,
	secret,
}: {
	label: string;
	onChange: (index: number, field: keyof McpKeyValueRow, value: string) => void;
	onRemove: (index: number) => void;
	rows: McpKeyValueRow[];
	secret?: boolean;
}) {
	return (
		<div className="flex flex-col gap-2">
			<Label variant="choice">{label}</Label>
			{rows.map((row, index) => (
				<div className="flex items-center gap-2" key={`${row.key}-${index}`}>
					<Input
						aria-label={`${label} key ${index + 1}`}
						onChange={(event: ChangeEvent<HTMLInputElement>) =>
							onChange(index, "key", event.target.value)
						}
						placeholder="Key"
						value={row.key}
					/>
					<Input
						aria-label={`${label} value ${index + 1}`}
						onChange={(event: ChangeEvent<HTMLInputElement>) =>
							onChange(index, "value", event.target.value)
						}
						placeholder={
							secret && row.value === "••••••" ? "Leave unchanged" : "Value"
						}
						type={secret ? "password" : "text"}
						value={row.value}
					/>
					<Button
						aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
						onClick={() => onRemove(index)}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					</Button>
				</div>
			))}
		</div>
	);
}

function McpServerSettingsDialog({
	deleteServer,
	onUpdateServer,
	server,
}: {
	deleteServer: (name: string) => Promise<{ error?: string; ok: boolean }>;
	onUpdateServer: (
		name: string,
		input: UpdateMcpServerInput
	) => Promise<{ error?: string; ok: boolean; server?: McpServer }>;
	server: McpServer;
}) {
	const [open, setOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [command, setCommand] = useState("");
	const [url, setUrl] = useState("");
	const [transport, setTransport] = useState<McpTransport>("stdio");
	const [argsText, setArgsText] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [envRows, setEnvRows] = useState<McpKeyValueRow[]>([]);
	const [headerRows, setHeaderRows] = useState<McpKeyValueRow[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const resetFromServer = () => {
		const nextTransport =
			server.transport === "sse"
				? "sse"
				: server.transport === "streamable-http" || server.url
					? "streamable-http"
					: "stdio";
		setTransport(nextTransport);
		setCommand(server.url ? "" : server.command);
		setUrl(server.url ?? "");
		setArgsText(server.args.join(" "));
		setDescription(server.description ?? "");
		setEnabled(server.enabled);
		setEnvRows(server.envKeys.map((key) => ({ key, value: "••••••" })));
		setHeaderRows(server.headerNames.map((key) => ({ key, value: "••••••" })));
		setFormError(null);
	};

	const mapRows = (rows: McpKeyValueRow[]) =>
		rows.reduce<Record<string, string>>((result, row) => {
			const key = row.key.trim();
			if (key) {
				result[key] = row.value;
			}
			return result;
		}, {});

	const handleSubmit = async () => {
		setFormError(null);
		if (transport === "stdio" && !command.trim()) {
			setFormError("Command is required for stdio servers.");
			return;
		}
		if (transport !== "stdio") {
			if (!url.trim()) {
				setFormError("Endpoint URL is required for remote servers.");
				return;
			}
			try {
				const parsed = new URL(url.trim());
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					setFormError("Endpoint URL must use http:// or https://.");
					return;
				}
			} catch {
				setFormError("Endpoint URL is not valid.");
				return;
			}
		}

		setSubmitting(true);
		try {
			const result = await onUpdateServer(server.name, {
				args: argsText
					.split(/\s+/)
					.map((value) => value.trim())
					.filter(Boolean),
				command: transport === "stdio" ? command.trim() : undefined,
				description: description.trim(),
				enabled,
				env: mapRows(envRows),
				headers: mapRows(headerRows),
				transport,
				url: transport === "stdio" ? undefined : url.trim(),
			});
			if (!result.ok) {
				setFormError(result.error ?? "Failed to save server settings.");
				return;
			}
			toast.success("MCP server settings saved");
			setOpen(false);
		} catch (error) {
			setFormError(
				error instanceof Error
					? error.message
					: "Failed to save server settings."
			);
		} finally {
			setSubmitting(false);
		}
	};

	const handleDelete = async () => {
		setDeleting(true);
		try {
			const result = await deleteServer(server.name);
			if (!result.ok) {
				setFormError(result.error ?? "Failed to remove server.");
				return;
			}
			toast.success("MCP server removed");
			setDeleteOpen(false);
			setOpen(false);
		} catch (error) {
			setFormError(
				error instanceof Error ? error.message : "Failed to remove server."
			);
		} finally {
			setDeleting(false);
		}
	};

	const updateRow = (
		setter: Dispatch<SetStateAction<McpKeyValueRow[]>>,
		index: number,
		field: keyof McpKeyValueRow,
		value: string
	) => {
		setter((current) =>
			current.map((row, rowIndex) =>
				rowIndex === index ? { ...row, [field]: value } : row
			)
		);
	};

	return (
		<Dialog
			onOpenChange={(value) => {
				setOpen(value);
				if (value) {
					resetFromServer();
				}
			}}
			open={open}
		>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				Settings
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Configure {server.name}</DialogTitle>
					<DialogDescription>
						Values are stored on the Core node. Existing secret values are
						masked; leave them unchanged to keep them.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
						<div>
							<p className="font-medium text-sm">Server enabled</p>
							<p className="text-muted-foreground text-xs">
								Disabled servers do not advertise tools to agents.
							</p>
						</div>
						<Button
							onClick={() => setEnabled((value) => !value)}
							size="sm"
							variant={enabled ? "default" : "outline"}
						>
							{enabled ? "Enabled" : "Disabled"}
						</Button>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-settings-transport">Transport</Label>
						<Select<McpTransport>
							onValueChange={(value) => {
								if (value) {
									setTransport(value);
								}
							}}
							value={transport}
						>
							<SelectTrigger id="mcp-settings-transport">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="stdio">Local process (stdio)</SelectItem>
								<SelectItem value="streamable-http">Streamable HTTP</SelectItem>
								<SelectItem value="sse">Legacy HTTP + SSE</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{transport === "stdio" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-settings-command">Command</Label>
								<Input
									id="mcp-settings-command"
									onChange={(event: ChangeEvent<HTMLInputElement>) =>
										setCommand(event.target.value)
									}
									value={command}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-settings-args">Arguments</Label>
								<Input
									id="mcp-settings-args"
									onChange={(event: ChangeEvent<HTMLInputElement>) =>
										setArgsText(event.target.value)
									}
									value={argsText}
								/>
							</div>
						</>
					) : (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mcp-settings-url">Endpoint URL</Label>
							<Input
								id="mcp-settings-url"
								onChange={(event: ChangeEvent<HTMLInputElement>) =>
									setUrl(event.target.value)
								}
								value={url}
							/>
						</div>
					)}
					<McpKeyValueRows
						label="Environment variables"
						onChange={(index, field, value) =>
							updateRow(setEnvRows, index, field, value)
						}
						onRemove={(index) =>
							setEnvRows((rows) =>
								rows.filter((_, rowIndex) => rowIndex !== index)
							)
						}
						rows={envRows}
						secret
					/>
					<Button
						onClick={() =>
							setEnvRows((rows) => [...rows, { key: "", value: "" }])
						}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add environment variable
					</Button>
					{transport === "stdio" ? null : (
						<>
							<McpKeyValueRows
								label="Request headers"
								onChange={(index, field, value) =>
									updateRow(setHeaderRows, index, field, value)
								}
								onRemove={(index) =>
									setHeaderRows((rows) =>
										rows.filter((_, rowIndex) => rowIndex !== index)
									)
								}
								rows={headerRows}
								secret
							/>
							<Button
								onClick={() =>
									setHeaderRows((rows) => [...rows, { key: "", value: "" }])
								}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add request header
							</Button>
						</>
					)}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-settings-description">Description</Label>
						<Textarea
							id="mcp-settings-description"
							onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
								setDescription(event.target.value)
							}
							rows={2}
							value={description}
						/>
					</div>
					{formError ? (
						<p className="text-sm text-status-destructive">{formError}</p>
					) : null}
				</div>
				<DialogFooter className="justify-between sm:justify-between">
					<AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
						<AlertDialogTrigger
							render={
								<Button variant="destructive">
									<HugeiconsIcon className="size-4" icon={Delete01Icon} />
									Remove server
								</Button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
								<AlertDialogDescription>
									This removes the server configuration from the Core node. It
									does not delete an installed package.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									disabled={deleting}
									onClick={handleDelete}
									variant="destructive"
								>
									Remove server
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
					<div className="flex gap-2">
						<Button onClick={() => setOpen(false)} variant="ghost">
							Cancel
						</Button>
						<Button loading={submitting} onClick={handleSubmit}>
							Save changes
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ToolDetail({
	tool,
	agents,
	onCallTool,
}: {
	tool: McpTool;
	agents: { id: string; name: string }[];
	onCallTool: ReturnType<typeof useMcp>["callTool"];
}) {
	const [argsText, setArgsText] = useState("{}");
	const [agentId, setAgentId] = useState<string>(() => agents[0]?.id ?? "");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<McpCallResult | null>(null);
	const [parseError, setParseError] = useState<string | null>(null);

	const resultText = useMemo(() => {
		if (!result) {
			return null;
		}
		if (!result.ok) {
			return result.error ?? "Tool call failed";
		}
		return isNativeText(result.output)
			? result.output
			: JSON.stringify(result.output, null, 2);
	}, [result]);

	const runCall = async () => {
		setParseError(null);
		setResult(null);
		if (!agentId) {
			setParseError("Choose an agent to run this tool as.");
			return;
		}
		let parsed: unknown;
		try {
			parsed = argsText.trim() ? JSON.parse(argsText) : {};
		} catch {
			setParseError("Arguments must be valid JSON.");
			return;
		}
		setRunning(true);
		try {
			const res = await onCallTool(tool.id, agentId, parsed);
			setResult(res ?? { ok: false, error: "No handler" });
		} catch (e) {
			setResult({
				ok: false,
				error: e instanceof Error ? e.message : "Tool call failed",
			});
		} finally {
			setRunning(false);
		}
	};

	return (
		<ListingDetailShell
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Tool ID", value: tool.id },
							{ label: "Server", value: tool.server },
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[tool.server]}
					icon={<HugeiconsIcon className="size-8" icon={Wrench01Icon} />}
					name={tool.name}
					tagline={tool.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Server", value: tool.server },
						{ label: "Runs as", value: agents.length > 0 ? "Agent" : "—" },
					]}
				/>
			}
		>
			<ListingSection title="Test call">
				{agents.length === 0 ? (
					<p className="rounded bg-muted px-3 py-2 text-muted-foreground text-xs">
						Create an agent first, then come back here to try this tool. Tools
						always run as one of your agents.
					</p>
				) : (
					<>
						<div className="flex items-center gap-2">
							<Label htmlFor={`agent-${tool.id}`} size="compact" tone="muted">
								Run as
							</Label>
							<Select
								items={agents.map((a) => ({ value: a.id, label: a.name }))}
								onValueChange={(value) => setAgentId(value ?? "")}
								value={agentId}
							>
								<SelectTrigger
									className="w-48"
									id={`agent-${tool.id}`}
									size="sm"
								>
									<SelectValue placeholder="Select an agent" />
								</SelectTrigger>
								<SelectContent>
									{agents.map((agent) => (
										<SelectItem key={agent.id} value={agent.id}>
											{agent.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor={`args-${tool.id}`} size="compact" tone="muted">
								Arguments (JSON)
							</Label>
							<Textarea
								id={`args-${tool.id}`}
								onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
									setArgsText(e.target.value)
								}
								rows={3}
								value={argsText}
								variant="code-caption"
							/>
						</div>
						{parseError ? (
							<p className="text-status-destructive text-xs">{parseError}</p>
						) : null}
						<div>
							<Button loading={running} onClick={runCall} size="sm">
								Test call
							</Button>
						</div>
					</>
				)}
				{resultText === null ? null : (
					<pre
						className={`max-h-60 overflow-auto rounded border px-3 py-2 text-xs ${
							result?.ok
								? "bg-muted"
								: "border-destructive/40 bg-destructive/10 text-status-destructive"
						}`}
					>
						{resultText}
					</pre>
				)}
			</ListingSection>
		</ListingDetailShell>
	);
}

function AddServerDialog({
	onCreateServer,
}: {
	onCreateServer: (
		input: CreateMcpServerInput
	) => Promise<CreateMcpServerResult>;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [transport, setTransport] = useState<McpTransport>("stdio");
	const [command, setCommand] = useState("");
	const [url, setUrl] = useState("");
	const [argsText, setArgsText] = useState("");
	const [headersText, setHeadersText] = useState("");
	const [envRows, setEnvRows] = useState<McpKeyValueRow[]>([]);
	const [description, setDescription] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const reset = () => {
		setName("");
		setTransport("stdio");
		setCommand("");
		setUrl("");
		setArgsText("");
		setHeadersText("");
		setEnvRows([]);
		setDescription("");
		setFormError(null);
	};

	const updateRow = (
		index: number,
		field: keyof McpKeyValueRow,
		value: string
	) => {
		setEnvRows((rows) =>
			rows.map((row, rowIndex) =>
				rowIndex === index ? { ...row, [field]: value } : row
			)
		);
	};

	const handleSubmit = async () => {
		setFormError(null);

		const trimmedName = name.trim();
		const trimmedCommand = command.trim();
		const trimmedUrl = url.trim();

		if (!trimmedName) {
			setFormError("Name is required.");
			return;
		}
		if (trimmedName.includes("__")) {
			setFormError("Name must not contain '__' (reserved legacy separator).");
			return;
		}
		if (transport === "stdio") {
			if (!trimmedCommand) {
				setFormError("Command is required for stdio servers.");
				return;
			}
		} else {
			if (!trimmedUrl) {
				setFormError("Endpoint URL is required for remote servers.");
				return;
			}
			try {
				const parsed = new URL(trimmedUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					setFormError("Endpoint URL must use http:// or https://.");
					return;
				}
			} catch {
				setFormError("Endpoint URL is not valid.");
				return;
			}
		}

		const headers: Record<string, string> = {};
		if (transport !== "stdio" && headersText.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(headersText);
			} catch {
				setFormError("Headers must be valid JSON.");
				return;
			}
			const decoded = z
				.record(
					z.string().refine((key) => Boolean(key.trim())),
					z.string()
				)
				.safeParse(parsed);
			if (!decoded.success) {
				setFormError("Headers must be a JSON object of string values.");
				return;
			}
			const headerObject = decoded.data;
			for (const key of Object.keys(headerObject)) {
				const value = headerObject[key];
				if (!(key.trim() && isNativeText(value))) {
					setFormError("Headers must be a JSON object of string values.");
					return;
				}
				headers[key] = value;
			}
		}

		const args = argsText
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const env = envRows.reduce<Record<string, string>>((result, row) => {
			const key = row.key.trim();
			if (key) {
				result[key] = row.value;
			}
			return result;
		}, {});

		setSubmitting(true);
		try {
			const result = await onCreateServer({
				name: trimmedName,
				transport,
				...(transport === "stdio"
					? { command: trimmedCommand, args }
					: { url: trimmedUrl, headers }),
				env,
				description: description.trim() || undefined,
			});
			if (result.ok) {
				reset();
				setOpen(false);
			} else {
				setFormError(result.error ?? "Failed to add server.");
			}
		} catch (e) {
			setFormError(e instanceof Error ? e.message : "Failed to add server.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					reset();
				}
			}}
			open={open}
		>
			<DialogTrigger render={<Button className="w-full" size="sm" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				Add server
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add MCP server</DialogTitle>
					<DialogDescription>
						Register a new MCP server. The entry is saved to{" "}
						<code className="text-xs">~/.ryu/state/mcp.json</code> and takes
						effect immediately, no restart required.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-name">Name</Label>
						<Input
							id="mcp-name"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setName(e.target.value)
							}
							placeholder="e.g. filesystem"
							value={name}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-transport">Transport</Label>
						<Select<McpTransport>
							onValueChange={(value) => {
								if (value) {
									setTransport(value);
								}
							}}
							value={transport}
						>
							<SelectTrigger id="mcp-transport">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="stdio">Local process (stdio)</SelectItem>
								<SelectItem value="streamable-http">Streamable HTTP</SelectItem>
								<SelectItem value="sse">Legacy HTTP + SSE</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{transport === "stdio"
								? "Spawn a local MCP process."
								: transport === "sse"
									? "Connect to the legacy SSE endpoint and its announced POST route."
									: "Connect to a current MCP Streamable HTTP endpoint."}
						</p>
					</div>

					{transport === "stdio" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-command">Command</Label>
								<Input
									id="mcp-command"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setCommand(e.target.value)
									}
									placeholder="e.g. npx"
									value={command}
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-args">
									Arguments{" "}
									<span className="text-muted-foreground text-xs">
										(space-separated)
									</span>
								</Label>
								<Input
									id="mcp-args"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setArgsText(e.target.value)
									}
									placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
									value={argsText}
								/>
							</div>
						</>
					) : (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-url">Endpoint URL</Label>
								<Input
									id="mcp-url"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setUrl(e.target.value)
									}
									placeholder="https://example.com/mcp"
									value={url}
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-headers">
									Headers{" "}
									<span className="text-muted-foreground text-xs">
										(optional JSON)
									</span>
								</Label>
								<Textarea
									id="mcp-headers"
									onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
										setHeadersText(e.target.value)
									}
									placeholder={'{"Authorization":"Bearer …"}'}
									rows={2}
									value={headersText}
								/>
							</div>
						</>
					)}

					<McpKeyValueRows
						label="Environment variables"
						onChange={(index, field, value) => updateRow(index, field, value)}
						onRemove={(index) =>
							setEnvRows((rows) =>
								rows.filter((_, rowIndex) => rowIndex !== index)
							)
						}
						rows={envRows}
					/>
					<Button
						onClick={() =>
							setEnvRows((rows) => [...rows, { key: "", value: "" }])
						}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add environment variable
					</Button>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-description">
							Description{" "}
							<span className="text-muted-foreground text-xs">(optional)</span>
						</Label>
						<Textarea
							id="mcp-description"
							onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
								setDescription(e.target.value)
							}
							placeholder="What does this server do?"
							rows={2}
							value={description}
						/>
					</div>

					{formError ? (
						<p className="text-sm text-status-destructive">{formError}</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						disabled={submitting}
						onClick={() => {
							setOpen(false);
							reset();
						}}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={submitting} onClick={handleSubmit} type="button">
						Add server
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
