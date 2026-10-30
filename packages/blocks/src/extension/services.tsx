"use client";

import {
	Loading03Icon,
	MoreHorizontalIcon,
	RotateClockwiseIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import type { CatalogItem as NativeCatalogItem } from "@ryuhq/core-client/catalog.ts";

export type SidecarAction = "install" | "start" | "stop" | "restart";

export interface SidecarRowData {
	deprecated?: boolean;
	description?: string;
	displayName: string;
	hasUpdate?: boolean;
	installState: NativeCatalogItem["install_state"];
	name: string;
	running: boolean;
}

export interface SidecarRowProps {
	entry: SidecarRowData;
	onAction?: (action: SidecarAction) => void;
	/** Action currently running for this row (drives the disabled / spinner UI). */
	pending?: SidecarAction | null;
}

/** The status the dot shows, spelled out for assistive technology. */
function statusLabel({
	failed,
	isInstalled,
	isInstalling,
	running,
}: {
	failed: boolean;
	isInstalled: boolean;
	isInstalling: boolean;
	running: boolean;
}): string {
	if (isInstalling) {
		return "Installing";
	}
	if (failed) {
		return "Install failed";
	}
	if (!isInstalled) {
		return "Not installed";
	}
	return running ? "Running" : "Stopped";
}

/** A 6px status dot; nothing for a service that is not installed. */
function StatusDot({
	failed,
	isInstalled,
	isInstalling,
	running,
}: {
	failed: boolean;
	isInstalled: boolean;
	isInstalling: boolean;
	running: boolean;
}) {
	if (isInstalling) {
		return (
			<HugeiconsIcon
				aria-hidden="true"
				className="animate-spin text-muted-foreground"
				icon={Loading03Icon}
				size={14}
			/>
		);
	}
	if (failed) {
		return <span className="size-1.5 rounded-full bg-destructive" />;
	}
	if (!isInstalled) {
		return null;
	}
	return (
		<span
			className={cn(
				"size-1.5 rounded-full",
				running ? "bg-success" : "bg-muted-foreground"
			)}
		/>
	);
}

/** The single visible action a row offers, or null when it has none. */
function primaryAction(
	entry: SidecarRowData,
	hasUpdate: boolean
): { action: SidecarAction; label: string } | null {
	if (entry.installState === "failed") {
		return { action: "install", label: "Retry" };
	}
	if (entry.installState !== "installed") {
		return entry.deprecated ? null : { action: "install", label: "Install" };
	}
	if (hasUpdate) {
		return { action: "install", label: "Update" };
	}
	return entry.running ? null : { action: "start", label: "Start" };
}

/**
 * A single sidecar row, presentational: status dot, name and one line of
 * description, one inline action, and Stop and Restart behind `⋯`. The live
 * extension wraps it with the real `ServiceEntry` mapping and the
 * `services-api` calls; the storyboard drives every state through props.
 */
export function SidecarRow({
	entry,
	pending = null,
	onAction,
}: SidecarRowProps) {
	const tl = useLiteralMessages();
	const isInstalled = entry.installState === "installed";
	const isInstalling =
		entry.installState === "installing" || pending === "install";
	const failed = entry.installState === "failed";
	const hasUpdate = Boolean(
		isInstalled && entry.hasUpdate && !entry.deprecated
	);
	const busy = pending !== null;
	const dimmed = !isInstalled || entry.deprecated;
	const primary = isInstalling ? null : primaryAction(entry, hasUpdate);
	const label = entry.displayName;
	const status = statusLabel({
		failed,
		isInstalled,
		isInstalling,
		running: entry.running,
	});
	const menuPending = pending === "stop" || pending === "restart";

	return (
		<div className="group/row flex min-h-12 items-center gap-3 py-2">
			<span
				className="flex size-4 shrink-0 items-center justify-center"
				title={status}
			>
				<span className="sr-only">{status}</span>
				<StatusDot
					failed={failed}
					isInstalled={isInstalled}
					isInstalling={isInstalling}
					running={entry.running}
				/>
			</span>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"truncate text-sm",
							dimmed && "text-muted-foreground"
						)}
					>
						{label}
					</span>
					{entry.deprecated ? (
						<span className="shrink-0 text-status-warning text-xs">
							Deprecated
						</span>
					) : null}
				</div>
				{entry.description ? (
					<p className="truncate text-detail text-muted-foreground">
						{entry.description}
					</p>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-1">
				{isInstalling ? (
					<span className="text-muted-foreground text-xs">Installing…</span>
				) : null}
				{primary ? (
					<Button
						disabled={busy}
						loading={pending === primary.action}
						onClick={() => onAction?.(primary.action)}
						size="sm"
						variant="outline"
					>
						{primary.label}
					</Button>
				) : null}
				{/* Stop and Restart sit in a reserved slot, so every row's inline
				    action lines up whether or not the row has the menu. */}
				{isInstalled && entry.running ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label={tl("More actions for {label}", { label })}
									className={cn(
										"transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-hover/row:duration-0 data-[popup-open]:opacity-100",
										menuPending ? "opacity-100" : "opacity-0"
									)}
									disabled={busy}
									loading={menuPending}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => onAction?.("restart")}>
								<HugeiconsIcon icon={RotateClockwiseIcon} size={16} />
								Restart
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onAction?.("stop")}>
								<HugeiconsIcon icon={StopIcon} size={16} />
								Stop
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					<span aria-hidden="true" className="size-8 shrink-0" />
				)}
			</div>
		</div>
	);
}
