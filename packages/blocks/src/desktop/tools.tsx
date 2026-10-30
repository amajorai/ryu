"use client";
import { cn } from "@ryu/ui/lib/utils.ts";
import styles from "./tools.module.css";

// Presentational layer of the desktop Tools page. The live app
// (`apps/desktop/src/pages/ToolsPage.tsx`) is a thin container that loads the
// MCP registry via `useMcp()` and renders this view with real handlers; the
// storyboard renders the same component with mock data and no-op handlers. One
// source of truth, so editing this block changes the real desktop too.
//
// Local UI state (the add-server dialog, each tool row's expand/args/result)
// stays inside this component — it is plain UI state, not app/backend/Tauri
// state. Everything that needs the backend (servers, tools, agents, calling a
// tool, creating a server) is passed in as props.

import { ServerStack01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRichLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { AddServerDialog } from "./tools-add-server-dialog.tsx";
import { ToolRow } from "./tools-tool-row.tsx";
import type { ToolsViewProps } from "./tools-types.ts";

export type {
	AgentOption,
	CreateServerInput,
	CreateServerResult,
	McpServerRow,
	McpToolRow,
	ToolCallResult,
	ToolsViewProps,
} from "./tools-types.ts";

const ALL_AGENTS = "__all__";

export function ToolsView({
	loading,
	error,
	servers,
	tools,
	agents,
	agentFilter = null,
	onAgentFilterChange,
	onCreateServer,
	onCallTool,
	onRetry,
}: ToolsViewProps) {
	const tlRich = useRichLiteralMessages();
	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
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
				{onRetry ? (
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="outline">
							Try again
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<Label htmlFor="agent-filter" size="compact" tone="muted">
						Allowlist
					</Label>
					<Select
						items={[
							{ value: ALL_AGENTS, label: "All tools" },
							...agents.map((a) => ({ value: a.id, label: a.name })),
						]}
						onValueChange={(v) =>
							onAgentFilterChange?.(!v || v === ALL_AGENTS ? null : v)
						}
						value={agentFilter ?? ALL_AGENTS}
					>
						<SelectTrigger className="w-44" id="agent-filter" size="sm">
							<SelectValue placeholder="All tools" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL_AGENTS}>All tools</SelectItem>
							{agents.map((agent) => (
								<SelectItem key={agent.id} value={agent.id}>
									{agent.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<AddServerDialog onCreateServer={onCreateServer} />
				</div>
			</div>

			<div className="scroll-fade flex-1 overflow-auto p-4">
				<section className="mb-6">
					<h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
						<HugeiconsIcon
							className="size-4 opacity-70"
							icon={ServerStack01Icon}
						/>
						Servers
						<Badge variant="secondary">
							{formatCount(servers.length) ?? "—"}
						</Badge>
					</h2>
					{servers.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={ServerStack01Icon} />
								</EmptyMedia>
								<EmptyTitle>No servers registered</EmptyTitle>
								<EmptyDescription>
									Add an MCP server to expose tools to your agents.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<AddServerDialog onCreateServer={onCreateServer} />
							</EmptyContent>
						</Empty>
					) : (
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
							{servers.map((server) => (
								<Card key={server.name}>
									<CardHeader>
										<CardTitle layout="badge-row" variant="default">
											{server.name}
										</CardTitle>
										<div
											className={cn(
												"flex flex-wrap text-muted-foreground text-sm",
												styles.serverBadges
											)}
											data-slot="card-description"
										>
											<Badge variant={server.enabled ? "default" : "secondary"}>
												{server.enabled ? "Enabled" : "Disabled"}
											</Badge>
											{server.available === false ? (
												<Badge variant="secondary">Not installed</Badge>
											) : null}
										</div>
									</CardHeader>
									<CardContent>
										<p className="line-clamp-2 text-muted-foreground text-sm">
											{server.description ?? "No description"}
										</p>
										<code
											className="mt-2 block truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs"
											title={[server.command, ...server.args].join(" ")}
										>
											{[server.command, ...server.args].join(" ")}
										</code>
									</CardContent>
								</Card>
							))}
						</div>
					)}
				</section>

				<section>
					<h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
						<HugeiconsIcon className="size-4 opacity-70" icon={Wrench01Icon} />
						{tlRich(
							"Tools<badge>{count}</badge>",
							{ count: formatCount(tools.length) ?? "—" },
							{ badge: (c) => <Badge variant="secondary">{c}</Badge> }
						)}
						{agentFilter ? (
							<span className="text-muted-foreground text-xs">
								filtered by allowlist
							</span>
						) : null}
					</h2>
					{tools.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={Wrench01Icon} />
								</EmptyMedia>
								<EmptyTitle>No tools</EmptyTitle>
								<EmptyDescription>
									{agentFilter
										? "This agent's allowlist exposes no tools."
										: "No MCP tools are registered yet."}
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								{agentFilter ? (
									<Button
										onClick={() => onAgentFilterChange?.(null)}
										size="sm"
										variant="ghost"
									>
										Clear agent filter
									</Button>
								) : (
									<AddServerDialog onCreateServer={onCreateServer} />
								)}
							</EmptyContent>
						</Empty>
					) : (
						<div className="flex flex-col gap-2">
							{tools.map((tool) => (
								<ToolRow
									agents={agents}
									key={tool.id}
									onCallTool={onCallTool}
									tool={tool}
								/>
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
