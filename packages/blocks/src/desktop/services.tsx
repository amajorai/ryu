"use client";

// Presentational layer of the desktop Services page. The live app
// (`apps/desktop/src/pages/ServicesPage.tsx`) is a thin container that loads
// sidecar status via `useServicesStatus()` + sandbox status and renders this
// view with real handlers; the storyboard renders the same component with mock
// data and no-op handlers. One source of truth, so editing this block changes
// the real desktop too.

import {
	CancelCircleIcon,
	CheckmarkCircle01Icon,
	Loading01Icon,
	PlayIcon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import type { ReactNode } from "react";
import { DockerRow, GatewayRow, SandboxRow } from "./services-runtime-rows.tsx";
import { SidecarRowView } from "./services-sidecar-row.tsx";
import type { ServicesViewProps } from "./services-types.ts";

export { SidecarRowView } from "./services-sidecar-row.tsx";
export type {
	DependencyRow,
	SandboxView,
	ServiceRow,
	ServicesViewProps,
} from "./services-types.ts";

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mt-4">
			<div className="px-4 py-1.5">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
					{title}
				</span>
			</div>
			<div className="mx-2 overflow-hidden rounded-lg border">{children}</div>
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
	const tl = useLiteralMessages();
	const hasMissingDeps = dependencies.some((d) => !d.installed);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start justify-end px-6 pt-6 pb-2">
				<div className="mt-1 flex gap-2">
					<Button
						disabled={bulkPending != null && bulkPending !== "start"}
						loading={bulkPending === "start"}
						onClick={onStartAll}
						size="sm"
						variant="ghost"
					>
						{bulkPending !== "start" && (
							<HugeiconsIcon className="mr-1.5 h-3.5 w-3.5" icon={PlayIcon} />
						)}
						{tl("Start all")}
					</Button>
					<Button
						disabled={bulkPending != null && bulkPending !== "stop"}
						loading={bulkPending === "stop"}
						onClick={onStopAll}
						size="sm"
						variant="ghost"
					>
						{bulkPending !== "stop" && (
							<HugeiconsIcon
								className="mr-1.5 h-3.5 w-3.5"
								icon={Square01Icon}
							/>
						)}
						{tl("Stop all")}
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
				<div className="scroll-fade flex-1 overflow-y-auto px-2 pb-6">
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
											className="h-3.5 w-3.5 text-status-success"
											icon={CheckmarkCircle01Icon}
										/>
									) : (
										<HugeiconsIcon
											className="h-3.5 w-3.5 text-status-destructive"
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
									disabled={bulkPending != null && bulkPending !== "deps"}
									loading={bulkPending === "deps"}
									onClick={onInstallMissing}
									size="sm"
									variant="ghost"
								>
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
