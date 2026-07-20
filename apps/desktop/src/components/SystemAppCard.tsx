// apps/desktop/src/components/SystemAppCard.tsx
//
// Card component for built-in system apps (Ghost, Shadow) whose lifecycle is
// sidecar-based rather than App-store lifecycle (install/enable/disable).
//
// Controls:
//   Install  -> POST /api/setup/:sidecarName/install  (binary download)
//   Start    -> POST /api/sidecar/:sidecarName/start
//   Stop     -> POST /api/sidecar/:sidecarName/stop
//
// The card reflects the sidecar's running state from the `sidecarStatus` map
// passed by the parent (polled via GET /api/sidecar/status). When the sidecar
// binary is not installed, only the Install button is shown. On non-Windows
// platforms a windows-first badge + disabled state is shown for ghost/shadow.
//
// The parent (the store's InstalledSection) is responsible for polling; this
// component is pure display + action.

import {
	ComputerIcon,
	Download01Icon,
	GlobeIcon,
	Square01Icon,
	Triangle01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Spinner } from "@ryu/ui/components/spinner";

import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import {
	installSidecar,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";

export interface SystemAppCardProps {
	app: AppInfo;
	/** Called after a successful install/start/stop so the parent can re-poll. */
	onStatusChange: () => void;
	/** Current running state for this sidecar; `undefined` means status unknown. */
	running: boolean | undefined;
	target: ApiTarget;
}

type Action = "install" | "start" | "stop";

export function SystemAppCard({
	app,
	running,
	target,
	onStatusChange,
}: SystemAppCardProps) {
	const [pending, setPending] = useState<Action | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const sidecarName = app.sidecarName;
	// A system app with no sidecar_name is misconfigured; render unavailable.
	const isConfigured = sidecarName !== null;

	const handleInstall = async () => {
		if (!isConfigured || pending !== null) {
			return;
		}
		setActionError(null);
		setPending("install");
		try {
			await installSidecar(target, sidecarName as string);
			onStatusChange();
		} catch (e) {
			setActionError(
				e instanceof Error ? e.message : "Failed to install sidecar"
			);
		} finally {
			setPending(null);
		}
	};

	const handleStart = async () => {
		if (!isConfigured || pending !== null) {
			return;
		}
		setActionError(null);
		setPending("start");
		try {
			await startSidecar(target, sidecarName as string);
			onStatusChange();
		} catch (e) {
			setActionError(
				e instanceof Error ? e.message : "Failed to start sidecar"
			);
		} finally {
			setPending(null);
		}
	};

	const handleStop = async () => {
		if (!isConfigured || pending !== null) {
			return;
		}
		setActionError(null);
		setPending("stop");
		try {
			await stopSidecar(target, sidecarName as string);
			onStatusChange();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "Failed to stop sidecar");
		} finally {
			setPending(null);
		}
	};

	// running === undefined means the sidecar name is absent from the status map,
	// which means it is not installed (binary not found).
	const isInstalled = running !== undefined;
	const isRunning = running === true;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<HugeiconsIcon className="size-4 opacity-70" icon={ComputerIcon} />
					{app.name}
				</CardTitle>
				<CardDescription className="flex flex-wrap items-center gap-2">
					<Badge variant="secondary">v{app.version}</Badge>
					<Badge variant="secondary">Built-in</Badge>
					{app.windowsFirst ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={ComputerIcon} />
							Windows-first
						</Badge>
					) : null}
					{app.localOnly ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={GlobeIcon} />
							Local only
						</Badge>
					) : null}
					{isInstalled ? (
						isRunning ? (
							<Badge variant="default">Running</Badge>
						) : (
							<Badge variant="secondary">Stopped</Badge>
						)
					) : (
						<Badge variant="secondary">Not installed</Badge>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{app.permissionGrants.length > 0 ? (
					<p className="text-muted-foreground text-xs">
						Grants:{" "}
						<span className="font-mono">{app.permissionGrants.join(", ")}</span>
					</p>
				) : null}
				<p className="text-muted-foreground text-sm">
					{app.runnables.length === 0
						? "No Runnables"
						: app.runnables.map((r) => `${r.name} (${r.kind})`).join(" · ")}
				</p>

				{actionError ? (
					<p className="text-destructive text-xs">{actionError}</p>
				) : null}

				<div className="flex flex-wrap gap-2">
					{/* Install — only when the binary is not yet present */}
					{isInstalled ? null : (
						<Button
							disabled={pending !== null || !isConfigured}
							onClick={handleInstall}
							size="sm"
							variant="ghost"
						>
							{pending === "install" ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Download01Icon} />
							)}
							Install
						</Button>
					)}

					{/* Start — installed and not running */}
					{isInstalled && !isRunning ? (
						<Button
							disabled={pending !== null}
							onClick={handleStart}
							size="sm"
							variant="ghost"
						>
							{pending === "start" ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Triangle01Icon} />
							)}
							Start
						</Button>
					) : null}

					{/* Stop — installed and running */}
					{isInstalled && isRunning ? (
						<Button
							disabled={pending !== null}
							onClick={handleStop}
							size="sm"
							variant="ghost"
						>
							{pending === "stop" ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Square01Icon} />
							)}
							Stop
						</Button>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}
