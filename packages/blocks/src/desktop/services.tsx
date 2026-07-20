"use client";

// Presentational layer of the desktop Services page. The live app
// (`apps/desktop/src/pages/ServicesPage.tsx`) is a thin container that loads
// sidecar status via `useServicesStatus()` + sandbox status and renders this
// view with real handlers; the storyboard renders the same component with mock
// data and no-op handlers. One source of truth, so editing this block changes
// the real desktop too.

import {
	Alert01Icon,
	AlertCircleIcon,
	CancelCircleIcon,
	CheckmarkCircle01Icon,
	CircleArrowUp01Icon,
	CircleIcon,
	Download01Icon,
	Loading01Icon,
	MinusSignIcon,
	PlayIcon,
	RotateClockwiseIcon,
	Shield01Icon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/** A sidecar row as the view needs it — the container resolves install state. */
export interface ServiceRow {
	deprecated?: boolean;
	description?: string | null;
	displayName: string;
	installedVersion?: string | null;
	installState: "installed" | "installing" | "failed" | "available" | string;
	latestVersion?: string | null;
	name: string;
	/** Action label currently in flight for this row (install/start/stop/restart). */
	pending?: string | null;
	running: boolean;
}

export interface DependencyRow {
	installed: boolean;
	name: string;
}

export interface SandboxView {
	available: boolean;
	docker?: { available: boolean; reason?: string | null } | null;
	enabled: boolean;
}

export interface ServicesViewProps {
	agents?: ServiceRow[];
	bulkPending?: "start" | "stop" | "deps" | null;
	dependencies?: DependencyRow[];
	error?: string | null;
	gatewayPending?: "start" | "stop" | null;
	gatewayRunning?: boolean | null;
	loading?: boolean;
	onGatewayStart?: () => void;
	onGatewayStop?: () => void;
	onInstall?: (name: string) => void;
	onInstallMissing?: () => void;
	onRestart?: (name: string) => void;
	onStart?: (name: string) => void;
	onStartAll?: () => void;
	onStop?: (name: string) => void;
	onStopAll?: () => void;
	onToggleSandbox?: () => void;
	sandbox?: SandboxView | null;
	sandboxPending?: boolean;
	tools?: ServiceRow[];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mt-4">
			<div className="px-4 py-1.5">
				<span className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
					{title}
				</span>
			</div>
			<div className="mx-2 overflow-hidden rounded-lg border">{children}</div>
		</div>
	);
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

/** A single sidecar row (mirrors the live `SidecarRow` component). */
export function SidecarRowView({
	entry,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: {
	entry: ServiceRow;
	onInstall?: (name: string) => void;
	onStart?: (name: string) => void;
	onStop?: (name: string) => void;
	onRestart?: (name: string) => void;
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
						className={cn(
							"truncate font-medium text-sm",
							!isInstalled && "text-muted-foreground"
						)}
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
				{isInstalling ? (
					<span className="text-muted-foreground text-xs">Installing…</span>
				) : isFailed ? (
					<Button
						className="h-7 px-2 text-amber-500 hover:text-amber-600"
						disabled={pending !== null}
						onClick={() => onInstall?.(entry.name)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className="mr-1 h-3.5 w-3.5"
							icon={AlertCircleIcon}
						/>
						Retry
					</Button>
				) : isInstalled || entry.deprecated ? (
					isInstalled ? (
						<>
							{hasUpdate ? (
								<Button
									className="h-7 px-2 text-blue-500 hover:text-blue-600"
									disabled={pending !== null}
									onClick={() => onInstall?.(entry.name)}
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
										onClick={() => onStop?.(entry.name)}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon
											className="mr-1 h-3.5 w-3.5"
											icon={Square01Icon}
										/>
										Stop
									</Button>
									<Button
										className="h-7 px-2"
										disabled={pending !== null}
										onClick={() => onRestart?.(entry.name)}
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
									onClick={() => onStart?.(entry.name)}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={PlayIcon} />
									Start
								</Button>
							)}
						</>
					) : null
				) : (
					<Button
						className="h-7 px-2"
						disabled={pending !== null}
						onClick={() => onInstall?.(entry.name)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={Download01Icon} />
						Install
					</Button>
				)}
			</div>
		</div>
	);
}

function GatewayRow({
	running,
	pending,
	onStart,
	onStop,
}: {
	running: boolean | null | undefined;
	pending: "start" | "stop" | null | undefined;
	onStart?: () => void;
	onStop?: () => void;
}) {
	return (
		<div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40">
			<div className="flex w-4 flex-shrink-0 items-center justify-center">
				{pending == null ? (
					running ? (
						<HugeiconsIcon
							className="h-3 w-3 fill-green-500 text-green-500"
							icon={CircleIcon}
						/>
					) : (
						<HugeiconsIcon
							className="h-3 w-3 text-muted-foreground"
							icon={CircleIcon}
						/>
					)
				) : (
					<HugeiconsIcon
						className="h-3.5 w-3.5 animate-spin text-muted-foreground"
						icon={Loading01Icon}
					/>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<HugeiconsIcon
						className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
						icon={Shield01Icon}
					/>
					<span className="truncate font-medium text-sm">Gateway</span>
				</div>
				<p className="truncate text-muted-foreground text-xs">
					{running
						? "Running — routing, firewall, and budget controls active"
						: "Not running — start to enable model routing and guardrails"}
				</p>
			</div>
			<div className="flex flex-shrink-0 items-center gap-1.5">
				{running ? (
					<>
						<Button
							className="h-7 px-2"
							disabled={pending != null}
							onClick={onStop}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={Square01Icon} />
							Stop
						</Button>
						<Button
							className="h-7 px-2"
							disabled={pending != null}
							onClick={onStart}
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
						disabled={pending != null}
						onClick={onStart}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={PlayIcon} />
						Start
					</Button>
				)}
			</div>
		</div>
	);
}

function SandboxRow({
	sandbox,
	pending,
	onToggle,
}: {
	sandbox: SandboxView | null | undefined;
	pending?: boolean;
	onToggle?: () => void;
}) {
	const available = sandbox?.available ?? false;
	const enabled = sandbox?.enabled ?? false;

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40">
			<div className="flex w-4 flex-shrink-0 items-center justify-center">
				{pending ? (
					<HugeiconsIcon
						className="h-3.5 w-3.5 animate-spin text-muted-foreground"
						icon={Loading01Icon}
					/>
				) : enabled ? (
					<HugeiconsIcon
						className="h-3 w-3 fill-green-500 text-green-500"
						icon={CircleIcon}
					/>
				) : (
					<HugeiconsIcon
						className="h-3 w-3 text-muted-foreground"
						icon={CircleIcon}
					/>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<span className="truncate font-medium text-sm">Wasmtime sandbox</span>
				<p className="truncate text-muted-foreground text-xs">
					{available
						? "Built-in wasmtime — run WASM/WASI modules with default-deny capabilities"
						: "Not compiled in — rebuild ryu-core with sandbox-wasmtime feature to enable"}
				</p>
			</div>
			<div className="flex flex-shrink-0 items-center gap-1.5">
				{available ? (
					<Button
						className="h-7 px-2"
						disabled={pending}
						onClick={onToggle}
						size="sm"
						variant="ghost"
					>
						{enabled ? (
							<>
								<HugeiconsIcon
									className="mr-1 h-3.5 w-3.5"
									icon={Square01Icon}
								/>
								Disable
							</>
						) : (
							<>
								<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={PlayIcon} />
								Enable
							</>
						)}
					</Button>
				) : (
					<span className="text-muted-foreground text-xs">Unavailable</span>
				)}
			</div>
		</div>
	);
}

function DockerRow({ sandbox }: { sandbox: SandboxView | null | undefined }) {
	const docker = sandbox?.docker;
	const available = docker?.available ?? false;
	const reason = docker?.reason ?? null;

	let description: string;
	if (available) {
		description =
			"Docker daemon detected - opt-in backend for long-lived workspaces and native binaries";
	} else if (reason) {
		description = `Unavailable: ${reason}`;
	} else {
		description =
			"Docker daemon not detected - install Docker Desktop to enable this backend";
	}

	return (
		<div className="flex items-center gap-3 border-t px-4 py-2.5 transition-colors hover:bg-muted/40">
			<div className="flex w-4 flex-shrink-0 items-center justify-center">
				{available ? (
					<HugeiconsIcon
						className="h-3 w-3 fill-green-500 text-green-500"
						icon={CircleIcon}
					/>
				) : (
					<HugeiconsIcon
						className="h-3 w-3 text-muted-foreground"
						icon={CircleIcon}
					/>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<span className="truncate font-medium text-sm">Docker backend</span>
				<p className="truncate text-muted-foreground text-xs">{description}</p>
			</div>
			<div className="flex flex-shrink-0 items-center gap-1.5">
				<span className="text-muted-foreground text-xs">
					{available ? "Detected" : "Not detected"}
				</span>
			</div>
		</div>
	);
}

export function ServicesView({
	loading,
	error,
	gatewayRunning,
	gatewayPending,
	agents = [],
	tools = [],
	dependencies = [],
	sandbox,
	sandboxPending,
	bulkPending,
	onStartAll,
	onStopAll,
	onInstallMissing,
	onGatewayStart,
	onGatewayStop,
	onToggleSandbox,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: ServicesViewProps) {
	const hasMissingDeps = dependencies.some((d) => !d.installed);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start justify-end px-6 pt-6 pb-2">
				<div className="mt-1 flex gap-2">
					<Button
						disabled={bulkPending != null}
						onClick={onStartAll}
						size="sm"
						variant="ghost"
					>
						{bulkPending === "start" ? (
							<HugeiconsIcon
								className="mr-1.5 h-3.5 w-3.5 animate-spin"
								icon={Loading01Icon}
							/>
						) : (
							<HugeiconsIcon className="mr-1.5 h-3.5 w-3.5" icon={PlayIcon} />
						)}
						Start all
					</Button>
					<Button
						disabled={bulkPending != null}
						onClick={onStopAll}
						size="sm"
						variant="ghost"
					>
						{bulkPending === "stop" ? (
							<HugeiconsIcon
								className="mr-1.5 h-3.5 w-3.5 animate-spin"
								icon={Loading01Icon}
							/>
						) : (
							<HugeiconsIcon
								className="mr-1.5 h-3.5 w-3.5"
								icon={Square01Icon}
							/>
						)}
						Stop all
					</Button>
				</div>
			</div>

			{loading ? (
				<div className="flex flex-1 items-center justify-center">
					<HugeiconsIcon
						className="h-5 w-5 animate-spin text-muted-foreground"
						icon={Loading01Icon}
					/>
				</div>
			) : error ? (
				<div className="flex flex-1 items-center justify-center">
					<p className="text-muted-foreground text-sm">{error}</p>
				</div>
			) : (
				<div className="scroll-fade-effect-y flex-1 overflow-y-auto px-2 pb-6">
					<Section title="Runtime">
						<GatewayRow
							onStart={onGatewayStart}
							onStop={onGatewayStop}
							pending={gatewayPending}
							running={gatewayRunning}
						/>
					</Section>

					<Section title="Agents">
						{agents.map((entry) => (
							<SidecarRowView
								entry={entry}
								key={entry.name}
								onInstall={onInstall}
								onRestart={onRestart}
								onStart={onStart}
								onStop={onStop}
							/>
						))}
					</Section>

					<Section title="Tools">
						{tools.map((entry) => (
							<SidecarRowView
								entry={entry}
								key={entry.name}
								onInstall={onInstall}
								onRestart={onRestart}
								onStart={onStart}
								onStop={onStop}
							/>
						))}
					</Section>

					<Section title="Sandboxes">
						<SandboxRow
							onToggle={onToggleSandbox}
							pending={sandboxPending}
							sandbox={sandbox}
						/>
						<DockerRow sandbox={sandbox} />
					</Section>

					<Section title="Dependencies">
						<div className="space-y-2 px-4 py-2">
							{dependencies.map((dep) => (
								<div className="flex items-center gap-2 text-sm" key={dep.name}>
									{dep.installed ? (
										<HugeiconsIcon
											className="h-3.5 w-3.5 text-green-500"
											icon={CheckmarkCircle01Icon}
										/>
									) : (
										<HugeiconsIcon
											className="h-3.5 w-3.5 text-destructive"
											icon={CancelCircleIcon}
										/>
									)}
									<span
										className={dep.installed ? "" : "text-muted-foreground"}
									>
										{dep.name}
									</span>
								</div>
							))}
							{hasMissingDeps ? (
								<Button
									className="mt-2"
									disabled={bulkPending != null}
									onClick={onInstallMissing}
									size="sm"
									variant="ghost"
								>
									{bulkPending === "deps" ? (
										<HugeiconsIcon
											className="mr-1.5 h-3.5 w-3.5 animate-spin"
											icon={Loading01Icon}
										/>
									) : null}
									Install missing
								</Button>
							) : null}
						</div>
					</Section>
				</div>
			)}
		</div>
	);
}
