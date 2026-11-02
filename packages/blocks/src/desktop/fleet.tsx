"use client";

// Presentational layer of the desktop Fleet page. The live app
// (`apps/desktop/src/pages/FleetPage.tsx`) is a thin container that probes nodes
// via Tauri `invoke`/`listen` + the node store and renders this view with real
// handlers; the storyboard renders the same component with mock data and no-op
// handlers. One source of truth, so editing this block changes the real desktop
// too.

import {
	AlertCircleIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	CircleIcon,
	Loading01Icon,
	Refresh01Icon,
	ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { translate as tl } from "@ryu/i18n/core";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Card, CardContent } from "@ryu/ui/components/card";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import type { ReactNode } from "react";
import { FleetSidecarRow } from "./fleet-sidecar-row.tsx";

/** A managed sidecar on a node, as the view needs it. */
export interface FleetServiceRow {
	deprecated?: boolean;
	description?: string | null;
	displayName: string;
	installedVersion?: string | null;
	installState: "installed" | "installing" | "failed" | string;
	latestVersion?: string | null;
	name: string;
	pending?: string | null;
	running: boolean;
}

export interface FleetNodeServices {
	agents: FleetServiceRow[];
	error: string | null;
	loading: boolean;
	providers: FleetServiceRow[];
	tools: FleetServiceRow[];
}

/** A node row as the view needs it; status is pre-resolved by the container. */
export interface FleetNode {
	expanded: boolean;
	latencyMs: number | null;
	name: string;
	online: boolean;
	services: FleetNodeServices | null;
	/** Whether the latency/online status has resolved yet for this node. */
	statusKnown: boolean;
	url: string;
}

export interface FleetViewProps {
	healthLoading?: boolean;
	lastRefreshedLabel?: string | null;
	nodes: FleetNode[];
	onInstall?: (name: string, sidecar: string) => void;
	onlineCount?: number;
	onOpenNodeSettings?: () => void;
	onRefresh?: () => void;
	onRefreshServices?: (name: string) => void;
	onRestart?: (name: string, sidecar: string) => void;
	onStart?: (name: string, sidecar: string) => void;
	onStop?: (name: string, sidecar: string) => void;
	onToggleExpand?: (name: string, online: boolean) => void;
	totalCount?: number;
}

function latencyColor(ms: number): string {
	if (ms < 100) {
		return "text-status-success";
	}
	if (ms < 500) {
		return "text-status-warning";
	}
	return "text-status-destructive";
}

function NodeStatusCell({
	loading,
	online,
	latencyMs,
	statusKnown,
}: {
	loading: boolean;
	online: boolean;
	latencyMs: number | null;
	statusKnown: boolean;
}) {
	if (loading && !statusKnown) {
		return <span className="text-muted-foreground text-xs">Checking…</span>;
	}
	if (statusKnown) {
		return (
			<>
				{latencyMs === null ? (
					<span className="text-muted-foreground text-xs">—</span>
				) : (
					<span
						className={`font-mono text-xs tabular-nums ${latencyColor(latencyMs)}`}
					>
						{latencyMs} ms
					</span>
				)}
				<Badge variant={online ? "default" : "destructive"}>
					{online ? "Online" : "Offline"}
				</Badge>
			</>
		);
	}
	return <Badge variant="secondary">Unknown</Badge>;
}

function ServiceSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="border-t first:border-t-0">
			<div className="px-4 py-1.5">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
					{title}
				</span>
			</div>
			{children}
		</div>
	);
}

function NodeSidecarPanel({
	node,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: {
	node: FleetNode;
	onInstall?: (sidecar: string) => void;
	onStart?: (sidecar: string) => void;
	onStop?: (sidecar: string) => void;
	onRestart?: (sidecar: string) => void;
}) {
	const { services } = node;
	if (!node.online) {
		return (
			<div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
				<HugeiconsIcon
					className="size-3 fill-muted-foreground/30 text-muted-foreground/30"
					icon={CircleIcon}
				/>
				Node is offline — cannot manage sidecars
			</div>
		);
	}
	if (services === null || services.loading) {
		return (
			<div className="flex items-center justify-center gap-2 py-5 text-muted-foreground text-sm">
				<HugeiconsIcon className="h-4 w-4 animate-spin" icon={Loading01Icon} />
				Loading services…
			</div>
		);
	}
	if (services.error) {
		return (
			<div className="flex items-center gap-2 px-4 py-4 text-sm text-status-destructive">
				<HugeiconsIcon className="size-4 shrink-0" icon={AlertCircleIcon} />
				{services.error}
			</div>
		);
	}
	const renderRows = (rows: FleetServiceRow[]) =>
		rows.map((entry) => (
			<FleetSidecarRow
				entry={entry}
				key={entry.name}
				onInstall={() => onInstall?.(entry.name)}
				onRestart={() => onRestart?.(entry.name)}
				onStart={() => onStart?.(entry.name)}
				onStop={() => onStop?.(entry.name)}
			/>
		));
	return (
		<>
			<ServiceSection title="Runtimes">
				{renderRows(services.agents)}
			</ServiceSection>
			<ServiceSection title="Tools">
				{renderRows(services.tools)}
			</ServiceSection>
			<ServiceSection title="Providers">
				{renderRows(services.providers)}
			</ServiceSection>
		</>
	);
}

export function FleetView({
	nodes,
	healthLoading,
	onlineCount = 0,
	totalCount = 0,
	lastRefreshedLabel,
	onOpenNodeSettings,
	onRefresh,
	onToggleExpand,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: FleetViewProps) {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-3">
				<div className="flex items-center gap-3">
					{!healthLoading && lastRefreshedLabel ? (
						<span className="text-muted-foreground text-xs">
							{tl("{online}/{total} online · updated {updated}", {
								online: onlineCount,
								total: totalCount,
								updated: lastRefreshedLabel,
							})}
						</span>
					) : null}
					<Button
						loading={healthLoading}
						onClick={onRefresh}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						Refresh
					</Button>
				</div>
			</div>

			<div className="scroll-fade flex-1 overflow-y-auto p-6">
				{nodes.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={ServerStack01Icon} />
							</EmptyMedia>
							<EmptyTitle>No nodes configured</EmptyTitle>
							<EmptyDescription>
								Add nodes to monitor and manage their sidecars across your
								fleet.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<p className="text-muted-foreground text-sm">
								Use the node settings to add your first node.
							</p>
							{onOpenNodeSettings ? (
								<Button onClick={onOpenNodeSettings} size="sm">
									Open node settings
								</Button>
							) : onRefresh ? (
								<Button onClick={onRefresh} size="sm" variant="ghost">
									Refresh nodes
								</Button>
							) : null}
						</EmptyContent>
					</Empty>
				) : healthLoading && nodes.every((n) => !n.statusKnown) ? (
					<div className="flex flex-col gap-3">
						{nodes.map((node) => (
							<Card key={node.name}>
								<CardContent inset="none">
									<div className="flex items-center justify-between gap-4 px-4 py-4">
										<div className="flex flex-col gap-1">
											<span className="font-medium text-sm">{node.name}</span>
											<span className="text-muted-foreground text-xs">
												{node.url}
											</span>
										</div>
										<span className="text-muted-foreground text-xs">
											Checking…
										</span>
									</div>
								</CardContent>
							</Card>
						))}
					</div>
				) : (
					<div className="flex flex-col gap-3">
						{nodes.map((node) => (
							<Card key={node.name}>
								<CardContent inset="none">
									<button
										className="flex w-full items-center justify-between gap-4 px-4 py-4 text-start transition-colors hover:bg-muted/40"
										onClick={() => onToggleExpand?.(node.name, node.online)}
										type="button"
									>
										<div className="flex flex-col gap-0.5">
											<span className="font-medium text-sm">{node.name}</span>
											<span className="text-muted-foreground text-xs">
												{node.url}
											</span>
										</div>
										<div className="flex items-center gap-4">
											<NodeStatusCell
												latencyMs={node.latencyMs}
												loading={healthLoading ?? false}
												online={node.online}
												statusKnown={node.statusKnown}
											/>
											{node.expanded ? (
												<HugeiconsIcon
													className="size-4 text-muted-foreground"
													icon={ArrowDown01Icon}
												/>
											) : (
												<DirectionalIcon
													className="size-4 text-muted-foreground"
													icon={ArrowRight01Icon}
												/>
											)}
										</div>
									</button>

									{node.expanded ? (
										<div className="border-t">
											<NodeSidecarPanel
												node={node}
												onInstall={(sidecar) => onInstall?.(node.name, sidecar)}
												onRestart={(sidecar) => onRestart?.(node.name, sidecar)}
												onStart={(sidecar) => onStart?.(node.name, sidecar)}
												onStop={(sidecar) => onStop?.(node.name, sidecar)}
											/>
										</div>
									) : null}
								</CardContent>
							</Card>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
