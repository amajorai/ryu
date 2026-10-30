import {
	AlertCircleIcon,
	ArrowDown01Icon,
	ClipboardIcon,
	ComputerTerminal01Icon,
	ServerStack01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { ContextMenuItem } from "@ryu/ui/components/context-menu.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import type { McpServer, McpTool } from "@/src/lib/api/mcp.ts";

/** A server together with the tools it advertises, after search filtering. */
export interface ServerGroup {
	server: McpServer;
	tools: McpTool[];
}

/** One server and its tools: a clickable header row (opens the server detail) over
 *  the server's tool cards, collapsible so a node with many servers stays scannable. */
export function ServerToolGroup({
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
					{toolsStatus || tools.length === 0 ? null : (
						<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
							{formatCount(tools.length)}
						</span>
					)}
					{unavailable ? (
						<Badge variant="outline">
							<HugeiconsIcon className="size-3.5" icon={AlertCircleIcon} />
							Not installed
						</Badge>
					) : server.enabled ? (
						<McpAuthBadge server={server} />
					) : (
						<Badge variant="outline">Disabled</Badge>
					)}
				</CollapsibleTrigger>
				<Button
					className="shrink-0"
					onClick={() => onSelect(`server:${server.name}`)}
					size="sm"
					variant="ghost-muted"
				>
					Details
				</Button>
			</div>
			<CollapsibleContent>
				<div className="pt-1">
					{tools.length === 0 ? (
						<p className="px-1 pb-1 text-detail text-muted-foreground">
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
							showServer={false}
							tools={tools}
						/>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Badges only the exceptional auth state. "No auth required" and configured
 *  credentials are the normal case, so they render nothing. */
export function McpAuthBadge({ server }: { server: McpServer }) {
	if (!server.authRequired || server.authConfigured) {
		return null;
	}
	return <Badge variant="outline">Authentication required</Badge>;
}

/** A titled group shell for tool cards that are not owned by a live server. */
export function ToolGroupShell({
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
			<h3 className="mb-1 flex items-center gap-2 px-1 font-semibold text-sm">
				{label}
				{count > 0 ? (
					<span className="font-normal text-muted-foreground/70 text-xs tabular-nums">
						{formatCount(count)}
					</span>
				) : null}
			</h3>
			{note ? (
				<p className="mb-2 px-1 text-detail text-muted-foreground">{note}</p>
			) : null}
			{children}
		</section>
	);
}

/** The flat A–Z list (also the search-results view). Each card keeps its server
 *  badge, which is the only place the grouping information can live here. */
export function FlatToolList({
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
			<QuietEmpty
				action={
					<Button onClick={onClearFilters} size="sm" variant="outline">
						{agentFilter
							? "Clear filters"
							: searching
								? "Clear search"
								: "Show servers"}
					</Button>
				}
				description={
					agentFilter
						? "This agent's allowlist exposes no matching tools."
						: "Try a different search."
				}
				icon={Wrench01Icon}
				title="No tools found"
			/>
		);
	}
	return (
		<div className="pt-2">
			<ToolCards onSelect={onSelect} selectedId={selectedId} tools={tools} />
		</div>
	);
}

/** The card grid for a set of tools. */
export function ToolCards({
	tools,
	selectedId,
	onSelect,
	showServer = true,
}: {
	tools: McpTool[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	/** Off inside a server group, whose header already names the server. */
	showServer?: boolean;
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
					action={
						showServer ? (
							<span className="text-muted-foreground text-xs">
								{tool.server}
							</span>
						) : undefined
					}
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
