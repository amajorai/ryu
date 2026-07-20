"use client";

// Presentational layer of the desktop Fleet page. The live app
// (`apps/desktop/src/pages/FleetPage.tsx`) is a thin container that probes nodes
// via Tauri `invoke`/`listen` + the node store and renders this view with real
// handlers; the storyboard renders the same component with mock data and no-op
// handlers. One source of truth, so editing this block changes the real desktop
// too.

import {
	Alert01Icon,
	AlertCircleIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	CircleArrowUp01Icon,
	CircleIcon,
	Download01Icon,
	Loading01Icon,
	MinusSignIcon,
	PlayIcon,
	Refresh01Icon,
	RotateClockwiseIcon,
	ServerStack01Icon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Card, CardContent } from "@ryu/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import type { ReactNode } from "react";

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
		return "text-green-600";
	}
	if (ms < 500) {
		return "text-yellow-600";
	}
	return "text-red-600";
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

function StatusDot({
	installing,
	installed,
	running,
}: {
	installing: boolean;
	installed: boolean;
	running: boolean;
}) {
	if (installing) {
		return (
			<HugeiconsIcon
				className="h-3.5 w-3.5 animate-spin text-muted-foreground"
				icon={Loading01Icon}
			/>
		);
	}
	if (!installed) {
		return (
			<HugeiconsIcon
				className="h-3.5 w-3.5 text-muted-foreground/50"
				icon={MinusSignIcon}
			/>
		);
	}
	if (running) {
		return (
			<HugeiconsIcon
				className="h-3 w-3 fill-green-500 text-green-500"
				icon={CircleIcon}
			/>
		);
	}
	return (
		<HugeiconsIcon
			className="h-3 w-3 text-muted-foreground"
			icon={CircleIcon}
		/>
	);
}

function SidecarActions({
	entry,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: {
	entry: FleetServiceRow;
	onInstall?: () => void;
	onStart?: () => void;
	onStop?: () => void;
	onRestart?: () => void;
}) {
	const pending = entry.pending ?? null;
	const isInstalled = entry.installState === "installed";
	const isInstalling =
		entry.installState === "installing" || pending === "install";
	const isFailed = entry.installState === "failed";
	const hasUpdate =
		isInstalled &&
		entry.latestVersion != null &&
		entry.installedVersion != null &&
		entry.latestVersion !== entry.installedVersion &&
		!entry.deprecated;

	if (isInstalling) {
		return (
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				<HugeiconsIcon className="h-3 w-3 animate-spin" icon={Loading01Icon} />
				Installing…
			</span>
		);
	}
	if (isFailed) {
		return (
			<Button
				className="h-7 px-2 text-amber-500 hover:text-amber-600"
				disabled={pending !== null}
				onClick={onInstall}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={AlertCircleIcon} />
				Retry
			</Button>
		);
	}
	if (!(isInstalled || entry.deprecated)) {
		return (
			<Button
				className="h-7 px-2"
				disabled={pending !== null}
				onClick={onInstall}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={Download01Icon} />
				Install
			</Button>
		);
	}
	if (!isInstalled) {
		return null;
	}
	return (
		<>
			{hasUpdate ? (
				<Button
					className="h-7 px-2 text-blue-500 hover:text-blue-600"
					disabled={pending !== null}
					onClick={onInstall}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className="mr-1 h-3.5 w-3.5"
						icon={CircleArrowUp01Icon}
					/>
					Update
				</Button>
			) : null}
			{entry.running ? (
				<>
					<Button
						className="h-7 px-2"
						disabled={pending !== null}
						onClick={onStop}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={Square01Icon} />
						Stop
					</Button>
					<Button
						className="h-7 px-2"
						disabled={pending !== null}
						onClick={onRestart}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className="mr-1 h-3.5 w-3.5"
							icon={RotateClockwiseIcon}
						/>
						Restart
					</Button>
				</>
			) : (
				<Button
					className="h-7 px-2"
					disabled={pending !== null}
					onClick={onStart}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={PlayIcon} />
					Start
				</Button>
			)}
		</>
	);
}

function FleetSidecarRow({
	entry,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: {
	entry: FleetServiceRow;
	onInstall?: () => void;
	onStart?: () => void;
	onStop?: () => void;
	onRestart?: () => void;
}) {
	const isInstalled = entry.installState === "installed";
	const isInstalling =
		entry.installState === "installing" || entry.pending === "install";

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40">
			<div className="flex w-4 flex-shrink-0 items-center justify-center">
				<StatusDot
					installed={isInstalled}
					installing={isInstalling}
					running={entry.running}
				/>
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span
						className={`truncate font-medium text-sm ${isInstalled ? "" : "text-muted-foreground"}`}
					>
						{entry.displayName}
					</span>
					{entry.deprecated ? (
						<span className="flex items-center gap-1 font-medium text-amber-500 text-xs">
							<HugeiconsIcon className="h-3 w-3" icon={Alert01Icon} />
							Deprecated
						</span>
					) : null}
				</div>
				{entry.description ? (
					<p className="truncate text-muted-foreground text-xs">
						{entry.description}
					</p>
				) : null}
			</div>

			<div className="flex flex-shrink-0 items-center gap-1.5">
				<SidecarActions
					entry={entry}
					onInstall={onInstall}
					onRestart={onRestart}
					onStart={onStart}
					onStop={onStop}
				/>
			</div>
		</div>
	);
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
				<span className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
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
			<div className="flex items-center gap-2 px-4 py-4 text-destructive text-sm">
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
							{onlineCount}/{totalCount} online · updated {lastRefreshedLabel}
						</span>
					) : null}
					<Button
						disabled={healthLoading}
						onClick={onRefresh}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className={`size-4 ${healthLoading ? "animate-spin" : ""}`}
							icon={Refresh01Icon}
						/>
						Refresh
					</Button>
				</div>
			</div>

			<div className="scroll-fade-effect-y flex-1 overflow-y-auto p-6">
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
							<div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
								<HugeiconsIcon
									className="size-4 shrink-0"
									icon={ServerStack01Icon}
								/>
								<span>Use the node settings to add your first node.</span>
							</div>
						</EmptyContent>
					</Empty>
				) : healthLoading && nodes.every((n) => !n.statusKnown) ? (
					<div className="flex flex-col gap-3">
						{nodes.map((node) => (
							<Card key={node.name}>
								<CardContent className="p-0">
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
								<CardContent className="p-0">
									<button
										className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/40"
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
												<HugeiconsIcon
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
