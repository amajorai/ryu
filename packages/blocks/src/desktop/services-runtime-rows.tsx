"use client";

import {
	CircleIcon,
	Loading01Icon,
	PlayIcon,
	RotateClockwiseIcon,
	Shield01Icon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import type { SandboxView } from "./services-types.ts";

export function GatewayRow({
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
							className="h-3 w-3 fill-success text-status-success"
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
							appearance="service-action"
							disabled={pending != null}
							onClick={onStop}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={Square01Icon} />
							Stop
						</Button>
						<Button
							appearance="service-action"
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
						appearance="service-action"
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

export function SandboxRow({
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
						className="h-3 w-3 fill-success text-status-success"
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
						appearance="service-action"
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

export function DockerRow({
	sandbox,
}: {
	sandbox: SandboxView | null | undefined;
}) {
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
						className="h-3 w-3 fill-success text-status-success"
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
				<p
					className="truncate text-muted-foreground text-xs"
					title={description}
				>
					{description}
				</p>
			</div>
			<div className="flex flex-shrink-0 items-center gap-1.5">
				<span className="text-muted-foreground text-xs">
					{available ? "Detected" : "Not detected"}
				</span>
			</div>
		</div>
	);
}
