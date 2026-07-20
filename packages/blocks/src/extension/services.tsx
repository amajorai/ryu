"use client";

import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	AlertCircle,
	AlertTriangle,
	ArrowUpCircle,
	Circle,
	Download,
	Loader2,
	Minus,
	Play,
	RotateCw,
	Square,
} from "lucide-react";

export type SidecarAction = "install" | "start" | "stop" | "restart";

export interface SidecarRowData {
	deprecated?: boolean;
	description?: string;
	displayName: string;
	hasUpdate?: boolean;
	installState: "installed" | "installing" | "failed" | "not_installed";
	name: string;
	running: boolean;
}

export interface SidecarRowProps {
	entry: SidecarRowData;
	onAction?: (action: SidecarAction) => void;
	/** Action currently running for this row (drives the disabled / spinner UI). */
	pending?: SidecarAction | null;
}

function StateGlyph({
	isInstalling,
	isInstalled,
	running,
}: {
	isInstalling: boolean;
	isInstalled: boolean;
	running: boolean;
}) {
	if (isInstalling) {
		return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
	}
	if (!isInstalled) {
		return <Minus className="size-3.5 text-muted-foreground/50" />;
	}
	if (running) {
		return <Circle className="size-3 fill-green-500 text-green-500" />;
	}
	return <Circle className="size-3 text-muted-foreground" />;
}

/**
 * A single sidecar row, presentational. The live extension wraps it with the
 * real `ServiceEntry` mapping and the `services-api` calls; the storyboard
 * drives every state through the `entry` and `pending` props alone.
 */
export function SidecarRow({
	entry,
	pending = null,
	onAction,
}: SidecarRowProps) {
	const isInstalled = entry.installState === "installed";
	const isInstalling =
		entry.installState === "installing" || pending === "install";
	const isFailed = entry.installState === "failed";
	const hasUpdate = Boolean(
		isInstalled && entry.hasUpdate && !entry.deprecated
	);
	const busy = pending !== null;
	const dimmed = !isInstalled || entry.deprecated;

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40">
			<div className="flex w-4 shrink-0 items-center justify-center">
				<StateGlyph
					isInstalled={isInstalled}
					isInstalling={isInstalling}
					running={entry.running}
				/>
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"truncate font-medium text-sm",
							dimmed && "text-muted-foreground"
						)}
					>
						{entry.displayName}
					</span>
					{entry.deprecated ? (
						<span className="flex items-center gap-1 font-medium text-amber-500 text-xs">
							<AlertTriangle className="size-3" />
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

			<div className="flex shrink-0 items-center gap-1.5">
				{isInstalling ? (
					<span className="text-muted-foreground text-xs">Installing…</span>
				) : isFailed ? (
					<Button
						className="h-7 px-2 text-amber-500 hover:text-amber-600"
						disabled={busy}
						onClick={() => onAction?.("install")}
						size="sm"
						variant="ghost"
					>
						<AlertCircle className="mr-1 size-3.5" />
						Retry
					</Button>
				) : isInstalled || entry.deprecated ? (
					isInstalled ? (
						<>
							{hasUpdate ? (
								<Button
									className="h-7 px-2 text-blue-500 hover:text-blue-600"
									disabled={busy}
									onClick={() => onAction?.("install")}
									size="sm"
									variant="ghost"
								>
									<ArrowUpCircle className="mr-1 size-3.5" />
									Update
								</Button>
							) : null}
							{entry.running ? (
								<>
									<Button
										className="h-7 px-2"
										disabled={busy}
										onClick={() => onAction?.("stop")}
										size="sm"
										variant="ghost"
									>
										<Square className="mr-1 size-3.5" />
										Stop
									</Button>
									<Button
										className="h-7 px-2"
										disabled={busy}
										onClick={() => onAction?.("restart")}
										size="sm"
										variant="ghost"
									>
										<RotateCw className="mr-1 size-3.5" />
										Restart
									</Button>
								</>
							) : (
								<Button
									className="h-7 px-2"
									disabled={busy}
									onClick={() => onAction?.("start")}
									size="sm"
									variant="ghost"
								>
									<Play className="mr-1 size-3.5" />
									Start
								</Button>
							)}
						</>
					) : null
				) : (
					<Button
						className="h-7 px-2"
						disabled={busy}
						onClick={() => onAction?.("install")}
						size="sm"
						variant="ghost"
					>
						<Download className="mr-1 size-3.5" />
						Install
					</Button>
				)}
			</div>
		</div>
	);
}
